// 安全写入层：指纹校验 + 原子写 + 时间戳备份 + 撤销日志（对齐 GPTZZZ v4 的 round-trip/journal 设计）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function exists(p) {
  try { await fsp.stat(p); return true; } catch { return false; }
}

export async function readText(p) {
  try { return await fsp.readFile(p, 'utf8'); } catch { return null; }
}

export async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

export function backupName(fileName, at) {
  return `${fileName}.${stamp(at)}.bak`;
}

const BACKUP_RE = /^(.+)\.(\d{8})-(\d{6})-(\d{3})\.bak$/;

export function parseBackupName(name) {
  const m = BACKUP_RE.exec(name);
  if (!m) return null;
  const [_, file, ymd, hms] = m;
  const at = new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}`);
  return { file, at: Number.isNaN(at.getTime()) ? null : at };
}

/** 备份单文件到 backups/<agentId>/ 下；同毫秒冲突时自动 _n 递增 */
export async function backupFile(backupRoot, agentId, srcPath, at) {
  const dir = path.join(backupRoot, agentId);
  await ensureDir(dir);
  const fileName = path.basename(srcPath);
  for (let n = 0; n < 1000; n += 1) {
    const dst = path.join(dir, backupName(fileName, at) + (n > 0 ? `_${n}` : ''));
    try {
      await fsp.copyFile(srcPath, dst, fs.constants.COPYFILE_EXCL);
      return dst;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('backupFile: 同一毫秒内备份次数过多');
}

/** 保留最近 keep 份备份（同名文件维度） */
export async function pruneBackups(backupRoot, agentId, fileName, keep = 20) {
  const dir = path.join(backupRoot, agentId);
  let names;
  try { names = await fsp.readdir(dir); } catch { return []; }
  const items = names
    .map((n) => ({ n, parsed: parseBackupName(n) }))
    .filter((x) => x.parsed && x.parsed.file === fileName)
    .sort((a, b) => (b.parsed.at?.getTime() ?? 0) - (a.parsed.at?.getTime() ?? 0));
  const removed = [];
  for (const old of items.slice(keep)) {
    try { await fsp.rm(path.join(dir, old.n), { force: true }); removed.push(old.n); } catch { /* 保留失败项 */ }
  }
  return removed;
}

/**
 * 原子写：tmp + rename；expectedSha 非 null 时先校验现文件指纹，
 * 不一致说明外部并发修改，拒绝覆盖（GPTZZZ 同款策略）。
 */
export async function atomicWrite(filePath, content, { expectedSha = null, mode = 0o600 } = {}) {
  if (expectedSha !== null) {
    const cur = await readText(filePath);
    if (cur !== null && sha256(cur) !== expectedSha) {
      const err = new Error(`文件在被外部修改，已拒绝覆盖：${filePath}（可手动备份后重试）`);
      err.code = 'E_CONCURRENT_MODIFY';
      throw err;
    }
  }
  await ensureDir(path.dirname(filePath));
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${stamp()}.tmp`);
  const fh = await fsp.open(tmp, 'w', mode);
  try {
    await fh.writeFile(content, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fsp.rename(tmp, filePath); // 同盘 rename 原子
  } catch {
    await fsp.copyFile(tmp, filePath);
    await fsp.rm(tmp, { force: true });
  }
}

/** 事务日志：每次写入登记 {agent, path, preSha, backupPath, at, undone}，用于一键撤销 */
function journalPath(dataDir) {
  return path.join(dataDir, 'journal.jsonl');
}

export async function journalAppend(dataDir, record) {
  await ensureDir(dataDir);
  await fsp.appendFile(journalPath(dataDir), JSON.stringify(record) + '\n', 'utf8');
}

export async function journalList(dataDir, limit = 100) {
  let text;
  try { text = await fsp.readFile(journalPath(dataDir), 'utf8'); } catch { return []; }
  return text.trim().split('\n').filter(Boolean).slice(-limit).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean).reverse();
}

/** 撤销一笔：preSha=null → 删除新文件；否则从备份恢复 */
export async function journalUndo(dataDir, record) {
  if (record.preSha === null) {
    if (record.postSha !== null) await fsp.rm(record.path, { force: true });
    return true;
  }
  if (!record.backupPath || !(await exists(record.backupPath))) return false;
  const backup = await readText(record.backupPath);
  await atomicWrite(record.path, backup, { expectedSha: record.postSha });
  return true;
}

// —— 目录解析：显式 override > 环境变量 > 默认 ~/.{dirName}（Windows 特殊工具走 LOCALAPPDATA）——

export function expandHome(p, home) {
  if (!p) return p;
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

export function resolveAgentDir({ home, env, override, envVar, defaultDirName, winLocalAppData }) {
  if (override) return expandHome(override, home);
  if (envVar && env[envVar] && env[envVar].trim()) return expandHome(env[envVar].trim(), home);
  if (winLocalAppData && process.platform === 'win32') {
    const local = env.LOCALAPPDATA?.trim() || path.join(home, 'AppData', 'Local');
    return path.join(local, winLocalAppData);
  }
  return path.join(home, defaultDirName);
}
