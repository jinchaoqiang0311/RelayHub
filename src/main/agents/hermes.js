// Hermes 适配器（实验）：Windows %LOCALAPPDATA%\hermes\config.yaml / Unix ~/.hermes/config.yaml
// 写 providers.relayhub_x = { base_url, api_key, model }，保留文件其余内容。
import path from 'node:path';
import { readText } from '../services/fsutils.js';
import { parseYaml, stringifyYaml } from './io.js';
import { PROVIDER_PREFIX } from './codex.js';

function providerIdOf(entryKey) {
  return PROVIDER_PREFIX + String(entryKey).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 24);
}

export const hermesAdapter = {
  meta: { id: 'hermes', platform: 'hermes' },

  async resolveDir(dir) {
    return { dir, file: path.join(dir, 'config.yaml') };
  },

  async readLive(dir) {
    const file = path.join(dir, 'config.yaml');
    const text = await readText(file);
    const parsed = text !== null ? parseYaml(text) : { value: null, error: null };
    return { path: file, text, parsed: parsed.value, parseError: text !== null && !parsed.value ? String(parsed.error) : null };
  },

  buildOps(live, payload, { entryKey }) {
    const pid = providerIdOf(entryKey);
    const doc = live.parsed && typeof live.parsed === 'object' ? { ...live.parsed } : {};
    const providers = { ...(doc.providers && typeof doc.providers === 'object' ? doc.providers : {}) };
    providers[pid] = {
      ...(providers[pid] && typeof providers[pid] === 'object' ? providers[pid] : {}),
      base_url: payload.baseUrl,
      api_key: payload.apiKey,
      model: payload.model || undefined,
    };
    doc.providers = providers;
    return [{ path: live.path, text: stringifyYaml(doc), containsSecret: true }];
  },

  stripOps(live, { entryKey }) {
    if (!live.parsed || typeof live.parsed !== 'object') return [];
    const doc = { ...live.parsed };
    const pid = providerIdOf(entryKey);
    const providers = doc.providers;
    if (providers && typeof providers === 'object') {
      const next = { ...providers };
      delete next[pid];
      if (Object.keys(next).length === 0) delete doc.providers;
      else doc.providers = next;
    }
    return [{ path: live.path, text: stringifyYaml(doc), containsSecret: false }];
  },

  detectActive(live) {
    const keys = Object.keys(live.parsed?.providers ?? {});
    const ours = keys.find((k) => k.startsWith(PROVIDER_PREFIX));
    return ours ?? null;
  },
};
