/**
 * 陪玩台 — Electron 主进程
 *
 * 职责：
 *  1. 按固定节奏抓屏（desktopCapturer 缩略图），压成 JPEG 存进环形缓冲
 *  2. 用低分辨率缩略图算运动分，判断"画面是否在动"
 *  3. 全局热键（默认 F9 连拍 / F10 单张）任何时候都能触发，含全屏独占游戏
 *  4. 触发时取缓冲里「事发前」的若干帧，交给渲染进程拼成 2×2 时序图
 *  5. 把拼图 POST 到主机端的 /screen（7422），由那边注入 AI 会话
 */
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, desktopCapturer, screen, nativeImage, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// ---------- 配置 ----------
const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');
const DEFAULTS = {
  host: '192.168.0.107',
  port: 7422,
  token: '',
  burst: 4,
  gapMs: 600,
  bufferSeconds: 14,
  sampleMs: 500,
  intervalSec: 180,
  maxEdge: 1280,
  quality: 72,
  note: '',
  hotkeyBurst: 'F9',
  hotkeySingle: 'F10',
  autoStart: false,
  ramp: [45, 90, 180, 240],   // 变速启动：前几次间隔短，之后固定 intervalSec
  freshMaxSec: 20,            // 最新帧超过这个年龄就不发（宁可晚，不能早）
  precomposeMs: 2000,         // 预生成拼图的节奏
  pullPort: 7423,             // 反向端口：主机端可以让它"现在截一张"
  pullToken: ''               // 反向端口令牌，留空表示不校验（只绑内网时够用）
};

function loadConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}
function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true });
    fs.writeFileSync(CONFIG_PATH(), JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) { log('保存配置失败: ' + e.message); }
}

let config = null;
let win = null;
let tray = null;

// ---------- 日志 ----------
const logs = [];
function log(msg) {
  const line = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${msg}`;
  logs.push(line);
  if (logs.length > 400) logs.shift();
  console.log(line);
  try { win?.webContents.send('log', line); } catch {}
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'deck.log'), line + '\n'); } catch {}
}

// ---------- 环形缓冲 ----------
/** 每项：{ at, jpeg(Buffer), width, height, motion } */
const ring = [];
const state = {
  capturing: false,
  auto: false,
  autoTimer: null,
  lastSend: null,
  lastError: null,
  motion: 0,
  frames: 0,
  gameMode: null,
  sheet: null,       // { at, dataUrl, count }
  rampIndex: 0       // 自动观察已经走到第几档
};

function pushFrame(item) {
  const keep = Math.ceil((config.bufferSeconds * 1000) / config.sampleMs);
  ring.push(item);
  while (ring.length > keep) ring.shift();
}

// ---------- 抓屏 ----------
let grabBusy = false;
async function grabOnce(width) {
  const display = screen.getPrimaryDisplay();
  const size = display.size;
  const scale = Math.min(1, width / size.width);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(size.width * scale), height: Math.round(size.height * scale) }
  });
  if (!sources.length) throw new Error('没有可用的屏幕源');
  return sources[0].thumbnail;
}

/** 运动分：把缩略图缩到 48×27 算平均绝对差（0~255） */
function motionScore(image) {
  const small = image.resize({ width: 48, height: 27, quality: 'good' });
  const buf = small.toBitmap(); // BGRA
  let sum = 0;
  let n = 0;
  for (let i = 0; i < buf.length; i += 4) {
    sum += buf[i] + buf[i + 1] + buf[i + 2];
    n += 3;
  }
  const avg = sum / Math.max(1, n);
  const prev = state.prevLuma;
  state.prevLuma = avg;
  if (prev === undefined) return 0;
  return Math.abs(avg - prev);
}

async function sampleTick() {
  if (grabBusy) return;
  grabBusy = true;
  try {
    const img = await grabOnce(config.maxEdge);
    const m = motionScore(img);
    state.motion = m;
    const jpeg = img.toJPEG(config.quality);
    pushFrame({ at: Date.now(), jpeg, width: img.getSize().width, height: img.getSize().height, motion: m });
    state.frames += 1;
    if (state.frames <= 3) log(`采样 #${state.frames} ${img.getSize().width}x${img.getSize().height} motion=${m.toFixed(1)}`);
    win?.webContents.send('motion', { motion: m, buffered: ring.length });
    precompose();
  } catch (e) {
    state.lastError = e.message;
    if (state.frames < 3 || Math.random() < 0.02) log('采样失败: ' + e.message);
  } finally {
    grabBusy = false;
  }
}

let precomposeBusy = false;
let lastPrecomposeAt = 0;

/** 预热：把「最近 burst 帧」提前拼好，热键按下时 0 延迟。 */
async function precompose(force = false) {
  if (precomposeBusy) return;
  const now = Date.now();
  if (!force && now - lastPrecomposeAt < config.precomposeMs) return;
  if (ring.length < Math.min(2, config.burst)) return;
  precomposeBusy = true;
  lastPrecomposeAt = now;
  try {
    const frames = ring.slice(-Math.max(1, Math.min(9, config.burst)));
    const dataUrl = await composeFrames(frames);
    if (dataUrl) {
      state.sheet = { at: Date.now(), dataUrl, count: frames.length };
      win?.webContents.send('sheet', { at: state.sheet.at, count: frames.length, dataUrl });
    }
  } catch (e) {
    log('预生成拼图失败: ' + e.message);
  } finally {
    precomposeBusy = false;
  }
}

function startSampling() {
  if (state.capturing) return;
  state.capturing = true;
  sampleTick();
  state.sampleTimer = setInterval(sampleTick, config.sampleMs);
  log(`开始采样（${config.sampleMs}ms/帧，缓冲 ${config.bufferSeconds}s）`);
}
function stopSampling() {
  state.capturing = false;
  clearInterval(state.sampleTimer);
  state.sampleTimer = null;
  log('停止采样');
}

// ---------- 拼图（交给渲染进程用 canvas 做）----------
async function composeFrames(frames) {
  const payload = frames.map((f) => ({
    at: f.at,
    dataUrl: 'data:image/jpeg;base64,' + f.jpeg.toString('base64')
  }));
  if (!win) return null;
  const json = JSON.stringify(payload);
  const dataUrl = await win.webContents.executeJavaScript(`window.composeFrames(${json})`, true);
  return dataUrl; // 'data:image/jpeg;base64,...'
}

// ---------- 发送 ----------
async function sendFrames(mode = 'manual') {
  if (!config.token) { state.lastError = '还没填令牌'; pushState(); return { ok: false, error: 'no token' }; }
  if (ring.length < 2) { state.lastError = '缓冲还没攒够'; pushState(); return { ok: false, error: 'buffer empty' }; }

  const take = Math.max(1, Math.min(9, config.burst));

  // 帧年龄闸：宁可晚，不能早
  const newest = ring[ring.length - 1];
  const ageSec = (Date.now() - newest.at) / 1000;
  if (ageSec > (config.freshMaxSec || 20)) {
    state.lastError = `画面过期 ${ageSec.toFixed(0)}s，跳过`;
    log(state.lastError);
    pushState();
    return { ok: false, error: 'stale-frames', ageSec };
  }

  let dataUrl = null;
  let frames = take;
  let hitCache = false;
  const sheetFresh = state.sheet && Date.now() - state.sheet.at < (config.precomposeMs + 2500);
  if (sheetFresh && state.sheet.count === take) {
    dataUrl = state.sheet.dataUrl;      // 命中预生成，0 延迟
    hitCache = true;
  } else {
    const picked = ring.slice(-take);
    frames = picked.length;
    try {
      dataUrl = await composeFrames(picked);
    } catch (e) {
      state.lastError = '拼图失败: ' + e.message; pushState(); return { ok: false, error: state.lastError };
    }
  }
  if (!dataUrl) return { ok: false, error: '窗口不可用' };

  const base64 = dataUrl.split(',')[1];
  const url = `http://${config.host}:${config.port}/screen`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
      body: JSON.stringify({
        image: { mediaType: 'image/jpeg', data: base64, name: 'game.jpg', note: config.note || '' },
        frames: frames.length,
        mode
      })
    });
    const text = await res.text();
    let body = {};
    try { body = JSON.parse(text); } catch {}
    const latency = Date.now() - started;
    const ok = res.ok && body.ok;
    state.lastSend = {
      at: Date.now(), ok, status: res.status, latency, cached: hitCache,
      kb: Math.round(Buffer.byteLength(base64, 'base64') / 1024),
      frames,
      error: ok ? null : (body.error || text.slice(0, 120))
    };
    state.lastError = ok ? null : state.lastSend.error;
    log(ok ? `已发送 ${frames} 帧 / ${state.lastSend.kb}KB / ${latency}ms${state.lastSend.cached ? '（命中预生成）' : '（实时拼图）'}` : `被拒：${state.lastSend.error}`);
    pushState();
    return { ok, ...state.lastSend };
  } catch (e) {
    state.lastError = e.message;
    state.lastSend = { at: Date.now(), ok: false, error: e.message };
    log('发送失败：' + e.message);
    pushState();
    return { ok: false, error: e.message };
  }
}

// ---------- 自动观察 ----------
function nextAutoDelay() {
  const ramp = Array.isArray(config.ramp) ? config.ramp : [];
  if (state.rampIndex < ramp.length) {
    const d = Math.max(15, Number(ramp[state.rampIndex]) || 60);
    state.rampIndex += 1;
    return d;
  }
  return Math.max(30, config.intervalSec);
}

function startAuto() {
  if (state.auto) return;
  state.auto = true;
  state.rampIndex = 0;
  const loop = async () => {
    if (!state.auto) return;
    const delay = nextAutoDelay();
    state.nextAutoAt = Date.now() + delay * 1000;
    win?.webContents.send('auto-tick', { delay, rampIndex: state.rampIndex });
    log(`下一次自动观察：${delay} 秒后`);
    await sendFrames('auto').catch(() => {});
    if (!state.auto) return;
    state.autoTimer = setTimeout(loop, delay * 1000);
  };
  state.autoTimer = setTimeout(loop, 0);
  log('自动观察已开（变速启动：' + (config.ramp || []).join('/') + ' 秒，之后 ' + config.intervalSec + ' 秒）');
  pushState();
}
function stopAuto() {
  state.auto = false;
  clearTimeout(state.autoTimer);
  clearInterval(state.autoTimer);
  state.autoTimer = null;
  state.rampIndex = 0;
  log('自动观察已关');
  pushState();
}

// ---------- 游戏模式（主机端开关）----------
async function gameMode(action) {
  const base = `http://${config.host}:${config.port}/game-mode`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${config.token}` };
  try {
    if (action === 'get') {
      const r = await fetch(base);
      state.gameMode = await r.json();
    } else {
      const r = await fetch(base, {
        method: 'POST',
        headers,
        body: JSON.stringify({ enabled: action === 'on', minutes: config.intervalSec > 0 ? 180 : 180 })
      });
      state.gameMode = await r.json();
      log(action === 'on' ? '游戏模式已开启' : '游戏模式已关闭');
    }
  } catch (e) {
    state.gameMode = { enabled: false, error: e.message };
  }
  pushState();
  return state.gameMode;
}

function pushState() {
  try {
    win?.webContents.send('state', {
      config, state: {
        capturing: state.capturing, auto: state.auto, frames: state.frames,
        motion: state.motion, buffered: ring.length,
        lastSend: state.lastSend, lastError: state.lastError, gameMode: state.gameMode,
        sheetAgeSec: state.sheet ? (Date.now() - state.sheet.at) / 1000 : null,
        newestAgeSec: ring.length ? (Date.now() - ring[ring.length - 1].at) / 1000 : null,
        nextAutoAt: state.nextAutoAt || null
      }
    });
    updateTray();
  } catch {}
}

// ---------- 热键 ----------
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const bind = (accel, fn, label) => {
    try {
      const ok = globalShortcut.register(accel, fn);
      log(`${label} ${accel} ${ok ? '已注册' : '注册失败（可能被占用）'}`);
    } catch (e) { log(`${label} ${accel} 注册异常: ${e.message}`); }
  };
  bind(config.hotkeyBurst, () => sendFrames('hotkey-burst'), '连拍');
  bind(config.hotkeySingle, () => sendFrames('hotkey-single'), '单张');
}

// ---------- 托盘 ----------
function updateTray() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: state.auto ? '停止自动观察' : '开始自动观察', click: () => (state.auto ? stopAuto() : startAuto()) },
    { label: `看一眼（${config.hotkeySingle}）`, click: () => sendFrames('tray') },
    { label: `连拍 ${config.burst} 帧（${config.hotkeyBurst}）`, click: () => sendFrames('tray-burst') },
    { type: 'separator' },
    { label: '游戏模式：开', click: () => gameMode('on') },
    { label: '游戏模式：关', click: () => gameMode('off') },
    { type: 'separator' },
    { label: '显示窗口', click: () => { win?.show(); win?.focus(); } },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`陪玩台 · ${state.auto ? '观察中' : '待机'}`);
}

// ---------- 窗口 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 480,
    minHeight: 620,
    backgroundColor: '#12141a',
    title: '陪玩台',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); }
  });
  win.on('show', pushState);
}

// ---------- IPC ----------
ipcMain.handle('get-bootstrap', () => ({
  config,
  sheet: state.sheet,
  state: {
    capturing: state.capturing, auto: state.auto, frames: state.frames,
    motion: state.motion, buffered: ring.length,
    lastSend: state.lastSend, lastError: state.lastError, gameMode: state.gameMode
  },
  logs: logs.slice(-100),
  userData: app.getPath('userData')
}));

ipcMain.handle('save-config', (_e, patch) => {
  config = { ...config, ...patch };
  saveConfig(config);
  registerHotkeys();
  startPullServer();
  if (state.auto) { stopAuto(); startAuto(); }
  pushState();
  return config;
});

ipcMain.handle('toggle-auto', () => { state.auto ? stopAuto() : startAuto(); return state.auto; });
ipcMain.handle('shoot', async (_e, mode) => sendFrames(mode || 'manual'));
ipcMain.handle('game-mode', (_e, action) => gameMode(action));
ipcMain.handle('open-userdata', () => shell.openPath(app.getPath('userData')));

// ---------- 反向拉取：主机端可以让它立刻截一张 ----------
let pullServer = null;
function startPullServer() {
  try { pullServer?.close(); } catch {}
  const http = require('node:http');
  pullServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (config.pullToken) {
      const auth = String(req.headers.authorization || '');
      if (auth !== `Bearer ${config.pullToken}`) { json(401, { ok: false, error: 'bad token' }); return; }
    }
    if (req.method === 'GET' && url.pathname === '/latest') {
      if (!state.sheet) { json(404, { ok: false, error: '还没有拼图' }); return; }
      const ageSec = (Date.now() - state.sheet.at) / 1000;
      json(200, { ok: true, at: state.sheet.at, ageSec, count: state.sheet.count, image: state.sheet.dataUrl });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/trigger') {
      log('收到拉取请求，立刻截一张');
      const r = await sendFrames('pull').catch((e) => ({ ok: false, error: e.message }));
      json(r?.ok ? 200 : 502, r || { ok: false });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/ping') { json(200, { ok: true, service: 'dsh-spectate', buffered: ring.length }); return; }
    json(404, { ok: false, error: 'not found' });
  });
  pullServer.listen(config.pullPort, '0.0.0.0', () => log(`拉取服务已启动 :${config.pullPort}`));
  pullServer.on('error', (e) => log('拉取服务启动失败: ' + e.message));
}

// ---------- 生命周期 ----------
app.whenReady().then(async () => {
  config = loadConfig();
  createWindow();

  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.on('click', () => { win?.isVisible() ? win.hide() : win?.show(); });
  updateTray();

  startSampling();
  registerHotkeys();
  startPullServer();
  gameMode('get').catch(() => {});
  if (config.autoStart) startAuto();
  log('陪玩台已启动');
});

app.on('window-all-closed', (e) => { e.preventDefault?.(); });
app.on('before-quit', () => { app.isQuitting = true; globalShortcut.unregisterAll(); });
