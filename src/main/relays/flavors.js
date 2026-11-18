// 站点分支（flavor）：one-api 家族各分支的真实差异收敛
// 差异不在 header 大小写（HTTP 头不区分大小写），而在：
//   1) 鉴权方式：session-cookie（new-api/one-api/One-Hub/Veloera） vs 登录返回 JWT 用 Bearer（VoAPI 系）
//   2) 列表响应形态：data:[...]（多数） vs data.items / data.records（One-Hub 及部分二开）
export const FLAVORS = {
  auto: { id: 'auto', label: '自动（按 new-api 标准）', auth: 'session', loginTokenFields: [], listKeys: ['items', 'records', 'list'] },
  newapi: { id: 'newapi', label: 'new-api / one-api', auth: 'session', loginTokenFields: [], listKeys: ['items', 'records', 'list'] },
  onehub: { id: 'onehub', label: 'One-Hub', auth: 'session', loginTokenFields: [], listKeys: ['items', 'records', 'list', 'data'] },
  voapi: { id: 'voapi', label: 'VoAPI', auth: 'jwt', loginTokenFields: ['token', 'access_token', 'jwt'], listKeys: ['items', 'records', 'list'] },
  veloera: { id: 'veloera', label: 'Veloera', auth: 'session', loginTokenFields: [], listKeys: ['items', 'records', 'list'] },
};

export function flavorFor(id) {
  return FLAVORS[id] ?? FLAVORS.auto;
}

/** 从任意已知形态中抽出令牌数组 */
export function extractList(data, listKeys) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const k of listKeys) {
    if (Array.isArray(data[k])) return data[k];
  }
  return [];
}

/** 站点端打码 Key 检测：sk-Fzob**********Ih4O 这类串不能直接用于网关调用 */
export function isMaskedKey(key) {
  if (typeof key !== 'string' || !key) return false;
  return /\*{2,}|…|\.\.\./.test(key);
}
