# Contributing to RelayHub

感谢关注 RelayHub！欢迎任何形式的贡献：bug 报告、功能建议、文档改进、代码 PR。

## 开发环境

```bash
git clone https://github.com/jinchaoqiang0311/RelayHub.git
cd RelayHub
pnpm install
pnpm start          # 开发运行
pnpm check          # 语法守卫（必过）
```

测试（提交前建议全跑）：

```bash
node test/smoke.mjs         # 冒烟 8 项
node test/station-sync.mjs  # 拟真站点 22 项
node test/dashboard.mjs     # 看板聚合
node test/pricebook.mjs     # 价格库
node test/ui-check.mjs      # UI 令牌/对比度/无障碍
```

## 代码约定

- **主进程/服务层**：ESM（`import/export`），Node ≥ 20
- **Electron 入口**：CJS（`main.cjs`，规避本地 electron 包遮蔽内置模块的问题）
- **渲染层**：无框架原生 JS + CSS 设计令牌（三层：primitive → semantic → component）
- **设计令牌**：组件只用 semantic 层（`--surface`/`--border`/`--accent`…），禁止直接引用 primitive
- **新增 Agent 适配器**：实现 `resolveDir / readLive / buildOps / stripOps / detectActive` 五个方法，注册到 `agents/index.js`
- **新增站点协议**：实现客户端工厂（login/self/listTokens/verifyKey/todayUsage/fetchPricing），加协议指纹到 `probeProtocol`

## 提交 PR 前

1. `pnpm check` 与全部测试通过
2. 新功能请附带测试（参考 `test/station-sync.mjs` 的拟真站点模式：本地 HTTP 服务器模拟站点协议）
3. 涉及配置写入的改动必须保持：先备份 → 指纹校验 → 原子写 → 事务日志
4. UI 改动跑 `node test/ui-check.mjs`（对比度/无障碍不回退）
5. 不要提交 `node_modules/`、`dist/`、`test/tmp-*`、含真实 Key 的任何文件

## 报告 Bug

请附上：RelayHub 版本（设置→关于）、操作系统、站点协议（卡片上的徽标）、
**脱敏后的**错误信息（toast 原文或 `%APPDATA%/RelayHub/crash.log` 尾部）。
不要贴完整 API Key / 密码 / cookie。
