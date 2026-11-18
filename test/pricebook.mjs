// 比价：本地价格库（覆盖式更新 + 多维筛选 + 最低价标记）
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

process.env.RELAYHUB_DATA = new URL('./tmp-book/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
fs.rmSync(process.env.RELAYHUB_DATA, { recursive: true, force: true });
const { createServices } = await import('../src/main/services/index.js');

const mk = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });

// 两个站点：A 便宜、B 贵；模型名大小写不同以验证归一化
const mkPricing = (models, groupRatio) => (req, res) => {
  const url = new URL(req.url, 'http://m');
  const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if (url.pathname === '/api/status') return json({ success: true, data: { version: 'v1', system_name: 'P' } });
  if (url.pathname === '/api/pricing') return json({ success: true, data: models, group_ratio: groupRatio });
  res.statusCode = 404; json({ success: false });
};

const srvA = await mk(mkPricing([
  { model_name: 'GPT-5', quota_type: 0, model_ratio: 1, completion_ratio: 4, enable_groups: ['std'], billing_mode: 'tiered_expr', billing_expr: 'tier("base", p * 2 + c * 8)' },
  { model_name: 'claude-sonnet-4-5', quota_type: 0, model_ratio: 1, completion_ratio: 1, enable_groups: ['std'], billing_mode: 'tiered_expr', billing_expr: 'tier("base", p * 3 + c * 15)' },
], { std: 1 }));
const srvB = await mk(mkPricing([
  { model_name: 'gpt-5', quota_type: 0, model_ratio: 1, completion_ratio: 4, enable_groups: ['vip'], billing_mode: 'tiered_expr', billing_expr: 'tier("base", p * 4 + c * 16)' },
  { model_name: 'claude-sonnet-4-5', quota_type: 0, model_ratio: 1, completion_ratio: 1, enable_groups: ['vip'], billing_mode: 'tiered_expr', billing_expr: 'tier("base", p * 2 + c * 10)' },
], { vip: 1 }));

const sv = await createServices().load();
const { stations, books, store } = sv;
const urlA = `http://127.0.0.1:${srvA.address().port}/`;
const urlB = `http://127.0.0.1:${srvB.address().port}/`;
const stA = await stations.add({ baseUrl: urlA, protocol: 'newapi', name: 'A站' });
const stB = await stations.add({ baseUrl: urlB, protocol: 'newapi', name: 'B站' });

// 全局充值比例 1.25；B 站单独 1.0
store.state.settings.rechargeRatio = 1.25;
await stations.setRechargeRatio(stB.id, 1);

// ① 同步全部站点 → 本地库
const s1 = await books.syncAll({ force: true });
assert.equal(s1.stations, 2, '两站同步成功');
assert.ok(s1.entries >= 4, '入库条目');
const stats1 = await books.stats();
assert.equal(stats1.models, 2, '归一化后 2 个模型（大小写合并）');
assert.equal(stats1.stations.length, 2);

// ② 定价与到手价：A站 gpt-5 $2/M × 1.25 = ¥2.5；B站 $4/M × 1.0 = ¥4
const q1 = await books.query({ sort: 'cnyIn-asc' });
const gptRows = q1.rows.filter((r) => r.modelKey === 'gpt-5');
assert.equal(gptRows.length, 2, 'gpt-5 两站各一条');
assert.ok(Math.abs(gptRows[0].cnyIn - 2.5) < 1e-9, 'A站到手 ¥2.5');
assert.equal(gptRows[0].stationName, 'A站');
assert.equal(gptRows[0].isCheapest, true, 'A站标记为最低');
assert.ok(Math.abs(gptRows[1].cnyIn - 4) < 1e-9, 'B站到手 ¥4（本站比例 1.0）');
assert.equal(gptRows[1].isCheapest, false);
assert.ok(Math.abs(gptRows[1].vsLowestPct - 60) < 1e-9, 'B站比最低贵 60%');

// ③ 多维筛选：站点 / 分组 / 价格区间 / 仅最便宜
const qA = await books.query({ stationIds: [stA.id] });
assert.equal(qA.rows.length, 2, '按站点筛选');
const qVip = await books.query({ groups: ['vip'] });
assert.ok(qVip.rows.every((r) => r.group === 'vip'), '按分组筛选');
const qCheap = await books.query({ cheapestOnly: true });
assert.equal(qCheap.rows.length, 2, '每模型一条最低价');
assert.ok(qCheap.rows.every((r) => r.isCheapest));
// 搜索 + 基准切换（按输出价）
const qOut = await books.query({ basis: 'out', sort: 'cnyOut-asc' });
assert.ok(qOut.rows[0].cnyOut <= qOut.rows[1].cnyOut, '按输出价排序');
const qSearch = await books.query({ q: 'claude' });
assert.equal(qSearch.rows.length, 2, '关键词搜索');

// ③b 公司 / 模型 分面筛选
const qAll = await books.query({});
const vendors = qAll.facets.vendors.map((v) => v.name);
assert.ok(vendors.includes('OpenAI'), '公司分面含 OpenAI（gpt-5 推断）');
assert.ok(vendors.includes('Anthropic'), '公司分面含 Anthropic（claude 推断）');
assert.ok(qAll.facets.models.length >= 2, '模型分面列表');
// 公司排序：OpenAI / Anthropic / Google / DeepSeek 置顶，其余按名称
const vendorOrder = qAll.facets.vendors.map((v) => v.name);
assert.deepEqual(vendorOrder.slice(0, 2), ['OpenAI', 'Anthropic'], '内置公司置顶顺序（本库仅这两家）');
const qVendor = await books.query({ vendor: 'Anthropic' });
assert.equal(qVendor.rows.length, 2, '按公司筛选（两站的 claude-sonnet-4-5）');
assert.ok(qVendor.rows.every((r) => r.vendor === 'Anthropic'));
const qModel = await books.query({ modelKey: 'gpt-5' });
assert.equal(qModel.rows.length, 2, '按模型筛选（大小写归一）');
assert.ok(qModel.rows.every((r) => r.modelKey === 'gpt-5'));
const qVM = await books.query({ vendor: 'OpenAI', modelKey: 'gpt-5' });
assert.equal(qVM.rows.length, 2, '公司+模型组合筛选');

// ③c 级联分面：分组随站点/公司/模型联动
const qFacetAll = await books.query({});
assert.ok(qFacetAll.facets.groups.some((g) => g.name === 'std'), '分组分面含 std');
assert.ok(qFacetAll.facets.groups.some((g) => g.name === 'vip'), '分组分面含 vip');
// 只看 A 站 → 分组只剩 std
const qFacetA = await books.query({ stationIds: [stA.id] });
assert.deepEqual(qFacetA.facets.groups.map((g) => g.name), ['std'], 'A 站分组只剩 std');
// 选公司 OpenAI → 分组只剩 std（gpt-5 在 A 站 std；B 站 vip 的 gpt-5 也是 OpenAI，故两者都在）
const qFacetV = await books.query({ vendor: 'OpenAI' });
assert.ok(qFacetV.facets.groups.length >= 1, '公司筛选后分组可用');
// 选站点 A + 公司 Anthropic → 分组仅 std
const qFacetAV = await books.query({ stationIds: [stA.id], vendor: 'Anthropic' });
assert.deepEqual(qFacetAV.facets.groups.map((g) => g.name), ['std'], '站点+公司联动后分组收窄');
// 选模型 → 分组随模型联动
const qFacetM = await books.query({ stationIds: [stB.id], modelKey: 'gpt-5' });
assert.deepEqual(qFacetM.facets.groups.map((g) => g.name), ['vip'], '模型锁定后分组仅 vip');
// 分组筛选生效
const qGroup = await books.query({ groups: ['vip'] });
assert.ok(qGroup.rows.length >= 1 && qGroup.rows.every((r) => r.group === 'vip'), '按分组筛选');
// 失效筛选被忽略而非返回空
const qStale = await books.query({ stationIds: [stA.id], groups: ['vip'] });
assert.ok(qStale.rows.length > 0, 'A 站无 vip 组时忽略失效分组筛选，仍返回数据');

// ④ 价格更新覆盖旧数据（B 站降价）
srvB.close();
const srvB2 = await mk(mkPricing([
  { model_name: 'gpt-5', quota_type: 0, model_ratio: 1, completion_ratio: 4, enable_groups: ['vip'], billing_mode: 'tiered_expr', billing_expr: 'tier("base", p * 1 + c * 4)' },
], { vip: 1 }));
// 站点 baseUrl 指向旧端口，改为直接替换端口不可行 → 用同一 station 重新指向新端口
const live = store.findStation(stB.id);
live.baseUrl = `http://127.0.0.1:${srvB2.address().port}/`;
live.pricing = null;
await books.syncStation(stB.id, { force: true });
const q2 = await books.query({ q: 'gpt-5', sort: 'cnyIn-asc' });
assert.equal(q2.rows.length, 2, '覆盖后仍两站');
const bNow = q2.rows.find((r) => r.stationName === 'B站');
assert.ok(Math.abs(bNow.cnyIn - 1) < 1e-9, 'B 站降价后到手 ¥1（覆盖生效）');
assert.equal(q2.rows[0].stationName, 'B站', '最低价换到 B 站');
assert.equal(q2.rows[0].isCheapest, true);

// ⑤ 清空
await books.clear();
const q3 = await books.query({});
assert.equal(q3.total, 0, '清空后无数据');
srvA.close(); srvB2.close();
console.log('BOOK OK — 本地价格库（覆盖/归一化/多维筛选/最低价/清空）全部通过');
process.exit(0);
