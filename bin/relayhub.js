#!/usr/bin/env node
// RelayHub CLI —— 与 GUI 共用同一套服务与数据目录（RELAYHUB_DATA 可覆盖）
import { createServices } from '../src/main/services/index.js';

const [, , cmd, ...rest] = process.argv;
const arg = (name, fallback = null) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : fallback;
};

const HELP = `
RelayHub CLI
  agents                       探测已安装的 Agent（只读）
  stations                     列出中转站与 Key
  station add <url> [--name n --user u --pass p]   添加中转站（new-api 系可登录拉 Key）
  key add <sk-...> [--url u --name n]              手动添加 Key（通用模式）
  deploy <agentId> [--station id --key id | --sk sk-...] [--model m] [--wire responses|chat]
  pricing <stationId> [--search 关键词] [--force]  模型定价与分组倍率
  models <stationId> <keyId>   列出该 Key 可用模型
  probe <stationId> <keyId> <model...> [--mode call|list|identity|inject]  模型验真
  entries [agentId]            查看已保存入口
  switch <agentId> <entryId>   切换入口
  remove <agentId> <entryId>   移除入口（剥掉路由）
  undo                         撤销上一笔写入
  journal                      写入日志
`;

function modelsLimit(rest) { return !rest.includes('--all'); }

async function main() {
  const services = await createServices().load();
  switch (cmd) {
    case 'agents': {
      const list = await services.agents.probeAll();
      for (const a of list) {
        console.log(`${a.dirExists ? '✓' : '×'} ${a.id.padEnd(9)} ${a.name.padEnd(12)} ${a.dir}${a.parseError ? '  [解析失败]' : ''}${a.activeProvider ? `  [当前: ${a.activeProvider}]` : ''}`);
      }
      break;
    }
    case 'stations': {
      for (const s of services.store.state.stations) {
        const flag = s.sessionInvalid ? '  ⚠ 会话已失效（请重新登录）' : '';
        console.log(`${s.id}  ${s.name}  ${s.baseUrl}  [${s.protocol}]  余额: ${s.balance?.usd != null ? '$' + s.balance.usd.toFixed(2) : '—'}${flag}`);
        for (const k of s.keys) console.log(`   - ${k.id}  ${k.name}  ${k.key ? k.key.slice(0, 10) + '…' : '(no key)'}`);
      }
      if (!services.store.state.stations.length) console.log('(空) 先用 station add 添加');
      break;
    }
    case 'station': {
      if (rest[0] !== 'add') throw new Error('用法: station add <url> [--name --user --pass]');
      const station = await services.stations.add({ baseUrl: rest[1], name: arg('name'), username: arg('user'), password: arg('pass') });
      if (arg('user') && arg('pass')) {
        await services.stations.login(station.id);
        console.log('已登录并拉取 Key');
      }
      console.log(`已添加: ${station.id}`);
      break;
    }
    case 'key': {
      if (rest[0] !== 'add') throw new Error('用法: key add <sk-...> [--url --name]');
      const { station, keyId } = await services.stations.addKey({ baseUrl: arg('url'), name: arg('name'), key: rest[1] });
      console.log(`已添加到 ${station.name}: ${keyId}`);
      break;
    }
    case 'deploy': {
      const agentId = rest[0];
      const result = await services.deploy.deploy({
        agentId,
        stationId: arg('station'),
        keyId: arg('key'),
        rawKey: arg('sk'),
        baseUrl: arg('url'),
        model: arg('model'),
        wireApi: arg('wire', 'responses'),
        name: arg('name'),
      });
      for (const w of result.written) console.log(`${w.action}: ${w.path}${w.backupPath ? `  (备份: ${w.backupPath})` : ''}`);
      if (result.restartPending?.length) console.log(`[提示] 正在运行: ${result.restartPending.join(', ')} — 重启后生效`);
      console.log(`完成。${result.hint}`);
      break;
    }
    case 'pricing': {
      const st = services.store.findStation(rest[0]);
      if (!st) throw new Error(`找不到站点: ${rest[0]}`);
      const p = await services.stations.fetchPricing(rest[0], { force: rest.includes('--force') });
      console.log(`站点: ${st.name}（${st.protocol}）  模型 ${p.models?.length ?? 0} 条  ${p.note ?? ''}`);
      const q = arg('search', '');
      const rows = (p.models ?? []).filter((m) => !q || m.model.toLowerCase().includes(q.toLowerCase())).slice(0, 60);
      for (const m of rows) {
        const grp = (m.groups ?? []).join(', ') || m.group || '—';
        if (m.quotaType === 1) console.log(`  ${m.model}  $${m.usdPerMillionInput}/次  组: ${grp}`);
        else console.log(`  ${m.model}  输入$${m.usdPerMillionInput?.toFixed?.(2) ?? m.usdPerMillionInput}/M  输出$${m.usdPerMillionOutput?.toFixed?.(2) ?? m.usdPerMillionOutput}/M  组: ${grp}`);
      }
      const gr = p.groupRatio ?? {};
      if (Object.keys(gr).length) console.log(`分组倍率: ${Object.entries(gr).map(([k, v]) => `${k}×${v}`).join('  ')}`);
      if (modelsLimit(rest)) console.log('（仅显示前 60 条，用 --search 过滤）');
      break;
    }
    case 'models': {
      const { models } = await services.stations.listModels(rest[0], rest[1]);
      for (const m of models) console.log(m);
      if (!models.length) console.log('(端点未返回模型列表)');
      break;
    }
    case 'probe': {
      const [sid, kid] = rest;
      const models = rest.slice(2).join(' ').split(/[\s,;，；]+/).filter(Boolean).slice(0, 10);
      if (!models.length) throw new Error('用法: probe <stationId> <keyId> <model...>  [--mode call|list|identity]');
      const mode = arg('mode', 'call');
      if (mode === 'identity' && models.length > 3) {
        console.log(`[提示] 身份探测将对 ${models.length} 个模型各发 2 次请求（约 ${models.length * 400} tokens）`);
      }
      let batchTokens = 0;
      for (const m of models) {
        const r = await services.stations.probeModel(sid, kid, { model: m, mode });
        if (mode === 'identity') {
          batchTokens += r.totalTokens ?? 0;
          console.log(`${r.ok ? '✓' : '✗'} ${m}  合计 ${r.totalTokens ?? 0} tokens`);
          if (r.summary) {
            console.log(`   模型：${r.summary.modelName ?? '未说明'}`);
            console.log(`   知识截止：${r.summary.cutoff ?? '未说明'}`);
            console.log(`   自称官方第一方：${r.summary.official ?? '未说明'}`);
          } else {
            console.log('   （未解析出结构化字段，见下方中文译文）');
          }
          for (const it of r.items ?? []) {
            const u = it.usage?.total ?? it.tokens ?? '?';
            console.log(`   [${it.tag}] ${it.ok ? `${it.latencyMs}ms ${u} tokens${it.translated ? ' 已中译' : ''}` : it.error}`);
            if (it.content) console.log(`     ${it.content.slice(0, 220)}`);
            if (it.original && it.original !== it.content) console.log(`     原文: ${it.original.slice(0, 220)}`);
          }
          console.log('   （自述仅供参考，套壳可能撒谎）');
        } else if (mode === 'inject') {
          batchTokens += r.totalTokens ?? 0;
          console.log(`${r.ok ? '✓' : '✗'} ${m}  合计 ${r.totalTokens ?? 0} tokens`);
          const p = r.probe ?? {};
          const susText = { high: '⚠ 疑似被注入', medium: '⚠ 可能有注入', low: '✓ 探针正常', unknown: '无法判定（无 token 用量）' }[p.suspicion] ?? '无法判定';
          console.log(`   探针: 短 prompt_tokens=${p.smallPrompt ?? '—'} 长=${p.largePrompt ?? '—'} 疑似注入≈${p.overhead ?? '—'} tokens → ${susText}`);
          if (p.delta != null) console.log(`   长度差值 ${p.delta}（预期约 ${p.deltaExpected}${p.deltaAnomaly ? '，⚠ 异常' : ''}）`);
          const leak = r.leak ?? {};
          console.log(`   泄漏问询(${leak.tokens ?? 0} tokens): ${leak.ok ? String(leak.content ?? '').slice(0, 400) : '失败'}`);
          const it = r.interference ?? {};
          console.log(`   干扰测试(${it.tokens ?? 0} tokens): 要求 ${it.expected} → ${JSON.stringify(it.actual)} ${it.exact ? '✓ 未被干扰' : '⚠ 被改写/加缀'}`);
          console.log('   （仅对粗糙注入有效，数值偏大也可能是合理适配提示）');
        } else {
          const detail = r.ok
            ? (mode === 'call'
              ? [`${r.latencyMs}ms`, r.usage ? `${r.usage.total ?? r.usage.total_tokens ?? '?'} tokens` : null, r.content ? `「${r.content}」` : null].filter(Boolean).join(' ')
              : '在模型列表中')
            : (r.error ?? '失败');
          if (mode === 'call' && r.usage) batchTokens += r.usage.total ?? 0;
          console.log(`${r.ok ? '✓' : '✗'} ${m}  ${detail}`);
        }
      }
      if (mode !== 'list' && models.length > 1) console.log(`本批合计约 ${batchTokens} tokens`);
      break;
    }
    case 'entries': {
      const agentId = rest[0];
      const ids = agentId ? [agentId] : services.agents.ids;
      for (const id of ids) {
        const st = services.store.agentState(id);
        console.log(`[${id}] 当前: ${st.currentEntryId ?? '—'}`);
        for (const e of st.entries) console.log(`  ${e.id}  ${e.name}  → ${e.baseUrl}${e.model ? '  model=' + e.model : ''}`);
      }
      break;
    }
    case 'switch': await services.deploy.switch(rest[0], rest[1]); console.log('已切换'); break;
    case 'remove': {
      const r = await services.deploy.remove(rest[0], rest[1]);
      for (const w of r.written) console.log(`${w.action}: ${w.path}`);
      console.log('已移除入口并剥掉路由');
      break;
    }
    case 'undo': { const r = await services.deploy.undo(); console.log(r.ok ? '已撤销' : r.message); break; }
    case 'journal': {
      for (const j of await services.deploy.journal()) console.log(`${j.at}  ${j.agent}  ${j.op}  ${j.path}`);
      break;
    }
    default: console.log(HELP);
  }
}

main().catch((err) => { console.error(`[error] ${err.message}`); process.exit(1); });
