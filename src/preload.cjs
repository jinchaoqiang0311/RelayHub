// preload：安全桥接（contextIsolation 开启，仅暴露白名单通道）
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set([
  'agents:probeAll', 'agents:probe', 'stats:dashboard', 'stats:journal',
  'book:sync', 'book:syncStation', 'book:query', 'book:stats', 'book:clear',
  'stations:list', 'stations:add', 'stations:login', 'stations:refresh', 'stations:remove',
  'stations:addKey', 'stations:createToken', 'stations:verifyKey', 'stations:revealKey', 'stations:listModels', 'stations:probeModel',
  'stations:loginRequirements', 'stations:applySession', 'stations:browserLogin', 'stations:captureSession', 'stations:fetchPricing',
  'stations:setRechargeRatio', 'stations:effectiveRatio',
  'deploy:run', 'deploy:switch', 'deploy:remove', 'deploy:undo', 'deploy:journal',
  'entries:list', 'sync:run',
  'update:check', 'update:install',
  'settings:get', 'settings:set', 'settings:openPath',
]);

contextBridge.exposeInMainWorld('relayhub', {
  openExternal: (url) => {
    if (typeof url === 'string' && url.startsWith('http')) ipcRenderer.send('aip:open-external', url);
  },
  invoke: (channel, payload) => {
    if (!CHANNELS.has(channel)) return Promise.resolve({ ok: false, error: `未授权通道: ${channel}` });
    return ipcRenderer.invoke(channel, payload);
  },
  onChanged: (fn) => ipcRenderer.on('relayhub:changed', (_e, data) => fn({ type: 'changed', ...data })),
  onSynced: (fn) => ipcRenderer.on('relayhub:synced', (_e, data) => fn(data)),
  onUpdate: (fn) => ipcRenderer.on('relayhub:update', (_e, data) => fn(data)),
  onError: (fn) => ipcRenderer.on('relayhub:error', (_e, data) => fn(data)),
});
