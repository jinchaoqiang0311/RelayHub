// RelayHub Electron 主进程（CJS：规避本地 node_modules/electron 遮蔽内置 ESM 导出的问题）
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require('electron');
const path = require('node:path');

let services = null;
let mainWindow = null;
let tray = null;

const PRELOAD = path.join(__dirname, '..', 'preload.cjs');
const RENDERER = path.join(__dirname, '..', 'renderer', 'index.html');
// 品牌资源（应用窗口图标 / 托盘图标）；打包后位于 app.asar 内，四层上溯到项目根的备选路径见 resolveAsset
const ASSET_DIRS = [
  path.join(__dirname, '..', '..', 'assets'),        // 开发态: <root>/src/main -> <root>/assets
  path.join(process.resourcesPath || '', 'assets'),   // 打包态 (asar 外)
];

function resolveAsset(name) {
  for (const dir of ASSET_DIRS) {
    const p = path.join(dir, name);
    try { if (require('node:fs').existsSync(p)) return p; } catch { /* 忽略 */ }
  }
  return null;
}

// —— 稳定性加固：Chromium 网络进程会因环境变量里「同名的多份代理键」（HTTP_PROXY + http_proxy）
//    反复崩溃（日志：NetworkService crashed, exitCode -1），进而拖死主进程。这里在启动前做两件事：
//    1) 归一化代理环境变量，只留一份，避免解析歧义；
//    2) 把网络服务放进浏览器进程（NetworkServiceInProcess），崩溃不再单独发生。
//    另外：虚拟显示器 / 老旧 GPU 驱动下 GPU 进程常以 exit_code=34 崩溃并拖死主进程，
//    默认关闭硬件加速（UI 轻量，软件渲染足够；需要时设 RELAYHUB_GPU=1 恢复）。
if (process.env.RELAYHUB_GPU !== '1') {
  try { app.disableHardwareAcceleration(); } catch { /* 忽略 */ }
}
(function hardenNetwork() {
  const env = process.env;
  const upper = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY'];
  for (const k of upper) {
    const lower = k.toLowerCase();
    if (env[k] && env[lower] && env[k] === env[lower]) delete env[lower];       // 同一值：删重复
    else if (env[k] && env[lower] && env[k] !== env[lower]) delete env[lower];  // 不一致：以上层（大写）为准
  }
  try {
    const features = new Set(String(app.commandLine.getSwitchValue('enable-features') || '').split(',').filter(Boolean));
    features.add('NetworkServiceInProcess');
    app.commandLine.appendSwitch('enable-features', [...features].join(','));
  } catch { /* 忽略 */ }
})();

// —— 崩溃/异常留痕：写入 <userData>/crash.log，便于事后定位“窗口突然消失” ——
let appQuitting = false;
if (app && typeof app.on === 'function') {
  app.on('before-quit', () => { appQuitting = true; });
} else {
  console.error('[RelayHub] electron app 不可用 —— 疑似 ELECTRON_RUN_AS_NODE=1 环境，已退出');
  process.exit(1);
}
function logCrash(kind, detail) {
  if (appQuitting && kind === 'child-process-gone') return; // 退出时子进程被回收是正常现象，不记假崩溃
  try {
    const file = path.join(app.getPath('userData'), 'crash.log');
    const line = `[${new Date().toISOString()}] ${kind}: ${detail}\n`;
    require('node:fs').appendFileSync(file, line, 'utf8');
  } catch { /* 记录失败不影响主流程 */ }
}
process.on('uncaughtException', (err) => logCrash('uncaughtException', err?.stack ?? String(err)));
process.on('unhandledRejection', (reason) => logCrash('unhandledRejection', String(reason)));
if (app && typeof app.on === 'function') { app.on('render-process-gone', (_e, _wc, details) => logCrash('render-process-gone', JSON.stringify(details))); }
if (app && typeof app.on === 'function') { app.on('child-process-gone', (_e, details) => logCrash('child-process-gone', JSON.stringify(details))); }

async function bootstrap() {
  const { createServices, electronCrypto } = await import('./services/index.js');
  const crypto = electronCrypto(app.safeStorage);
  services = createServices({ dataDir: app.getPath('userData'), cryptoProvider: crypto });
  await services.load();
}

function createWindow() {
  const winIcon = resolveAsset('icon-256.png');
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    title: 'RelayHub — 多中转站 Key 管理器',
    backgroundColor: '#0F172A',
    ...(winIcon ? { icon: winIcon } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });
  mainWindow.loadFile(RENDERER);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('focus', onWindowFocusSync);
}

function rebuildTray() {
  if (!services) return;
  const items = [];
  for (const agentId of services.agents.ids) {
    const agentState = services.store.agentState(agentId);
    const subs = agentState.entries.slice(0, 12).map((entry) => ({
      label: `${entry.id === agentState.currentEntryId ? '● ' : '○ '}${entry.name}`,
      click: async () => {
        try {
          await services.deploy.switch(agentId, entry.id);
          mainWindow?.webContents.send('relayhub:changed', { agentId });
          rebuildTray();
        } catch (err) {
          mainWindow?.webContents.send('relayhub:error', { message: String(err.message ?? err) });
        }
      },
    }));
    items.push(...subs, { type: 'separator' });
  }
  const contextMenu = Menu.buildFromTemplate([
    { label: 'RelayHub', enabled: false },
    { type: 'separator' },
    ...items,
    { label: '打开主窗口', click: () => { mainWindow ? mainWindow.show() : createWindow(); } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
  if (!tray) {
    // 托盘图标：优先品牌 logo（16/32px），失败再退回空图（保证不崩）
    const trayIcon = resolveAsset('tray-32.png') || resolveAsset('tray-16.png') || resolveAsset('icon-32.png');
    let img = nativeImage.createEmpty();
    if (trayIcon) {
      const loaded = nativeImage.createFromPath(trayIcon);
      if (!loaded.isEmpty()) img = loaded;
    }
    tray = new Tray(img);
    tray.setToolTip('RelayHub — 多中转站 Key 管理器');
  }
  tray.setContextMenu(contextMenu);
}

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, async (_ev, payload) => {
    try { return { ok: true, data: await fn(payload ?? {}) }; }
    catch (err) { return { ok: false, error: String(err.message ?? err), code: err.code ?? null }; }
  });

  handle('agents:probeAll', () => services.agents.probeAll());
  handle('agents:probe', (p) => services.agents.probe(p.agentId, p));
  handle('stats:dashboard', async () => {
    const agentsProbe = await services.agents.probeAll().catch(() => []);
    // 今日消费：并发拉各站（带 10 分钟缓存；失效/未登录站点静默跳过）
    const todayRows = {};
    await Promise.all(services.store.state.stations.map(async (s) => {
      if (s.sessionInvalid) return;
      try { todayRows[s.id] = await services.stations.todayUsage(s.id); } catch { /* 该站不支持/离线 */ }
    }));
    const { buildDashboard } = await import('./services/dashboard.js');
    return buildDashboard(services.store, agentsProbe, todayRows);
  });
  handle('stats:journal', () => services.deploy.journal());

  // AI 排行榜（内嵌站点）辅助通道
  ipcMain.on('aip:open-external', (_e, url) => {
    if (typeof url === 'string' && url.startsWith('http')) shell.openExternal(url);
  });

  // 比价：本地价格库
  handle('book:sync', (p) => services.books.syncAll(p));
  handle('book:syncStation', (p) => services.books.syncStation(p.stationId, p));
  handle('book:query', (p) => services.books.query(p));
  handle('book:stats', () => services.books.stats());
  handle('book:clear', () => services.books.clear());

  handle('stations:list', () => services.store.state.stations.map((s) => ({
    ...s,
    sessionInvalid: Boolean(s.sessionInvalid),
    sessionError: s.sessionError ?? null,
    keys: s.keys.map((k) => ({ ...k, key: k.key ? k.key.slice(0, 8) + '…' + k.key.slice(-4) : null })),
  })));
  handle('stations:add', (p) => services.stations.add(p).then(rebuildTrayOnce));
  handle('stations:login', (p) => services.stations.login(p.id, p).then(rebuildTrayOnce));
  handle('stations:refresh', (p) => services.stations.refresh(p.id).then(rebuildTrayOnce));
  handle('stations:remove', (p) => services.stations.remove(p.id).then(rebuildTrayOnce));
  handle('stations:addKey', (p) => services.stations.addKey(p).then(rebuildTrayOnce));
  handle('stations:createToken', (p) => services.stations.createToken(p.id, p).then(rebuildTrayOnce));
  handle('stations:verifyKey', (p) => services.stations.verifyKey(p.id, p.keyId, p));
  handle('stations:revealKey', (p) => services.stations.revealKey(p.stationId, p.keyId));
  handle('stations:listModels', (p) => services.stations.listModels(p.stationId, p.keyId));
  handle('stations:probeModel', (p) => services.stations.probeModel(p.stationId, p.keyId, p));
  handle('stations:fetchPricing', (p) => services.stations.fetchPricing(p.stationId, p));
  handle('stations:setRechargeRatio', (p) => services.stations.setRechargeRatio(p.stationId, p.ratio));
  handle('stations:effectiveRatio', (p) => services.stations.effectiveRechargeRatio(p.stationId));
  handle('stations:loginRequirements', (p) => services.stations.loginRequirements(p.stationId));
  handle('stations:applySession', (p) => services.stations.applySession(p.stationId, p.session ?? {}).then(rebuildTrayOnce));
  handle('stations:browserLogin', (p) => browserLoginWindow(p.stationId));
  handle('stations:captureSession', (p) => captureLoginSession(p.stationId).then(rebuildTrayOnce));

  handle('deploy:run', (p) => services.deploy.deploy(p).then(rebuildTrayOnce));
  handle('deploy:switch', (p) => services.deploy.switch(p.agentId, p.entryId).then(rebuildTrayOnce));
  handle('deploy:remove', (p) => services.deploy.remove(p.agentId, p.entryId).then(rebuildTrayOnce));
  handle('deploy:undo', () => services.deploy.undo().then(rebuildTrayOnce));
  handle('deploy:journal', () => services.deploy.journal());

  handle('entries:list', () => {
    const out = {};
    for (const id of services.agents.ids) {
      const st = services.store.agentState(id);
      out[id] = { currentEntryId: st.currentEntryId, entries: st.entries.map(({ rawKey, ...rest }) => ({ ...rest, hasRawKey: Boolean(rawKey) })) };
    }
    return out;
  });

  handle('settings:get', () => services.store.state.settings);
  handle('settings:set', (p) => {
    services.store.state.settings = { ...services.store.state.settings, ...p };
    return services.store.save();
  });
  handle('sync:run', () => syncRun(true).then(rebuildTrayOnce));
  handle('update:check', async () => {
    if (!app.isPackaged) return { dev: true, version: app.getVersion() };
    const { autoUpdater } = require('electron-updater');
    const r = await autoUpdater.checkForUpdates().catch((e) => ({ error: String(e.message ?? e) }));
    return { version: app.getVersion(), latest: r?.updateInfo?.version ?? null, error: r?.error ?? null };
  });
  handle('update:install', () => {
    if (!app.isPackaged) return { dev: true };
    try { require('electron-updater').autoUpdater.quitAndInstall(); } catch { /* ignore */ }
    return { quitting: true };
  });
  handle('settings:openPath', (p) => {
    const map = { data: services.dataDir, backups: path.join(services.dataDir, 'backups') };
    shell.openPath(map[p.target] ?? services.dataDir);
    return true;
  });
}

function rebuildTrayOnce(result) {
  try { rebuildTray(); } catch { /* 托盘失败不影响主流程 */ }
  return result;
}

/**
 * 浏览器代登：打开站点登录页窗口，用户在里面完成人机验证并登录；
 * 主进程轮询会话（cookie + URL 离开登录页 + localStorage JWT），
 * 命中后自动 applySession 并拉取 Key。
 */
let loginWinRef = null; // 供「我已登录，立即抓取」手动兜底

async function collectLoginMaterial(win, hostname, baseUrl) {
  // cookie 优先，且不被页面 JS 扫描失败阻塞
  let cookieStr = '';
  try {
    let cookies = [];
    try { cookies = await win.webContents.session.cookies.get({ url: baseUrl }); } catch { /* fallback */ }
    if (!cookies.length) {
      try { cookies = await win.webContents.session.cookies.get({}); } catch { /* empty */ }
      if (hostname) {
        const host = hostname.replace(/^www\./, '').toLowerCase();
        const filtered = cookies.filter((c) => {
          const d = (c.domain || '').replace(/^\./, '').toLowerCase();
          return d === host || d.endsWith('.' + host) || host.endsWith(d);
        });
        if (filtered.length) cookies = filtered;
      }
    }
    cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch { /* ignore */ }

  let url = '';
  try { url = win.webContents.getURL(); } catch { /* ignore */ }

  // 页面扫描：JWT + userId + sid + Sub2API 的 auth_token/refresh_token（失败不影响 cookie 判定）
  let scan = { jwt: null, userId: null, username: null, sid: null, authToken: null, refreshToken: null };
  try {
    scan = await win.webContents.executeJavaScript(`(() => {
      const out = { jwt: null, userId: null, username: null, sid: null };
      try {
        for (const store of [window.localStorage, window.sessionStorage]) {
          if (!store) continue;
          for (let i = 0; i < store.length; i++) {
            const k = store.key(i);
            const v = store.getItem(k);
            if (typeof v !== 'string') continue;
            if (!out.jwt && v.startsWith('eyJ') && v.split('.').length >= 2) out.jwt = v;
            if (/^(auth_token|token)$/i.test(k) && v.length > 20 && !out.authToken) out.authToken = v;
            if (/^refresh_token$/i.test(k) && v.length > 20 && !out.refreshToken) out.refreshToken = v;
            let o = null;
            try { o = JSON.parse(v); } catch { /* 非 JSON */ }
            const walk = (obj, depth) => {
              if (!obj || typeof obj !== 'object' || depth > 4) return;
              const uid = obj.id ?? obj.user_id ?? obj.userId;
              if (Number.isInteger(uid) && uid > 0 && (obj.username || obj.email || obj.display_name || obj.role)) {
                if (!out.userId) { out.userId = uid; out.username = obj.username ?? obj.email ?? obj.display_name ?? null; }
              }
              const tk = obj.access_token ?? obj.accessToken ?? obj.token;
              if (typeof tk === 'string' && tk.startsWith('eyJ') && !out.jwt) out.jwt = tk;
              const sid = obj.sid ?? obj.session_id ?? obj.sessionId;
              if (typeof sid === 'string' && sid.length > 8 && !out.sid) out.sid = sid;
              for (const child of Object.values(obj)) {
                if (child && typeof child === 'object') walk(child, depth + 1);
              }
            };
            if (o) walk(o, 0);
          }
        }
      } catch { /* 无法访问存储 */ }
      return out;
    })()`, true);
  } catch { /* 页面未就绪/CSP，cookie 判定照常 */ }

  return { cookieStr, url, scan };
}

function isLoginPageUrl(url) {
  try {
    const u = new URL(url);
    const p = (u.pathname || '') + (u.hash || '');
    return /sign-in|sign-up|login|signin|\/auth(\/|$)|\/oauth/i.test(p);
  } catch { return false; }
}

async function browserLoginWindow(stationId) {
  const station = services.store.findStation(stationId);
  if (!station) throw new Error(`找不到中转站: ${stationId}`);
  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = null;
    let cookieSeenCount = 0;
    let lastCookieStr = '';
    const win = new BrowserWindow({
      width: 470,
      height: 760,
      title: `登录 ${station.name} — 登录成功后自动同步到 RelayHub`,
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    loginWinRef = { win, stationId };

    const finish = async (payload) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      // 关键顺序：先落库并拉取 Key，成功后才关窗（关窗会销毁 session cookie）
      let applyResult = null;
      let applyError = null;
      if (payload?.cookie || payload?.accessToken) {
        try {
          applyResult = await services.stations.applySession(stationId, payload);
        } catch (err) {
          applyError = String(err.message ?? err);
        }
      }
      if (applyResult) {
        try { if (!win.isDestroyed()) win.close(); } catch { /* already closed */ }
        resolve({ ...payload, applied: true });
      } else {
        // 失败：不关窗，保留现场，用户可点「我已登录，立即抓取」重试
        resolve({ ...payload, applied: false, applyError: applyError ?? '未抓到有效会话' });
      }
    };

    win.on('closed', async () => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      loginWinRef = null;
      // 用户手动关窗：cookie 仍在默认 session 里（窗口销毁不影响 session），尽力抓一次
      try {
        let cookies = [];
        try { cookies = await require('electron').session.defaultSession.cookies.get({ url: station.baseUrl }); } catch { /* ignore */ }
        const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        if (cookieStr) {
          const applyResult = await services.stations.applySession(stationId, { cookie: cookieStr }).catch(() => null);
          resolve({ cookie: cookieStr, applied: Boolean(applyResult), cancelled: !applyResult });
          return;
        }
      } catch { /* ignore */ }
      resolve({ cancelled: true });
    });

    // 登录页路由探测：候选来自实测站点（Xoras /sign-in、new-api 默认 /login、hash 路由等）
    // 服务端一律回 SPA index.html（HTTP 200），需检查【渲染结果】——出现密码输入框才算登录页
    const root = station.baseUrl.replace(/\/+$/, '');
    const hostname = (() => { try { return new URL(station.baseUrl).hostname; } catch { return null; } })();
    const candidates = ['/sign-in', '/sign-up', '/login', '/auth/login', '/auth', '/console/login', '/user/login', '/#/login', '/#/sign-in', '/signin'];
    (async () => {
      for (const path of candidates) {
        if (settled || win.isDestroyed()) return;
        try { await win.loadURL(root + path); } catch { continue; }
        await new Promise((r) => setTimeout(r, 2500)); // 等 SPA 渲染（React/TanStack 路由挂载）
        if (settled || win.isDestroyed()) return;
        try {
          const hit = await win.webContents.executeJavaScript(`(() => {
            try {
              const pw = document.querySelector('input[type=password]');
              if (pw) return true;
              const txt = ((document.body && document.body.innerText) || '').slice(0, 600).toLowerCase();
              const nf = /not\\s*found|404|不存在/.test(txt);
              return !nf && /(登录|login|sign\\s?in)/.test(txt);
            } catch { return false; }
          })()`, true);
          if (hit) return; // 已停在可登录页面，交给用户操作
        } catch { /* 页面未就绪，继续下一个候选 */ }
      }
      // 全部候选未命中：停在 /sign-in（Xoras 系）或首页，用户自行导航；轮询照常工作
      if (!settled && !win.isDestroyed()) win.loadURL(root + '/sign-in').catch(() => win.loadURL(root).catch(() => {}));
    })().catch(() => {});

    pollTimer = setInterval(async () => {
      if (settled || win.isDestroyed()) { if (pollTimer) clearInterval(pollTimer); loginWinRef = null; return; }
      // cookie 检测永远先跑，不被页面扫描阻塞
      const mat = await collectLoginMaterial(win, hostname, station.baseUrl).catch(() => ({ cookieStr: '', url: '', scan: {} }));
      const { cookieStr, url, scan } = mat;
      const leftLogin = Boolean(url) && !isLoginPageUrl(url);

      // JWT 型站点 + 非 JWT 的 Bearer token 型站点（如 Sub2API 的 auth_token，非 eyj 形态）
      if (scan?.jwt || scan?.authToken) {
        try {
          const v = await services.stations.verifySession(stationId, { accessToken: scan.jwt ?? scan.authToken, userId: scan.userId ?? null });
          if (v.ok) return finish({ accessToken: v.accessToken ?? scan.jwt ?? scan.authToken, userId: v.userId ?? scan.userId, username: v.username, refreshToken: v.refreshToken ?? scan.refreshToken ?? null });
        } catch { /* 下一轮 */ }
      }

      // new-api 系：拿到会话 cookie 后主动用 refresh 端点验证（唯一确凿证据）
      // 注意：verifySession 内部会轮换 cookie，必须用返回的新 cookie 落库
      if (cookieStr) {
        if (cookieStr !== lastCookieStr) lastCookieStr = cookieStr;
        const looksAuth = /new_api_refresh|session=|refresh|sid=|token=/i.test(cookieStr) || leftLogin;
        if (looksAuth) {
          cookieSeenCount += 1;
          const enough = leftLogin ? (scan?.userId || cookieSeenCount >= 2) : cookieSeenCount >= 2;
          if (enough) {
            try {
              const v = await services.stations.verifySession(stationId, {
                cookie: cookieStr,
                userId: scan?.userId ?? null,
                sid: scan?.sid ?? null,
              });
              if (v.ok) {
                return finish({
                  cookie: v.cookie || cookieStr,
                  accessToken: v.accessToken,
                  userId: v.userId ?? scan?.userId ?? null,
                  username: v.username ?? scan?.username ?? null,
                  sid: v.sid ?? scan?.sid ?? null,
                  refreshToken: v.refreshToken ?? null,
                });
              }
            } catch { /* refresh 还没好，下一轮再试 */ }
            // refresh 验证未通过但已离开登录页：兜底直接落库（旧版 session 模式）
            if (leftLogin && scan?.userId) {
              return finish({ cookie: cookieStr, userId: scan.userId, username: scan.username ?? null, sid: scan.sid ?? null });
            }
          }
        } else {
          cookieSeenCount = 0;
        }
      } else {
        cookieSeenCount = 0;
      }
    }, 2000);
  });
}

/** 手动兜底：用户已在登录窗口完成登录但自动检测未命中时，从当前登录窗口抓会话 */
async function captureLoginSession(stationId) {
  const win = loginWinRef?.win;
  if (!win || win.isDestroyed()) throw new Error('登录窗口已关闭，请重新点「登录」打开窗口并在里面登录');
  const station = services.store.findStation(stationId);
  if (!station) throw new Error(`找不到中转站: ${stationId}`);
  const hostname = (() => { try { return new URL(station.baseUrl).hostname; } catch { return null; } })();
  const mat = await collectLoginMaterial(win, hostname, station.baseUrl);
  if (!mat.cookieStr && !mat.scan?.jwt && !mat.scan?.authToken) throw new Error('没抓到任何会话材料（cookie/token 均为空），确认已在窗口里登录成功');

  let payload = {
    ...(mat.cookieStr ? { cookie: mat.cookieStr } : {}),
    ...(mat.scan?.jwt || mat.scan?.authToken ? { accessToken: mat.scan.jwt ?? mat.scan.authToken } : {}),
    ...(mat.scan?.refreshToken ? { refreshToken: mat.scan.refreshToken } : {}),
    userId: mat.scan?.userId ?? null,
    sid: mat.scan?.sid ?? null,
  };

  // 优先走 verifySession：用 refresh 端点验证并拿到轮换后的新 cookie + accessToken
  if (payload.cookie) {
    try {
      const v = await services.stations.verifySession(stationId, { cookie: payload.cookie, userId: payload.userId, sid: payload.sid });
      if (v.ok) {
        payload = {
          cookie: v.cookie || payload.cookie,
          accessToken: v.accessToken,
          userId: v.userId ?? payload.userId,
          username: v.username,
          sid: v.sid ?? payload.sid,
          refreshToken: v.refreshToken ?? null,
        };
      }
    } catch { /* verify 失败则用原始 cookie 兜底 */ }
  }

  const applied = await services.stations.applySession(stationId, payload);
  try { if (!win.isDestroyed()) win.close(); } catch { /* ignore */ }
  return { applied: true, keys: applied?.keys?.length ?? 0, balance: applied?.balance ?? null };
}

let syncLastAt = 0;
let syncBusy = false;

async function syncRun(manual = false) {
  if (syncBusy) return { skipped: 'busy' };
  syncBusy = true;
  try {
    const summary = await services.sync.runOnce({ manual });
    syncLastAt = Date.now();
    mainWindow?.webContents.send('relayhub:synced', summary);
    return summary;
  } finally {
    syncBusy = false;
  }
}

function startSyncLoop() {
  const t1 = setTimeout(() => syncRun(false), 8000);
  t1.unref?.();
  const t2 = setInterval(() => syncRun(false), 30 * 60 * 1000);
  t2.unref?.();
}

function onWindowFocusSync() {
  const THROTTLE = 5 * 60 * 1000;
  if (Date.now() - syncLastAt > THROTTLE) syncRun(false);
}

/** 自动更新：仅打包后激活；签名走 electron-builder 标准 env（CSC_LINK / CSC_KEY_PASSWORD / APPLE_ID…） */
async function setupAutoUpdate() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return;
  }
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-downloaded', () => mainWindow?.webContents.send('relayhub:update', { stage: 'downloaded' }));
    autoUpdater.on('checking-for-update', () => mainWindow?.webContents.send('relayhub:update', { stage: 'checking' }));
    autoUpdater.on('update-not-available', () => mainWindow?.webContents.send('relayhub:update', { stage: 'up-to-date' }));
    autoUpdater.on('error', () => mainWindow?.webContents.send('relayhub:update', { stage: 'error' }));
    await autoUpdater.checkForUpdates();
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000).unref?.();
  } catch {
    /* publish URL 未配置或无网络：静默 */
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { mainWindow ? (mainWindow.show(), mainWindow.focus()) : createWindow(); });
  app.whenReady().then(async () => {
    await bootstrap();
    registerIpc();
    createWindow();
    rebuildTray();
    startSyncLoop();
    setupAutoUpdate();
  });
  app.on('window-all-closed', () => { /* 常驻托盘 */ });
}
