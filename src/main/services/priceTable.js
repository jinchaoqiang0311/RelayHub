// 官方模型价格表：LiteLLM 口径（USD per M tokens）
// 来源优先级：本地缓存（7 天）→ LiteLLM GitHub JSON → 内置热门模型兜底
import fsp from 'node:fs/promises';
import path from 'node:path';

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const TTL_MS = 7 * 24 * 3600 * 1000;

/** 内置兜底：主流模型官方价（USD per M tokens），LiteLLM 拉取失败时使用 */
export const EMBEDDED_PRICE_TABLE = {
  'claude-opus-4-5': { usdIn: 5, usdOut: 25 },
  'claude-opus-4-6': { usdIn: 5, usdOut: 25 },
  'claude-opus-4-1': { usdIn: 15, usdOut: 75 },
  'claude-sonnet-4-5': { usdIn: 3, usdOut: 15 },
  'claude-sonnet-4-6': { usdIn: 3, usdOut: 15 },
  'claude-sonnet-5-5': { usdIn: 2, usdOut: 10 },
  'claude-haiku-4-5': { usdIn: 1, usdOut: 5 },
  'claude-haiku-4-6': { usdIn: 1, usdOut: 5 },
  'gpt-5': { usdIn: 1.25, usdOut: 10 },
  'gpt-5.1': { usdIn: 1.25, usdOut: 10 },
  'gpt-5-mini': { usdIn: 0.25, usdOut: 2 },
  'gpt-5-nano': { usdIn: 0.05, usdOut: 0.4 },
  'gpt-4.1': { usdIn: 2, usdOut: 8 },
  'gpt-4o': { usdIn: 2.5, usdOut: 10 },
  'gpt-4o-mini': { usdIn: 0.15, usdOut: 0.6 },
  'o3': { usdIn: 2, usdOut: 8 },
  'o4-mini': { usdIn: 1.1, usdOut: 4.4 },
  'gemini-2.5-pro': { usdIn: 1.25, usdOut: 10 },
  'gemini-2.5-flash': { usdIn: 0.3, usdOut: 2.5 },
  'deepseek-chat': { usdIn: 0.27, usdOut: 1.1 },
  'deepseek-reasoner': { usdIn: 0.55, usdOut: 2.19 },
  'qwen-max': { usdIn: 1.6, usdOut: 6.4 },
  'qwen3-max': { usdIn: 1.2, usdOut: 6 },
  'glm-4.5': { usdIn: 0.6, usdOut: 2.2 },
  'kimi-k2': { usdIn: 0.6, usdOut: 2.5 },
};

function normalizeLiteLLM(raw) {
  const table = {};
  for (const [name, v] of Object.entries(raw ?? {})) {
    if (!v || typeof v !== 'object') continue;
    const inTok = Number(v.input_cost_per_token);
    const outTok = Number(v.output_cost_per_token);
    if (!Number.isFinite(inTok) || !Number.isFinite(outTok)) continue;
    const row = {
      usdIn: inTok * 1e6,
      usdOut: outTok * 1e6,
    };
    const cr = Number(v.cache_read_input_token_cost);
    const cw = Number(v.cache_creation_input_token_cost);
    if (Number.isFinite(cr) && cr >= 0) row.cacheRead = cr * 1e6;
    if (Number.isFinite(cw) && cw >= 0) row.cacheWrite = cw * 1e6;
    table[name.toLowerCase()] = row;
  }
  return table;
}

/**
 * 获取官方价格表（model → {usdIn, usdOut, cacheRead?, cacheWrite?}，USD per M tokens）。
 * 本地缓存 7 天；LiteLLM 拉取失败时回退内置表并标记 partial。
 */
export async function getOfficialPriceTable({ dataDir, force = false } = {}) {
  const cacheFile = dataDir ? path.join(dataDir, 'official-prices.json') : null;
  if (!force && cacheFile) {
    try {
      const cached = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
      if (cached?.fetchedAt && Date.now() - cached.fetchedAt < TTL_MS && cached.table && Object.keys(cached.table).length) {
        return { ...cached, cached: true };
      }
    } catch { /* 无缓存 */ }
  }
  let table = null;
  let source = 'embedded';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(LITELLM_URL, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    clearTimeout(timer);
    if (res.ok) {
      const raw = await res.json();
      const normalized = normalizeLiteLLM(raw);
      if (Object.keys(normalized).length > 100) {
        table = normalized;
        source = 'litellm';
      }
    }
  } catch { /* 网络/墙：走兜底 */ }
  if (!table) {
    table = { ...EMBEDDED_PRICE_TABLE };
    // 内置表补全缓存字段为 null 占位，保持结构一致
    for (const row of Object.values(table)) {
      if (row.cacheRead === undefined) row.cacheRead = null;
      if (row.cacheWrite === undefined) row.cacheWrite = null;
    }
  }
  const result = { table, source, fetchedAt: Date.now(), partial: source === 'embedded' };
  if (cacheFile) {
    try {
      await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
      await fsp.writeFile(cacheFile, JSON.stringify(result), 'utf8');
    } catch { /* 缓存写入失败不影响返回 */ }
  }
  return result;
}
