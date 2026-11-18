// 看板聚合单测（隔离数据目录）
import fs from 'node:fs';
process.env.RELAYHUB_DATA = new URL('./tmp-dash/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
fs.rmSync(process.env.RELAYHUB_DATA, { recursive: true, force: true });
import { createServices } from '../src/main/services/index.js';
import { buildDashboard } from '../src/main/services/dashboard.js';
import assert from 'node:assert/strict';

const sv = await createServices().load();
const { store, stations, deploy } = sv;

const st1 = await stations.add({ baseUrl: 'https://a.test', name: 'A站', protocol: 'newapi' });
const s1 = store.findStation(st1.id); // 实时引用
s1.balance = { usd: 12.5 };
s1.keys = [
  { id: '1', name: 'k1', key: 'sk-aaa', unlimited: true, masked: false },
  { id: '2', name: 'k2', key: 'sk-Ab12**********Yz90', unlimited: false, masked: true, usdRemain: 0.5 },
];
s1.updatedAt = new Date().toISOString();
s1.warnings = [{ level: 'warn', text: 'Key「k2」剩余额度不足 $1' }];

const st2 = await stations.add({ baseUrl: 'https://b.test', name: 'B站', protocol: 'generic' });
const s2 = store.findStation(st2.id);
s2.sessionInvalid = true;
s2.sessionError = '会话已失效';
s2.keys = [{ id: '3', name: 'k3', key: null, masked: false }];

await deploy.deploy({ agentId: 'claude', stationId: st1.id, keyId: '1', rawKey: 'sk-x', baseUrl: 'https://a.test' });

const d = buildDashboard(store);
assert.equal(d.summary.stations, 2);
assert.equal(d.summary.stationsInvalid, 1);
assert.equal(d.summary.stationsWarn, 1);
assert.equal(d.summary.keys, 3);
assert.equal(d.summary.keysMasked, 1);
assert.ok(Math.abs(d.summary.balanceUsd - 12.5) < 1e-9, '余额合计');
assert.equal(d.summary.entriesTotal >= 1, true);
assert.equal(d.summary.entriesActive >= 1, true);
const rowA = d.stationRows.find((r) => r.id === st1.id);
assert.equal(rowA.status, 'warn');
assert.equal(rowA.health, 65, 'warn 健康度 80-15');
const rowB = d.stationRows.find((r) => r.id === st2.id);
assert.equal(rowB.health, 0, 'invalid 健康度 0');
const cl = d.agentRows.find((a) => a.id === 'claude');
assert.ok(cl.currentEntry, 'claude 有当前入口');
assert.equal(cl.currentStationName, 'A站');
// 今日消费聚合
const usage = { [st1.id]: { usd: 1.25, rpm: 6, tpm: 900, supported: true, fetchedAt: 1, day: 'x' }, [st2.id]: { usd: 0.5, rpm: 0, tpm: 0, supported: true, fetchedAt: 1, day: 'x' } };
const d2 = buildDashboard(store, [], usage);
assert.ok(Math.abs(d2.usage.totalUsd - 1.75) < 1e-9, '今日消费合计');
assert.equal(d2.usage.stationsKnown, 2);
assert.equal(d2.usage.rpm, 6);
assert.ok(d2.usage.rows.every((r) => r.usd != null), '每站今日消费');
console.log('DASHBOARD OK — 聚合断言全过（含今日消费）');
process.exit(0);
