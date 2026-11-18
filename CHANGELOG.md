# Changelog

本文件记录用户可感知的变更。格式参考 Keep a Changelog。

## [0.18.3] - 2026-11-18

### 首个公开版本

- 多站点账号管理：协议自动探测（new-api/one-api 系 / Sub2API / Anthropic 直连 / 通用）
- 登录：账号密码 + Turnstile 浏览器代登（含新版 new-api Bearer/refresh 轮换、15 分钟 token 自动续期）
- 一键下发：6 个 Agent 适配器（claude/codex/gemini/grok/openclaw/hermes），先备份→指纹校验→原子写→事务日志→可撤销
- 打码 Key 自动补拉（429 退避+缓存）
- 站点级充值比例 + 定价抓取（billing_expr 表达式解析：多档/缓存价/按次，LiteLLM 价格表）
- 模型验真四模式：真实调用/列表校验/身份探测/注入检测（token 消耗提示）
- 比价页：本地价格库覆盖式更新 + 站点/公司/模型/分组四级级联筛选 + 最低价标记
- 数据看板：站点健康度/余额/今日消费/Key 总量/Agent 矩阵
- 自动同步：启动/30 分钟/窗口聚焦；Key 轮换只重写受影响入口
- CLI 与 GUI 共用数据
- CI（Windows/Ubuntu × Node 22/24 测试矩阵）+ Release 工作流（打 tag 自动出安装包）
- 品牌资源：logo 多形态 + 多尺寸位图 + 托盘图标
- 稳定性：代理环境变量归一化、网络服务入进程、GPU 软渲染回退、崩溃留痕
