// 拟真站点测试：本地 HTTP 服务器模拟 new-api 协议，全链路验证
// 协议探测 → 登录拉 Key → 部署 → Key 轮换 → 自动同步重写入口 → 低余额告警
process.env.RELAYHUB_DATA = new URL('./tmp-sync/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createServices } from '../src/main/services/index.js';
import { probeProtocol } from '../src/main/relays/index.js';

fs.rmSync(process.env.RELAYHUB_DATA, { recursive: true, force: true });
const TMP = path.resolve('test/tmp-sync-agents');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, 'codex'), { recursive: true });

// —— 拟真 new-api 站点 ——
let liveKey = 'sk-live-111111111111';
let quota = 1250000; // $2.5（低于 $5 阈值 → 触发低余额告警）
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const json = (obj) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
  if (url.pathname === '/api/status') return json({ success: true, data: { version: 'v0.9.8-mock', system_name: 'MockNewAPI' } });
  if (url.pathname === '/api/user/login') {
    let b = ''; req.on('data', (c) => b += c);
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      if (body.username !== 'tester') return json({ success: false, message: 'bad user' });
      res.setHeader('set-cookie', 'session=mockcookie123; Path=/; HttpOnly');
      json({ success: true, data: { id: 7, username: 'tester' } });
    });
    return;
  }
  if (url.pathname === '/api/user/self') return json({ success: true, data: { id: 7, username: 'tester', quota, used_quota: 1000 } });
  if (url.pathname === '/v1/models') {
    if (req.headers.authorization !== `Bearer ${liveKey}`) { res.statusCode = 401; return json({ error: { message: 'bad key' } }); }
    return json({ data: [{ id: 'gpt-5' }, { id: 'gpt-5.1' }] });
  }
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    if (req.headers.authorization !== `Bearer ${liveKey}`) { res.statusCode = 401; return json({ error: { message: 'bad key' } }); }
    let b = ''; req.on('data', (c) => b += c);
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      if (body.model === 'gpt-5') return json({ choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 } });
      res.statusCode = 503;
      json({ error: { message: '无可用渠道 (model not found)' } });
    });
    return;
  }
  if (url.pathname === '/api/token/' && req.method === 'GET') {
    return json({ success: true, data: [{ id: 1, name: '主 Key', key: liveKey.replace('sk-', ''), status: 1, unlimited_quota: false, remain_quota: quota, used_quota: 1000, expired_time: -1 }] });
  }
  res.statusCode = 404;
  json({ success: false, message: 'not found' });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;
const mkServer = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });
console.log(`拟真站点: ${baseUrl}`);

const services = await createServices().load();
const { store, deploy, stations, sync } = services;

// ① 协议探测：指纹识别
const fp = await probeProtocol(baseUrl);
assert.equal(fp.reachable, true);
assert.equal(fp.family, 'newapi');
assert.equal(fp.systemName, 'MockNewAPI');
assert.equal(fp.tokenApi, true);
assert.equal(fp.openaiCompat, true); // mock 提供 /v1/models（供 ⑩ 模型拉取测试）
console.log('✓ ① 协议探测通过');

// ① 自动识别协议的站点添加
const station = await stations.add({ baseUrl, username: 'tester', password: 'pw' });
assert.equal(station.protocol, 'newapi');
assert.equal(station.probe.systemName, 'MockNewAPI');

// ② 登录 + 拉取 Key
await stations.login(station.id);
const cur = store.findStation(station.id);
assert.equal(cur.keys.length, 1);
assert.equal(cur.keys[0].key, liveKey);
assert.equal(cur.session.cookie, 'session=mockcookie123');
console.log('✓ ① 登录拉取 Key 通过');

// ③ 部署到 Codex（隔离目录）
fs.writeFileSync(path.join(TMP, 'codex', 'config.toml'), 'model = "gpt-5"\n');
const r1 = await deploy.deploy({ agentId: 'codex', stationId: station.id, keyId: cur.keys[0].id, model: 'gpt-5.1', overrideDir: path.join(TMP, 'codex') });
let toml = fs.readFileSync(path.join(TMP, 'codex', 'config.toml'), 'utf8');
assert.match(toml, /experimental_bearer_token = "sk-live-111111111111"/);
console.log('✓ ② 部署写入通过');

// ③ 低余额告警（$2.5 < $5）
assert.ok((cur.warnings ?? []).some((w) => w.text.includes('余额偏低')));
console.log('✓ ③ 低余额告警通过');

// ④ Key 轮换 → 自动同步重写当前入口
liveKey = 'sk-live-222222222222';
const s1 = await sync.runOnce({ manual: true });
assert.equal(s1.stationsSynced, 1);
assert.equal(s1.entriesRewritten.length, 1);
assert.equal(s1.entriesRewritten[0].live, true, '当前入口被实时重写');
toml = fs.readFileSync(path.join(TMP, 'codex', 'config.toml'), 'utf8');
assert.match(toml, /experimental_bearer_token = "sk-live-222222222222"/);
console.log('✓ ④ 自动同步重写通过');

// ⑤ 同步不重写未变化的入口（幂等）
const s2 = await sync.runOnce({ manual: true });
assert.equal(s2.entriesRewritten.length, 0);
console.log('✓ ⑤ 同步幂等通过');

// ⑥ autoSync=false 时非手动同步被跳过
store.state.settings.autoSync = false;
const s3 = await sync.runOnce();
assert.equal(s3.skipped, 'autoSync 关闭');
store.state.settings.autoSync = true;
console.log('✓ ⑥ 同步开关通过');

// ⑦ anthropic 直连协议：拟真 /v1/models 测活
const anthropicServer = await mkServer((req, res) => {
  const key = req.headers['x-api-key'];
  const url = new URL(req.url, 'http://mock');
  res.setHeader('content-type', 'application/json');
  if (key !== 'sk-ant-good') { res.statusCode = 401; res.end(JSON.stringify({ error: { message: 'bad key' } })); return; }
  if (url.pathname === '/v1/messages' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => b += c);
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      if (body.model === 'claude-sonnet-4-5') return res.end(JSON.stringify({ content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 6, output_tokens: 2 } }));
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'model not found' } }));
    });
    return;
  }
  res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-opus-4-1' }] }));
});
const antBase = `http://127.0.0.1:${anthropicServer.address().port}/`;
const antStation = await stations.add({ baseUrl: antBase, protocol: 'anthropic', name: '官方直连' });
const { keyId: antKid } = await stations.addKey({ stationId: antStation.id, name: 'ant key', key: 'sk-ant-good' });
const antVerify = await stations.verifyKey(antStation.id, antKid, { model: 'claude-sonnet-4-5' });
assert.equal(antVerify.ok, true);
assert.equal(antVerify.modelPresent, true);
// 用坏 Key 再测：手动塞一个坏 key
antStation.keys[0].key = 'sk-ant-bad';
const badRes = await stations.verifyKey(antStation.id, antKid, {});
assert.equal(badRes.ok, false);
assert.equal(badRes.status, 401);
console.log('✓ ⑦ anthropic 直连测活通过（好 Key 200/模型匹配，坏 Key 401）');

// ⑧ One-Hub 分支：data.items 列表形态
const ohServer = await mkServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if (url.pathname === '/api/user/login') { res.setHeader('set-cookie', 'session=oh1; Path=/'); return json({ success: true, data: { id: 3, username: 'oh' } }); }
  if (url.pathname === '/api/token/') return json({ success: true, data: { items: [{ id: 5, name: 'OH Key', key: 'ohkey1', unlimited_quota: true, expired_time: -1 }] } });
  res.statusCode = 404; json({ success: false });
});
const ohBase = `http://127.0.0.1:${ohServer.address().port}/`;
const oh = await stations.add({ baseUrl: ohBase, protocol: 'newapi', flavor: 'onehub', username: 'u', password: 'p' });
await stations.login(oh.id);
const ohKeys = store.findStation(oh.id).keys;
assert.equal(ohKeys.length, 1, 'One-Hub items 形态解析成功');
assert.equal(ohKeys[0].key, 'sk-ohkey1');
ohServer.close();
console.log('✓ ⑧ One-Hub 分支（data.items 列表形态）通过');

// ⑨ VoAPI 分支：登录返回 JWT，后续请求走 Bearer
const voServer = await mkServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if (url.pathname === '/api/user/login') return json({ success: true, data: { id: 9, username: 'vo', token: 'jwt-mock-xyz' } });
  if (url.pathname === '/api/token/') {
    if (req.headers.authorization !== 'Bearer jwt-mock-xyz') { res.statusCode = 401; return json({ success: false, message: 'need jwt' }); }
    return json({ success: true, data: [{ id: 6, name: 'Vo Key', key: 'vokey1', unlimited_quota: true, expired_time: -1 }] });
  }
  res.statusCode = 404; json({ success: false });
});
const voBase = `http://127.0.0.1:${voServer.address().port}/`;
const vo = await stations.add({ baseUrl: voBase, protocol: 'newapi', flavor: 'voapi', username: 'u', password: 'p' });
await stations.login(vo.id);
const voState = store.findStation(vo.id);
assert.equal(voState.session.accessToken, 'jwt-mock-xyz', 'VoAPI 登录提取 JWT');
const voKeys = voState.keys;
assert.equal(voKeys.length, 1, 'VoAPI Bearer 鉴权拉取 Key 成功');
assert.equal(voKeys[0].key, 'sk-vokey1');
voServer.close();
console.log('✓ ⑨ VoAPI 分支（JWT Bearer 鉴权）通过');

// ⑩ 模型列表拉取 + 缓存
const lm1 = await stations.listModels(station.id, cur.keys[0].id);
assert.equal(lm1.models.length, 2);
assert.deepEqual(lm1.models, ['gpt-5', 'gpt-5.1']);
const lm2 = await stations.listModels(station.id, cur.keys[0].id);
assert.equal(lm2.cached, true, '10 分钟内走缓存');
console.log('✓ ⑩ 模型列表拉取（/v1/models + 缓存）通过');

// ⑪ 命令行匹配单测：识别 node 包装的 claude CLI，排除自身进程
const { matchIds } = await import('../src/main/services/procs.js');
const hits = matchIds([
  'node C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js --resume',
  'D:\\软件项目\\RelayHub\\RelayHub.exe --squirrel-firstrun',
  'codex --model gpt-5.1',
], ['claude', 'codex', 'gemini']);
assert.deepEqual([...hits].sort(), ['claude', 'codex']);
console.log('✓ ⑪ CLI 命令行匹配 + 自身排除通过');

// ⑫ Sub2API：指纹识别 + JWT 登录 + 拉 Key + 部署 + 测活/模型
const s2Server = await mkServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const auth = req.headers.authorization ?? '';
  const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if (url.pathname === '/api/v1/settings/public') return json({ code: 0, message: 'success', data: { version: 'v1.0.0-mock' } });
  if (url.pathname === '/api/v1/auth/login') {
    let b = ''; req.on('data', (c) => b += c);
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      if (body.email !== 't@x.com') return json({ code: 400, message: 'bad email' });
      json({ code: 0, data: { access_token: 'jwt-s2a', refresh_token: 'rt-s2a', expires_in: 3600, token_type: 'Bearer', user: { id: 11, email: 't@x.com', username: 't', balance: 2.5, frozen_balance: 0 } } });
    });
    return;
  }
  if (url.pathname === '/api/v1/user/profile') {
    if (auth !== 'Bearer jwt-s2a') { res.statusCode = 401; return json({ code: 401, message: 'Token has expired', reason: 'TOKEN_EXPIRED' }); }
    return json({ code: 0, data: { id: 11, email: 't@x.com', username: 't', balance: 2.5, frozen_balance: 0 } });
  }
  if (url.pathname === '/api/v1/keys' && req.method === 'GET') {
    if (auth !== 'Bearer jwt-s2a') { res.statusCode = 401; return json({ code: 401, message: 'Token has expired', reason: 'TOKEN_EXPIRED' }); }
    return json({ code: 0, data: { items: [{ id: 9, key: 's2akey1', name: 'S2A Key', status: 'active', quota: 10, quota_used: 2.5, expires_at: null }], total: 1, page: 1, page_size: 100, pages: 1 } });
  }
  if (url.pathname === '/api/v1/keys' && req.method === 'POST') {
    if (auth !== 'Bearer jwt-s2a') { res.statusCode = 401; return json({ code: 401, message: 'Token has expired', reason: 'TOKEN_EXPIRED' }); }
    return json({ code: 0, data: { id: 10, key: 's2anew', name: 'relayhub-new', status: 'active', quota: 0, quota_used: 0 } });
  }
  if (url.pathname === '/v1/models') {
    if (auth !== 'Bearer sk-s2akey1') { res.statusCode = 401; return json({ error: { message: 'bad key' } }); }
    return json({ data: [{ id: 'claude-sonnet-4-5' }, { id: 'gpt-5' }] });
  }
  res.statusCode = 404; json({ code: 404, message: 'not found' });
});
const s2Base = `http://127.0.0.1:${s2Server.address().port}/`;

const fp2 = await probeProtocol(s2Base);
assert.equal(fp2.family, 'sub2api', 'Sub2API 指纹识别');
const s2a = await stations.add({ baseUrl: s2Base, username: 't@x.com', password: 'pw' });
assert.equal(s2a.protocol, 'sub2api', '自动识别为 sub2api 协议');
await stations.login(s2a.id);
const s2st = store.findStation(s2a.id);
assert.equal(s2st.session.accessToken, 'jwt-s2a', '登录持有 JWT');
assert.equal(s2st.balance.usd, 2.5);
assert.ok((s2st.warnings ?? []).some((w) => w.text.includes('余额偏低')), 'Sub2API 低余额告警');
assert.equal(s2st.keys.length, 1);
assert.equal(s2st.keys[0].key, 'sk-s2akey1', '完整 Key 自动补 sk- 前缀');
assert.equal(s2st.keys[0].unlimited, false);
assert.equal(s2st.keys[0].usdRemain, 7.5);
const r12 = await deploy.deploy({ agentId: 'claude', stationId: s2a.id, keyId: s2st.keys[0].id, overrideDir: path.join(TMP, 'claude') });
const cdoc12 = JSON.parse(fs.readFileSync(path.join(TMP, 'claude', 'settings.json'), 'utf8'));
assert.equal(cdoc12.env.ANTHROPIC_AUTH_TOKEN, 'sk-s2akey1');
const vk12 = await stations.verifyKey(s2a.id, s2st.keys[0].id);
assert.equal(vk12.ok, true, 'sk Key 测活通过网关 /v1/models');
const lms12 = await stations.listModels(s2a.id, s2st.keys[0].id);
assert.deepEqual(lms12.models, ['claude-sonnet-4-5', 'gpt-5']);
s2Server.close();
console.log('✓ ⑫ Sub2API 全链路（探测/自动识别/登录/拉Key/告警/部署/测活/模型）通过');

// ⑬ 模型验真：真实调用 / 列表校验 / 失败路径 / Anthropic 端点
antStation.keys[0].key = 'sk-ant-good'; // ⑦ 里被改成坏 Key，恢复用于验真
const p1 = await stations.probeModel(station.id, cur.keys[0].id, { model: 'gpt-5', mode: 'call' });
assert.equal(p1.ok, true, '真实调用可用模型');
assert.ok(p1.latencyMs >= 0);
assert.equal(p1.content, 'OK');
assert.equal(p1.usage.total, 8);
const p2 = await stations.probeModel(station.id, cur.keys[0].id, { model: 'no-such-model', mode: 'call' });
assert.equal(p2.ok, false, '不存在模型真实调用失败');
assert.equal(p2.httpStatus, 503);
assert.match(p2.error, /无可用渠道/);
const p3 = await stations.probeModel(station.id, cur.keys[0].id, { model: 'gpt-5', mode: 'list' });
assert.equal(p3.ok, true, '列表校验命中');
const p3b = await stations.probeModel(station.id, cur.keys[0].id, { model: 'no-such-model', mode: 'list' });
assert.equal(p3b.ok, false, '列表校验未命中');
const p4 = await stations.probeModel(antStation.id, antKid, { model: 'claude-sonnet-4-5', mode: 'call' });
if (!p4.ok) console.log('[debug p4]', JSON.stringify(p4), 'key=', antStation.keys[0].key);
assert.equal(p4.ok, true, 'Anthropic 协议真实调用');
assert.equal(p4.content, 'OK');
anthropicServer.close();

// ⑯ 身份探测：2 条问诊 + token 合计 + 中文展示
const p5 = await stations.probeModel(station.id, cur.keys[0].id, { model: 'gpt-5', mode: 'identity' });
assert.equal(p5.ok, true, '身份探测应答');
assert.equal(p5.items.length, 2, '中英两条问诊');
assert.equal(p5.mode, 'identity');
assert.ok(p5.items[0].content, '有中文展示文本');
assert.ok(p5.totalTokens >= 16, 'token 合计含中译调用');
const p6 = await stations.probeModel(station.id, cur.keys[0].id, { model: 'gpt-5', mode: 'identity' });
assert.ok(p6.items.every((i) => i.original !== undefined), '保留原文');
console.log('✓ ⑯ 身份探测（中英两问 + token 合计 + 中文展示）通过');
console.log('✓ ⑬ 模型验真（真实调用/列表校验/失败路径/Anthropic 端点）通过');

// ⑭ Turnstile：登录前置检查 + query 参数登录 + 浏览器代登回填
const tsServer = await mkServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const cookie = req.headers.cookie ?? '';
  const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if (url.pathname === '/api/status') return json({ success: true, data: { version: 'v1', system_name: 'TurnstileMock', turnstile_check: true, turnstile_site_key: '0xMOCKKEY' } });
  if (url.pathname === '/api/user/login' && req.method === 'POST') {
    if (!url.searchParams.get('turnstile')) return json({ success: false, message: 'Turnstile token 为空' });
    res.setHeader('set-cookie', 'session=ts1; Path=/');
    return json({ success: true, data: { id: 21, username: 'tsuser' } });
  }
  if (url.pathname === '/api/user/self') {
    if (!cookie.includes('session=')) { res.statusCode = 401; return json({ success: false, message: 'no session' }); }
    if (req.headers['new-api-user'] !== '21') { res.statusCode = 401; return json({ success: false, message: 'Unauthorized, New-Api-User header not provided' }); }
    return json({ success: true, data: { id: 21, username: 'tsuser', quota: 500000, used_quota: 0 } });
  }
  if (url.pathname === '/api/token/') {
    if (!cookie.includes('session=')) { res.statusCode = 401; return json({ success: false }); }
    if (req.headers['new-api-user'] !== '21') { res.statusCode = 401; return json({ success: false, message: 'Unauthorized, New-Api-User header not provided' }); }
    return json({ success: true, data: [{ id: 31, name: 'TS Key', key: 'tskey1', unlimited_quota: true, expired_time: -1 }] });
  }
  res.statusCode = 404; json({ success: false });
});
const tsBase = `http://127.0.0.1:${tsServer.address().port}/`;
const ts = await stations.add({ baseUrl: tsBase });
assert.equal(ts.protocol, 'newapi');
const lr = await stations.loginRequirements(ts.id);
assert.equal(lr.needsTurnstile, true, '站点要求 Turnstile');
assert.equal(lr.siteKey, '0xMOCKKEY');
let tsRejected = false;
try { await stations.login(ts.id, { username: 'tsuser', password: 'p' }); } catch (e) { tsRejected = /Turnstile/i.test(e.message); }
assert.ok(tsRejected, '无 Turnstile token 登录被拒并透传站点错误');
await stations.login(ts.id, { username: 'tsuser', password: 'p', turnstileToken: 'GOOD-TOKEN' });
const tsst = store.findStation(ts.id);
assert.equal(tsst.session.cookie, 'session=ts1', 'query 形式带 token 登录成功');
assert.equal(tsst.keys.length, 1);
const vs = await services.stations.verifySession(ts.id, { cookie: 'session=ts1', userId: 21 });
assert.equal(vs.ok, true, '候选会话验证通过（带 New-Api-User 头）');
const ts2 = await stations.add({ baseUrl: tsBase });
await stations.applySession(ts2.id, { cookie: 'session=ts1', userId: 21 });
const ts2st = store.findStation(ts2.id);
assert.equal(ts2st.keys.length, 1, '浏览器代登回填后拉取 Key 成功（带 New-Api-User 头）');
assert.equal(ts2st.balance.usd, 1);
tsServer.close();
console.log('✓ ⑭ Turnstile 登录前置检查/query登录/浏览器代登回填 通过');

// ⑰ 会话失效标记：401 → sessionInvalid=true（UI 露出「重新登录」）；重新登录后清除
const deadServer = await mkServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if (url.pathname === '/api/status') return json({ success: true, data: { version: 'v1', system_name: 'DeadMock' } });
  if (url.pathname === '/api/user/login') {
    let b = ''; req.on('data', (c) => b += c);
    req.on('end', () => { res.setHeader('set-cookie', 'session=dead-ok; Path=/'); json({ success: true, data: { id: 55, username: 'd' } }); });
    return;
  }
  res.statusCode = 401;
  json({ success: false, message: 'Unauthorized' });
});
const deadBase = `http://127.0.0.1:${deadServer.address().port}/`;
const dead = await stations.add({ baseUrl: deadBase, protocol: 'newapi' });
// 手工塞一个坏会话，模拟过期
dead.session = { cookie: 'session=stale' };
let failed = false;
try { await stations.refresh(dead.id); } catch { failed = true; }
assert.equal(failed, true, '失效会话刷新失败');
const deadNow = store.findStation(dead.id);
assert.equal(deadNow.sessionInvalid, true, '会话失效被标记');
assert.ok(deadNow.sessionError, '记录了失效原因');
// 重新登录（服务端始终 401 业务接口，但登录成功→标记应清除再因刷新失败重新置位）
await stations.login(dead.id, { username: 'd', password: 'p' }).catch(() => {});
const afterLogin = store.findStation(dead.id);
assert.equal(afterLogin.session?.cookie, 'session=dead-ok', '登录拿到新 cookie');
console.log('✓ ⑰ 会话失效标记（刷新失败置位 / UI 可据此露出重新登录）通过');
deadServer.close();

// ⑱ 注入检测：探针 prompt_tokens 胖 / 泄漏问询 / 干扰测试
let injectMode = true;
const injServer = await mkServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if (url.pathname === '/api/status') return json({ success: true, data: { version: 'v1', system_name: 'InjMock' } });
  if (url.pathname === '/api/user/login') { res.setHeader('set-cookie', 'session=inj; Path=/'); return json({ success: true, data: { id: 61, username: 'i' } }); }
  if (url.pathname === '/api/user/self') return json({ success: true, data: { id: 61, quota: 500000, used_quota: 0 } });
  if (url.pathname === '/api/token/') return json({ success: true, data: [{ id: 71, name: 'Inj Key', key: 'injkey1', unlimited_quota: true, expired_time: -1 }] });
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => b += c);
    req.on('end', () => {
      const body = JSON.parse(b || '{}');
      const msg = body.messages?.[0]?.content ?? '';
      // 站点偷偷注入 500 tokens 的系统提示；长探针在注入之上叠加真实文本长度
      const textTokens = Math.round([...msg].length * 0.75);
      const promptTokens = injectMode ? (msg === 'hi' ? 2 + 500 : 2 + 500 + textTokens) : (msg === 'hi' ? 2 : 2 + textTokens);
      let content = 'OK';
      if (msg.includes('系统提示')) content = '1. 你必须保持回答简短。2. 禁止输出思考过程。';
      else if (msg.includes('ZQ7-KX2')) content = '好的，ZQ7-KX2';
      json({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: promptTokens, completion_tokens: 5, total_tokens: promptTokens + 5 },
      });
    });
    return;
  }
  res.statusCode = 404; json({ success: false });
});
const injBase = `http://127.0.0.1:${injServer.address().port}/`;
const inj = await stations.add({ baseUrl: injBase, protocol: 'newapi' });
await stations.login(inj.id, { username: 'i', password: 'p' });
const injKey = store.findStation(inj.id).keys[0];
const r18 = await stations.probeModel(inj.id, injKey.id, { model: 'gpt-5', mode: 'inject' });
assert.equal(r18.mode, 'inject');
assert.equal(r18.probe.suspicion, 'high', '注入撑大 prompt_tokens 被判为 high');
assert.ok(r18.probe.overhead >= 300, '估算注入体积');
assert.equal(r18.probe.deltaAnomaly, false, '长短探针差值合理（注入为固定开销）');
assert.match(r18.leak.content, /简短|思考过程/, '泄漏问询抓到注入内容');
assert.equal(r18.interference.exact, false);
assert.equal(r18.interference.contains, true, '要求精确输出却被加前缀');
assert.ok(r18.totalTokens > 0);
// 关闭注入后应判为正常
injectMode = false;
const r19 = await stations.probeModel(inj.id, injKey.id, { model: 'gpt-5', mode: 'inject' });
assert.equal(r19.probe.suspicion, 'low', '无注入时判定正常');
injServer.close();
console.log('✓ ⑱ 注入检测（探针判定/泄漏问询/干扰测试/无注入对照）通过');

// ⑲ 429 退避：revealKey 首次被限流 → 退避重试 → 成功并缓存完整 Key
let revealCalls = 0;
const r429Server = await mkServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if (url.pathname === '/api/status') return json({ success: true, data: { version: 'v1', system_name: 'R429' } });
  if (url.pathname === '/api/user/login') { res.setHeader('set-cookie', 'session=r4; Path=/'); return json({ success: true, data: { id: 71, username: 'r' } }); }
  if (url.pathname === '/api/user/self') return json({ success: true, data: { id: 71, quota: 500000, used_quota: 0 } });
  if (url.pathname === '/api/token/') return json({ success: true, data: [{ id: 81, name: 'R4 Key', key: 'sk-R4**********XXXX', unlimited_quota: true, expired_time: -1 }] });
  if (url.pathname === '/api/token/81/key' && req.method === 'POST') {
    revealCalls += 1;
    if (revealCalls === 1) { res.statusCode = 429; return json({ success: false, message: 'Too Many Requests' }); }
    return json({ success: true, data: { key: 'sk-R4FULLKEY9999' } });
  }
  res.statusCode = 404; json({ success: false });
});
const r4Base = `http://127.0.0.1:${r429Server.address().port}/`;
const r4 = await stations.add({ baseUrl: r4Base, protocol: 'newapi' });
await stations.login(r4.id, { username: 'r', password: 'p' });
const r4Key = store.findStation(r4.id).keys[0];
assert.equal(r4Key.masked, true, '打码 Key 被识别');
const r4v = await stations.verifyKey(r4.id, r4Key.id, { model: 'gpt-5' });
assert.equal(revealCalls, 2, '首次 429 后退避重试了一次');
assert.equal(store.findStation(r4.id).keys[0].key, 'sk-R4FULLKEY9999', '完整 Key 已缓存（后续不再 reveal）');
assert.equal(r4v.ok, false, 'mock 无 /v1/models，测活返回不可用但不抛错');
r429Server.close();
console.log('✓ ⑲ 429 退避重试 + 完整 Key 缓存通过');

// ⑳ 定价抓取：/api/pricing 匿名拉取 + USD 换算 + 分组倍率 + 充值比例到手价
let mockExchange = 7.3;
const prServer = await mkServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if (url.pathname === '/api/status') return json({ success: true, data: { version: 'v1', system_name: 'PrMock', usd_exchange_rate: mockExchange } });
  if (url.pathname === '/api/pricing') {
    return json({
      success: true,
      data: [
        { model_name: 'gpt-5', quota_type: 0, model_ratio: 2.5, model_price: 0, completion_ratio: 4, enable_groups: ['default', 'vip'], billing_mode: 'tiered_expr', billing_expr: 'tier("standard", p * 2 + cr * 0.2 + cc * 2.5 + c * 10)' },
        { model_name: 'long-ctx', quota_type: 0, model_ratio: 37.5, model_price: 0, completion_ratio: 5, enable_groups: ['default'], billing_mode: 'tiered_expr', billing_expr: 'len <= 272000 ? tier("0_272k", p * 10 + cr * 1 + c * 50) : tier("272k_plus", p * 20 + cr * 2 + c * 100)' },
        { model_name: 'legacy', quota_type: 0, model_ratio: 1.5, model_price: 0, completion_ratio: 3, enable_groups: ['default'] },
        { model_name: 'linear', quota_type: 0, model_ratio: 0, model_price: 0, completion_ratio: 1, enable_groups: ['default'], billing_mode: 'tiered_expr', billing_expr: 'p * 2 + c * 4' },
        { model_name: 'per-req', quota_type: 0, model_ratio: 0, model_price: 0, completion_ratio: 1, enable_groups: ['default'], billing_mode: 'tiered_expr', billing_expr: 'tier("base", fixed(0.02))' },
        { model_name: 'by-count', quota_type: 1, model_ratio: 0, model_price: 0.1, completion_ratio: 1, enable_groups: ['vip'] },
      ],
      group_ratio: { default: 1, vip: 0.8 },
      usable_group: { default: '', vip: 'VIP 分组' },
    });
  }
  if (url.pathname === '/api/user/login') { res.setHeader('set-cookie', 'session=pr; Path=/'); return json({ success: true, data: { id: 91, username: 'p' } }); }
  if (url.pathname === '/api/user/self') return json({ success: true, data: { id: 91, quota: 500000, used_quota: 0 } });
  if (url.pathname === '/api/token/') return json({ success: true, data: [] });
  res.statusCode = 404; json({ success: false });
});
const prBase = `http://127.0.0.1:${prServer.address().port}/`;
const prSt = await stations.add({ baseUrl: prBase, protocol: 'newapi' });
const pr1 = await stations.fetchPricing(prSt.id);
assert.equal(pr1.models.length, 6, '定价模型条目');
const gpt5 = pr1.models.find((m) => m.model === 'gpt-5');
// 表达式优先：p*2 → $2/M（真实价），而不是 model_ratio×2 = $5
assert.equal(gpt5.usdPerMillionInput, 2, '计费表达式优先（p×1M = $2/M）');
assert.equal(gpt5.usdPerMillionOutput, 10, '表达式输出 c×1M = $10/M');
assert.equal(gpt5.priceSource, 'expr');
assert.equal(gpt5.cacheRead, 0.2, '缓存读价格');
// 多档计费：两档都解析，带 len 范围标签
const lc = pr1.models.find((m) => m.model === 'long-ctx');
assert.equal(lc.tiers.length, 2, '长上下文两档');
assert.equal(lc.tiers[0].usdIn, 10, '短档输入 $10');
assert.equal(lc.tiers[1].usdIn, 20, '长档输入 $20');
assert.equal(lc.tiers[0].rangeLabel, '≤272k', '短档范围标签');
assert.equal(lc.tiers[1].rangeLabel, '>272k', '长档范围标签');
// 无 tier 包装的线性式 → base 档
const linear = pr1.models.find((m) => m.model === 'linear');
assert.equal(linear.usdPerMillionInput, 2, '线性式 p*2 = $2');
assert.equal(linear.usdPerMillionOutput, 4, '线性式 c*4 = $4');
// fixed(N) → 按次（N 美元/次）
const perReq = pr1.models.find((m) => m.model === 'per-req');
assert.equal(perReq.priceSource, 'expr_fixed', 'fixed 归为表达式·按次');
assert.equal(perReq.perRequest, 0.02, 'fixed(0.02) = $0.02/次');
assert.equal(perReq.usdPerMillionInput, 0.02);
// 无表达式模型走经典倍率估算：1.5×2 = 3
const legacy = pr1.models.find((m) => m.model === 'legacy');
assert.equal(legacy.usdPerMillionInput, 3, '经典倍率 = 1.5×2');
assert.equal(legacy.priceSource, 'ratio');
assert.equal(pr1.groupRatio.default, 1);
assert.equal(pr1.usdExchangeRate, 1, '汇率强制 1:1（忽略站点 7.3）');
// 到手价 = 官方USD × 分组倍率 × 充值比例
const rr = 1.25;
store.state.settings.rechargeRatio = rr;
const pr2 = await stations.fetchPricing(prSt.id, { force: true, rechargeRatio: rr });
const gpt5b = pr2.models.find((m) => m.model === 'gpt-5');
const vipRow = gpt5b.rows.find((r) => r.key === 'vip');
assert.ok(vipRow, 'vip 分组行存在');
assert.ok(Math.abs(vipRow.usdIn - 1.6) < 1e-9, 'vip 组输入 = 2×0.8');
assert.ok(Math.abs(vipRow.cnyIn - 2) < 1e-9, '到手价 = 1.6×1×1.25 = 2');
assert.ok(Math.abs(vipRow.cnyOut - 10) < 1e-9, '到手输出 = 8×1×1.25 = 10');
const officialRow = gpt5b.rows.find((r) => r.key === '官方');
assert.ok(Math.abs(officialRow.cnyIn - 2.5) < 1e-9, '官方到手 = 2×1×1.25 = 2.5');
// 固定 1:1 已在上面验证（5/1.25 = 4），无汇率站点行为一致
const pr3 = await stations.fetchPricing(prSt.id);
assert.equal(pr3.cached, true, '1 小时内走缓存');
const byCount = pr1.models.find((m) => m.quotaType === 1);
assert.equal(byCount.usdPerMillionInput, 0.1, '按次计费');
prServer.close();
console.log('✓ ⑳ 定价抓取（USD换算/分组倍率/充值比例到手价/缓存）通过');

// ㉑ Sub2API 定价估算：分组倍率 × 官方价格表
const s2pServer = await mkServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const auth = req.headers.authorization ?? '';
  const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if (url.pathname === '/api/v1/settings/public') return json({ code: 0, data: {} });
  if (url.pathname === '/api/v1/auth/login') return json({ code: 0, data: { access_token: 's2pt', user: { id: 99, email: 'p@x.com' } } });
  if (url.pathname === '/api/v1/groups/available') {
    if (auth !== 'Bearer s2pt') { res.statusCode = 401; return json({ code: 401 }); }
    return json({ code: 0, data: [
      { id: 1, name: '标准组', rate_multiplier: 1, models: [] },
      { id: 2, name: '折扣组', rate_multiplier: 0.5, models: [] },
    ] });
  }
  if (url.pathname === '/api/v1/groups/rates') return json({ code: 0, data: {} });
  if (url.pathname === '/api/v1/keys' && req.method === 'GET') {
    if (auth !== 'Bearer s2pt') { res.statusCode = 401; return json({ code: 401 }); }
    return json({ code: 0, data: { items: [
      { id: 50, name: 'K1', key: 's2k1', group_id: 2, status: 'active', quota: 0, quota_used: 0 },
    ] } });
  }
  res.statusCode = 404; json({ code: 404 });
});
const s2pBase = `http://127.0.0.1:${s2pServer.address().port}/`;
const s2p = await stations.add({ baseUrl: s2pBase, protocol: 'sub2api' });
await stations.login(s2p.id, { username: 'p@x.com', password: 'p' });
const s2pLive = store.findStation(s2p.id);
s2pLive.keys[0].models = ['claude-sonnet-4-5', 'custom-model-x']; // 模拟测活缓存的可用模型
const priceTable = {
  'claude-sonnet-4-5': { usdIn: 3, usdOut: 15 },
};
const s2p1 = await stations.fetchPricing(s2p.id, { force: true, rechargeRatio: 1.25, _table: priceTable });
const known = s2p1.models.find((m) => m.model === 'claude-sonnet-4-5');
assert.equal(known.priceSource, 'official_table', '官方价格表来源');
assert.equal(known.group, '折扣组');
assert.equal(known.groupRateMultiplier, 0.5);
assert.ok(Math.abs(known.usdPerMillionInput - 1.5) < 1e-9, '到手 USD = 3×0.5');
assert.ok(Math.abs(known.usdPerMillionOutput - 7.5) < 1e-9, '输出 = 15×0.5');
assert.ok(Math.abs(known.rows[0].cnyIn - 1.875) < 1e-9, '到手价 = 1.5×1×1.25（rows）');
assert.ok(Math.abs(known.rows[0].cnyOut - 9.375) < 1e-9, '到手输出 = 7.5×1.25');
const unknown = s2p1.models.find((m) => m.model === 'custom-model-x');
assert.equal(unknown.officialKnown, false, '不在官方表的模型标注未知价');
assert.equal(unknown.usdPerMillionInput, null);
s2pServer.close();
console.log('✓ ㉑ Sub2API 定价估算（官方表×分组倍率/未知标注）通过');

// ㉒ 站点级充值比例：站点覆盖 > 全局，清除后回落全局，改比例后缓存失效重算
const rrServer = await mkServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if (url.pathname === '/api/status') return json({ success: true, data: { version: 'v1', system_name: 'RR' } });
  if (url.pathname === '/api/pricing') return json({ success: true, data: [{ model_name: 'gpt-5', quota_type: 0, model_ratio: 1, model_price: 0, completion_ratio: 1, enable_groups: ['default'], billing_mode: 'tiered_expr', billing_expr: 'tier("base", p * 2 + c * 4)' }], group_ratio: { default: 1 } });
  res.statusCode = 404; json({ success: false });
});
const rrBase = `http://127.0.0.1:${rrServer.address().port}/`;
const rrSt = await stations.add({ baseUrl: rrBase, protocol: 'newapi', name: 'RR站' });
store.state.settings.rechargeRatio = 1.2;
const rr1 = await stations.effectiveRechargeRatio(rrSt.id);
assert.equal(rr1.ratio, 1.2, '默认用全局比例');
assert.equal(rr1.source, 'global');
await stations.setRechargeRatio(rrSt.id, 1.5);
const rr2 = await stations.effectiveRechargeRatio(rrSt.id);
assert.equal(rr2.ratio, 1.5, '站点覆盖生效');
assert.equal(rr2.source, 'station');
// 先取一次定价（缓存），改比例后应失效
await stations.fetchPricing(rrSt.id, { force: true });
assert.ok(store.findStation(rrSt.id).pricing, '定价已缓存');
await stations.setRechargeRatio(rrSt.id, 1.5);
assert.equal(store.findStation(rrSt.id).pricing, null, '改比例后定价缓存被清空');
const pr4 = await stations.fetchPricing(rrSt.id, { force: true });
const g4 = pr4.models.find((m) => m.model === 'gpt-5');
assert.ok(Math.abs(g4.rows[0].cnyIn - 3) < 1e-9, '到手价 = 2×1×1.5 = 3');
await stations.setRechargeRatio(rrSt.id, null);
const rr3 = await stations.effectiveRechargeRatio(rrSt.id);
assert.equal(rr3.ratio, 1.2);
assert.equal(rr3.source, 'global');
let bad = false;
try { await stations.setRechargeRatio(rrSt.id, -1); } catch { bad = true; }
assert.equal(bad, true, '非法比例被拒绝');
rrServer.close();
console.log('✓ ㉒ 站点级充值比例（覆盖/回落/缓存失效/非法拒绝）通过');

// ⑮ 打码 Key 自动补拉（新版 new-api 列表脱敏，POST /api/token/:id/key 取回完整 Key）
const maskServer = await mkServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const cookie = req.headers.cookie ?? '';
  const auth = req.headers.authorization ?? '';
  const json = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if (url.pathname === '/api/status') return json({ success: true, data: { version: 'v1', system_name: 'MaskedMock' } });
  if (url.pathname === '/api/user/login') { res.setHeader('set-cookie', 'session=m1; Path=/'); return json({ success: true, data: { id: 41, username: 'm' } }); }
  if (url.pathname === '/api/user/self') {
    if (!cookie.includes('session=')) { res.statusCode = 401; return json({ success: false }); }
    return json({ success: true, data: { id: 41, quota: 1000000, used_quota: 0 } });
  }
  if (url.pathname === '/api/token/') {
    if (!cookie.includes('session=')) { res.statusCode = 401; return json({ success: false }); }
    return json({ success: true, data: [{ id: 77, name: 'Masked Key', key: 'sk-Ab12**********Yz90', unlimited_quota: true, expired_time: -1 }] });
  }
  if (url.pathname === '/api/token/77/key' && req.method === 'POST') {
    if (!cookie.includes('session=')) { res.statusCode = 401; return json({ success: false }); }
    return json({ success: true, data: { key: 'sk-FULLMASK1234567890' } });
  }
  if (url.pathname === '/v1/models') {
    if (auth !== 'Bearer sk-FULLMASK1234567890') { res.statusCode = 401; return json({ error: { message: 'Invalid token' } }); }
    return json({ data: [{ id: 'gpt-5' }] });
  }
  res.statusCode = 404; json({ success: false });
});
const maskBase = `http://127.0.0.1:${maskServer.address().port}/`;
const mkSt = await stations.add({ baseUrl: maskBase });
assert.equal(mkSt.protocol, 'newapi');
await stations.login(mkSt.id, { username: 'm', password: 'p' });
const mkKeys = store.findStation(mkSt.id).keys;
assert.equal(mkKeys[0].masked, true, '列表打码 Key 被识别');
const rk15 = await stations.revealKey(mkSt.id, mkKeys[0].id);
assert.equal(rk15.key, 'sk-FULLMASK1234567890', '取回完整 Key');
assert.equal(store.findStation(mkSt.id).keys[0].masked, false, '缓存后不再标记打码');
const vk15 = await stations.verifyKey(mkSt.id, mkKeys[0].id, { model: 'gpt-5' });
assert.equal(vk15.ok, true, '测活用补拉后的完整 Key');
const mk3 = await stations.add({ baseUrl: maskBase });
await stations.login(mk3.id, { username: 'm', password: 'p' });
await deploy.deploy({ agentId: 'gemini', stationId: mk3.id, keyId: store.findStation(mk3.id).keys[0].id, overrideDir: path.join(TMP, 'gemini-masked') });
const gem15 = fs.readFileSync(path.join(TMP, 'gemini-masked', '.env'), 'utf8');
assert.match(gem15, /sk-FULLMASK1234567890/, '部署也自动补拉完整 Key');
maskServer.close();
console.log('✓ ⑮ 打码 Key 自动补拉（列表打码识别/单Key取回/测活/部署）通过');

server.close();
console.log('STATION-SYNC OK — 拟真站点全链路通过');
process.exit(0); // Windows 上避免 libuv 关闭句柄断言噪音
