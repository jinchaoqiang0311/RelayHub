// Agent 注册表：目录解析 + 活性读取 + 入口探测
import os from 'node:os';
import { AGENT_META, AGENT_IDS } from '../../shared/constants.js';
import { exists, resolveAgentDir } from '../services/fsutils.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { geminiAdapter } from './gemini.js';
import { grokAdapter } from './grok.js';
import { openclawAdapter } from './openclaw.js';
import { hermesAdapter } from './hermes.js';

export const ADAPTERS = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: geminiAdapter,
  grok: grokAdapter,
  openclaw: openclawAdapter,
  hermes: hermesAdapter,
};

export function resolveAgentDirFor(agentId, { override } = {}) {
  const meta = AGENT_META[agentId];
  if (!meta) throw new Error(`未知 agent: ${agentId}`);
  return resolveAgentDir({
    home: os.homedir(),
    env: process.env,
    override,
    envVar: meta.envVar,
    defaultDirName: meta.defaultDirName,
    winLocalAppData: meta.winLocalAppData,
  });
}

/** 只读探测一个 agent */
export async function probeAgent(agentId, { override } = {}) {
  const meta = AGENT_META[agentId];
  const adapter = ADAPTERS[agentId];
  const dir = resolveAgentDirFor(agentId, { override });
  const { file } = await adapter.resolveDir(dir);
  const dirExists = await exists(dir);
  const live = await adapter.readLive(dirExists ? dir : dir);
  const activePid = dirExists ? adapter.detectActive(live) : null;
  const result = {
    id: agentId,
    name: meta.name,
    experimental: meta.experimental,
    hint: meta.hint,
    envVar: meta.envVar,
    dir,
    file: live.path,
    dirExists,
    fileExists: live.text !== null,
    parseError: live.parseError ?? null,
    activeProvider: activePid,
  };
  // claude 专属：检测启动器损坏（shim 报错文本被误存为 exe，或原生二进制缺失）
  if (agentId === 'claude') {
    try {
      const { execFile } = await import('node:child_process');
      const claudeVer = await new Promise((resolve) => {
        execFile('claude', ['--version'], { timeout: 20000, windowsHide: true, shell: process.platform === 'win32' }, (err, stdout) => {
          resolve(err ? null : String(stdout).trim());
        });
      });
      if (!claudeVer) result.launcherBroken = true;
      else result.cliVersion = claudeVer;
    } catch { /* 探测失败不阻塞 */ }
  }
  return result;
}

export async function probeAllAgents() {
  const results = await Promise.all(AGENT_IDS.map((id) => probeAgent(id).catch((err) => ({
    id,
    name: AGENT_META[id].name,
    error: String(err.message ?? err),
  }))));
  return results;
}

export function adapterFor(agentId) {
  const a = ADAPTERS[agentId];
  if (!a) throw new Error(`未知 agent: ${agentId}`);
  return a;
}
