// 部署编排：中转站 Key → Agent 配置文件
// 流程（GPTZZZ v4 同款安全语义）：读活档 → 全量备份 → 原子写（指纹校验）→ 事务日志 → 更新入口库
import path from 'node:path';
import { AGENT_META } from '../../shared/constants.js';
import { adapterFor, resolveAgentDirFor } from '../agents/index.js';
import { exists, readText, sha256, atomicWrite, backupFile, pruneBackups, journalAppend, journalList, journalUndo } from './fsutils.js';
import { runningAgents } from './procs.js';
import { clientFor, isMaskedKey } from '../relays/index.js';

function entryKey(entryId) {
  return String(entryId).replace(/-/g, '').slice(0, 12);
}

export function createDeployService({ store, dataDir, backupRoot }) {
  const keep = () => store.state.settings.backupKeep ?? 20;

  function stationKeyFor(station, keyId) {
    const hit = (station.keys ?? []).find((k) => k.id === keyId);
    if (!hit) throw new Error(`中转站「${station.name}」里找不到 Key: ${keyId}`);
    return hit;
  }

  async function resolveApiKey(entry) {
    if (entry.rawKey) return entry.rawKey;
    const station = store.findStation(entry.stationId);
    if (!station) throw new Error(`找不到中转站: ${entry.stationId}`);
    const key = stationKeyFor(station, entry.keyId);
    if (!key.key) throw new Error(`Key「${key.name}」没有可用密钥内容，请先在站点里刷新`);
    // 站点端打码 Key：自动调官方取回端点补拉完整 Key 并缓存
    if (isMaskedKey(key.key)) {
      const client = clientFor(station);
      if (typeof client.revealKey !== 'function') {
        throw new Error(`「${station.name}」的 Key 在站点端被打码且该协议没有取回接口，请到站点网页复制完整 Key 后用「加 Key」手动添加`);
      }
      const full = await client.revealKey(key.id);
      key.key = full;
      key.masked = false;
      await store.save();
    }
    return key.key;
  }

  async function writeOps(agentId, live, ops, { journalTag }) {
    const written = [];
    for (const op of ops) {
      const preText = await readText(op.path);
      const preSha = preText !== null ? sha256(preText) : null;
      let backupPath = null;
      if (!op.deleteFile && preText !== null) {
        backupPath = await backupFile(backupRoot, agentId, op.path);
        await pruneBackups(backupRoot, agentId, path.basename(op.path), keep());
      }
      if (op.deleteFile) {
        const e = await exists(op.path);
        if (e) {
          backupPath = await backupFile(backupRoot, agentId, op.path);
          const { rm } = await import('node:fs/promises');
          await rm(op.path, { force: true });
        }
      } else if (preText !== op.text) {
        await atomicWrite(op.path, op.text);
      }
      const postText = op.deleteFile ? null : await readText(op.path);
      await journalAppend(dataDir, {
        at: new Date().toISOString(),
        agent: agentId,
        tag: journalTag,
        path: op.path,
        preSha,
        postSha: postText !== null ? sha256(postText) : null,
        backupPath,
        op: op.deleteFile ? 'delete' : op.restoreText !== undefined ? 'restore' : 'write',
        undone: false,
      });
      written.push({ path: op.path, action: op.deleteFile ? 'delete' : 'write', backupPath });
    }
    return written;
  }

  async function applyEntry(agentId, entry, { dryRun = false } = {}) {
    const meta = AGENT_META[agentId];
    const adapter = adapterFor(agentId);
    const dir = resolveAgentDirFor(agentId, { override: entry.overrideDir });
    const { file } = await adapter.resolveDir(dir);
    const live = await adapter.readLive(dir);
    if (live.parseError) throw new Error(`${meta.name} 现有配置解析失败（${live.parseError}），请手动检查 ${live.path}`);
    const apiKey = await resolveApiKey(entry);
    const payload = {
      baseUrl: entry.baseUrl,
      apiKey,
      model: entry.model ?? null,
      name: entry.name,
      wireApi: entry.wireApi ?? 'responses',
      reasoningEffort: entry.reasoningEffort ?? null,
      api: entry.api ?? null,
      models: entry.models ?? null,
    };
    const ops = adapter.buildOps(live, payload, { entryKey: entryKey(entry.id) });
    if (dryRun) return { dryRun: true, ops: ops.map((o) => ({ path: o.path, action: o.deleteFile ? 'delete' : 'write', text: o.text })) };
    const written = await writeOps(agentId, live, ops, { journalTag: `apply:${entry.id}` });
    entry.appliedAt = new Date().toISOString();
    return { entry, written };
  }

  return {
    /** 一键部署 / 切换：写入 agent 配置并登记入口 */
    async deploy(input) {
      const { agentId, stationId, keyId, rawKey, name, model, wireApi, reasoningEffort, overrideDir, dryRun } = input;
      const meta = AGENT_META[agentId];
      if (!meta) throw new Error(`未知 agent: ${agentId}`);
      const agentStore = store.agentState(agentId);
      let entry = null;
      if (input.entryId) {
        entry = agentStore.entries.find((e) => e.id === input.entryId) ?? null;
        if (!entry) throw new Error(`找不到入口: ${input.entryId}`);
        // 只覆盖显式提供的字段，避免同步重放时把 undefined 写进入口
        for (const k of ['model', 'wireApi', 'reasoningEffort', 'overrideDir', 'baseUrl', 'name']) {
          if (input[k] !== undefined) entry[k] = input[k];
        }
      } else {
        const station = store.findStation(stationId);
        let label;
        if (station) {
          const key = keyId ? stationKeyFor(station, keyId) : null;
          label = `${station.name}${key ? ' · ' + key.name : ''}`;
        } else if (rawKey) {
          label = name || '手动 Key';
        } else {
          throw new Error('deploy: 需要 stationId+keyId 或 rawKey');
        }
        entry = {
          id: `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          agentId,
          name: label,
          stationId: station?.id ?? null,
          keyId: keyId ?? null,
          rawKey: rawKey ?? null,
          baseUrl: input.baseUrl ?? station?.baseUrl,
          model: model ?? null,
          wireApi: wireApi ?? 'responses',
          reasoningEffort: reasoningEffort ?? null,
          overrideDir: overrideDir ?? null,
          createdAt: new Date().toISOString(),
        };
        if (!entry.baseUrl) throw new Error('缺少 baseUrl');
        agentStore.entries.push(entry);
      }
      const result = await applyEntry(agentId, entry, { dryRun });
      if (!dryRun) {
        agentStore.currentEntryId = entry.id;
        await store.save();
      }
      return { ...result, entry, hint: meta.hint, restartPending: dryRun ? [] : await runningAgents([agentId]) };
    },

    /** 切回某个已保存入口（从入口库重放写入） */
    async switch(agentId, entryId) {
      const agentStore = store.agentState(agentId);
      const entry = agentStore.entries.find((e) => e.id === entryId);
      if (!entry) throw new Error(`找不到入口: ${entryId}`);
      const result = await applyEntry(agentId, entry);
      agentStore.currentEntryId = entryId;
      await store.save();
      return { ...result, hint: AGENT_META[agentId].hint, restartPending: await runningAgents([agentId]) };
    },

    /** 删除入口：把该入口写入的路由从配置文件里剥掉 */
    async remove(agentId, entryId) {
      const meta = AGENT_META[agentId];
      const adapter = adapterFor(agentId);
      const agentStore = store.agentState(agentId);
      const entry = agentStore.entries.find((e) => e.id === entryId);
      if (!entry) throw new Error(`找不到入口: ${entryId}`);
      const dir = resolveAgentDirFor(agentId, { override: entry.overrideDir });
      const live = await adapter.readLive(dir);
      const ops = adapter.stripOps(live, { entryKey: entryKey(entryId) });
      const written = await writeOps(agentId, live, ops, { journalTag: `remove:${entryId}` });
      agentStore.entries = agentStore.entries.filter((e) => e.id !== entryId);
      if (agentStore.currentEntryId === entryId) agentStore.currentEntryId = null;
      await store.save();
      return { written, hint: meta.hint };
    },

    /** 撤销最近一笔写操作 */
    async undo() {
      const records = await journalList(dataDir, 200);
      const rec = records.find((r) => !r.undone);
      if (!rec) return { ok: false, message: '没有可撤销的写入' };
      const ok = await journalUndo(dataDir, rec);
      rec.undone = ok;
      const { writeFile } = await import('node:fs/promises');
      const jPath = path.join(dataDir, 'journal.jsonl');
      const all = records.slice().reverse().map((r) => JSON.stringify(r)).join('\n') + '\n';
      await writeFile(jPath, all, 'utf8');
      return ok ? { ok: true, undone: rec } : { ok: false, message: '备份文件缺失，撤销失败' };
    },

    journal: () => journalList(dataDir, 50),
  };
}
