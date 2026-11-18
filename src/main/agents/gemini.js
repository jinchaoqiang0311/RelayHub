// Gemini CLI 适配器：~/.gemini/.env（dotenv）
// 逆向结论：GPTZZZ 写 GEMINI_API_KEY / GOOGLE_GEMINI_BASE_URL / GEMINI_MODEL 到 .env，settings.json 只读不改。
import path from 'node:path';
import { readText } from '../services/fsutils.js';
import { parseDotenv, stringifyDotenv, setDotenv, deleteDotenv } from './io.js';

const KEYS = { apiKey: 'GEMINI_API_KEY', baseUrl: 'GOOGLE_GEMINI_BASE_URL', model: 'GEMINI_MODEL' };
const ROUTING_KEYS = Object.values(KEYS);

export const geminiAdapter = {
  meta: { id: 'gemini', platform: 'gemini' },

  async resolveDir(dir) {
    return { dir, file: path.join(dir, '.env') };
  },

  async readLive(dir) {
    const file = path.join(dir, '.env');
    const text = await readText(file);
    return { path: file, text, doc: text !== null ? parseDotenv(text) : null };
  },

  buildOps(live, payload) {
    const doc = live.doc ?? parseDotenv('');
    setDotenv(doc, KEYS.apiKey, payload.apiKey);
    setDotenv(doc, KEYS.baseUrl, payload.baseUrl);
    if (payload.model) setDotenv(doc, KEYS.model, payload.model);
    else deleteDotenv(doc, KEYS.model);
    return [{ path: live.path, text: stringifyDotenv(doc), containsSecret: true }];
  },

  stripOps(live) {
    if (!live.doc) return [];
    const doc = live.doc;
    for (const k of ROUTING_KEYS) deleteDotenv(doc, k);
    return [{ path: live.path, text: stringifyDotenv(doc), containsSecret: false }];
  },

  detectActive(live) {
    const base = live.doc?.values?.[KEYS.baseUrl];
    return base && live.doc?.values?.[KEYS.apiKey] ? base : null;
  },
};
