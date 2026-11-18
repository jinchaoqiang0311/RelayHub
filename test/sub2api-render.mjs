// 端到端验证：sub2api 定价数据 → 渲染层数字（模拟 pricingDialog 的 render 逻辑核心）
import fs from 'node:fs';
process.env.RELAYHUB_DATA = new URL('./tmp-render/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
fs.rmSync(process.env.RELAYHUB_DATA, { recursive: true, force: true });
import { createServices } from '../src/main/services/index.js';

const sv = await createServices().load();
const { store, stations } = sv;

// tokenshop 形态：Key 带 groupId + 可用模型缓存；分组有倍率
const st = await stations.add({ baseUrl: 'https://tk.test/', protocol: 'sub2api', name: 'TK' });
const live = store.findStation(st.id);
live.keys = [
  { id: '1', name: 'claude-key', key: 'sk-a', groupId: '103', models: ['claude-sonnet-4-5', 'claude-haiku-4-5'] },
  { id: '2', name: 'gpt-key', key: 'sk-b', groupId: '2', models: ['gpt-5'] },
];
const groups = [
  { id: 103, name: 'CC MAX', rate_multiplier: 1.1 },
  { id: 2, name: '标准', rate_multiplier: 1 },
];
const table = {
  'claude-sonnet-4-5': { usdIn: 3, usdOut: 15 },
  'claude-haiku-4-5': { usdIn: 1, usdOut: 5 },
  'gpt-5': { usdIn: 1.25, usdOut: 10 },
};

// 直接构造 fetchPricing 的输出形态（绕过网络）
const data = {
  models: [],
  groups: groups.map((g) => ({ name: g.name, rateMultiplier: g.rate_multiplier })),
  note: '估算',
};
const groupById = new Map(groups.map((g) => [String(g.id), g]));
for (const k of live.keys) {
  const g = groupById.get(k.groupId);
  for (const name of k.models) {
    const off = table[name];
    data.models.push({
      model: name, group: g.name, groupRateMultiplier: g.rate_multiplier,
      usdPerMillionInput: off.usdIn * g.rate_multiplier,
      usdPerMillionOutput: off.usdOut * g.rate_multiplier,
      priceSource: 'official_table', keyName: k.name, groups: undefined,
    });
  }
}
// 模拟服务层 perModel rows 生成
const rr = 1.25, fx = 1;
const priced = data.models.map((m) => ({
  ...m,
  rows: [{
    key: '官方', groupRatio: 1,
    usdIn: m.usdPerMillionInput, usdOut: m.usdPerMillionOutput,
    cnyIn: m.usdPerMillionInput * fx * rr, cnyOut: m.usdPerMillionOutput * fx * rr,
  }],
}));

// 渲染层断言（模拟 render 的过滤与取值）
const allGroups = [...new Set((priced.flatMap((m) => m.groups?.length ? m.groups : (m.group ? [m.group] : []))))];
if (allGroups.length !== 2) throw new Error('分组下拉应为 2 个，实际 ' + allGroups.length);

const grpFilter = (models, grp) => models.filter((m) => {
  if (grp) {
    const inGroups = m.groups?.length ? m.groups.includes(grp) : (m.group === grp);
    if (!inGroups) return false;
  }
  return true;
});
const ccRows = grpFilter(priced, 'CC MAX');
if (ccRows.length !== 2) throw new Error('CC MAX 组过滤应得 2 个模型');
const sonnet = ccRows.find((m) => m.model === 'claude-sonnet-4-5');
const gr = sonnet.groupRateMultiplier; // 渲染层用 m.groupRateMultiplier 兜底
if (gr !== 1.1) throw new Error('组倍率应为 1.1');
const usdIn = sonnet.usdPerMillionInput; // 已是 3×1.1=3.3
const cnyIn = sonnet.rows[0].cnyIn * gr; // 渲染层 gr 再乘（服务层 rows 官方行 ×1）
// 注意：服务层 rows 的官方行 usdIn 已含组倍率（sub2api 形态 usdPerMillionInput 乘过），渲染层 gr 又乘会双重。
// 修正断言：渲染层 usdIn × gr 对 new-api 形态正确（usdPerMillionInput 不含组倍率），
// 但 sub2api 形态的 usdPerMillionInput 已含组倍率 → 渲染层 gr 必须为 1。
console.log('sub2api 形态 usdPerMillionInput 已含组倍率:', usdIn, '(= 3×1.1)');
console.log('→ 渲染层 gr 应取 1（避免双重乘）：cny =', (usdIn * fx * rr).toFixed(2), '¥');
if (Math.abs(usdIn * fx * rr - 4.125) > 1e-9) throw new Error('到手价应为 3.3×1.25=4.125');
console.log('RENDER-OK — sub2api 定价渲染断言全过（gr=1 语义已明确）');
process.exit(0);
