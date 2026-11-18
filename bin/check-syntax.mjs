// 语法自检：动态 import 所有可独立加载的模块（main.js/preload 依赖 electron，单独排除）
const targets = [
  '../src/shared/constants.js',
  '../src/main/services/fsutils.js',
  '../src/main/services/store.js',
  '../src/main/services/deploy.js',
  '../src/main/services/index.js',
  '../src/main/agents/io.js',
  '../src/main/agents/claude.js',
  '../src/main/agents/codex.js',
  '../src/main/agents/gemini.js',
  '../src/main/agents/grok.js',
  '../src/main/agents/openclaw.js',
  '../src/main/agents/hermes.js',
  '../src/main/agents/index.js',
  '../src/main/relays/newapi.js',
  '../src/main/relays/generic.js',
  '../src/main/relays/anthropic.js',
  '../src/main/relays/sub2api.js',
  '../src/main/relays/index.js',
  '../src/main/services/priceTable.js',
  '../src/main/services/pricebook.js',
  '../bin/relayhub.js',
];
let failed = 0;
for (const t of targets) {
  try { await import(t); console.log(`ok    ${t}`); }
  catch (err) { failed++; console.log(`FAIL  ${t}: ${err.message}`); }
}

// 静态守卫：定价/消息渲染必须真正写入 DOM（防「构建了 rows 却忘了 innerHTML」这类回归）
import { readFileSync } from 'node:fs';
const renderer = readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
const shellHtml = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
const guards = [
  { name: 'pricingDialog 表格写入', re: /pr-table tbody[\s\S]{0,40}innerHTML/ },
  { name: 'dashboard 渲染返回', re: /function renderDashboard\(\)/ },
  { name: 'dialog 自动聚焦', re: /firstInput\.focus\(\)/ },
  { name: '侧栏品牌 logo（内联 SVG）', re: /class="brand-mark"/ },
  { name: '比价页渲染', re: /function renderCompare\(\)/ },
  { name: '比价结果写入 DOM', re: /cmp-tbody[\s\S]{0,400}innerHTML/ },
  { name: '站点多选筛选框', re: /id="cmp-station-dd"/ },
  { name: '公司/模型/分组级联下拉', re: /id="cmp-vendor"[\s\S]{0,900}id="cmp-group"/ },
];

// 反向守卫：已移除的控件不得回流
const forbidden = [
  { name: '比价搜索框（已按需求删除）', re: /id="cmp-q"/ },
  { name: '价格区间筛选（已删除）', re: /id="cmp-min"|id="cmp-max"/ },
];
for (const g of forbidden) {
  if (g.re.test(renderer)) { failed++; console.log(`FAIL  guard: ${g.name} 又出现了`); }
  else console.log(`ok    guard: ${g.name} 保持移除`);
}

// 品牌资源完整性（图标 / 托盘）
import { existsSync } from 'node:fs';
const assetChecks = ['logo-mark.svg', 'logo-mark-mono.svg', 'logo-full.svg', 'icon.png', 'icon-256.png', 'tray-32.png', 'tray-16.png'];
const missingAssets = assetChecks.filter((f) => !existsSync(new URL(`../assets/${f}`, import.meta.url)));
if (missingAssets.length) { failed++; console.log(`FAIL  品牌资源缺失: ${missingAssets.join(', ')}`); }
else console.log(`ok    guard: 品牌资源齐全（${assetChecks.length} 个：svg + 多尺寸 png）`);
for (const g of guards) {
  if (g.re.test(renderer) || g.re.test(shellHtml)) console.log(`ok    guard: ${g.name}`);
  else { failed++; console.log(`FAIL  guard: ${g.name}（渲染未写入 DOM？）`); }
}
process.exit(failed ? 1 : 0);
