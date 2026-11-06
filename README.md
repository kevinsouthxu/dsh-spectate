# 陪玩台 · dsh-spectate

给 AI 陪玩做的**可视化观察台**：在你玩游戏的那台电脑上跑，按节奏抓屏，用全局热键把「刚刚发生的那几秒」拼成一张时序图，POST 到主机端的观察接口，让 AI 看到画面并在 QQ / 聊天窗口里说一句。

面向 [DSH](https://github.com/deepseek-ai) + QQ 桥接那类「有独立会话和记忆」的陪伴场景，**不新建人格、不分裂记忆**——它只负责把画面送进去。

## 它解决什么问题

定时截图的通病是"闭着眼睛按快门"：团战那两秒大概率错过。

这个应用的做法是**环形缓冲 + 事发前取帧**：

- 后台每 500ms 抓一帧压成 JPEG，留在内存里的环形缓冲（默认 14 秒）
- 你按 F9 的时候，取的是**按下去之前**的 4 帧，不是之后
- 4 帧拼成 2×2，每格带时间戳，一张图就看得出「在推进 / 在挨打 / 在跑」

拼图换的是**时间覆盖**：4 帧拼成 2×2 后整体再缩到 1280 长边，单张约 1,300 token（与一张 1280×720 单帧同量级）。

代价是每格画面变小（约 640×360），游戏里的小字和 UI 细节会不如单帧清楚。**动作趋势更清楚，细节更糊**——这是取舍，不是免费午餐。

## 功能

- **全局热键**：默认 `F9` 连拍 4 帧、`F10` 只发最新 1 帧。走的是 Electron `globalShortcut`，全屏独占游戏里也能触发
- **自动观察**：按间隔自动发一次连拍（默认 180 秒），可在界面里关
- **运动指示**：缩略图差分算出来的运动分，实时显示在界面上
- **拼图带时间戳**：渲染进程用 canvas 拼，格子间有边线，一眼分清先后
- **托盘常驻**：点图标显示/隐藏，右键菜单可直接"看一眼""开游戏模式"
- **两种触发分离**：手动热键不受间隔限制，自动观察走自己的节奏

## 安装

### 系统要求

| 用途 | 要求 |
|---|---|
| Windows 便携客户端 | Windows 10 / 11，x64（64 位）；自带 Electron，无需安装 Node.js |
| 接收端 | Node.js 18+，建议使用仍受维护的 LTS 版本；需自行提供 DSH / QQ 会话注入接口 |
| 源码运行与打包 | Node.js 22.12+、npm、Git |

Windows 范围依据 [Electron 官方支持平台](https://github.com/electron/electron#platform-support)。本项目仅提供 Windows x64 包，不提供 Windows 7 / 8 或 32 位包；未对每个 Windows 版本及游戏组合完成实测。

### 下载与校验

Windows 用户可从 [最新 Release](https://github.com/kevinsouthxu/dsh-spectate/releases/latest) 下载 `dsh-spectate-v0.1.1-win32-x64.zip`，完整解压后运行 `dsh-spectate-win32-x64/dsh-spectate.exe`。首次运行需配置接收端地址与令牌。界面顶部及窗口标题显示版本号，反馈问题时请附上它。

同时下载同一 Release 的 `SHA256SUMS.txt`，在下载目录打开终端执行：

```powershell
certutil -hashfile .\dsh-spectate-v0.1.1-win32-x64.zip SHA256
certutil -hashfile .\dsh-spectate-v0.1.1-receiver.zip SHA256
```

将输出的 SHA-256 与 `SHA256SUMS.txt` 中对应文件名的值比较，应完全一致（大小写不影响）。只下载客户端时只需执行第一条。

这是未签名的便携版。截图客户端需要配合接收端及你自己的 DSH 会话注入接口使用，不能单独完成 AI 陪玩。

从源码运行：

```sh
git clone https://github.com/kevinsouthxu/dsh-spectate
cd dsh-spectate
npm install
npm start
```

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

本仓库自带一个最小接收端：[`receiver/server.mjs`](receiver/server.mjs)。它收图后转发给任意"能往会话里塞内容"的地址，默认是 DSH 桥接的 `/api/inject`，你可以换成自己的实现。

接收端需要 Node.js 18+。在 PowerShell 中启动示例：

```powershell
$env:SCREEN_TOKEN = '替换成你自己的长随机令牌'
$env:INJECT_URL = 'http://127.0.0.1:3100/api/inject'
$env:INJECT_KEY = '替换成你的桥接会话标识'
# 下游桥接需要鉴权时，再设置 INJECT_TOKEN。
node receiver/server.mjs
```

客户端填写相同的 `SCREEN_TOKEN`。`INJECT_URL` 是需要自行提供的桥接接口，接收 JSON `{key, text, image}`；返回非 2xx 或 JSON `ok:false` 会被视为失败。接收端默认关闭游戏模式，连接后在客户端开启。默认客户端地址为本机 `127.0.0.1:7422`，跨机器使用时改成接收端的局域网地址。

## 三种触发方式

| 谁发起 | 怎么走 | 用在什么时候 |
|---|---|---|
| **你** | 按 F9 / F10（全局热键，全屏游戏也生效） | 看到精彩瞬间，想让她点评 |
| **定时** | 变速启动 `ramp: [45, 90, 180, 240]`，之后固定 `intervalSec` | 长时间挂机，保持"她在看"的在场感 |
| **她** | 她回一句「让我看看」之类的请求，主机端转发到 `:7423/trigger`，立刻截一张 | 她主动想确认你在干嘛 |

反向拉取服务（`:7423`，默认绑 `127.0.0.1`）：

```http
GET  /ping       -> {"ok":true,"service":"dsh-spectate","buffered":12}
GET  /latest     -> {"ok":true,"ageSec":1.2,"count":4,"image":"data:image/jpeg;base64,..."}
POST /trigger    -> 立刻抓一组并发出去，返回这次发送结果
```

`pullToken` 留空时会自动生成并保存在本机配置中，调用反向接口须携带该 Bearer token。

## 预生成拼图

后台每 `precomposeMs`（默认 2 秒）把「最近 `burst` 帧」拼好放着。按下热键时直接发这张，不再现场拼——省掉两百多毫秒的 canvas 合成。

## 帧老龄闸

最新一帧超过 `freshMaxSec`（默认 20 秒）就不发，直接返回 `stale-frames`。

理由跟 `dsh-watch-together` 里那条一样：**宁可晚，不能早**。对着二十秒前的画面点评，比不说话更糟。

## 配置

配置存在 Electron 的 userData 目录（界面里「设置 → 打开数据目录」可直接打开）：

```
%APPDATA%/dsh-spectate/config.json
```

| 键 | 默认 | 说明 |
|---|---|---|
| `host` / `port` | 127.0.0.1 / 7422 | 观察服务地址 |
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
- 独占全屏或 HDR 下 `desktopCapturer` 可能拿到黑屏，可先尝试无边框窗口，必要时关闭 HDR
- 只抓主显示器
- 窗口关了不会退出，走托盘；要真退出用托盘菜单
- 反向拉取服务默认只绑 `127.0.0.1`；要让别的机器触发，把配置里的 `pullBind` 改成 `0.0.0.0`（首次启动会自动生成 `pullToken`）
- 预生成拼图超过 1.5 秒就重新拼，保证热键发的是"刚刚"，不是几秒前

## 许可

MIT
