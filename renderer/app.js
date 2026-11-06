/* 陪玩台 · 渲染进程 */

const $ = (id) => document.getElementById(id);
const api = window.deck;

let cfg = null;

// ---------- 拼图：主进程会直接调用这个函数 ----------
window.composeFrames = async function composeFrames(frames) {
  if (!frames || !frames.length) return null;
  const cols = frames.length >= 3 ? 2 : frames.length;
  const rows = Math.ceil(frames.length / cols);

  const imgs = await Promise.all(frames.map((f) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = f.dataUrl;
  })));

  const cellW = imgs[0].naturalWidth;
  const cellH = imgs[0].naturalHeight;
  const labelH = Math.round(cellH * 0.055);

  const canvas = document.createElement('canvas');
  canvas.width = cellW * cols;
  canvas.height = (cellH + labelH) * rows;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  imgs.forEach((img, i) => {
    const cx = (i % cols) * cellW;
    const cy = Math.floor(i / cols) * (cellH + labelH);
    ctx.drawImage(img, cx, cy, cellW, cellH);
    // 时间戳条
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(cx, cy + cellH, cellW, labelH);
    const t = frames[i].at ? new Date(frames[i].at) : null;
    const text = `${i + 1}/${frames.length}` + (t ? '  ' + t.toLocaleTimeString('zh-CN', { hour12: false }) : '');
    ctx.fillStyle = '#ffd34d';
    ctx.font = `${Math.round(labelH * 0.62)}px Consolas, monospace`;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cx + labelH * 0.3, cy + cellH + labelH / 2);
    // 格子边线
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.strokeRect(cx + 0.5, cy + 0.5, cellW - 1, cellH - 1);
  });

  // 拼图后统一缩到 1280 长边：token 直接降到约 1/4，可读性几乎无损
  const MAX_COMPOSITE_EDGE = 1280;
  const longest = Math.max(canvas.width, canvas.height);
  if (longest > MAX_COMPOSITE_EDGE) {
    const k = MAX_COMPOSITE_EDGE / longest;
    const small = document.createElement('canvas');
    small.width = Math.round(canvas.width * k);
    small.height = Math.round(canvas.height * k);
    const sctx = small.getContext('2d');
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(canvas, 0, 0, small.width, small.height);
    return small.toDataURL('image/jpeg', 0.82);
  }

  return canvas.toDataURL('image/jpeg', 0.82);
};

// ---------- 预览 ----------
async function renderPreview(dataUrl, info) {
  const canvas = $('preview');
  if (!dataUrl) return;
  const img = new Image();
  img.onload = () => {
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
    canvas.classList.add('show');
    $('preview-empty').style.display = 'none';
  };
  img.src = dataUrl;
  if (info) $('send-info').textContent = info;
}

// ---------- 状态渲染 ----------
function renderState(payload) {
  const s = payload.state;
  const c = payload.config;
  cfg = c;

  const dot = $('conn-dot');
  const h = s.health;
  if (h && h.ok) {
    const gmOn = h.gameMode?.enabled;
    dot.className = gmOn ? 'dot on' : 'dot warn';
    const tail = gmOn ? '游戏模式开' : '游戏模式关';
    $('conn-text').textContent = `已连接 ${c.host}:${c.port} · ${h.latency}ms · ${tail}`;
  } else if (h && !h.ok) {
    dot.className = 'dot bad';
    $('conn-text').textContent = `连不上 ${c.host}:${c.port}（${h.error || '超时'}）`;
  } else {
    dot.className = 'dot';
    $('conn-text').textContent = `检测中… ${c.host}:${c.port}`;
  }

  const gm = s.gameMode;
  if (gm && gm.enabled) {
    const left = Math.max(0, Math.round((gm.untilMs - Date.now()) / 60000));
    $('gm-value').textContent = `开启 · 剩 ${left} 分`;
  } else {
    $('gm-value').textContent = gm?.error ? '未知' : '关闭';
  }

  $('buf-value').textContent = String(s.buffered ?? 0);
  $('motion-value').textContent = (s.motion ?? 0).toFixed(1);
  $('motion-bar').style.width = Math.min(100, (s.motion ?? 0) * 4) + '%';

  const autoBtn = $('btn-auto');
  autoBtn.textContent = s.auto ? '停止观察' : '开始观察';
  autoBtn.classList.toggle('running', !!s.auto);

  if (s.lastSend) {
    const t = new Date(s.lastSend.at).toLocaleTimeString('zh-CN', { hour12: false });
    const okText = s.lastSend.ok
      ? `${t} · ${s.lastSend.frames} 帧 · ${s.lastSend.kb}KB · ${s.lastSend.latency}ms`
      : `${t} · 失败：${s.lastSend.error || s.lastSend.status}`;
    $('send-info').textContent = okText;
  }

  $('hk-single').textContent = c.hotkeySingle;
  $('hk-burst').textContent = c.hotkeyBurst;
}

function fillSettings(c) {
  $('cfg-host').value = c.host;
  $('cfg-port').value = c.port;
  $('cfg-token').value = c.token;
  $('cfg-burst').value = c.burst;
  $('cfg-gap').value = c.gapMs;
  $('cfg-interval').value = c.intervalSec;
  $('cfg-buffer').value = c.bufferSeconds;
  $('cfg-sample').value = c.sampleMs;
  $('cfg-quality').value = c.quality;
  $('cfg-hk-burst').value = c.hotkeyBurst;
  $('cfg-hk-single').value = c.hotkeySingle;
  $('cfg-motion').checked = !!c.motionTrigger;
  $('cfg-motion-th').value = c.motionThreshold;
  $('cfg-motion-sustain').value = c.motionSustain;
  $('cfg-motion-cool').value = c.motionCooldownSec;
  $('cfg-note').value = c.note;
}

// ---------- 事件 ----------
$('btn-auto').addEventListener('click', () => api.toggleAuto());

$('btn-single').addEventListener('click', async () => {
  const r = await api.shoot('ui-single');
  await afterShoot(r);
});

$('btn-burst').addEventListener('click', async () => {
  const r = await api.shoot('ui-burst');
  await afterShoot(r);
});

async function afterShoot(res) {
  if (!res?.ok) return;
  // 主进程不快照返回图，这里重取一次拼图用于预览
  const boot = await api.bootstrap();
  renderState(boot);
}

$('btn-save').addEventListener('click', async () => {
  const patch = {
    host: $('cfg-host').value.trim() || '192.168.0.107',
    port: Number($('cfg-port').value) || 7422,
    token: $('cfg-token').value.trim(),
    burst: Math.max(1, Math.min(9, Number($('cfg-burst').value) || 4)),
    gapMs: Math.max(100, Number($('cfg-gap').value) || 600),
    intervalSec: Math.max(30, Number($('cfg-interval').value) || 180),
    bufferSeconds: Math.max(2, Number($('cfg-buffer').value) || 14),
    sampleMs: Math.max(100, Number($('cfg-sample').value) || 500),
    quality: Math.max(30, Math.min(95, Number($('cfg-quality').value) || 72)),
    hotkeyBurst: $('cfg-hk-burst').value.trim() || 'F9',
    hotkeySingle: $('cfg-hk-single').value.trim() || 'F10',
    motionTrigger: $('cfg-motion').checked,
    motionThreshold: Math.max(5, Math.min(120, Number($('cfg-motion-th').value) || 25)),
    motionSustain: Math.max(1, Math.min(9, Number($('cfg-motion-sustain').value) || 3)),
    motionCooldownSec: Math.max(15, Number($('cfg-motion-cool').value) || 60),
    note: $('cfg-note').value.trim()
  };
  const saved = await api.saveConfig(patch);
  fillSettings(saved);
  const btn = $('btn-save');
  const old = btn.textContent;
  btn.textContent = '✓ 已保存';
  setTimeout(() => { btn.textContent = old; }, 1600);
});

$('btn-gm-on').addEventListener('click', () => api.gameMode('on'));
$('btn-gm-off').addEventListener('click', () => api.gameMode('off'));
$('btn-open').addEventListener('click', () => api.openUserData());

api.onState((payload) => {
  renderState(payload);
  if (payload.config && !$('cfg-host').value) fillSettings(payload.config);
});

api.onMotion(({ motion }) => {
  $('motion-value').textContent = motion.toFixed(1);
  $('motion-bar').style.width = Math.min(100, motion * 4) + '%';
  api.bootstrap().then((b) => { $('buf-value').textContent = String(b.state.buffered ?? 0); }).catch(() => {});
});

api.onSheet((sheet) => {
  if (sheet?.dataUrl) renderPreview(sheet.dataUrl, `预生成 ${sheet.count} 帧 · ${new Date(sheet.at).toLocaleTimeString('zh-CN', { hour12: false })}`);
});

api.onLog((line) => {
  const el = $('log');
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
});

// ---------- 启动 ----------
(async function init() {
  const boot = await api.bootstrap();
  fillSettings(boot.config);
  renderState(boot);
  $('log').textContent = (boot.logs || []).join('\n');
  $('log').scrollTop = $('log').scrollHeight;
})();
