# Security Policy / 安全策略

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest  | ✅ |

## 报告漏洞

发现安全漏洞请通过 [GitHub Security Advisories](https://github.com/jinchaoqiang0311/RelayHub/security/advisories/new) 私密报告，**不要开公开 issue**。会在 72 小时内回应。

## 安全设计要点

- **本地优先**：所有凭据（站点密码、API Key、会话 cookie/JWT）仅存本机 `%APPDATA%/RelayHub/`，经 Electron `safeStorage`（Windows DPAPI）加密；无任何远程上报
- **最小权限**：渲染层 `contextIsolation` 开启、`nodeIntegration` 关闭，IPC 走 preload 白名单
- **写入防护**：配置文件写入前 sha256 指纹校验（防并发覆盖）、时间戳备份、事务日志、可撤销
- **站点凭据不出站**：RelayHub 只与用户配置的中转站通信；内置价格表来自 LiteLLM 静态 JSON（只读拉取）

## 已知边界（诚实声明）

- `store.json` 中加密字段依赖 DPAPI，**同 Windows 账户下其他本地进程理论上可解**——这不是云服务，请勿在不受信任的机器上存放高价值 Key
- CLI 模式（无 Electron）降级为固定盐混淆，仅防肩窥
- 浏览器代登窗口加载的是站点真实页面，第三方站点的脚本在该窗口内运行（与普通浏览器一致）
- 定价/测活等请求会携带用户 Key 访问所配置的站点——这是功能本身

## 报告通道

GitHub Security Advisories（优先）或 issue 中标注 `[security]`（仅限非敏感问题）。
