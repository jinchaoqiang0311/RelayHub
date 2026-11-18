<div align="center">

<img src="assets/logo-full.svg" alt="RelayHub" width="720">

**多中转站 · 一键下发 Key**

把散落各处的 AI 中转站账号与 Key 收进一个本地应用，一次点击写入 Claude Code / Codex / Gemini CLI 等命令行工具。

[![License: MIT](https://img.shields.io/badge/License-MIT-22C55E.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-3B82F6.svg)](#安装)
[![Electron](https://img.shields.io/badge/Electron-37-9FEAF9.svg)](https://www.electronjs.org/)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933.svg)](package.json)

</div>

---

## 这是什么

如果你同时用好几个 AI 中转站（new-api / one-api / Sub2API 及其分支），一定会遇到这些麻烦：

- 每个站的账号、余额、Key 散落在不同网页里
- 想给 Claude Code 换个站，得手动翻配置文件、改环境变量、删 auth.json……
- 哪个站便宜、哪个站这个模型有渠道、有没有偷偷被塞系统提示——全靠猜

**RelayHub 把这些做成一个本地桌面应用**：

| | |
|---|---|
| 🔑 **多站账号管理** | 添加中转站 → 登录 → 自动拉取余额与全部 Key |
| ⚡ **一键下发** | 选站点 → 选 Key → 选 Agent → 写入配置，全程备份可撤销 |
| 💰 **比价** | 本地价格库 + 四级级联筛选（站点→公司→模型→分组），一眼找到最便宜 |
| 🔬 **模型验真** | 真实调用 / 列表校验 / 身份探测 / 注入检测，四种模式辨真假 |
| 🖥 **系统托盘** | 常驻后台，托盘菜单一键切换站点 |

纯本地运行：**账号密码与 Key 只存在你电脑里**（Electron safeStorage / DPAPI 加密），不上传任何服务器。

## 支持的站点协议

| 协议 | 能力 | 识别方式 |
|---|---|---|
| **new-api / one-api 系** | 登录、余额、Key 列表、新建 Key、今日消费、模型定价 | `/api/status` 指纹 |
| **Sub2API**（Wei-Shaw/sub2api） | JWT 登录、余额、Key 管理、分组倍率 | `/api/v1/settings/public` 指纹 |
| **Anthropic 直连** | 官方 / 透传站，`x-api-key` 测活 | 手动选择 |
| **通用（贴 Key）** | 任意能给出 Base URL + sk- 的服务 | 兜底模式 |

同族分支自动收敛：One-Hub（`data.items` 列表形态）、VoAPI（JWT Bearer）、Veloera 等无需特殊配置。

## 支持的 Agent

| Agent | 配置文件 | 状态 |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | ✅ 稳定 |
| Codex CLI / 桌面版 | `~/.codex/config.toml` | ✅ 稳定（保留 auth.json、强制 responses、兼容 0.169+） |
| Gemini CLI | `~/.gemini/.env` | ✅ 稳定 |
| Grok Build | `~/.grok/config.toml` | 🧪 实验 |
| OpenClaw | `~/.openclaw/openclaw.json` | 🧪 实验 |
| Hermes | `%LOCALAPPDATA%\hermes\config.yaml` | 🧪 实验 |

每次写入：**先备份 → sha256 指纹校验防并发覆盖 → 原子写 → 事务日志 → 一键撤销**。只动与路由相关的键，你的 `mcp_servers` 等原有配置原样保留。

## 核心功能一览

### 📊 数据看板（首页）
站点健康度 / 总余额 / **今日消费**（`/api/log/self/stat`）/ Key 总量 / Agent 部署矩阵，价格与余额条形图。

### 🏦 中转站管理
- **协议自动探测**：添加站点时自动识别 new-api / Sub2API / 通用，选错也不用改
- **Turnstile 人机验证**：站点要求验证码时自动弹出站点登录页，你手动登录，RelayHub 抓取会话回填（含新版 new-api 的 Bearer + refresh 轮换）
- **打码 Key 自动补拉**：新版 new-api 列表只给 `sk-Ab12****Yz90`，自动调 `POST /api/token/:id/key` 取回完整 Key（429 限流退避 + 缓存）
- **会话失效提醒**：卡片上直接出现「重新登录」按钮，不用翻配置找入口
- **站点级充值比例**：每个站单独设置（元/$），到手价各算各的，也可跟随全局

### 💵 模型定价（表达式级精确）
解析 new-api 的 `billing_expr` 计费表达式（`p*2 + c*10` = 输入 $2/M、输出 $10/M），含缓存读写价、`len<=272k` 长上下文多档、`fixed(N)` 按次——**不用 `model_ratio` 估算**（实测差 37.5 倍）。Sub2API 站用官方价格表（LiteLLM 口径）× 分组倍率估算。

### 🔬 模型验真（四种模式）
| 模式 | 消耗 | 回答的问题 |
|---|---|---|
| 真实调用 | ~20–80 tokens | 这个模型有没有真实渠道 |
| 列表校验 | 免费 | 模型在不在 `/v1/models` |
| 身份探测 | ~200–600 tokens | 模型自报身份，判套壳（中英文交叉问诊，中文展示） |
| 注入检测 | ~200–600 tokens | 上游有没有偷偷塞系统提示（`prompt_tokens` 探针 + 泄漏问询 + 指令干扰） |

### ⚖️ 比价
本地价格库覆盖式更新（实测 9 站 891 条 / 241 模型），**站点 → 公司 → 模型 → 分组** 四级级联筛选、按输入/输出/合计比价、最低价标记与溢价百分比。

### 🔄 自动同步
启动 / 每 30 分钟 / 窗口聚焦时拉取变更；Key 轮换只重写引用它的入口，供应商永不自动切换。

## 安装

### 从 Release 下载（推荐）

<div align="center">

**[⬇️ 前往 Releases 下载安装包](https://github.com/jinchaoqiang0311/RelayHub/releases/latest)**

</div>

| 平台 | 文件 |
|---|---|
| Windows | `RelayHub.Setup.<版本>.exe`（NSIS 安装包，含品牌图标） |
| Linux | `RelayHub-<版本>.AppImage` / `relayhub_<版本>_amd64.deb` |

每次打 `v*` 标签，CI 自动跑全量测试并构建上传。

### 从源码运行

```bash
git clone https://github.com/jinchaoqiang0311/RelayHub.git
cd RelayHub
pnpm install
pnpm start
```

> 需要 Node.js ≥ 20 与 pnpm。Windows 下若 pnpm 被 ExecutionPolicy 拦截，用 `cmd /c pnpm install`。

### 打包安装包（本地）

```bash
pnpm dist        # Windows 出 NSIS exe；Linux 出 AppImage/deb（按当前平台）
```

### 日常启动（开发环境）

双击桌面快捷方式（安装时创建），或运行 `scripts\start-relayhub.cmd`——**脱离终端独立运行**，关掉终端应用也不退。

## CLI

```bash
node bin/relayhub.js agents                        # 探测已安装 Agent（含 CLI 启动器健康检查）
node bin/relayhub.js station add <url> --user me --pass secret
node bin/relayhub.js stations                      # 站点与 Key 列表
node bin/relayhub.js deploy codex --station <id> --key <kid> --model gpt-5.1
node bin/relayhub.js pricing <站点ID> --search claude   # 模型定价
node bin/relayhub.js models <站点ID> <KeyID>            # 该 Key 可用模型
node bin/relayhub.js probe <站点ID> <KeyID> gpt-5 --mode identity   # 模型验真
node bin/relayhub.js probe <站点ID> <KeyID> gpt-5 --mode inject     # 注入检测
node bin/relayhub.js undo                          # 撤销上一笔配置写入
```

## 项目结构

```
src/
├── main/
│   ├── main.cjs            # Electron 主进程（窗口/托盘/IPC/代登窗口）
│   ├── agents/             # 6 个 Agent 适配器（claude/codex/gemini/grok/openclaw/hermes）
│   ├── relays/             # 站点协议客户端（newapi/sub2api/anthropic/generic + 分支 flavor）
│   └── services/           # 部署编排/加密存储/自动同步/价格库/看板/进程探测
├── preload.cjs             # contextBridge 白名单桥接
└── renderer/               # 无构建前端（原生 JS + CSS 令牌）
bin/relayhub.js             # CLI
test/                       # 冒烟 8 项 + 拟真站点 22 项 + 看板/价格库/UI 检查
```

## 安全设计

- Key 与密码经 **Electron safeStorage（Windows DPAPI）** 加密落盘；CLI 模式降级为混淆并明确标注
- 站点会话（cookie/JWT）同样加密存储，退出登录即清除
- 无遥测、无上报、无内置统计——一切数据都在本地
- 配置写入前自动备份（时间戳 .bak），sha256 指纹校验防并发覆盖

## 已知限制

- 部分站点开启 Turnstile/验证码，程序化登录被拒——走浏览器代登（弹窗手动登录后自动抓会话）
- Sub2API 站不发布单模型价格，比价页按官方价格表 × 分组倍率估算并标注
- Grok / OpenClaw / Hermes 适配器为实验级（配置结构资料少，欢迎 issue 反馈）
- 站点级“今日消费”依赖站点时区，午夜前后可能有小时级误差

## 致谢

- [QuantumNous/new-api](https://github.com/QuantumNous/new-api) — 覆盖最广的中转站协议（本项目逆向并兼容其 auth/pricing/token 接口）
- [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api) — 订阅号池型中转站协议参考
- [my-api-box](https://github.com/) — `parseNewApiBillingExpression` 计费表达式解析的实现参考
- [litellm](https://github.com/BerriAI/litellm) — 官方模型价格表数据源

## License

[MIT](LICENSE) © 2026
