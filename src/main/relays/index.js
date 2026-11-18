// 中转站客户端注册表 + 协议探测
import { createNewApiClient, probeProtocol } from './newapi.js';
import { createGenericClient, validateSkKey } from './generic.js';
import { createAnthropicClient } from './anthropic.js';
import { createSub2ApiClient } from './sub2api.js';
import { isMaskedKey } from './flavors.js';
import { localizeLoginError } from './newapi.js';

const CLIENTS = { newapi: createNewApiClient, generic: createGenericClient, anthropic: createAnthropicClient, sub2api: createSub2ApiClient };

export function clientFor(station, sessionStore = {}) {
  const factory = CLIENTS[station.protocol] ?? CLIENTS.generic;
  return factory({ baseUrl: station.baseUrl, store: station.session ?? sessionStore, flavor: station.flavor });
}

/** 操作报错中文化：给站点 HTTP 错误附加可行动的中文提示 */
export function localizeStationError(err) {
  const status = err?.status ?? 0;
  const msg = String(err?.message ?? err);
  if (status === 429 || /too many|429|频繁/i.test(msg)) return `${msg} —— 站点限流中，稍等 1–2 分钟再试`;
  if (status === 401 || /unauthorized|invalid access token|not logged in/i.test(msg)) {
    return `${msg} —— 会话已失效，请点「重新登录」重新抓一次会话`;
  }
  if (status >= 500) return `${msg} —— 站点服务器错误，稍后重试`;
  return msg;
}

export { validateSkKey, probeProtocol, isMaskedKey, localizeLoginError };
