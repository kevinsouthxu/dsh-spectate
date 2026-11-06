# 陪玩台 · dsh-spectate

给 AI 陪玩做的**可视化观察台**：在你玩游戏的那台电脑上跑，按节奏抓屏，用全局热键把「刚刚发生的那几秒」拼成一张时序图，POST 到主机端的观察接口，让 AI 看到画面并在 QQ / 聊天窗口里说一句。

面向 [DSH](https://github.com/deepseek-ai) + QQ 桥接那类「有独立会话和记忆」的陪伴场景，**不新建人格、不分裂记忆**——它只负责把画面送进去。

## 它解决什么问题

定时截图的通病是"闭着眼睛按快门"：团战那两秒大概率错过。

这个应用的做法是**环形缓冲 + 事发前取帧**：

- 后台每 500ms 抓一帧压成 JPEG，留在内存里的环形缓冲（默认 14 秒）
- 你按 F9 的时候，取的是**按下去之前**的 4 帧，不是之后
- 4 帧拼成 2×2，每格带时间戳，一张图就看得出「在推进 / 在挨打 / 在跑」

拼图不增加 token：单帧 1280×720 是 92 万像素，4 帧拼成 2×2 还是 92 万像素，信息量却翻了四倍。

## 功能

- **全局热键**：默认 `F9` 连拍 4 帧、`F10` 单张。走的是 Electron `globalShortcut`，全屏独占游戏里也能触发
- **自动观察**：按间隔自动发一次连拍（默认 180 秒），可在界面里关
- **运动指示**：缩略图差分算出来的运动分，实时显示在界面上
- **拼图带时间戳**：渲染进程用 canvas 拼，格子间有边线，一眼分清先后
- **托盘常驻**：点图标显示/隐藏，右键菜单可直接"看一眼""开游戏模式"
- **两种触发分离**：手动热键不受间隔限制，自动观察走自己的节奏

## 快速开始

```sh
npm install
npm start
```

首次启动后，在「设置」里填两样东西：

| 字段 | 说明 |
|---|---|
| 主机 | 跑 DSH / QQ 桥接那台机器的内网 IP |
| 令牌 | 观察接口的 Bearer token |

填完点「保存并应用」，然后按 `F9` ——界面上会出现你刚才那两秒的 2×2 拼图，同时发到主机端。

## 对接的接口

应用只依赖两个 HTTP 端点，**任何能收图的观察服务都能接**：

```http
POST /game-mode      {"enabled": true, "minutes": 180}
GET  /game-mode      -> {"enabled": true, "untilMs": 1793800000000}

POST /screen
Authorization: Bearer <token>
Content-Type: application/json

{
  "image": { "mediaType": "image/jpeg", "data": "<base64>", "name": "game.jpg", "note": "在打大乱斗" },
  "frames": 4,
  "mode": "hotkey-burst"
}
```

参考实现见 [dshqq](https://github.com/) 的 `src/screen-inject-server.js`（收图 → 缩图 → 带图注入 AI 会话）。

## 配置

配置存在 Electron 的 userData 目录（界面里「设置 → 打开数据目录」可直接打开）：

```
%APPDATA%/dsh-spectate/config.json
```

| 键 | 默认 | 说明 |
|---|---|---|
| `host` / `port` | 192.168.0.107 / 7422 | 观察服务地址 |
| `token` | 空 | Bearer token |
| `burst` | 4 | 每次拼几帧（1–9） |
| `gapMs` | 600 | 帧间隔（仅用于采集冗余帧时） |
| `sampleMs` | 500 | 采样间隔 |
| `bufferSeconds` | 14 | 环形缓冲长度 |
| `intervalSec` | 180 | 自动观察间隔 |
| `quality` | 72 | JPEG 质量 |
| `hotkeyBurst` / `hotkeySingle` | F9 / F10 | 全局热键 |

## 已知限制

- 长时间高分辨率抓屏会吃 CPU，低配机器建议把 `sampleMs` 调到 800–1000
- 独占全屏 + HDR 下 `desktopCapturer` 可能拿到黑屏，改成无边框窗口即可
- 只抓主显示器
- 窗口关了不会退出，走托盘；要真退出用托盘菜单

## 许可

MIT
