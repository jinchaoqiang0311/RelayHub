// Codex CLI 适配器：~/.codex/config.toml（TOML）+ auth.json 处理
// 逆向结论（GPTZZZ v4.0.1 gptzzzCodexRouting 同款）：
//   model_provider / model / model_reasoning_effort / disable_response_storage
//   [model_providers.<id>] name / base_url / wire_api / experimental_bearer_token
// 写入后删除 auth.json（先备份）以强制 API Key 鉴权；保留 mcp_servers 等用户表。
import path from 'node:path';
import { exists, readText } from '../services/fsutils.js';
import { parseToml, stringifyToml } from './io.js';

const ROUTING_TOP = ['model_provider', 'model', 'model_reasoning_effort', 'disable_response_storage', 'openai_base_url', 'preferred_auth_method', 'model_catalog_json'];
const PROVIDERS_TABLE = 'model_providers';
export const PROVIDER_PREFIX = 'relayhub_';

function providerIdOf(entryKey) {
  return PROVIDER_PREFIX + String(entryKey).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 24);
}

async function liveFor(dir) {
  const configPath = path.join(dir, 'config.toml');
  const authPath = path.join(dir, 'auth.json');
  const [text, authText] = await Promise.all([readText(configPath), readText(authPath)]);
  const parsed = text !== null ? parseToml(text) : { value: null, error: null };
  return {
    path: configPath,
    text,
    parsed: parsed.value,
    parseError: text !== null && !parsed.value ? String(parsed.error) : null,
    authPath,
    authText,
    authExists: await exists(authPath),
  };
}

export const codexAdapter = {
  meta: { id: 'codex', platform: 'openai' },

  async resolveDir(dir) {
    return { dir, file: path.join(dir, 'config.toml') };
  },

  async readLive(dir) {
    const live = await liveFor(dir);
    live.providerId = providerIdOf(live.parsed?.model_provider?.startsWith?.(PROVIDER_PREFIX) ? live.parsed.model_provider : '');
    return live;
  },

  buildOps(live, payload, { entryKey }) {
    const pid = providerIdOf(entryKey);
    const doc = live.parsed && typeof live.parsed === 'object' ? { ...live.parsed } : {};
    doc.model_provider = pid;
    doc.model = payload.model || 'gpt-5';
    if (payload.reasoningEffort) doc.model_reasoning_effort = payload.reasoningEffort;
    doc.disable_response_storage = true;
    // codex 0.169+ 彻底移除 wire_api="chat"（官方 discussion #7782），写了会导致整个
    // config.toml 加载失败、桌面版闪退。强制收敛为 responses。
    const wireApi = payload.wireApi === 'chat' ? 'responses' : (payload.wireApi || 'responses');
    // base_url 尾斜杠会让 codex 拼 //v1/responses：非流式正常但流式 SSE 直接 0 事件关闭
    // （"stream closed before response.completed"）。必须去掉尾斜杠。
    const baseUrl = String(payload.baseUrl || '').replace(/\/+$/, '');
    const providers = { ...(doc[PROVIDERS_TABLE] && typeof doc[PROVIDERS_TABLE] === 'object' ? doc[PROVIDERS_TABLE] : {}) };
    providers[pid] = {
      ...(providers[pid] && typeof providers[pid] === 'object' ? providers[pid] : {}),
      name: payload.name || pid,
      base_url: baseUrl,
      wire_api: wireApi,
      experimental_bearer_token: payload.apiKey,
    };
    doc[PROVIDERS_TABLE] = providers;
    const ops = [{ path: live.path, text: stringifyToml(doc), containsSecret: true, wireApiCoerced: payload.wireApi === 'chat' }];
    // 注意：不再删除 auth.json。Codex 桌面版启动需要它（内含官方 OPENAI_API_KEY）；
    // model_provider 指向 relayhub provider 时 codex CLI 优先走 bearer token，auth.json 仅作备用。
    return ops;
  },

  stripOps(live, { entryKey }) {
    if (!live.parsed || typeof live.parsed !== 'object') return [];
    const doc = { ...live.parsed };
    const pid = providerIdOf(entryKey);
    for (const k of ROUTING_TOP) delete doc[k];
    const providers = doc[PROVIDERS_TABLE];
    if (providers && typeof providers === 'object') {
      const next = { ...providers };
      delete next[pid];
      if (Object.keys(next).length === 0) delete doc[PROVIDERS_TABLE];
      else doc[PROVIDERS_TABLE] = next;
    }
    const ops = [{ path: live.path, text: stringifyToml(doc), containsSecret: false }];
    // auth.json 不再删除，因此剥离时也不需要恢复它
    return ops;
  },

  detectActive(live) {
    const mp = typeof live.parsed?.model_provider === 'string' ? live.parsed.model_provider : null;
    if (mp && mp.startsWith(PROVIDER_PREFIX)) return mp;
    return null;
  },
};
