# RelayHub 品牌标识规范

> 依据：`brand` 技能 `references/logo-usage-rules.md` + `ui-ux-pro-max` 生成的设计系统（Dark Mode / Code dark + run green）。图标库检索无「hub/relay」条目，标记形态为自建几何构造。

## 1. 概念

**中心枢纽 + 三向中继臂**

- 中心实心圆 = **Hub**（枢纽，RelayHub 本体）
- 三条圆头臂 = **Relay**（中继分发，指向多个中转站 / 多个下游 Agent）
- 整体是纯几何三向标记：在 16px 仍可辨识为一个「带放射的节点」，在 512px 有足够留白与节奏

不做的事：不用渐变、不用阴影、不用描边特效（品牌规范绝对禁止项）。

## 2. 文件清单

| 文件 | 用途 | 说明 |
|---|---|---|
| `logo-mark.svg` | 应用图标 / 侧栏 / 托盘源文件 | 512×512，深底板 `#0F172A`，绿标记 `#22C55E` |
| `logo-mark-mono.svg` | 单色 / 反白场景 | 继承 `currentColor`，无底板 |
| `logo-full.svg` | 横版组合（图标 + 字标 + 副标） | 1200×320，用于文档/关于页/README |
| `icon-{16,24,32,48,64,128,256,512}.png` | 多尺寸位图 | 由 `scripts/render-logo.cjs` 栅格化 |
| `icon.png` | 512 主图标 | electron-builder 打包用（`build/icon.png` 同理） |
| `tray-16.png` / `tray-32.png` | 系统托盘 | 已替代此前的空图（不再是隐形托盘） |

重新生成位图：

```bash
node_modules/electron/dist/electron.exe scripts/render-logo.cjs
```

## 3. 配色（仅限调色板内）

| 角色 | 值 | 用途 |
|---|---|---|
| Plate（底板） | `#0F172A` | 图标底板、深色界面底 |
| Mark（标记） | `#22C55E` | 枢纽与中继臂 |
| Wordmark（字标） | `#F8FAFC` | 深底上的 "Relay" |
| Wordmark accent | `#22C55E` | "Hub" |
| Tagline | `#94A3B8` | 副标 |

## 4. 使用规则

- **Clear space**：四周留白 ≥ 标记高度（图标方形高度的 1×）
- **最小尺寸**：数字显示 ≥ 16px（位图用 `tray-16.png` / `icon-32.png`）；印刷 ≥ 12mm
- **允许**：深底用彩色版，浅底用彩色版（底板自带深色，无需反白）；单色场景用 `logo-mark-mono.svg`
- **禁止**：拉伸/旋转/加阴影/加渐变/改色/加描边/裁切/重排元素/在嘈杂图片上直接压标

## 5. 应用位置（已落地）

| 位置 | 用法 |
|---|---|
| 侧栏品牌区 | 内联 SVG 20px + 字标「Relay`Hub`」 |
| 窗口标题栏图标 | `icon-256.png` |
| 系统托盘 | `tray-32.png`（失败回退 16px → icon-32） |
| 设置 → 关于 | 内联 SVG 44px + 字标 + 副标 |
| 安装包 / 应用图标 | `build/icon.png`（由 512 复制） |
| 后续 | README 头图建议用 `logo-full.svg` |
