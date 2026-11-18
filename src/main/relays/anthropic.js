// Anthropic 直连协议：官方 API 或 anthropic 协议透传的中转站
// 无站点登录概念；Key 形如 sk-ant-...（透传站也常是自定义 sk-）
// 测活：GET /v1/models（x-api-key + anthropic-version），官方与多数透传站已支持
const UA = 'RelayHub/0.1 (+https://local)';
const ANTHROPIC_VERSION = '2023-06-01';
const TIMEOUT_MS = 15000;

export function createAnthropicClient({ baseUrl }) {
  async function verifyKey(apiKey, { model } = {}) {
    const root = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(new URL('v1/models', root), {
        headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'user-agent': UA },
      });
      if (!res.ok) return { ok: false, status: res.status };
      const json = await res.json().catch(() => null);
      const list = Array.isArray(json?.data) ? json.data : [];
      const models = list.map((m) => m?.id).filter(Boolean);
      return { ok: true, models, modelPresent: model ? models.includes(model) : null };
    } catch (err) {
      return { ok: false, error: String(err.message ?? err) };
    } finally { clearTimeout(timer); }
  }

  return {
    get session() { return {}; },
    login: async () => { throw new Error('anthropic 直连无站点登录，请直接粘贴 Key'); },
    self: async () => ({ quota: 0, note: 'anthropic 直连不提供余额查询' }),
    status: async () => ({}),
    listTokens: async () => [],
    createToken: async () => { throw new Error('anthropic 直连请手动添加 Key'); },
    verifyKey,
    todayUsage: async () => ({ quota: 0, rpm: 0, tpm: 0, note: 'anthropic 直连不提供用量统计' }),
    fetchPricing: async () => ({ models: [], groupRatio: {}, usableGroup: {}, note: 'anthropic 直连无站点定价' }),
  };
}
