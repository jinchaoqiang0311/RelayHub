// 重启感知：检测正在运行的 Agent（桌面端进程名 + CLI 命令行），切换配置后提醒
import { execFile } from 'node:child_process';

const DESKTOP_IMAGES = {
  claude: ['claude.exe', 'claude code.exe'],
  codex: ['codex.exe', 'codex-tui.exe'],
  gemini: ['gemini.exe'],
  grok: ['grok.exe', 'grok build.exe'],
  openclaw: ['openclaw.exe', 'openclaw-desktop.exe'],
  hermes: ['hermes.exe'],
};

// CLI 形态：node/npx 包装或裸命令（如 `codex --model x`、`node .../claude cli.js`、`npx @openai/codex`）
// SEP：行首或引号/路径符之后 —— 故意不含空格，避免把「参数值里恰好带 agent 名」的进程误报
// END：命令名后接空白/引号/路径延续/行尾
const SEP = String.raw`(^|["'(\\/=])`;
const END = String.raw`(["'\s/\\)\]]|$)`;
const cmdRe = (names, extra) => new RegExp(SEP + `(?:${names.join('|')})(\\.[a-z]+)?${END}` + (extra ? `|${extra}` : ''), 'i');

const CLI_PATTERNS = {
  claude: cmdRe(['claude-code', 'claude'], '@anthropic-ai[\\\\/]claude-code'),
  codex: cmdRe(['codex-tui', 'codex'], '@openai[\\\\/]codex'),
  gemini: cmdRe(['gemini-cli', 'gemini'], '@google[\\\\/]gemini-cli'),
  grok: cmdRe(['grok-build', 'grok']),
  openclaw: cmdRe(['openclaw-desktop', 'openclaw']),
  hermes: cmdRe(['hermes']),
};

function runCmd(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
    child.on('error', () => resolve(null));
  });
}

async function imagesWin32() {
  const out = await runCmd('tasklist', ['/FO', 'CSV', '/NH']);
  if (!out) return new Set();
  const names = new Set();
  for (const line of out.split('\n')) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m) names.add(m[1].toLowerCase());
  }
  return names;
}

async function commandLinesWin32() {
  const out = await runCmd('powershell.exe', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine']);
  if (!out) return [];
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

async function commandLinesUnix() {
  const out = await runCmd('ps', ['-axo', 'args=']);
  if (!out) return [];
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** 命令行匹配（导出以便单测） */
export function matchIds(lines, agentIds) {
  const hits = new Set();
  for (const line of lines) {
    if (line.includes('RelayHub')) continue; // 自身进程不参与匹配
    for (const id of agentIds) {
      if (hits.has(id)) continue;
      if (CLI_PATTERNS[id]?.test(line)) hits.add(id);
    }
  }
  return hits;
}

/** 返回正在运行的 agent id 列表（桌面端进程名 + CLI 命令行，双路合并） */
export async function runningAgents(agentIds) {
  const ids = [...new Set(agentIds)];
  try {
    if (process.platform === 'win32') {
      const [imgSet, cmdLines] = await Promise.all([imagesWin32(), commandLinesWin32()]);
      const hits = matchIds(cmdLines, ids);
      for (const id of ids) {
        if ((DESKTOP_IMAGES[id] ?? []).some((img) => imgSet.has(img.toLowerCase()))) hits.add(id);
      }
      return [...hits];
    }
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const cmdLines = await commandLinesUnix();
      const hits = matchIds(cmdLines, ids);
      for (const id of ids) {
        const base = (DESKTOP_IMAGES[id] ?? [])[0]?.replace(/\.exe$/, '');
        if (base && cmdLines.some((l) => l.toLowerCase().includes(base))) hits.add(id);
      }
      return [...hits];
    }
  } catch { /* 探测失败按未运行处理 */ }
  return [];
}
