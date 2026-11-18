// PNG → ICO 转换（多尺寸内嵌，纯 Node 实现，无依赖）
// ICO 格式：ICONDIR(6B) + ICONDIRENTRY(16B × N) + 各尺寸图像数据（可直接内嵌 PNG，Vista+ 支持）
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SIZES = [256, 64, 48, 32, 16];
const images = SIZES.map((s) => {
  const p = path.join(ROOT, 'assets', `icon-${s}.png`);
  return { size: s, data: fs.readFileSync(p) };
});

// ICO 目录
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type = 1 (icon)
header.writeUInt16LE(images.length, 4);

const entries = [];
let offset = 6 + 16 * images.length;
for (const img of images) {
  const e = Buffer.alloc(16);
  e.writeUInt8(img.size >= 256 ? 0 : img.size, 0); // width (0 = 256)
  e.writeUInt8(img.size >= 256 ? 0 : img.size, 1); // height
  e.writeUInt8(0, 2); // palette
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bit depth
  e.writeUInt32LE(img.data.length, 8);
  e.writeUInt32LE(offset, 12);
  entries.push(e);
  offset += img.data.length;
}

const ico = Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
const out = path.join(ROOT, 'build', 'icon.ico');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, ico);
console.log(`生成 ${out}  ${ico.length} bytes  含 ${images.length} 尺寸 [${SIZES.join(', ')}]`);
