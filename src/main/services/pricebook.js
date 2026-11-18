// 本地价格库：把各站定价归一化落盘（dataDir/pricebook.json），站点更新即整站覆盖
// 归一化条目：{ stationId, stationName, protocol, model, modelKey, group, groupRatio,
//              usdIn, usdOut, usdPerRequest, priceSource, known, cnyIn, cnyOut, ratio, fetchedAt }
import fsp from 'node:fs/promises';
import path from 'node:path';

const FILE = 'pricebook.json';
const VERSION = 1;

/** 公司下拉的置顶顺序（其余按名称排序） */
const VENDOR_PRIORITY = ['OpenAI', 'Anthropic', 'Google', 'DeepSeek'];

function vendorRank(name) {
  const i = VENDOR_PRIORITY.indexOf(name);
  return i === -1 ? VENDOR_PRIORITY.length : i;
}

function compareVendor(a, b) {
  const ra = vendorRank(a.name), rb = vendorRank(b.name);
  if (ra !== rb) return ra - rb;
  return a.name.localeCompare(b.name);
}

/**
 * 公司/厂商识别：优先用站点 pricing 里的 vendors 映射（new-api 原生字段），
 * 缺失时按模型名前缀/关键字推断。返回标准公司名（找不到归入「其他」）。
 */
const VENDOR_RULES = [
  [/^(claude|anthropic)/i, 'Anthropic'],
  [/^(gpt|chatgpt|o1|o3|o4|davinci|text-embedding|whisper|tts-|dall-e|sora|codex)/i, 'OpenAI'],
  [/^(gemini|gemma|palm|imagen|veo)/i, 'Google'],
  [/^deepseek/i, 'DeepSeek'],
  [/^(qwen|qwq|qvq|tongyi)/i, 'Alibaba'],
  [/^(glm|chatglm)/i, 'Zhipu'],
  [/^(kimi|moonshot)/i, 'Moonshot'],
  [/^grok/i, 'xAI'],
  [/^(llama|meta-)/i, 'Meta'],
  [/^(mistral|mixtral|codestral|pixtral)/i, 'Mistral'],
  [/^(doubao|seed|skylark)/i, 'ByteDance'],
  [/^(ernie|wenxin)/i, 'Baidu'],
  [/^yi-/i, '01.AI'],
  [/^(hunyuan|tencent)/i, 'Tencent'],
  [/^(minimax|abab)/i, 'MiniMax'],
  [/^mimo/i, 'Xiaomi'],
  // 中文命名的国产模型（站点常直接写产品名）
  [/火山|豆包|即梦|doubao|seedance|seedream/i, 'ByteDance'],
  [/通义|千问|qwen/i, 'Alibaba'],
  [/智谱|清言|glm/i, 'Zhipu'],
  [/文心|ERNIE/i, 'Baidu'],
  [/混元|hunyuan/i, 'Tencent'],
  [/可灵|kling/i, 'Kuaishou'],
  [/星火|spark/i, 'iFlytek'],
  [/百川|baichuan/i, 'Baichuan'],
  [/^(step-|stepfun)/i, 'StepFun'],
  [/^(spark|iflytek)/i, 'iFlytek'],
  [/^(baichuan)/i, 'Baichuan'],
  [/^(internlm)/i, 'Shanghai AI Lab'],
  [/^(command|cohere)/i, 'Cohere'],
  [/^(nova|titan)/i, 'Amazon'],
  [/^(phi-)/i, 'Microsoft'],
  [/^sonar/i, 'Perplexity'],
  [/^(flux|stable-|sdxl)/i, 'Stability'],
  [/^(midjourney|mj-)/i, 'Midjourney'],
  [/^(kling|kolors)/i, 'Kuaishou'],
  [/^(vidu)/i, 'Shengshu'],
];

export function vendorOf(model, vendorName) {
  const name = String(model ?? '').trim();
  if (!name) return vendorName || '其他';
  // 站点显式标注优先（但排除无意义的通用值）
  if (vendorName && !/^(unknown|other|未知|自定义|测试)$/i.test(vendorName)) return vendorName;
  for (const [re, label] of VENDOR_RULES) {
    if (re.test(name)) return label;
  }
  // 形如 "vendor/model" 的命名（如 bytedance/doubao-pro）
  const slash = name.indexOf('/');
  if (slash > 0) {
    const prefix = name.slice(0, slash).toLowerCase();
    const hit = VENDOR_RULES.find(([re]) => re.test(prefix + '-'));
    if (hit) return hit[1];
    return prefix.charAt(0).toUpperCase() + prefix.slice(1);
  }
  return '其他';
}

function bookPath(dataDir) { return path.join(dataDir, FILE); }

export async function readBook(dataDir) {
  try {
    const raw = JSON.parse(await fsp.readFile(bookPath(dataDir), 'utf8'));
    if (raw?.version === VERSION && raw.stations && typeof raw.stations === 'object') return raw;
  } catch { /* 无库或损坏：返回空库 */ }
  return { version: VERSION, updatedAt: null, stations: {} };
}

export async function writeBook(dataDir, book) {
  const file = bookPath(dataDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(book), 'utf8');
  await fsp.rename(tmp, file);
}

/**
 * 把某站点的定价快照转成归一化条目。
 * pricing: stations.fetchPricing 的返回（models[].rows[] 已含组倍率变体与到手价）
 * ratio: 该站生效的充值比例
 */
export function normalizeStation(station, pricing, ratio) {
  const entries = [];
  const fetchedAt = pricing?.fetchedAt ?? Date.now();
  const groupRatioMap = pricing?.groupRatio && typeof pricing.groupRatio === 'object' ? pricing.groupRatio : {};

  /** 生成一条归一化条目 */
  const push = (m, group, groupRatio, usdIn, usdOut, perRequest) => {
    const known = usdIn != null || usdOut != null;
    entries.push({
      stationId: station.id,
      stationName: station.name,
      protocol: station.protocol,
      model: String(m.model ?? '').trim(),
      modelKey: String(m.model ?? '').trim().toLowerCase(),
      vendor: vendorOf(m.model, m.vendorName),
      group: group ?? '',
      groupRatio: groupRatio ?? 1,
      perRequest: perRequest ?? null,
      usdIn, usdOut,
      cnyIn: usdIn != null && ratio ? usdIn * ratio : null,
      cnyOut: usdOut != null && ratio ? usdOut * ratio : null,
      priceSource: m.priceSource ?? 'unknown',
      known,
      ratio: ratio ?? null,
      fetchedAt,
    });
  };

  for (const m of pricing?.models ?? []) {
    if (!String(m.model ?? '').trim()) continue;
    const baseIn = m.usdPerMillionInput;
    const baseOut = m.usdPerMillionOutput;
    const groups = Array.isArray(m.groups) ? m.groups.filter(Boolean) : [];
    if (groups.length) {
      // new-api 形态：标价不含组倍率，按「每个可用分组 × 该组倍率」展开（含倍率=1 的分组）
      for (const g of groups) {
        const gr = Number(groupRatioMap[g] ?? 1) || 1;
        push(m, g, gr,
          baseIn == null ? null : baseIn * gr,
          baseOut == null ? null : baseOut * gr,
          m.perRequest ?? null);
      }
    } else if (m.group) {
      // sub2api 形态：标价已含组倍率，直接沿用
      push(m, m.group, Number(m.groupRateMultiplier) || 1, baseIn, baseOut, m.perRequest ?? null);
    } else {
      push(m, '', 1, baseIn, baseOut, m.perRequest ?? null);
    }
  }
  return entries;
}

/** 写入整站价格（覆盖旧数据） */
export function upsertStation(book, station, pricing, ratio) {
  const entries = normalizeStation(station, pricing, ratio);
  book.stations[station.id] = {
    id: station.id,
    name: station.name,
    protocol: station.protocol,
    fetchedAt: pricing?.fetchedAt ?? Date.now(),
    ratio: ratio ?? null,
    priceTableSource: pricing?.priceTableSource ?? null,
    entryCount: entries.length,
    entries,
    error: null,
  };
  book.updatedAt = new Date().toISOString();
  return entries.length;
}

export function markStationError(book, station, message) {
  book.stations[station.id] = {
    ...(book.stations[station.id] ?? {}),
    id: station.id,
    name: station.name,
    protocol: station.protocol,
    entries: book.stations[station.id]?.entries ?? [],
    entryCount: book.stations[station.id]?.entryCount ?? 0,
    error: message,
    errorAt: new Date().toISOString(),
  };
  book.updatedAt = new Date().toISOString();
}

/** 扁平化所有条目 */
export function flatten(book) {
  const out = [];
  for (const s of Object.values(book.stations)) {
    for (const e of s.entries ?? []) out.push(e);
  }
  return out;
}

/**
 * 多维查询 + 比价
 * filters: { q, stationIds[], groups[], sources[], billing: 'all'|'token'|'percall',
 *            knownOnly, ratioApplied, minCny, maxCny, sort, cheapestOnly, basis: 'in'|'out'|'sum' }
 */
export function query(book, filters = {}) {
  const f = {
    q: (filters.q ?? '').trim().toLowerCase(),
    stationIds: Array.isArray(filters.stationIds) && filters.stationIds.length ? new Set(filters.stationIds) : null,
    groups: Array.isArray(filters.groups) && filters.groups.length ? new Set(filters.groups) : null,
    sources: Array.isArray(filters.sources) && filters.sources.length ? new Set(filters.sources) : null,
    vendor: (filters.vendor ?? '').trim(),
    modelKey: (filters.modelKey ?? '').trim().toLowerCase(),
    billing: filters.billing ?? 'all',
    knownOnly: filters.knownOnly !== false,
    sort: filters.sort ?? 'cnyIn-asc',
    cheapestOnly: Boolean(filters.cheapestOnly),
    basis: filters.basis ?? 'in',
    limit: Math.min(Number(filters.limit) || 500, 2000),
  };

  let rows = flatten(book);
  // 兼容旧库：早期条目没有 vendor 字段，读取时补推断值
  rows = rows.map((r) => (r.vendor ? r : { ...r, vendor: vendorOf(r.model) }));
  // —— 第一层：与分面无关的条件（关键词 / 站点 / 来源 / 计费 / 已知价）——
  if (f.q) rows = rows.filter((r) => r.modelKey.includes(f.q) || r.stationName.toLowerCase().includes(f.q) || (r.group || '').toLowerCase().includes(f.q));
  if (f.stationIds) rows = rows.filter((r) => f.stationIds.has(r.stationId));
  if (f.sources) rows = rows.filter((r) => f.sources.has(r.priceSource));
  if (f.billing === 'token') rows = rows.filter((r) => r.perRequest == null);
  if (f.billing === 'percall') rows = rows.filter((r) => r.perRequest != null);
  if (f.knownOnly) rows = rows.filter((r) => r.known);

  // —— 级联分面：公司 → 模型 → 分组，每级都基于上一级的结果计算 ——
  const countBy = (list, pick) => {
    const m = new Map();
    for (const r of list) { const k = pick(r); if (k == null || k === '') continue; m.set(k, (m.get(k) ?? 0) + 1); }
    return m;
  };
  // 公司：受站点/关键词等影响
  const vendorCount = countBy(rows, (r) => r.vendor);
  const facets = {
    vendors: [...vendorCount.entries()].map(([name, count]) => ({ name, count })).sort(compareVendor),
    models: [],
    groups: [],
  };
  // 公司 → 收窄（失效的已选公司自动忽略）
  let scoped = rows;
  if (f.vendor) {
    const narrowed = rows.filter((r) => r.vendor === f.vendor);
    if (narrowed.length) scoped = narrowed;
    else facets.staleVendor = f.vendor;
  }
  // 模型：受公司影响
  const modelMap = new Map();
  for (const r of scoped) {
    const cur = modelMap.get(r.modelKey);
    if (cur) cur.count += 1;
    else modelMap.set(r.modelKey, { key: r.modelKey, label: r.model, vendor: r.vendor, count: 1 });
  }
  facets.models = [...modelMap.values()].sort((a, b) => a.label.localeCompare(b.label));
  // 模型 → 收窄
  if (f.modelKey) {
    const narrowed = scoped.filter((r) => r.modelKey === f.modelKey);
    if (narrowed.length) scoped = narrowed;
    else facets.staleModel = f.modelKey;
  }
  // 分组：受站点/公司/模型影响
  const groupCount = countBy(scoped, (r) => r.group || '');
  facets.groups = [...groupCount.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));

  rows = scoped;
  if (f.groups) {
    const narrowed = rows.filter((r) => f.groups.has(r.group || ''));
    if (narrowed.length) rows = narrowed;
    else facets.staleGroup = [...f.groups][0];
  }
  const priceOf = (r) => (f.basis === 'out' ? r.cnyOut : f.basis === 'sum' ? (r.cnyIn ?? 0) + (r.cnyOut ?? 0) : r.cnyIn);

  // 每个模型的最低价（按当前基准），用于「最低价」标记与「仅看最便宜」
  const cheapest = new Map();
  for (const r of rows) {
    const v = priceOf(r);
    if (v == null) continue;
    const cur = cheapest.get(r.modelKey);
    if (!cur || v < cur.value) cheapest.set(r.modelKey, { value: v, stationId: r.stationId, group: r.group });
  }
  for (const r of rows) {
    const c = cheapest.get(r.modelKey);
    const v = priceOf(r);
    r.isCheapest = Boolean(c && v != null && Math.abs(v - c.value) < 1e-9 && c.stationId === r.stationId && c.group === r.group);
    r.modelLowestValue = c?.value ?? null;
    r.vsLowestPct = c && v != null && c.value > 0 ? ((v - c.value) / c.value) * 100 : null;
  }

  let result = f.cheapestOnly ? rows.filter((r) => r.isCheapest) : rows;
  const dir = /-desc$/.test(f.sort) ? -1 : 1;
  const key = f.sort.replace(/-(asc|desc)$/, '');
  const cmp = {
    cnyIn: (a, b) => (a.cnyIn ?? Infinity) - (b.cnyIn ?? Infinity),
    cnyOut: (a, b) => (a.cnyOut ?? Infinity) - (b.cnyOut ?? Infinity),
    model: (a, b) => a.modelKey.localeCompare(b.modelKey),
    station: (a, b) => a.stationName.localeCompare(b.stationName),
    fetchedAt: (a, b) => (a.fetchedAt ?? 0) - (b.fetchedAt ?? 0),
  }[key] ?? ((a, b) => (a.cnyIn ?? Infinity) - (b.cnyIn ?? Infinity));
  result = [...result].sort((a, b) => dir * cmp(a, b)).slice(0, f.limit);

  return {
    rows: result,
    total: rows.length,
    shown: result.length,
    modelsCompared: cheapest.size,
    facets,
    stations: Object.values(book.stations).map((s) => ({ id: s.id, name: s.name, protocol: s.protocol, entries: s.entryCount ?? 0, error: s.error ?? null, fetchedAt: s.fetchedAt ?? null })),
    groups: facets.groups.map((g) => g.name),
    sources: [...new Set(flatten(book).map((r) => r.priceSource))].sort(),
    updatedAt: book.updatedAt,
    filters: f,
  };
}
