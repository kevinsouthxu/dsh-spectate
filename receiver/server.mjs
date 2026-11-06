/**
 * 参考接收端 —— 最小可用的 /screen、/game-mode
 *
 * 它的职责只有一个：把收到的拼图变成「会话里的一条消息」。
 * 这里用 HTTP 转发的方式实现（默认转发到 DSH 桥接的 /api/inject），
 * 你可以把 forward() 换成任何能往会话里塞内容的东西：localStorage、MCP、你自己的接口。
 *
 * 启动：
 *   INJECT_URL=http://127.0.0.1:3100/api/inject \
 *   INJECT_TOKEN=xxxx \
 *   SCREEN_TOKEN=scr-xxxx \
 *   node receiver/server.mjs
 *
 * 依赖：Node 18+（用内置 fetch），无第三方包。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.SCREEN_PORT || 7422);
const BIND = process.env.SCREEN_BIND || '0.0.0.0';
const SCREEN_TOKEN = process.env.SCREEN_TOKEN || '';
const INJECT_URL = process.env.INJECT_URL || 'http://127.0.0.1:3100/api/inject';
const INJECT_TOKEN = process.env.INJECT_TOKEN || '';
const INJECT_KEY = process.env.INJECT_KEY || 'private:0000000000';
const PROMPT_TOKEN = process.env.PROMPT_SESSION_TOKEN || '';   // 会话令牌（写进提示里给模型调工具用）
const MIN_GAP_MS = Number(process.env.MIN_GAP_MS || 20000);
const QUIET_GAP_MS = Number(process.env.QUIET_GAP_MS || 60000);
const MAX_BYTES = 6 * 1024 * 1024;

const STATE_DIR = process.env.SCREEN_STATE || path.join(process.cwd(), 'receiver-state');
const MODE_FILE = path.join(STATE_DIR, 'game-mode.json');
const LOG_FILE = path.join(STATE_DIR, 'screen.log');

fs.mkdirSync(STATE_DIR, { recursive: true });

const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
};

function readMode() {
  try {
    const j = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8'));
    return { enabled: !!j.enabled && (!j.untilMs || Date.now() < j.untilMs), untilMs: j.untilMs || 0 };
  } catch { return { enabled: false, untilMs: 0 }; }
}
function writeMode(enabled, minutes) {
  const rec = { enabled: !!enabled, since: Date.now(), untilMs: enabled ? Date.now() + (minutes || 180) * 60000 : 0 };
  fs.writeFileSync(MODE_FILE, JSON.stringify(rec, null, 2) + '\n', 'utf8');
  return rec;
}

/** 把一张拼图变成会话里的一条消息 —— 换成你自己的实现即可。 */
async function forward({ text, image }) {
  const res = await fetch(INJECT_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(40000),
    headers: {
      'content-type': 'application/json',
      ...(INJECT_TOKEN ? { 'x-console-token': INJECT_TOKEN } : {})
    },
    body: JSON.stringify({ key: INJECT_KEY, text, image })
  });
  const body = await res.text();
  return { status: res.status, body: body.slice(0, 300) };
}

function buildText(note) {
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  return [
    `【当前时间】${now}`,
    PROMPT_TOKEN ? `【会话令牌】${PROMPT_TOKEN}` : '',
    '【唤醒原因】他打游戏时随手给你看了一眼屏幕',
    '',
    `他：[图片]${note ? ' ' + note : ' 喏'}`,
    '',
    '（别复述图里有什么，别念数字、格数、时间戳。当自己坐在旁边看，随口一句就行。）'
  ].filter(Boolean).join('\n');
}

let lastInjectAt = 0;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (req.method === 'GET' && url.pathname === '/screen/ping') {
    json(200, { ok: true, service: 'dsh-spectate-receiver', minGapMs: MIN_GAP_MS });
    return;
  }

  if (url.pathname === '/game-mode') {
    if (req.method === 'GET') { const m = readMode(); json(200, { ok: true, ...m }); return; }
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {}
        const m = writeMode(body.enabled !== false, body.minutes);
        log('游戏模式', m.enabled ? '开启' : '关闭');
        json(200, { ok: true, ...m });
      });
      return;
    }
    json(405, { ok: false, error: 'method not allowed' });
    return;
  }

  if (req.method !== 'POST' || url.pathname !== '/screen') { json(404, { ok: false, error: 'not found' }); return; }
  if (SCREEN_TOKEN && String(req.headers.authorization || '') !== `Bearer ${SCREEN_TOKEN}`) {
    json(401, { ok: false, error: 'bad token' });
    return;
  }

  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > MAX_BYTES) req.destroy(); });
  req.on('end', async () => {
    let body;
    try { body = JSON.parse(raw); } catch { json(400, { ok: false, error: 'invalid json' }); return; }

    if (!readMode().enabled) { json(409, { ok: false, error: 'game-mode-off' }); return; }

    const now = Date.now();
    if (now - lastInjectAt < MIN_GAP_MS) {
      json(429, { ok: false, error: 'too-frequent', retryAfterMs: MIN_GAP_MS - (now - lastInjectAt) });
      return;
    }

    const img = body.image || {};
    const data = String(img.data || '').replace(/^data:image\/\w+;base64,/, '');
    if (!data) { json(400, { ok: false, error: 'image.data 为空' }); return; }
    lastInjectAt = now;

    try {
      const r = await forward({
        text: buildText(img.note),
        image: { mediaType: img.mediaType || 'image/jpeg', data, name: img.name || 'game.jpg' }
      });
      log(`inject 方式=${body.mode || '?'} 帧数=${body.frames || '?'} ${r.status} ${Math.round(Buffer.byteLength(data, 'base64') / 1024)}KB`);
      json(r.status >= 200 && r.status < 300 ? 200 : 502, { ok: r.status < 300, detail: r.body });
    } catch (e) {
      log('转发失败', e.message);
      json(500, { ok: false, error: e.message });
    }
  });
});

server.listen(PORT, BIND, () => log(`接收端已启动 http://${BIND}:${PORT}/screen  转发到 ${INJECT_URL}`));
