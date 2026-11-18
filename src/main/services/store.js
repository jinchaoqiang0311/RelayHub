// 加密存储：Electron 下用 safeStorage(DPAPI) 加密敏感字段；CLI 下退化为混淆并明确标记
import fsp from 'node:fs/promises';
import path from 'node:path';

const SECRET_FIELDS = new Set(['password', 'token', 'apiKey', 'accessToken', 'cookie']);

function encryptShallow(crypto, obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_FIELDS.has(k) && typeof v === 'string' && v) {
      out[k] = crypto ? crypto.encrypt(v) : { __plain: true, v };
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = encryptShallow(crypto, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function decryptShallow(crypto, obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SECRET_FIELDS.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = v.__plain ? v.v : crypto.decrypt(v);
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = decryptShallow(crypto, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function createStore(dataDir, cryptoProvider) {
  const file = path.join(dataDir, 'store.json');
  const state = { version: 1, stations: [], agents: {}, settings: { backupKeep: 20 } };

  async function load() {
    let text;
    try { text = await fsp.readFile(file, 'utf8'); } catch { return state; }
    try {
      const doc = JSON.parse(text);
      state.version = doc.version ?? 1;
      state.stations = (doc.stations ?? []).map((s) => ({ ...s, ...decryptShallow(cryptoProvider, s) }));
      state.agents = doc.agents ?? {};
      state.settings = { ...state.settings, ...(doc.settings ?? {}) };
    } catch (err) {
      throw new Error(`存储文件损坏：${file}（${err.message}）`);
    }
    return state;
  }

  async function save() {
    const doc = {
      version: 1,
      stations: state.stations.map((s) => encryptShallow(cryptoProvider, s)),
      agents: state.agents,
      settings: state.settings,
    };
    await fsp.mkdir(dataDir, { recursive: true });
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8');
    await fsp.rename(tmp, file);
  }

  return {
    dataDir,
    get state() { return state; },
    load,
    save,
    // 便捷方法
    findStation(id) { return state.stations.find((s) => s.id === id) ?? null; },
    addStation(s) { state.stations.push(s); return s; },
    removeStation(id) {
      const i = state.stations.findIndex((s) => s.id === id);
      if (i >= 0) state.stations.splice(i, 1);
      return i >= 0;
    },
    agentState(agentId) {
      if (!state.agents[agentId]) state.agents[agentId] = { entries: [], currentEntryId: null };
      return state.agents[agentId];
    },
  };
}

/** Electron safeStorage 加密器；不可用时返回 null（明文降级） */
export function electronCrypto(safeStorage) {
  if (!safeStorage?.isEncryptionAvailable?.()) return null;
  return {
    encrypt(plain) {
      return { __enc: true, v: safeStorage.encryptString(plain).toString('base64') };
    },
    decrypt(box) {
      if (box.__plain) return box.v;
      return safeStorage.decryptString(Buffer.from(box.v, 'base64'));
    },
  };
}

/** CLI 降级加密器：仅混淆（XOR 固定盐 + base64），文档必须声明其强度有限 */
import crypto from 'node:crypto';
const CLI_SALT = 'RelayHub-local-obfuscation-only';
export function cliCrypto() {
  return {
    encrypt(plain) {
      const key = crypto.createHash('sha256').update(CLI_SALT).digest();
      const data = Buffer.from(plain, 'utf8');
      for (let i = 0; i < data.length; i++) data[i] ^= key[i % key.length];
      return { __obf: true, v: data.toString('base64') };
    },
    decrypt(box) {
      if (box.__plain) return box.v;
      const key = crypto.createHash('sha256').update(CLI_SALT).digest();
      const data = Buffer.from(box.v, 'base64');
      for (let i = 0; i < data.length; i++) data[i] ^= key[i % key.length];
      return data.toString('utf8');
    },
  };
}
