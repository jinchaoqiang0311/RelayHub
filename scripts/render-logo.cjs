// 把 logo SVG 栅格化为多尺寸 PNG（应用图标 + 托盘图标）；用 Electron 渲染，无需额外依赖
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const SVG = path.join(ROOT, 'assets', 'logo-mark.svg');
const OUT = path.join(ROOT, 'assets');
const TMP = path.join(os.tmpdir(), 'relayhub-logo-render');
const SIZES = [512, 256, 128, 64, 48, 32, 24, 16];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Electron 默认在最后一个窗口关闭时退出——渲染循环会因此中断，这里屏蔽掉
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  let failed = 0;
  fs.mkdirSync(TMP, { recursive: true });
  try {
    const svgUrl = 'file:///' + SVG.replace(/\\/g, '/');
    for (const size of SIZES) {
      const htmlFile = path.join(TMP, `s${size}.html`);
      fs.writeFileSync(htmlFile, `<!doctype html><meta charset="utf-8"><style>
        html,body{margin:0;padding:0;background:#0F172A;overflow:hidden}
        img{display:block;width:${size}px;height:${size}px}
      </style><img src="${svgUrl}">`, 'utf8');

      const win = new BrowserWindow({
        width: size,
        height: size,
        show: false,
        useContentSize: true,
        frame: false,
        backgroundColor: '#0F172A',
        webPreferences: { backgroundThrottling: false },
      });
      await win.loadFile(htmlFile);
      await sleep(200);
      const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
      const png = img.toPNG();
      const file = path.join(OUT, `icon-${size}.png`);
      fs.writeFileSync(file, png);
      win.destroy();
      const empty = png.length < 300;
      if (empty) failed++;
      console.log(`生成 ${path.basename(file)}  ${size}x${size}  ${Math.round(png.length / 1024)}KB${empty ? '  [疑似空白]' : ''}`);
      await sleep(60);
    }
    fs.copyFileSync(path.join(OUT, 'icon-512.png'), path.join(OUT, 'icon.png'));
    fs.copyFileSync(path.join(OUT, 'icon-32.png'), path.join(OUT, 'tray-32.png'));
    fs.copyFileSync(path.join(OUT, 'icon-16.png'), path.join(OUT, 'tray-16.png'));
    // electron-builder 需要 build/icon.png（≥256）
    const buildDir = path.join(ROOT, 'build');
    fs.mkdirSync(buildDir, { recursive: true });
    fs.copyFileSync(path.join(OUT, 'icon-512.png'), path.join(buildDir, 'icon.png'));
    console.log(`完成：${failed ? failed + ' 个异常' : '全部正常'}；另已在 build/icon.png 放置打包图标`);
  } catch (err) {
    console.error('栅格化失败:', err.message);
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
    app.exit(failed ? 1 : 0);
  }
});
