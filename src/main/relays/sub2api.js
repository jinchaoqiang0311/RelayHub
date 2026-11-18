// Sub2API（Wei-Shaw/sub2api）客户端：订阅号池型中转站
// 协议（源码核实：backend/internal/server/routes + handler）：
//   POST /api/v1/auth/login {email,password} → data:{access_token, refresh_token?, user:{id,balance(USD),...}}
//   POST /api/v1/auth/refresh {refresh_token} → 新 token 对
//   GET  /api/v1/user/profile（Bearer JWT）→ User{balance USD, frozen_balance}
//   GET  /api/v1/keys?page&page_size（Bearer）→ data:{items:[{id,key(完整),name,status:'active',quota(USD,0=无限),quota_used,expires_at}]}
//   POST /api/v1/keys {name,...} → data:APIKey
//   GET  /api/v1/groups/available → [Group]
//   网关（站点根）：GET /v1/models、POST /v1/messages、/v1/chat/completions、/v1/responses —— API Key Bearer 鉴权
//   信封：{code:0, message, data}；错误 {code: httpStatus, message, reason?}
// 注意：站点开启 Turnstile 时程序化登录会被拒，请走「贴 Key」模式。
import { localizeLoginError } from './newapi.js';

const UA = 'RelayHub/0.1 (+https://local)';
const TIMEOUT_MS = 15000;

function envelope(json, status) {
  if (json && typeof json === 'object' && 'code' in json) {
    if (json.code !== 0) {
      const err = new Error(json.message || `sub2api 错误 code=${json.code}`);
      err.code = status === 401 ? 'E_TOKEN_EXPIRED' : 'E_STATION';
      err.status = status;
      err.reason = json.reason ?? null;
      throw err;
    }
    return json.data;
  }
  return json;
}

async function request(baseUrl, urlPath, { method = 'GET', headers = {}, body, token, timeoutMs = TIMEOUT_MS } = {}) {
  const url = new URL(urlPath, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: {
        'user-agent': UA,
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    if (!res.ok && !(json && typeof json === 'object' && 'code' in json)) {
      const err = new Error(`HTTP ${res.status} ${res.statusText} @ ${urlPath}${text ? `: ${text.slice(0, 120)}` : ''}`);
      err.code = res.status === 401 ? 'E_TOKEN_EXPIRED' : 'E_HTTP';
      err.status = res.status;
      throw err;
    }
    return { res, json };
  } catch (err) {
    if (err.name === 'AbortError') {
      const e2 = new Error(`请求超时（${timeoutMs}ms）：${urlPath}`);
      e2.code = 'E_TIMEOUT';
      throw e2;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeKey(t) {
  const quota = Number(t.quota) || 0;
  const used = Number(t.quota_used) || 0;
  const unlimited = quota === 0;
  const remainUsd = unlimited ? null : Math.max(0, quota - used);
  let expiredTime = null;
  if (t.expires_at) {
    const ms = Date.parse(t.expires_at);
    if (!Number.isNaN(ms)) expiredTime = Math.floor(ms / 1000);
  }
  const key = t.key ? (String(t.key).startsWith('sk-') ? String(t.key) : 'sk-' + t.key) : null;
  return {
    id: String(t.id),
    name: t.name ?? `key-${t.id}`,
    key,
    groupId: t.group_id != null ? String(t.group_id) : null, // 所属分组（价格=官方价×分组倍率）
    status: t.status === 'active' ? 1 : 0,
    remainQuota: null,
    unlimited,
    usedQuota: null,
    usdRemain: remainUsd,
    expired: expiredTime !== null && expiredTime * 1000 < Date.now(),
    expiredTime,
    source: 'sub2api',
  };
}

export function createSub2ApiClient({ baseUrl, store }) {
  let session = { ...(store ?? {}) };

  async function authedRequest(urlPath, options = {}) {
    const attempt = async () => request(baseUrl, urlPath, { ...options, token: session.accessToken });
    try {
      return await attempt();
    } catch (err) {
      // Access Token 过期：先 refresh 一次再重试
      if (err.code === 'E_TOKEN_EXPIRED' && session.refreshToken && !options._retried) {
        const { json } = await request(baseUrl, '/api/v1/auth/refresh', {
          method: 'POST',
          body: { refresh_token: session.refreshToken },
        });
        const data = envelope(json, 200);
        if (data?.access_token) {
          session = { ...session, accessToken: data.access_token, ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}) };
          return attempt();
        }
      }
      throw err;
    }
  }

  async function login(username, password, opts = {}) {
    const body = { email: username, password };
    if (opts.turnstileToken) body.turnstile_token = opts.turnstileToken;
    const { res, json } = await request(baseUrl, '/api/v1/auth/login', { method: 'POST', body });
    if (json && typeof json === 'object' && json.code !== 0) {
      const raw = String(json.message ?? '');
      // 邮箱格式类错误已有专门提示，其余走统一映射表
      if (/email/i.test(raw)) {
        throw new Error('该站点登录必须使用邮箱（Email）作为账号名——请在「中转站」里把用户名改成注册邮箱后重试');
      }
      throw new Error(localizeLoginError(raw, res.status));
    }
    const data = envelope(json, 200);
    if (!data?.access_token) {
      // 有些分支要求邮箱格式：username 不是邮箱时给出明确指引
      if (/email/i.test(String(json?.message ?? ''))) {
        throw new Error('该站点登录必须使用邮箱（Email）作为账号名——请在「中转站」里把用户名改成注册邮箱后重试');
      }
      const err = new Error('登录成功但站点未返回 access_token');
      err.code = 'E_STATION';
      throw err;
    }
    session = {
      accessToken: data.access_token,
      ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
      userId: data.user?.id ?? session.userId,
      username: data.user?.email ?? username,
    };
    return { user: data.user, session };
  }

  /** 登录前置检查：站点是否要求 Turnstile 人机验证及其 sitekey */
  async function loginRequirements() {
    try {
      const { json } = await request(baseUrl, '/api/v1/settings/public', {});
      const data = envelope(json, 200);
      return { needsTurnstile: Boolean(data?.turnstile_enabled), siteKey: data?.turnstile_site_key ?? null };
    } catch {
      return { needsTurnstile: false, siteKey: null };
    }
  }

  async function self() {
    const { json } = await authedRequest('/api/v1/user/profile');
    const data = envelope(json, 200);
    return { id: data?.id, username: data?.username, email: data?.email, balance: data?.balance, frozenBalance: data?.frozen_balance };
  }

  async function status() {
    const { json } = await request(baseUrl, '/api/v1/settings/public', {});
    return envelope(json, 200);
  }

  async function listTokens() {
    const { json } = await authedRequest('/api/v1/keys?page=1&page_size=100');
    const data = envelope(json, 200);
    const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
    return items.filter((t) => t && typeof t === 'object').map(normalizeKey);
  }

  async function createToken({ name, unlimited = true } = {}) {
    const body = { name: name || `relayhub-${new Date().toISOString().slice(0, 10)}` };
    if (!unlimited) body.quota = 5; // 最低额度兜底；unlimited 时 quota 留空 = 不限制
    const { json } = await authedRequest('/api/v1/keys', { method: 'POST', body });
    const data = envelope(json, 200);
    if (!data?.key) throw new Error('令牌已创建但站点未返回 key，请在站内手动复制');
    return normalizeKey(data);
  }

  async function verifyKey(apiKey, { model } = {}) {
    const url = new URL('v1/models', baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${apiKey}`, 'user-agent': UA } });
      if (!res.ok) return { ok: false, status: res.status };
      const json = await res.json().catch(() => null);
      const models = (json?.data ?? []).map((m) => m?.id).filter(Boolean);
      return { ok: true, models, modelPresent: model ? models.includes(model) : null };
    } catch (err) {
      return { ok: false, error: String(err.message ?? err) };
    } finally { clearTimeout(timer); }
  }

  /** 今日消费：Sub2API 无公开日用量端点，返回不支持标记 */
  async function todayUsage() {
    return { quota: 0, rpm: 0, tpm: 0, supported: false, note: 'Sub2API 暂不提供日用量统计接口' };
  }

  /**
   * 定价：Sub2API 站点不发布单模型价格（model-plaza 多数关闭）。
   * 参考 my-api-box：官方参考价（价格表）× 分组倍率 估算，并标注估算来源。
   * keys: 站点的 Key 列表（含 groupId / models 可用模型），priceTable: 官方价格表。
   */
  async function fetchPricing({ keys = [], priceTable = null } = {}) {
    const groups = await authedRequest('/api/v1/groups/available').then(({ json }) => envelope(json, 200)).catch(() => []);
    const rates = await authedRequest('/api/v1/groups/rates').then(({ json }) => envelope(json, 200)).catch(() => null);
    const list = Array.isArray(groups) ? groups : [];
    const groupById = new Map(list.map((g) => [String(g.id), g]));
    // Key 没有缓存的可用模型列表时现场拉一次 /v1/models（最多 3 个，避免刷接口）
    let fetched = 0;
    for (const k of keys) {
      if ((k.models?.length ?? 0) > 0 || fetched >= 3 || !k.key) continue;
      const r = await verifyKey(k.key).catch(() => null);
      if (r?.ok && r.models?.length) { k.models = r.models; fetched += 1; }
    }
    const models = [];
    const seen = new Set();
    for (const k of keys) {
      const g = k.groupId ? groupById.get(String(k.groupId)) : null;
      const mult = Number(g?.rate_multiplier ?? k.groupRateMultiplier) || 1;
      const gName = g?.name ?? '(分组未绑定)';
      for (const name of k.models ?? []) {
        const dedupe = `${name}::${gName}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const off = priceTable?.[String(name).toLowerCase()] ?? null;
        models.push({
          model: name,
          group: gName,
          groupRateMultiplier: mult,
          modelRatio: mult,
          quotaType: 0,
          usdPerMillionInput: off ? off.usdIn * mult : null,
          usdPerMillionOutput: off ? off.usdOut * mult : null,
          cacheRead: off?.cacheRead != null ? off.cacheRead * mult : null,
          priceSource: off ? 'official_table' : 'unknown',
          officialKnown: Boolean(off),
          subscriptionType: g?.subscription_type ?? null,
          dailyLimitUsd: g?.daily_limit_usd ?? null,
          keyName: k.name,
        });
      }
    }
    // 无可用模型列表的 Key：至少展示其分组倍率（(分组) 占位行）
    for (const k of keys) {
      if (k.models?.length) continue;
      const g = k.groupId ? groupById.get(String(k.groupId)) : null;
      const gName = g?.name ?? '(分组未绑定)';
      const dedupe = `group::${gName}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      models.push({
        model: `(分组) ${gName}`,
        group: gName,
        groupRateMultiplier: Number(g?.rate_multiplier) || 1,
        modelRatio: Number(g?.rate_multiplier) || 1,
        quotaType: 0,
        usdPerMillionInput: null,
        usdPerMillionOutput: null,
        priceSource: 'group_only',
        officialKnown: false,
        subscriptionType: g?.subscription_type ?? null,
        keyName: k.name,
      });
    }
    return {
      models,
      groups: list.map((g) => ({ name: g.name ?? String(g.id), description: g.description ?? '', rateMultiplier: Number(g.rate_multiplier) || 1, subscriptionType: g.subscription_type ?? null })),
      rates: rates && typeof rates === 'object' ? rates : null,
      note: 'Sub2API 不发布单模型价格：已用官方参考价 × 分组倍率 估算（模型名不在官方价格表的显示 —）',
    };
  }

  return {
    get session() { return session; },
    login,
    loginRequirements,
    self,
    status,
    listTokens,
    createToken,
    verifyKey,
    todayUsage,
    fetchPricing,
  };
}
