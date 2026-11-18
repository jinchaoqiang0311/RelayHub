// 通用协议：官方 API / 未开放登录接口的中转站 → 手动粘贴 Key + Base URL
// 与 newapi 共用 verifyKey 逻辑，其余操作为本地管理。
import { createNewApiClient } from './newapi.js';

export function createGenericClient({ baseUrl }) {
  const inner = createNewApiClient({ baseUrl });
  return {
    get session() { return inner.session; },
    login: async () => { throw new Error('通用模式无站点登录，请直接粘贴 Key'); },
    self: async () => ({ quota: 0, note: '通用模式不提供余额查询' }),
    status: async () => ({}),
    listTokens: async () => [],
    createToken: async () => { throw new Error('通用模式请手动添加 Key'); },
    verifyKey: inner.verifyKey,
    todayUsage: async () => ({ quota: 0, rpm: 0, tpm: 0, note: '通用模式不提供用量统计' }),
    fetchPricing: async () => ({ models: [], groupRatio: {}, usableGroup: {}, note: '通用模式不提供定价数据' }),
  };
}

export function validateSkKey(key) {
  if (typeof key !== 'string') return 'Key 必须是字符串';
  const k = key.trim();
  if (!k) return 'Key 不能为空';
  if (k.length < 8) return 'Key 长度异常';
  return null;
}
