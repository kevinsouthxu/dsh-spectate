/**
 * 参考接收端 —— 最小可用的 /screen、/game-mode
 *
 * 职责只有一个：把收到的拼图变成「会话里的一条消息」。
 * 默认用 HTTP 转发实现（转发到 DSH 桥接的 /api/inject），
 * 你可以把 forward() 换成任何能往会话里塞内容的东西。
 *
 * 启动：
 *   SCREEN_TOKEN=scr-xxxx INJECT_URL=http://127.0.0.1:3100/api/inject \
 *   INJECT_TOKEN=xxxx node receiver/server.mjs
 *
 * Node 18+，无第三方依赖。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.SCREEN_PORT || 7422);
const BIND = process.env.SCREEN_BIND || '0.0.0.0';
const INJECT_URL = process.env.INJECT_URL || 'http://127.0.0.1:3100/api/inject';
const INJECT_TOKEN = process.env.INJECT_TOKEN || '';
const INJECT_KEY = process.env.INJECT_KEY || 'private:0000000000';
const PROMPT_TOKEN = process.env.PROMPT_SESSION_TOKEN || '';
const MIN_GAP_MS = Number(process.env.MIN_GAP_MS || 20000);
const MAX_BYTES = 6 * 1024 * 1024;

const STATE_DIR = process.env.SCREEN_STATE || path.join(process.cwd(), 'receiver-state');
const MODE_FILE = path.join(STATE_DIR, 'game-mode.json');
const LOG_FILE = path.join(STATE_DIR, 'screen.log');
fs.mkdirSync(STATE_DIR, { recursive: true });

// 令牌：没配就自动生成，绝不裸奔
let SCREEN_TOKEN = process.env.SCREEN_TOKEN || '';
if (!SCREEN_TOKEN) {
  SCREEN_TOKEN = 'scr-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  console.warn('[warn] 未设置 SCREEN_TOKEN，已自动生成：' + SCREEN_TOKEN + '（重启会变，建议写进环境变量）');
}

function log(...a) {
  const line = '[' + new Date().toISOString() + '] ' + a.join(' ');
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

process.on('unhandledRejection', (e) => log('未捕获的 Promise 拒绝:', (e && e.message) || String(e)));
process.on('uncaughtException', (e) => log('未捕获异常:', (e && e.message) || String(e)));

/** 写接口统一鉴权。 */
function authed(req) {
  return String(req.headers.authorization || '') === 'Bearer ' + SCREEN_TOKEN;
}

/** 只接受非空 JSON 对象；其他输入返回 null。 */
function safeObject(raw) {
  try {
    const v = JSON.parse(raw || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    return v;
  } catch {
    return null;
  }
}

function readMode() {
  try {
    const j = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8'));
    const on = Boolean(j.enabled) && (!j.untilMs || Date.now() < j.untilMs);
    return { enabled: on, untilMs: j.untilMs || 0 };
  } catch {
    return { enabled: false, untilMs: 0 };
  }
}

function writeMode(enabled, minutes) {
  const now = Date.now();
  const rec = { enabled: Boolean(enabled), since: now, untilMs: enabled ? now + (Number(minutes) || 180) * 60000 : 0 };
  try { fs.writeFileSync(MODE_FILE, JSON.stringify(rec, null, 2) + '\n', 'utf8'); } catch (e) { log('写模式失败', e.message); }
  return rec;
}

/** 把一张拼图变成会话里的一条消息 —— 换成你自己的实现即可。 */
async function forward({ text, image }) {
  const res = await fetch(INJECT_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(40000),
    headers: Object.assign(
      { 'content-type': 'application/json' },
      INJECT_TOKEN ? { 'x-console-token': INJECT_TOKEN } : {}
    ),
    body: JSON.stringify({ key: INJECT_KEY, text, image })
  });
  const body = await res.text();
  return { status: res.status, body };
}

function buildText(note) {
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  return [
    '【当前时间】' + now,
    PROMPT_TOKEN ? '【会话令牌】' + PROMPT_TOKEN : '',
    '【唤醒原因】他打游戏时随手给你看了一眼屏幕',
    '',
    '他：[图片]' + (note ? ' ' + note : ' 喏'),
    '',
    '（别复述图里有什么，别念数字、格数、时间戳。当自己坐在旁边看，随口一句就行。）'
  ].filter(Boolean).join('\n');
}

let lastInjectAt = 0;

const server = http.createServer((req, res) => {
  const json = (code, obj) => {
    try {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    } catch {}
  };

  let url;
  try {
    url = new URL(req.url || '/', 'http://127.0.0.1');
  } catch {
    json(400, { ok: false, error: 'bad url' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/screen/ping') {
    json(200, { ok: true, service: 'dsh-spectate-receiver', minGapMs: MIN_GAP_MS });
    return;
  }

  if (url.pathname === '/game-mode') {
    if (req.method === 'GET') {
      json(200, Object.assign({ ok: true }, readMode()));
      return;
    }
    if (req.method === 'POST') {
      if (!authed(req)) { json(401, { ok: false, error: 'bad token' }); return; }
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
      req.on('end', () => {
        const body = safeObject(raw);
        if (body === null) { json(400, { ok: false, error: 'invalid json' }); return; }
        const m = writeMode(body.enabled !== false, body.minutes);
        log('游戏模式', m.enabled ? '开启' : '关闭');
        json(200, Object.assign({ ok: true }, m));
      });
      return;
    }
    json(405, { ok: false, error: 'method not allowed' });
    return;
  }

  if (req.method !== 'POST' || url.pathname !== '/screen') {
    json(404, { ok: false, error: 'not found' });
    return;
  }
  if (!authed(req)) { json(401, { ok: false, error: 'bad token' }); return; }

  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > MAX_BYTES) req.destroy(); });
  req.on('end', async () => {
    try {
      const body = safeObject(raw);
      if (body === null) { json(400, { ok: false, error: 'invalid json' }); return; }

      if (!readMode().enabled) { json(409, { ok: false, error: 'game-mode-off' }); return; }

      const now = Date.now();
      if (now - lastInjectAt < MIN_GAP_MS) {
        json(429, { ok: false, error: 'too-frequent', retryAfterMs: MIN_GAP_MS - (now - lastInjectAt) });
        return;
      }

      const img = (body.image && typeof body.image === 'object') ? body.image : {};
      const data = String(img.data || '').replace(/^data:image\/\w+;base64,/, '');
      if (!data) { json(400, { ok: false, error: 'image.data is empty' }); return; }
      lastInjectAt = now;

      const r = await forward({
        text: buildText(img.note),
        image: { mediaType: img.mediaType || 'image/jpeg', data, name: img.name || 'game.jpg' }
      });

      // HTTP 2xx 不代表业务成功：下游可能返回 {"ok":false}
      let downstreamOk = r.status >= 200 && r.status < 300;
      try {
        const parsed = JSON.parse(r.body || '{}');
        if (parsed && parsed.ok === false) downstreamOk = false;
      } catch {}

      log('inject mode=' + (body.mode || '?') + ' frames=' + (body.frames || '?') + ' http=' + r.status + ' ' +
        Math.round(Buffer.byteLength(data, 'base64') / 1024) + 'KB' + (downstreamOk ? '' : ' DOWNSTREAM-FAILED'));
      json(downstreamOk ? 200 : 502, { ok: downstreamOk, detail: r.body.slice(0, 500) });
    } catch (e) {
      log('处理失败', (e && e.message) || String(e));
      json(500, { ok: false, error: (e && e.message) || String(e) });
    }
  });
});

server.listen(PORT, BIND, () => log('接收端已启动 http://' + BIND + ':' + PORT + '/screen  转发到 ' + INJECT_URL));
