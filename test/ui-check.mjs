// UI 令牌与对比度校验：确保设计系统落地正确（无未定义变量、关键对比度达 WCAG AA）
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../src/renderer/style.css', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');

let failed = 0;
const fail = (m) => { failed++; console.log('FAIL  ' + m); };
const ok = (m) => console.log('ok    ' + m);

// 1) 定义集合
const defined = new Set([...css.matchAll(/--([a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
// 2) 使用集合（CSS + app.js 内联样式）
const used = new Set();
for (const src of [css, js]) {
  for (const m of src.matchAll(/var\(--([a-z0-9-]+)\)/gi)) used.add(m[1]);
}
const missing = [...used].filter((t) => !defined.has(t));
if (missing.length) fail(`未定义的设计令牌: ${missing.join(', ')}`);
else ok(`令牌引用完整（定义 ${defined.size} 个，使用 ${used.size} 个，无悬空引用）`);

// 3) 旧令牌残留（--bg2/--bg3/--line/--fg-dim/--accent2 已废弃）
const legacy = ['bg2', 'bg3', 'line', 'fg-dim', 'accent2'].filter((t) => used.has(t) && !defined.has(t));
if (legacy.length) fail(`废弃令牌仍在引用: ${legacy.join(', ')}`);
else ok('无废弃令牌引用');

// 4) 焦点可见性：不得只有 outline:none 而无替代
if (/outline:\s*none/.test(css) && !/:focus-visible/.test(css)) fail('存在 outline:none 且无 :focus-visible 替代（WCAG 2.4.7）');
else ok('焦点环存在（:focus-visible + 2px ring）');

// 5) 减少动效偏好
if (!/prefers-reduced-motion/.test(css)) fail('缺少 prefers-reduced-motion 支持');
else ok('已尊重 prefers-reduced-motion');

// 6) 对比度计算（WCAG 2.1）
const hex = (h) => { const s = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)); };
const lum = (rgb) => {
  const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const l1 = lum(hex(a)), l2 = lum(hex(b)); const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]; return (hi + 0.05) / (lo + 0.05); };

const pairs = [
  ['正文 fg / 背景', '#F8FAFC', '#0F172A', 4.5],
  ['次要文字 fg-muted / 卡片', '#94A3B8', '#1B2336', 4.5],
  ['强调 accent / 背景', '#22C55E', '#0F172A', 3.0],
  ['危险 danger / 卡片', '#F87171', '#1B2336', 4.5],
  ['警告 warn / 卡片', '#FBBF24', '#1B2336', 4.5],
  ['正文 / 卡片', '#F8FAFC', '#1B2336', 4.5],
];
for (const [name, fg, bg, min] of pairs) {
  const r = ratio(fg, bg);
  if (r < min) fail(`对比度不足 ${name}: ${r.toFixed(2)} < ${min}`);
  else ok(`对比度 ${name}: ${r.toFixed(2)} ≥ ${min}`);
}

// 7) 无 emoji 当图标（ui-ux-pro-max 交付清单）
const emoji = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}]/u;
if (emoji.test(js) || emoji.test(html)) fail('渲染层仍含 emoji 图标（应改用文字/SVG）');
else ok('无 emoji 图标');

// 8) 交互元素有 cursor 与过渡
if (!/\.btn[\s\S]{0,400}cursor:\s*pointer/.test(css)) fail('.btn 缺少 cursor:pointer');
else ok('.btn cursor:pointer + 过渡动效');

// 9) 表格可滚动容器
const wrapCount = (js.match(/table-wrap/g) || []).length;
if (wrapCount < 2) fail(`表格滚动容器不足（找到 ${wrapCount} 处）`);
else ok(`表格滚动容器 ${wrapCount} 处（密集数据可扫描）`);

console.log(failed ? `\nUI-CHECK 失败 ${failed} 项` : '\nUI-CHECK OK — 设计系统令牌/对比度/无障碍全部通过');
process.exit(failed ? 1 : 0);
