// Claude Code 适配器：~/.claude/settings.json（或 claude.json）的 env 块
// 逆向结论（GPTZZZ v4.0.1 同款机制）：写入 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN，
// 可选模型分层，强制关闭 BEDROCK/VERTEX/FOUNDRY 云路由；保留用户其余配置（additive 模式）。
import path from 'node:path';
import { exists, readText } from '../services/fsutils.js';
import { parseJsonc } from './io.js';

const ENV_KEYS = {
  baseUrl: 'ANTHROPIC_BASE_URL',
  token: 'ANTHROPIC_AUTH_TOKEN',
  apiKey: 'ANTHROPIC_API_KEY',
  modelOpus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  modelSonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  modelHaiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
};
const PLATFORM_SWITCHES = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
const ROUTING_ENV_KEYS = [...Object.values(ENV_KEYS), ...PLATFORM_SWITCHES];

async function settingsPath(dir) {
  const settings = path.join(dir, 'settings.json');
  if (await exists(settings)) return settings;
  const alt = path.join(dir, 'claude.json');
  return (await exists(alt)) ? alt : settings;
}

export const claudeAdapter = {
  meta: { id: 'claude', platform: 'anthropic' },

  async resolveDir(dir) {
    return { dir, file: await settingsPath(dir) };
  },

  async readLive(dir) {
    const file = await settingsPath(dir);
    const text = await readText(file);
    const parsed = text !== null ? parseJsonc(text) : { value: null, error: null };
    return { path: file, text, parsed: parsed.value, parseError: text !== null && !parsed.value ? String(parsed.error) : null };
  },

  buildOps(live, payload) {
    const doc = live.parsed && typeof live.parsed === 'object' ? { ...live.parsed } : {};
    const env = { ...(doc.env && typeof doc.env === 'object' ? doc.env : {}) };
    env[ENV_KEYS.baseUrl] = payload.baseUrl;
    env[ENV_KEYS.token] = payload.apiKey;
    if (payload.model) {
      // 单模型直填三层；不填分层则交给中转站路由
      env[ENV_KEYS.modelOpus] = payload.model;
      env[ENV_KEYS.modelSonnet] = payload.model;
      env[ENV_KEYS.modelHaiku] = payload.model;
    } else {
      delete env[ENV_KEYS.modelOpus];
      delete env[ENV_KEYS.modelSonnet];
      delete env[ENV_KEYS.modelHaiku];
    }
    for (const k of PLATFORM_SWITCHES) env[k] = false;
    doc.env = env;
    const text = JSON.stringify(doc, null, 2) + '\n';
    return [{ path: live.path, text, containsSecret: true }];
  },

  stripOps(live) {
    if (!live.parsed || typeof live.parsed !== 'object') return [];
    const doc = { ...live.parsed };
    const env = { ...(doc.env && typeof doc.env === 'object' ? doc.env : {}) };
    for (const k of ROUTING_ENV_KEYS) delete env[k];
    if (Object.keys(env).length === 0) delete doc.env; else doc.env = env;
    return [{ path: live.path, text: JSON.stringify(doc, null, 2) + '\n', containsSecret: false }];
  },

  detectActive(live) {
    const env = live.parsed?.env;
    if (!env) return null;
    if (env[ENV_KEYS.baseUrl] && env[ENV_KEYS.token]) return env[ENV_KEYS.baseUrl];
    return null;
  },
};
