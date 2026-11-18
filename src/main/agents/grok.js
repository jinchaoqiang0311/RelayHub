// Grok Build 适配器（实验）：~/.grok/config.toml，provider 表结构与 Codex 同族（base_url / wire_api / api_backend）
import path from 'node:path';
import { readText } from '../services/fsutils.js';
import { parseToml, stringifyToml } from './io.js';
import { PROVIDER_PREFIX } from './codex.js';

const ROUTING_TOP = ['model_provider', 'model'];

function providerIdOf(entryKey) {
  return PROVIDER_PREFIX + String(entryKey).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 24);
}

export const grokAdapter = {
  meta: { id: 'grok', platform: 'grok' },

  async resolveDir(dir) {
    return { dir, file: path.join(dir, 'config.toml') };
  },

  async readLive(dir) {
    const file = path.join(dir, 'config.toml');
    const text = await readText(file);
    const parsed = text !== null ? parseToml(text) : { value: null, error: null };
    return { path: file, text, parsed: parsed.value, parseError: text !== null && !parsed.value ? String(parsed.error) : null };
  },

  buildOps(live, payload, { entryKey }) {
    const pid = providerIdOf(entryKey);
    const doc = live.parsed && typeof live.parsed === 'object' ? { ...live.parsed } : {};
    doc.model_provider = pid;
    doc.model = payload.model || 'grok-4';
    const providers = { ...(doc.model_providers && typeof doc.model_providers === 'object' ? doc.model_providers : {}) };
    providers[pid] = {
      ...(providers[pid] && typeof providers[pid] === 'object' ? providers[pid] : {}),
      name: payload.name || pid,
      base_url: String(payload.baseUrl || '').replace(/\/+$/, ''), // 尾斜杠会破坏流式 URL 拼接
      wire_api: payload.wireApi || 'responses',
      api_backend: payload.wireApi || 'responses',
      experimental_bearer_token: payload.apiKey,
    };
    doc.model_providers = providers;
    return [{ path: live.path, text: stringifyToml(doc), containsSecret: true }];
  },

  stripOps(live, { entryKey }) {
    if (!live.parsed || typeof live.parsed !== 'object') return [];
    const doc = { ...live.parsed };
    const pid = providerIdOf(entryKey);
    for (const k of ROUTING_TOP) delete doc[k];
    const providers = doc.model_providers;
    if (providers && typeof providers === 'object') {
      const next = { ...providers };
      delete next[pid];
      if (Object.keys(next).length === 0) delete doc.model_providers;
      else doc.model_providers = next;
    }
    return [{ path: live.path, text: stringifyToml(doc), containsSecret: false }];
  },

  detectActive(live) {
    const mp = typeof live.parsed?.model_provider === 'string' ? live.parsed.model_provider : null;
    return mp && mp.startsWith(PROVIDER_PREFIX) ? mp : null;
  },
};
