// new-api / one-api 系中转站客户端（覆盖绝大多数中转站）
// 协议要点：
//   POST /api/user/login {username,password} → data:{id,...} + Set-Cookie(session)
//   新版 new-api 要求后续请求带 New-API-User: <userId> 头（防 CSRF）
//   GET /api/user/self → data:{quota, used_quota, ...}（余额）
//   GET /api/token/ → data:[{id, key, name, status, remain_quota, unlimited_quota, used_quota, expired_time}]
//   POST /api/token/ → 创建令牌（key 为 sk- 后缀，展示时补 sk-）
// 响应统一信封 {success, message, data}；不同分支（VoAPI/Veloera/one-hub）字段略有差异，做容错解析。
import { flavorFor, extractList, isMaskedKey } from './flavors.js';

/**
 * 登录错误中文化：把站点返回的英文/技术性报错映射成用户能直接行动的中文提示。
 * 匹配按序进行，命中即返回；未命中保留原文（附中文引导）。
 */
export function localizeLoginError(rawMessage, status) {
  const msg = String(rawMessage ?? '');
  const s = status ?? 0;
  const rules = [
    [/turnstile.*empty|turnstile.*为空/i, '人机验证未通过：Turnstile token 为空——请点「重新登录」走浏览器代登（在窗口里手动点验证）'],
    [/turnstile|verification failed/i, '人机验证未通过：请点「重新登录」在打开的窗口里手动完成 Turnstile 验证'],
    [/invalid (username|password|email|credential)|wrong (password|username|email)|密码错误|用户名或密码/i, '用户名或密码错误——请检查账号密码（注意大小写）；Sub2API 类站点请用注册邮箱登录'],
    [/user (not )?exist|account (not )?exist|用户不存在/i, '账号不存在——确认用户名/邮箱是否注册过该站点'],
    [/has been (banned|disabled)|account.*(banned|disabled|blocked)|已被封禁|封禁/i, '账号已被封禁或禁用——请联系站点管理员'],
    [/too many|rate.?limit|429|频繁/i, '登录尝试过于频繁（站点限流）——请等 1–2 分钟后再试'],
    [/2fa|two.?factor|totp|verification code/i, '该账号开启了两步验证（2FA）——请在站点网页登录一次完成验证，或关闭 2FA 后再试'],
    [/email.*valid|valid.*email|failed on the .email/i, '该站点要求用注册邮箱登录——请把用户名改成完整邮箱地址'],
    [/require.*(email|register)|email.*required/i, '该站点要求用注册邮箱登录——请把用户名改成完整邮箱地址'],
    [/password.*encrypt|encryption/i, '站点要求加密传输密码——请通过「重新登录」的浏览器窗口登录'],
    [/invalid request/i, '登录请求被站点拒绝（参数校验失败）——检查用户名格式（邮箱类站点需填邮箱）'],
  ];
  for (const [re, zh] of rules) {
    if (re.test(msg)) return zh;
  }
  if (s === 401 || s === 403) return '登录被拒绝（鉴权失败）——检查账号密码，或站点可能要求人机验证，请试「重新登录」走浏览器代登';
  if (s === 429) return '登录尝试过于频繁（站点限流）——请等 1–2 分钟后再试';
  if (s >= 500) return '站点服务器错误——稍后重试，或联系站点管理员';
  return `${msg}（站点原始报错）`;
}


const UA = 'RelayHub/0.1 (+https://local)';
const TIMEOUT_MS = 15000;
const TOKEN_REFRESH_AHEAD_S = 60; // access token 剩 60s 内视作过期，提前刷新

/**
 * 解析 tiered 计费表达式 → 真实 USD 价格（每百万 tokens）。
 * 参考实现：my-api-box parseNewApiBillingExpression / new-api pkg/billingexpr/expr.md
 * 变量：p=输入(prompt) cr=缓存读 cc=缓存写5m cc1h=缓存写1h c=输出(completion)，系数即 USD/M。
 * 支持：①tier("名", 系数式) ②len 条件多档（len <= 272000 ? tier(...) : tier(...)）
 *      ③fixed(N) 按次计费（N 美元/次）④无 tier 包装的线性式（视为 base 档）⑤v1: 前缀
 */
export function parseBillingExpr(expr) {
  if (!expr || typeof expr !== 'string' || expr.length > 4096) return null;
  let rest = expr.trim().replace(/^v1:\s*/, '');
  // 线性式无 tier 包装：p * 2 + c * 4 → 视为 base 档
  if (!rest.startsWith('tier(') && /^((?:p|c|cr|cc|cc1h)\s*\*\s*[\d.]+\s*\+\s*)*(?:(?:p|c|cr|cc|cc1h)\s*\*\s*[\d.]+)$/.test(rest)) {
    rest = `tier("base", ${rest})`;
  }
  const tiers = [];
  let lastLE = null; // 上一档的 len <= 边界，else 档继承为 >
  let guard = 0;
  while (rest && guard++ < 8) {
    let cond = null;
    const qm = rest.indexOf('?');
    const tStart = rest.indexOf('tier(');
    if (qm >= 0 && tStart > qm) {
      cond = rest.slice(0, qm).trim(); // 例如 "len <= 272000"
      rest = rest.slice(qm + 1).trim();
    }
    const tm = /^tier\(\s*"([^"]{0,120})"\s*,\s*(fixed\(\s*([\d.]+)\s*\)|[^()]*)\s*\)\s*/.exec(rest);
    if (!tm) return null;
    const name = tm[1] || 'base';
    const fixedVal = tm[3] != null ? Number(tm[3]) : null;
    rest = rest.slice(tm[0].length);
    if (rest.startsWith(':')) rest = rest.slice(1).trim();
    const coeff = {};
    let perRequest = null;
    if (fixedVal != null) {
      perRequest = fixedVal; // fixed(N) = N 美元/次
    } else {
      for (const term of (tm[2] ?? '').split('+')) {
        const t = /^\s*(cc1h|cc|cr|c|p)\s*\*\s*([\d.]+)\s*$/i.exec(term);
        if (!t) return null;
        coeff[t[1].toLowerCase()] = Number(t[2]);
      }
      if (coeff.p == null && coeff.c == null) return null;
    }
    // len 条件 → 档位范围标签（≤272k / >272k）
    let rangeLabel = null;
    if (cond) {
      const le = /len\s*<=\s*([\d_]+)/i.exec(cond);
      const gt = /len\s*>\s*([\d_]+)/i.exec(cond);
      if (le) { lastLE = Number(le[1].replace(/_/g, '')); rangeLabel = `≤${lastLE / 1000}k`; }
      else if (gt) { lastLE = Number(gt[1].replace(/_/g, '')); rangeLabel = `>${lastLE / 1000}k`; }
    } else if (lastLE != null) {
      rangeLabel = `>${lastLE / 1000}k`;
      lastLE = null;
    }
    tiers.push({
      name,
      cond,
      rangeLabel,
      usdIn: perRequest != null ? perRequest : (coeff.p ?? null),
      usdOut: perRequest != null ? perRequest : (coeff.c ?? null),
      cacheRead: coeff.cr ?? null,
      cacheWrite5m: coeff.cc ?? null,
      cacheWrite1h: coeff.cc1h ?? null,
      perRequest,
    });
  }
  if (!tiers.length) return null;
  return { tiers, standard: tiers[0] };
}

/** 把 Set-Cookie 响应头并入现有 cookie 串（同名覆盖；Max-Age=0/Expires 过期则删除） */
export function mergeSetCookie(oldCookieStr, setCookieHeader) {
  if (!setCookieHeader) return oldCookieStr ?? '';
  const jar = new Map();
  for (const pair of String(oldCookieStr ?? '').split(';')) {
    const t = pair.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    jar.set(t.slice(0, i).trim(), t.slice(i + 1).trim());
  }
  const parts = String(setCookieHeader).split(/,(?=[^;]+?=)/);
  for (const part of parts) {
    const segs = part.split(';').map((s) => s.trim());
    const first = segs[0];
    if (!first) continue;
    const i = first.indexOf('=');
    if (i < 0) continue;
    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1).trim();
    const attrs = segs.slice(1).join(';').toLowerCase();
    const deleted = value === '' || /max-age\s*=\s*(0|-\d)/.test(attrs) || /expires\s*=\s*thu,\s*01\s*jan\s*1970/.test(attrs);
    if (deleted) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** 解析 access token 的过期时间戳（秒）；非 JWT 返回 null */
function jwtExpSeconds(token) {
  if (typeof token !== 'string' || token.split('.').length < 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload?.exp) ? payload.exp : null;
  } catch { return null; }
}

/** 协议探测：只读访问站点公开端点，识别 one-api/new-api 系 / Sub2API 及分支特征 */
export async function probeProtocol(baseUrl, { timeoutMs = 8000 } = {}) {
  const root = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  const out = { reachable: false, family: null, version: null, systemName: null, tokenApi: null, openaiCompat: null, raw: null };
  const fetchJson = async (path, headers = {}) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(new URL(path, root), { signal: ctrl.signal, headers: { 'user-agent': UA, accept: 'application/json', ...headers } });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 忽略非 JSON */ }
      return { status: res.status, json };
    } catch {
      return { status: 0, json: null };
    } finally { clearTimeout(timer); }
  };

  const [status, sub2api] = await Promise.all([fetchJson('api/status'), fetchJson('api/v1/settings/public')]);
  if (status.status === 0 && sub2api.status === 0) return out; // 完全不可达
  out.reachable = true;

  // Sub2API 指纹：/api/v1/settings/public 返回 code:0 信封
  // （tokenshop 等站 /api/status 404，只能靠这个端点识别；sub2api 的面板 API 全在 /api/v1 下）
  if (sub2api.json && typeof sub2api.json === 'object' && sub2api.json.code === 0) {
    out.family = 'sub2api';
    out.systemName = 'Sub2API';
    const token = await fetchJson('api/v1/keys');
    out.tokenApi = token.status === 0 ? null : (token.status === 404 ? false : true);
    const models = await fetchJson('v1/models');
    out.openaiCompat = models.status === 0 ? null : (models.status === 404 ? false : true);
    return out;
  }

  // 无 status 也无 sub2api 指纹：若 /api/v1/auth/login 存在（405/400/422 都算），也认 sub2api
  if (status.status === 404 && sub2api.status === 404) {
    const probe2 = await fetchJson('api/v1/auth/login');
    if (probe2.status !== 0 && probe2.status !== 404) {
      out.family = 'sub2api';
      out.systemName = 'Sub2API';
      out.tokenApi = true;
      const models = await fetchJson('v1/models');
      out.openaiCompat = models.status === 0 ? null : (models.status === 404 ? false : true);
      return out;
    }
  }

  if (status.json && typeof status.json === 'object') {
    const data = status.json.data ?? status.json;
    if (data && typeof data === 'object') {
      out.family = 'newapi';
      out.version = data.version ?? null;
      out.systemName = data.system_name ?? null;
      out.raw = { version: data.version ?? null, system_name: data.system_name ?? null };
    }
  }

  // /api/token/ 无鉴权：401/403 → 令牌 API 存在；200 → 存在（异常配置）；404 → 非该协议
  const token = await fetchJson('api/token/');
  out.tokenApi = token.status === 0 ? null : (token.status === 404 ? false : true);

  // OpenAI 兼容端点存在性（不做鉴权，仅看状态码族）
  const models = await fetchJson('v1/models');
  out.openaiCompat = models.status === 0 ? null : (models.status === 404 ? false : true);
  return out;
}

function envelope(json, status) {
  if (json && typeof json === 'object' && 'success' in json) {
    if (json.success === false) {
      const err = new Error(json.message || '中转站返回失败');
      err.code = 'E_STATION';
      err.status = status;
      throw err;
    }
    return json.data;
  }
  if (json && typeof json === 'object' && 'data' in json) return json.data;
  return json;
}

async function request(baseUrl, urlPath, { method = 'GET', headers = {}, body, cookie, userId, timeoutMs = TIMEOUT_MS } = {}) {
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
        ...(cookie ? { cookie } : {}),
        ...(userId ? { 'new-api-user': String(userId) } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 响应（可能登录页） */ }
    if (!res.ok) {
      // 所有非 2xx 都抛带 status 的错：429 限流、401 等状态码不丢（限流响应未必带 success 信封）
      const err = new Error(`HTTP ${res.status} ${res.statusText} @ ${urlPath}${text ? `: ${text.slice(0, 120)}` : ''}`);
      err.code = res.status === 429 ? 'E_RATE_LIMITED' : 'E_HTTP';
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

export function createNewApiClient({ baseUrl, store, flavor }) {
  // store: {cookie, userId, accessToken} 可由调用方注入（会话缓存）
  const fl = flavorFor(flavor ?? store?.flavor);
  let session = { ...(store ?? {}) };

  async function login(username, password, opts = {}) {
    // 开启 Turnstile 的站点：token 必须放在 URL query「?turnstile=」（middleware c.Query("turnstile")）
    const urlPath = opts.turnstileToken
      ? `/api/user/login?turnstile=${encodeURIComponent(opts.turnstileToken)}`
      : '/api/user/login';
    const { res, json } = await request(baseUrl, urlPath, { method: 'POST', body: { username, password } });
    // 登录失败：站点报错中文化后抛出（用户能直接行动）
    if (json && typeof json === 'object' && json.success === false) {
      throw new Error(localizeLoginError(json.message, res.status));
    }
    if (!res.ok && !(json && typeof json === 'object' && 'success' in json)) {
      throw new Error(localizeLoginError(`HTTP ${res.status} ${res.statusText}`, res.status));
    }
    const data = envelope(json);
    const setCookie = res.headers.get('set-cookie') ?? '';
    const cookie = setCookie.split(/,(?=[^;]+?=)/).map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
    session = {
      cookie: mergeSetCookie(cookie || session.cookie, setCookie),
      userId: data?.id ?? data?.user?.id ?? session.userId,
      username: data?.username ?? data?.user?.username ?? data?.user?.email ?? username,
      ...(session.accessToken ? { accessToken: session.accessToken } : {}),
      ...(data?.access_token ? { accessToken: data.access_token, accessExpiresAt: data.access_expires_at ?? jwtExpSeconds(data.access_token) ?? null } : {}),
      ...(data?.refresh_token ? { refreshToken: data.refresh_token } : {}),
      ...(data?.session?.sid ? { sid: data.session.sid } : {}),
    };
    // JWT 型分支（VoAPI 系）：从登录响应提取令牌，后续请求走 Bearer
    if (fl.auth === 'jwt' && data && typeof data === 'object') {
      for (const f of fl.loginTokenFields) {
        if (typeof data[f] === 'string' && data[f]) { session.accessToken = data[f]; break; }
      }
    }
    return { user: data, session };
  }

  /** 登录前置检查：站点是否要求 Turnstile 人机验证及其 sitekey */
  async function loginRequirements() {
    try {
      const { json } = await request(baseUrl, '/api/status', {});
      const data = envelope(json);
      return { needsTurnstile: Boolean(data?.turnstile_check), siteKey: data?.turnstile_site_key ?? null };
    } catch {
      return { needsTurnstile: false, siteKey: null };
    }
  }

  function authHeaders() {
    return session.accessToken ? { authorization: `Bearer ${session.accessToken}` } : {};
  }

  /**
   * 新版 new-api（rc.4x+）：cookie 只是 refresh 凭证（new_api_refresh / new_api_has_session），
   * 面板 API 要 Bearer access token。POST /api/user/auth/refresh 用 cookie 换 bundle。
   * 注意：refresh cookie 是一次性轮换的——每次成功都必须保存响应里的新 Set-Cookie。
   */
  async function refreshAccessToken() {
    const headers = { ...authHeaders() };
    if (session.sid) headers['x-auth-session'] = session.sid;
    const { res, json } = await request(baseUrl, '/api/user/auth/refresh', {
      method: 'POST',
      cookie: session.cookie,
      userId: session.userId,
      headers,
      body: {},
    });
    // 先吸收轮换后的 cookie（成功失败都要，失败时也可能刷新了标记位）
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) session.cookie = mergeSetCookie(session.cookie, setCookie);
    let data;
    try {
      data = envelope(json);
    } catch (err) {
      const stale = /REVOKED|EXPIRED|UNAUTHORIZED/i.test(String(json?.code ?? '') + String(json?.message ?? ''));
      if (stale) {
        const e2 = new Error('登录会话已失效（refresh 令牌已轮换或被撤销），请重新点「登录」再抓一次会话');
        e2.code = 'E_RELOGIN_REQUIRED';
        throw e2;
      }
      throw err;
    }
    if (!data?.access_token) {
      const e2 = new Error('刷新失败：站点未返回 access_token，请重新登录');
      e2.code = 'E_RELOGIN_REQUIRED';
      throw e2;
    }
    session.accessToken = data.access_token;
    session.accessExpiresAt = data.access_expires_at ?? jwtExpSeconds(data.access_token) ?? null;
    if (data.refresh_token) session.refreshToken = data.refresh_token;
    session.userId = data.user?.id ?? session.userId;
    session.username = data.user?.username ?? data.user?.email ?? session.username;
    if (data.session?.sid) session.sid = data.session.sid;
    return data;
  }

  /** 确保手上有可用的 Bearer token：没有或快过期就 refresh；旧版纯 session 模式刷新失败不阻塞 */
  async function ensureAccessToken() {
    const expiring = session.accessExpiresAt != null
      && session.accessExpiresAt - TOKEN_REFRESH_AHEAD_S <= Math.floor(Date.now() / 1000);
    const hasToken = Boolean(session.accessToken) && !expiring;
    if (hasToken) return;
    if (!session.cookie && !session.refreshToken) return;
    if (session.accessToken && expiring) {
      session.accessToken = null; // 过期即丢弃，避免拿着废 token 请求
    }
    try { await refreshAccessToken(); } catch (err) {
      if (err.code === 'E_RELOGIN_REQUIRED') throw err; // 明确要求重新登录，不静默
      /* 旧版 session+New-Api-User 模式：静默降级 */
    }
  }

  async function self() {
    await ensureAccessToken();
    const { json } = await request(baseUrl, '/api/user/self', { cookie: session.cookie, userId: session.userId, headers: authHeaders() });
    return envelope(json);
  }

  async function status() {
    const { json } = await request(baseUrl, '/api/status', {});
    return envelope(json);
  }

  async function listTokens() {
    await ensureAccessToken();
    const { json } = await request(baseUrl, '/api/token/?p=1&size=100', { cookie: session.cookie, userId: session.userId, headers: authHeaders() });
    const data = envelope(json);
    const items = extractList(data, fl.listKeys);
    return items.filter((t) => t && typeof t === 'object').map((t) => ({
      id: t.id,
      name: t.name ?? `token-${t.id}`,
      key: t.key ? (String(t.key).startsWith('sk-') ? String(t.key) : 'sk-' + t.key) : null,
      masked: isMaskedKey(t.key),
      status: t.status,
      remainQuota: t.remain_quota,
      unlimited: Boolean(t.unlimited_quota),
      usedQuota: t.used_quota,
      expiredTime: t.expired_time,
      createdAt: t.created_time,
    }));
  }

  /**
   * 取回完整 Key：新版 new-api 列表打码，官方途径是 POST /api/token/:id/key。
   * 该端点带 CriticalRateLimit，429 时指数退避重试；成功后完整 Key 由调用方缓存，不再重复取。
   */
  async function revealKey(tokenId, { maxRetries = 2 } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        await ensureAccessToken();
        const { res, json } = await request(baseUrl, `/api/token/${encodeURIComponent(tokenId)}/key`, {
          method: 'POST',
          cookie: session.cookie,
          userId: session.userId,
          headers: authHeaders(),
          body: {},
        });
        const data = envelope(json, res.status);
        const full = data?.key ?? data;
        if (typeof full !== 'string' || !full || isMaskedKey(full)) {
          throw new Error('站点未返回完整 Key（可能已改用其他隐私策略）');
        }
        return String(full).startsWith('sk-') ? String(full) : 'sk-' + full;
      } catch (err) {
        lastErr = err;
        const is429 = err.status === 429 || /too many|429|限流|频繁|rate.?limit/i.test(String(err.message ?? ''));
        if (!is429 || attempt >= maxRetries) break;
        // 退避：4s → 8s，给站点限流窗口恢复时间
        await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
      }
    }
    if (lastErr?.status === 429 || /too many|429|限流|频繁/i.test(String(lastErr?.message ?? ''))) {
      const e2 = new Error('站点限流（429）：取完整 Key 太频繁，请稍后再试。完整 Key 成功后会自动缓存，不会重复索取。');
      e2.code = 'E_RATE_LIMITED';
      e2.status = 429;
      throw e2;
    }
    throw lastErr;
  }

  async function createToken({ name, unlimited = true }) {
    await ensureAccessToken();
    const body = {
      name: name || `relayhub-${new Date().toISOString().slice(0, 10)}`,
      remain_quota: 0,
      unlimited_quota: unlimited,
      expired_time: -1,
      model_limits_enabled: false,
      model_limits: '',
      group: '',
    };
    const { json } = await request(baseUrl, '/api/token/', { method: 'POST', cookie: session.cookie, userId: session.userId, headers: authHeaders(), body });
    const data = envelope(json);
    if (data?.key) {
      const key = String(data.key).startsWith('sk-') ? String(data.key) : 'sk-' + data.key;
      return { id: data.id ?? null, name: data.name ?? body.name, key };
    }
    // 有的分支创建后不回显 key，改走列表
    const tokens = await listTokens();
    const hit = tokens.find((t) => t.name === body.name && t.key);
    if (!hit) throw new Error('令牌已创建但站点未返回 key，请在站内手动复制');
    return hit;
  }

  async function verifyKey(apiKey, { model } = {}) {
    // 用 sk key 打一次 /v1/models 验证可用性（OpenAI 兼容端点）
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

  /** 今日消费：GET /api/log/self/stat（quota 原始单位，调用方换算 USD） */
  async function todayUsage({ startTimestamp, endTimestamp }) {
    await ensureAccessToken();
    const qs = `?type=0&start_timestamp=${startTimestamp}&end_timestamp=${endTimestamp}`;
    const { json } = await request(baseUrl, `/api/log/self/stat${qs}`, { cookie: session.cookie, userId: session.userId, headers: authHeaders() });
    const data = envelope(json, 200) ?? {};
    return { quota: Number(data.quota) || 0, rpm: Number(data.rpm) || 0, tpm: Number(data.tpm) || 0 };
  }

  /** 定价 + 充值比例（usd_exchange_rate 来自 /api/status，站点未提供时 null）
   *  新版 new-api（如 aicost/aixoras）的 /api/pricing 需登录会话：有 cookie 就带上并重试匿名 */
  async function fetchPricing() {
    const attempt = async (useSession) => {
      const reqOpts = useSession
        ? { cookie: session.cookie, userId: session.userId, headers: authHeaders() }
        : {};
      const [pricingRes, statusRes] = await Promise.all([
        request(baseUrl, '/api/pricing', reqOpts),
        request(baseUrl, '/api/status', {}).catch(() => null),
      ]);
      return { pricingRes, statusRes };
    };
    let pricingRes, statusRes;
    try {
      ({ pricingRes, statusRes } = await attempt(true)); // 有会话优先带会话
    } catch (err) {
      if (!session.cookie && !session.accessToken) throw err;
      ({ pricingRes, statusRes } = await attempt(false).catch(() => ({ pricingRes: null, statusRes: null }))); // 带会话失败回退匿名
    }
    if (!pricingRes) throw new Error('定价接口不可达');
    if (pricingRes.res.status === 401 || pricingRes.res.status === 403) {
      const e2 = new Error('定价接口需要登录会话——请先点「重新登录」后再拉取定价');
      e2.code = 'E_RELOGIN_REQUIRED';
      throw e2;
    }
    const pricingJson = pricingRes.json;
    const statusData = (() => {
      try { const d = envelope(statusRes?.json, statusRes?.res?.status); return d && typeof d === 'object' ? d : null; } catch { return null; }
    })();
    // 强制限定：所有站点汇率一律 1:1（站点自带的 usd_exchange_rate 不采信，避免不同站口径不一）
    const usdExchangeRate = 1;
    const priceUnit = Number(statusData?.price) || null;
    // 经典倍率换算的单位基数：USD/M = ratio × 1e6 / quota_per_unit（默认 500000 → ×2）
    const quotaPerUnit = Number(statusData?.quota_per_unit) || 500000;

    const env = pricingJson ? envelope(pricingJson, pricingRes.res.status) : null;
    // envelope 已解包一层 {success, data}；兼容站点把 data 再包一层（data.data）或直接返回数组的形态
    const payload = Array.isArray(env) ? env : (env?.data ?? env);
    const ratioSrcForVendors = env && !Array.isArray(env) ? env : (pricingJson ?? {});
    // 站点原生厂商表：vendors[{id,name}] + 每个模型 vendor_id → vendorName
    const vendorById = new Map();
    for (const v of Array.isArray(ratioSrcForVendors?.vendors) ? ratioSrcForVendors.vendors : []) {
      if (v && Number.isFinite(Number(v.id)) && typeof v.name === 'string' && v.name.trim()) vendorById.set(Number(v.id), v.name.trim());
    }
    const models = (Array.isArray(payload) ? payload : (Array.isArray(env) ? env : [])).filter((m) => m && m.model_name).map((m) => {
      // 价格来源优先级：tiered 计费表达式（站点真实价）> 按次 model_price > 倍率×$2/M（经典估算）
      const parsed = parseBillingExpr(m.billing_expr);
      const byCount = m.quota_type === 1;
      const exprPerReq = parsed?.standard?.perRequest ?? null;
      const usdIn = byCount
        ? Number(m.model_price) || 0
        : exprPerReq != null
          ? exprPerReq
          : parsed?.standard?.usdIn ?? (Number(m.model_ratio) || 0) * (1e6 / quotaPerUnit);
      const usdOut = byCount
        ? Number(m.model_price) || 0
        : exprPerReq != null
          ? exprPerReq
          : parsed?.standard?.usdOut ?? (Number(m.model_ratio) || 0) * (Number(m.completion_ratio) || 1) * (1e6 / quotaPerUnit);
      return {
        model: m.model_name,
        vendorName: vendorById.get(Number(m.vendor_id)) ?? null,
        quotaType: m.quota_type ?? 0,
        modelRatio: Number(m.model_ratio) || 0,
        modelPrice: Number(m.model_price) || 0,
        completionRatio: Number(m.completion_ratio) || 1,
        groups: Array.isArray(m.enable_groups) ? m.enable_groups : [],
        billingMode: m.billing_mode ?? null,
        billingExpr: m.billing_expr ?? null,
        endpoints: Array.isArray(m.supported_endpoint_types) ? m.supported_endpoint_types : [],
        // 站点标价（不含分组倍率）——分组倍率在展示层按所选分组动态叠加
        usdPerMillionInput: usdIn,
        usdPerMillionOutput: usdOut,
        priceSource: byCount ? 'per_call' : (parsed ? (exprPerReq != null ? 'expr_fixed' : 'expr') : 'ratio'),
        tiers: parsed?.tiers ?? null, // 长上下文多档价格（含 len 范围标签）
        perRequest: exprPerReq,
        cacheRead: parsed?.standard?.cacheRead ?? null,
        cacheWrite5m: parsed?.standard?.cacheWrite5m ?? null,
        cacheWrite1h: parsed?.standard?.cacheWrite1h ?? null,
      };
    });
    const ratioSrc = env && !Array.isArray(env) ? env : (pricingJson ?? {});
    return {
      models,
      groupRatio: ratioSrc?.group_ratio && typeof ratioSrc.group_ratio === 'object' ? ratioSrc.group_ratio : {},
      usableGroup: ratioSrc?.usable_group && typeof ratioSrc.usable_group === 'object' ? ratioSrc.usable_group : {},
      vendors: Array.isArray(ratioSrc?.vendors) ? ratioSrc.vendors : [],
      usdExchangeRate,
      priceUnit,
      quotaPerUnit,
    };
  }

  return {
    get session() { return session; },
    login,
    loginRequirements,
    refreshAccessToken,
    self,
    status,
    listTokens,
    revealKey,
    createToken,
    verifyKey,
    todayUsage,
    fetchPricing,
  };
}
