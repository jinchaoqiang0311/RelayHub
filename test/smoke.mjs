// 冒烟测试：全流程走临时目录，不触碰真实 agent 配置
process.env.RELAYHUB_DATA = new URL('./tmp-data/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServices } from '../src/main/services/index.js';

fs.rmSync(process.env.RELAYHUB_DATA, { recursive: true, force: true }); // 清理上次运行残留

const TMP = path.resolve('test/tmp-agents');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, 'claude'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'codex'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'gemini'), { recursive: true });

const services = await createServices().load();
const { store, deploy, stations } = services;

// 1) 通用站点 + 手动 Key
const { station, keyId } = await stations.addKey({
  baseUrl: 'https://relay.example.test',
  name: '测试站',
  key: 'sk-test-1234567890abcdef',
});
assert.equal(store.state.stations.length, 1);

// 2) Claude Code：additive 合并 + 备份
fs.writeFileSync(path.join(TMP, 'claude', 'settings.json'), JSON.stringify({ model: 'keep-me', env: { FOO: '1' } }));
const r1 = await deploy.deploy({ agentId: 'claude', stationId: station.id, keyId, model: 'claude-x', overrideDir: path.join(TMP, 'claude') });
const claudeDoc = JSON.parse(fs.readFileSync(path.join(TMP, 'claude', 'settings.json'), 'utf8'));
assert.equal(claudeDoc.model, 'keep-me');                 // 用户原有键保留
assert.equal(claudeDoc.env.FOO, '1');
assert.equal(claudeDoc.env.ANTHROPIC_BASE_URL, 'https://relay.example.test');
assert.equal(claudeDoc.env.ANTHROPIC_AUTH_TOKEN, 'sk-test-1234567890abcdef');
assert.equal(claudeDoc.env.CLAUDE_CODE_USE_BEDROCK, false);
const backups = fs.readdirSync(path.join(process.env.RELAYHUB_DATA, 'backups', 'claude'));
assert.ok(backups.length >= 1, 'claude 备份存在');
assert.ok(r1.entry.id, '入口已登记');

// 3) Codex：TOML provider 表 + 保留 mcp_servers + 删 auth.json
fs.writeFileSync(path.join(TMP, 'codex', 'config.toml'), 'model = "gpt-5"\n\n[mcp_servers.playwright]\ncommand = "npx"\n');
fs.writeFileSync(path.join(TMP, 'codex', 'auth.json'), '{"OPENAI_API_KEY":"official"}');
const r2 = await deploy.deploy({ agentId: 'codex', stationId: station.id, keyId, model: 'gpt-5.1', wireApi: 'responses', overrideDir: path.join(TMP, 'codex') });
const codexText = fs.readFileSync(path.join(TMP, 'codex', 'config.toml'), 'utf8');
assert.match(codexText, /\[model_providers\.relayhub_/);
assert.match(codexText, /base_url = "https:\/\/relay\.example\.test"/);
assert.match(codexText, /experimental_bearer_token = "sk-test-1234567890abcdef"/);
assert.match(codexText, /\[mcp_servers\.playwright\]/);   // 用户表保留
// auth.json 必须保留：Codex 桌面版启动需要它（曾经因删除导致桌面版闪退）
assert.ok(fs.existsSync(path.join(TMP, 'codex', 'auth.json')), 'auth.json 保留（桌面版启动需要）');
assert.equal(fs.readFileSync(path.join(TMP, 'codex', 'auth.json'), 'utf8'), '{"OPENAI_API_KEY":"official"}');

// 4) Gemini：dotenv 合并
fs.writeFileSync(path.join(TMP, 'gemini', '.env'), '# 注释\nGEMINI_API_KEY=old\nOTHER=keep\n');
await deploy.deploy({ agentId: 'gemini', stationId: station.id, keyId, overrideDir: path.join(TMP, 'gemini') });
const gemText = fs.readFileSync(path.join(TMP, 'gemini', '.env'), 'utf8');
assert.match(gemText, /# 注释/);
assert.match(gemText, /OTHER=keep/);
assert.match(gemText, /GOOGLE_GEMINI_BASE_URL=https:\/\/relay\.example\.test/);

// 5) 入口切换（第二个 Key）
const { keyId: keyId2 } = await stations.addKey({ stationId: station.id, name: '备用 Key', key: 'sk-second-abcdef123456' });
const r3 = await deploy.deploy({ agentId: 'claude', stationId: station.id, keyId: keyId2, overrideDir: path.join(TMP, 'claude') });
const claudeDoc2 = JSON.parse(fs.readFileSync(path.join(TMP, 'claude', 'settings.json'), 'utf8'));
assert.equal(claudeDoc2.env.ANTHROPIC_AUTH_TOKEN, 'sk-second-abcdef123456');
assert.equal(store.agentState('claude').currentEntryId, r3.entry.id);

// 6) 移除入口 → 剥掉路由，保留用户键
await deploy.remove('claude', r3.entry.id);
const claudeDoc3 = JSON.parse(fs.readFileSync(path.join(TMP, 'claude', 'settings.json'), 'utf8'));
assert.ok(!claudeDoc3.env?.ANTHROPIC_AUTH_TOKEN, '路由已剥离');
assert.equal(claudeDoc3.model, 'keep-me');

// 7) 撤销最后一笔写入（移除操作）
const undo = await deploy.undo();
assert.equal(undo.ok, true);

// 8) 加密存储往返
await store.save();
const store2 = await createServices().load();
const sk = store2.store.findStation(station.id).keys.find((k) => k.id === keyId);
assert.equal(sk.key, 'sk-test-1234567890abcdef', '加密后能正确解出 Key');

console.log('SMOKE OK — 8 项断言全部通过');
console.log('agent 探测（真实机器，只读）：');
for (const a of await services.agents.probeAll()) {
  console.log(`  ${a.dirExists ? '✓' : '×'} ${a.id.padEnd(9)} ${a.dir}`);
}
