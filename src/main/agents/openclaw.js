// OpenClaw 适配器（实验）：~/.openclaw/openclaw.json 的 models.providers 块
// 写入 models.providers.relayhub_x = { baseUrl, apiKey, api, models }；models 默认模型交给用户或 payload.model。
import path from 'node:path';
import { readText } from '../services/fsutils.js';
import { parseJsonc } from './io.js';
import { PROVIDER_PREFIX } from './codex.js';

function providerIdOf(entryKey) {
  return PROVIDER_PREFIX + String(entryKey).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 24);
}

export const openclawAdapter = {
  meta: { id: 'openclaw', platform: 'openclaw' },

  async resolveDir(dir) {
    return { dir, file: path.join(dir, 'openclaw.json') };
  },

  async readLive(dir) {
    const file = path.join(dir, 'openclaw.json');
    const text = await readText(file);
    const parsed = text !== null ? parseJsonc(text) : { value: null, error: null };
    return { path: file, text, parsed: parsed.value, parseError: text !== null && !parsed.value ? String(parsed.error) : null };
  },

  buildOps(live, payload, { entryKey }) {
    const pid = providerIdOf(entryKey);
    const doc = live.parsed && typeof live.parsed === 'object' ? { ...live.parsed } : {};
    const models = { ...(doc.models && typeof doc.models === 'object' ? doc.models : {}) };
    const providers = { ...(models.providers && typeof models.providers === 'object' ? models.providers : {}) };
    providers[pid] = {
      ...(providers[pid] && typeof providers[pid] === 'object' ? providers[pid] : {}),
      baseUrl: payload.baseUrl,
      apiKey: payload.apiKey,
      api: payload.api || 'openai-completions',
      models: payload.models && payload.models.length ? payload.models : {},
    };
    models.providers = providers;
    if (payload.model) models.defaultModel = `${pid}/${payload.model}`;
    doc.models = models;
    return [{ path: live.path, text: JSON.stringify(doc, null, 2) + '\n', containsSecret: true }];
  },

  stripOps(live, { entryKey }) {
    if (!live.parsed || typeof live.parsed !== 'object') return [];
    const doc = { ...live.parsed };
    const pid = providerIdOf(entryKey);
    const models = doc.models;
    if (models && typeof models === 'object') {
      const next = { ...models };
      const providers = { ...(next.providers ?? {}) };
      delete providers[pid];
      next.providers = providers;
      if (typeof next.defaultModel === 'string' && next.defaultModel.startsWith(pid + '/')) delete next.defaultModel;
      doc.models = next;
    }
    return [{ path: live.path, text: JSON.stringify(doc, null, 2) + '\n', containsSecret: false }];
  },

  detectActive(live) {
    const dm = live.parsed?.models?.defaultModel;
    return typeof dm === 'string' && dm.startsWith(PROVIDER_PREFIX) ? dm.split('/')[0] : null;
  },
};
