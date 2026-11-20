/* RelayHub 渲染层：无框架，直接操作 DOM */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = { view: 'dashboard', stations: [], agents: [], entries: {}, settings: {}, dashboard: null, journal: [] };

async function api(channel, payload) {
  const res = await window.relayhub.invoke(channel, payload);
  if (!res?.ok) throw new Error(res?.error || '未知错误');
  return res.data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 6500 : 3500);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const AGENT_ICON = { claude: '◆', codex: '◇', gemini: '✦', grok: '✧', openclaw: '❖', hermes: '✶' };

async function refreshAll() {
  const requests = [api('stations:list'), api('agents:probeAll'), api('entries:list'), api('settings:get')];
  if (state.view === 'dashboard') requests.push(api('stats:dashboard'));
  if (state.view === 'compare') requests.push(api('book:stats'));
  const [stations, agents, entries, settings, extra] = await Promise.all(requests);
  Object.assign(state, { stations, agents, entries, settings });
  if (state.view === 'dashboard' && extra) state.dashboard = extra;
  if (state.view === 'compare' && extra) compareState().stats = extra;
}

/* ---------------- 看板视图 ---------------- */
const STATUS_BADGE = { ok: ['ok', '正常'], warn: ['warn', '有告警'], invalid: ['err', '会话失效'], unknown: ['', '未同步'] };

function renderDashboard() {
  const d = state.dashboard;
  if (!d) return '<h2>看板</h2><p class="sub">加载中…</p>';
  const s = d.summary;

  const balanceBar = d.stationRows.length ? (() => {
    const max = Math.max(...d.stationRows.map((r) => r.balanceUsd ?? 0), 1);
    return d.stationRows.map((r) => {
      const w = r.balanceUsd != null ? Math.max(2, Math.round((r.balanceUsd / max) * 100)) : 0;
      const color = r.balanceUsd != null && r.balanceUsd < (state.settings.lowBalanceUsd ?? 5) ? 'var(--danger)' : 'var(--accent)';
      return `<div class="row" style="margin:4px 0" title="${esc(r.name)}">
        <span style="width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" class="muted">${esc(r.name)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${w}%;background:${color}"></div></div>
        <span style="width:70px;text-align:right">${r.balanceUsd != null ? '$' + r.balanceUsd.toFixed(2) : '—'}</span>
      </div>`;
    }).join('');
  })() : '<p class="muted">暂无站点数据</p>';

  const stationTable = d.stationRows.length ? `
    <div class="table-wrap"><table>
      <thead><tr><th>站点</th><th>状态</th><th>余额</th><th>今日消费</th><th>Key</th><th>模型</th><th>健康度</th><th>告警</th><th>同步</th></tr></thead>
      <tbody>${d.stationRows.map((r) => {
        const [cls, label] = STATUS_BADGE[r.status] ?? ['', r.status];
        const healthColor = r.health >= 80 ? 'var(--accent)' : r.health >= 40 ? 'var(--warn)' : 'var(--danger)';
        const warnText = r.warnings.length ? esc(r.warnings[0]) + (r.warnings.length > 1 ? ` +${r.warnings.length - 1}` : '') : '—';
        const usageRow = (d.usage?.rows ?? []).find((u) => u.stationId === r.id);
        const todayCell = usageRow?.usd != null ? '$' + usageRow.usd.toFixed(4) + (usageRow.rpm ? `<br><span class="muted" style="font-size:11px">RPM ${usageRow.rpm}</span>` : '') : '<span class="muted" style="font-size:11px">' + (usageRow?.supported ? '—' : '不支持') + '</span>';
        return `<tr>
          <td><b>${esc(r.name)}</b><br><span class="muted" style="font-size:11px">${esc(protocolLabel(r.protocol))}</span></td>
          <td><span class="badge ${cls}">${label}</span>${r.sessionError ? `<br><span class="badge err" title="${esc(r.sessionError)}">需重新登录</span>` : ''}</td>
          <td>${r.balanceUsd != null ? '$' + r.balanceUsd.toFixed(2) : '—'}${r.frozenUsd ? `<br><span class="muted" style="font-size:11px">冻结 $${r.frozenUsd.toFixed(2)}</span>` : ''}</td>
          <td>${todayCell}</td>
          <td>${r.keyCount}${r.keysUnlimited ? ` <span class="muted" style="font-size:11px">(${r.keysUnlimited} 无限)</span>` : ''}${r.keysMasked ? `<br><span class="badge warn" style="font-size:10px">${r.keysMasked} 打码</span>` : ''}${r.keysExpired ? `<br><span class="badge err" style="font-size:10px">${r.keysExpired} 过期</span>` : ''}${r.keysLowQuota ? `<br><span class="badge warn" style="font-size:10px">${r.keysLowQuota} 低额度</span>` : ''}</td>
          <td>${r.modelsKnown || '—'}</td>
          <td><div class="bar-track bar-track-sm"><div class="bar-fill" style="width:${r.health}%;background:${healthColor}"></div></div> <span class="muted" style="font-size:11px">${r.health}</span></td>
          <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.warnings.join('；'))}">${warnText}</td>
          <td>${r.updatedAt ? `<span class="muted" style="font-size:11px">${new Date(r.updatedAt).toLocaleTimeString()}</span>` : '<span class="muted">—</span>'}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>` : '<p class="muted">还没有站点，去「中转站」添加</p>';

  const AGENT_ICON2 = { claude: '◆', codex: '◇', gemini: '✦', grok: '✧', openclaw: '❖', hermes: '✶' };
  const agentMatrix = `
    <div class="agent-grid">
      ${d.agentRows.map((a) => {
        const inst = d.agentInstall.find((x) => x.id === a.id) ?? {};
        const installed = inst.dirExists ? (inst.launcherBroken ? ['err', '启动器损坏'] : ['ok', '已安装']) : ['err', '未安装'];
        const cur = a.currentEntry;
        return `<div class="card" style="margin:0">
          <h3>${AGENT_ICON2[a.id] ?? '•'} ${esc(a.id)} ${installed[0] === 'ok' ? `<span class="badge ok">${inst.cliVersion ? esc(inst.cliVersion.split('(')[0]) : installed[1]}</span>` : `<span class="badge ${installed[0]}">${installed[1]}</span>`}</h3>
          <div style="margin-top:6px">
            ${cur ? `<div><span class="badge ${a.currentStationInvalid ? 'err' : 'ok'}">● ${esc(cur.name)}</span></div>
              <div class="muted" style="font-size:11px;margin-top:3px">${esc(cur.baseUrl ?? '')}${cur.model ? ' · ' + esc(cur.model) : ''}</div>
              ${a.currentStationInvalid ? '<div class="badge err" style="margin-top:4px">所连站点会话失效</div>' : ''}
              ${a.lastAppliedAt ? `<div class="muted" style="font-size:11px;margin-top:3px">写入于 ${new Date(a.lastAppliedAt).toLocaleString()}</div>` : ''}`
            : `<span class="muted">未配置（${a.entryCount} 个入口）</span>`}
          </div>
        </div>`;
      }).join('')}
    </div>`;

  const journalBtn = `<button class="btn small" id="btn-dash-journal">最近写入</button>`;

  return `
  <div class="spread">
    <div><h2>数据看板</h2><p class="sub">汇总 + 各站点健康度 · 生成于 ${new Date(d.generatedAt).toLocaleTimeString()}${s.lastSyncAt ? ' · 上次同步 ' + new Date(s.lastSyncAt).toLocaleTimeString() : ''}</p></div>
    <div class="row">${journalBtn}<button class="btn small primary" id="btn-dash-reload">刷新数据</button></div>
  </div>
  <section class="agent-grid">
    <div class="card" style="margin:0"><h3>中转站</h3><div class="kpi">${s.stations}</div>
      <div class="muted" style="margin-top:4px"><span class="badge ok">正常 ${s.stationsHealthy}</span> <span class="badge warn">告警 ${s.stationsWarn}</span> <span class="badge err">失效 ${s.stationsInvalid}</span></div></div>
    <div class="card" style="margin:0"><h3>总余额</h3><div class="kpi kpi-ok">$${s.balanceUsd.toFixed(2)}</div>
      <div class="muted" style="margin-top:4px">${s.balanceUsdKnown}/${s.stations} 个站点已知</div></div>
    <div class="card" style="margin:0"><h3>API Keys</h3><div class="kpi">${s.keys}</div>
      <div class="muted" style="margin-top:4px">${s.keysUnlimited} 无限 · ${s.keysMasked} 打码 · ${s.keysExpiring} 过期</div></div>
    <div class="card" style="margin:0"><h3>今日消费</h3><div class="kpi kpi-accent">$${(d.usage?.totalUsd ?? 0).toFixed(2)}</div>
      <div class="muted" style="margin-top:4px">${d.usage?.stationsKnown ?? 0}/${d.usage?.stationsTotal ?? 0} 站点 · RPM ${d.usage?.rpm ?? 0} · TPM ${d.usage?.tpm ?? 0}</div></div>
    <div class="card" style="margin:0"><h3>Agent 部署</h3><div class="kpi">${s.entriesActive}<span style="font-size:14px;color:var(--fg-muted)">/${s.entriesTotal}</span></div>
      <div class="muted" style="margin-top:4px">当前生效 / 累计入口 · ${s.warnings} 条告警</div></div>
  </section>
  <section class="card"><h3>各站余额分布</h3>${balanceBar}</section>
  <section class="card"><h3>各站今日消费</h3>${d.usage?.rows?.length ? d.usage.rows.map((r) => {
    const max = Math.max(...d.usage.rows.map((x) => x.usd ?? 0), 0.01);
    const w = r.usd != null && r.usd > 0 ? Math.max(2, Math.round((r.usd / max) * 100)) : 0;
    return `<div class="row" style="margin:4px 0" title="${esc(r.name)}">
      <span style="width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" class="muted">${esc(r.name)}</span>
      <div class="bar-track"><div style="width:${w}%;height:100%;background:var(--accent);border-radius:4px"></div></div>
      <span style="width:110px;text-align:right">${r.usd != null ? '$' + r.usd.toFixed(4) : (r.supported ? '—' : '<span class="muted">不支持</span>')} ${r.rpm ? '<span class="muted" style="font-size:11px">RPM ' + r.rpm + '</span>' : ''}</span>
    </div>`;
  }).join('') : '<p class="muted">暂无数据</p>'}</section>
  <section class="card"><h3>站点明细</h3>${stationTable}</section>
  <section><h3 style="font-size:16px;margin-bottom:10px">Agent 部署矩阵</h3>${agentMatrix}</section>`;
}

/* ---------------- 中转站视图 ---------------- */
function renderStations() {
  const cards = state.stations.map((s) => {
    const bal = s.balance?.usd != null ? `$${s.balance.usd.toFixed(2)}` : '—';
    const probe = s.probe ? ` · 检测: ${esc(s.probe.systemName || s.probe.family || '')}${s.probe.version ? ' ' + esc(s.probe.version) : ''}${s.probe.tokenApi === false ? ' · ⚠令牌API缺失' : ''}` : '';
    const warns = (s.warnings ?? []).map((w) => `<span class="badge warn">${esc(w.text)}</span>`).join(' ');
    const invalid = Boolean(s.sessionInvalid);
    const canLogin = LOGIN_PROTOCOLS.includes(s.protocol);
    const hasSession = Boolean(s.session?.cookie || s.session?.accessToken);
    return `
    <div class="card"${invalid ? ' style="border-color:#7a2b2b"' : ''}>
      <div class="spread">
        <h3>${esc(s.name)} <span class="badge ${s.protocol === 'newapi' ? 'ok' : ''}">${esc(protocolLabel(s.protocol))}</span>${invalid ? ' <span class="badge err">会话已失效</span>' : ''}</h3>
        <div class="row">
          ${LOGIN_PROTOCOLS.includes(s.protocol) ? `<button class="btn small" data-act="refresh" data-id="${esc(s.id)}">刷新</button>` : ''}
          ${canLogin && (!hasSession || invalid) ? `<button class="btn small primary" data-act="login" data-id="${esc(s.id)}">${invalid ? '重新登录' : '登录'}</button>` : ''}
          <button class="btn small" data-act="probe" data-id="${esc(s.id)}">模型验真</button>
          <button class="btn small" data-act="pricing" data-id="${esc(s.id)}">定价</button>
          <button class="btn small" data-act="ratio" data-id="${esc(s.id)}">比例${s.rechargeRatio != null ? ' ' + s.rechargeRatio : ''}</button>
          <button class="btn small" data-act="addkey" data-id="${esc(s.id)}">加 Key</button>
          <button class="btn small danger" data-act="delstation" data-id="${esc(s.id)}">删除</button>
        </div>
      </div>
      <div class="meta">${esc(s.baseUrl)} · 余额 ${bal}${s.updatedAt ? ' · 更新于 ' + new Date(s.updatedAt).toLocaleString() : ''}${probe}</div>
      ${invalid ? `<div style="margin-top:6px"><span class="badge err">${esc(s.sessionError ?? '会话已失效')}</span></div>` : ''}
      ${warns ? `<div style="margin-top:6px">${warns}</div>` : ''}
      ${s.keys?.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Key 名称</th><th>密钥</th><th>额度</th><th></th></tr></thead>
        <tbody>${s.keys.map((k) => `
          <tr>
            <td>${esc(k.name)} ${k.expired ? '<span class="badge err">已过期</span>' : ''}</td>
            <td><code>${esc(k.key ?? '（需刷新）')}</code>${k.masked ? ' <span class="badge warn">站点打码，测活/部署时自动取回</span>' : ''}</td>
            <td>${k.unlimited ? '无限' : k.usdRemain != null ? '$' + k.usdRemain.toFixed(2) : '—'}${!k.unlimited && k.usdRemain != null && k.usdRemain < 1 ? ' <span class="badge warn">将耗尽</span>' : ''}</td>
            <td class="row">
              <button class="btn small" data-act="verify" data-id="${esc(s.id)}" data-key="${esc(k.id)}">测活</button>
              <button class="btn small" data-act="copykey" data-id="${esc(s.id)}" data-key="${esc(k.id)}">复制</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table></div>` : `<p class="muted" style="margin-top:8px">还没有 Key：登录后刷新，或直接「加 Key」粘贴。</p>`}
    </div>`;
  }).join('');

  return `
  <div class="spread">
    <div><h2>中转站</h2><p class="sub">管理多个中转站账号；登录后自动拉取该站的全部 API Key 与余额</p></div>
    <div class="row"><button class="btn primary" id="btn-add-station">+ 添加中转站</button></div>
  </div>
  <section>${state.stations.length ? cards : `<div class="card"><p class="muted">还没有中转站。点击右上角添加，例如 https://api.xxx.com（new-api/one-api 系站点）。</p></div>`}</section>`;
}

function protocolLabel(p) {
  return { newapi: 'new-api 协议', sub2api: 'Sub2API 协议', anthropic: 'Anthropic 直连', generic: '通用模式' }[p] ?? p;
}
const LOGIN_PROTOCOLS = ['newapi', 'sub2api'];

/* ---------------- 一键配置视图 ---------------- */
function renderDeploy() {
  const cards = state.agents.map((a) => {
    const entries = state.entries[a.id]?.entries ?? [];
    const currentId = state.entries[a.id]?.currentEntryId ?? null;
    const installed = a.dirExists ? (a.fileExists ? 'ok' : 'warn') : 'err';
    const installedText = a.dirExists ? (a.fileExists ? '已安装' : '目录存在') : '未检测到';
    return `
    <div class="card">
      <div class="spread">
        <h3>${AGENT_ICON[a.id] ?? '•'} ${esc(a.name)} ${a.experimental ? '<span class="badge exp">实验</span>' : ''}</h3>
        <span class="badge ${installed}">${installedText}</span>
      </div>
      <div class="meta">${esc(a.dir)}${a.parseError ? ` · <span class="badge err">配置解析失败</span>` : ''}${a.launcherBroken ? ` · <span class="badge err">CLI 启动器损坏（原生二进制缺失）</span>` : ''}${a.cliVersion ? ` · <span class="muted">${esc(a.cliVersion)}</span>` : ''}</div>
      <div>${entries.length ? entries.map((e) => `
        <span class="entry-chip ${e.id === currentId ? 'current' : ''}" title="${esc(e.baseUrl || '')}">
          ${e.id === currentId ? '● ' : '○ '}${esc(e.name)}
          ${e.id !== currentId ? `<span class="chip-x" data-act="switchentry" data-agent="${a.id}" data-entry="${esc(e.id)}" title="切换">↺</span>` : ''}
          <span class="chip-x" data-act="delentry" data-agent="${a.id}" data-entry="${esc(e.id)}" title="移除">×</span>
        </span>`).join('') : '<span class="muted">暂无配置</span>'}</div>
      <div class="row" style="margin-top:10px">
        <button class="btn small primary" data-act="deployform" data-agent="${a.id}">一键配置</button>
      </div>
    </div>`;
  }).join('');

  return `
  <div class="spread">
    <div><h2>一键配置</h2><p class="sub">选中「中转站 → Key → Agent」，一次点击写入对应配置文件（自动备份，可撤销）</p></div>
    <div class="row"><button class="btn small" id="btn-undo">撤销上次写入</button></div>
  </div>
  <section class="agent-grid">${cards}</section>`;
}

/* ---------------- 设置视图 ---------------- */
function renderSettings() {
  return `
  <h2>设置</h2><p class="sub">数据默认存放于应用数据目录；Key 与密码使用系统级加密（DPAPI）保存</p>
  <section class="card">
    <h3>自动同步</h3>
    <p class="muted">启动后、每 30 分钟、窗口回到前台时拉取站点 Key/余额变更，并自动重写引用了变更 Key 的入口（不会替你切换供应商）。上次同步：${state.settings.lastSyncAt ? new Date(state.settings.lastSyncAt).toLocaleString() : '尚未同步'}</p>
    <div class="row" style="margin-top:10px">
      <label class="row"><input type="checkbox" id="set-autosync" ${state.settings.autoSync !== false ? 'checked' : ''} style="width:auto" /> 启用自动同步</label>
      <button class="btn primary" id="btn-sync-now">立即同步</button>
    </div>
  </section>
  <section class="card">
    <h3>预警</h3>
    <label class="field">低余额阈值（美元）</label>
    <input type="number" id="set-lowbal" min="0" step="0.5" value="${esc(state.settings.lowBalanceUsd ?? 5)}" style="max-width:120px" />
    <div class="row" style="margin-top:10px"><button class="btn primary" id="btn-save-settings">保存</button></div>
  </section>
  <section class="card">
    <h3>充值比例（用于价格到手价换算）</h3>
    <p class="muted">含义：充多少人民币得 1 美元额度。例：充 1.25 元得 $1 额度 → 填 1.25。到手价 = 官方USD价 × 分组倍率 × 充值比例（汇率强制 1:1）。留空则价格表不显示人民币列。</p>
    <label class="field">全局充值比例（元/$，可被单站点覆盖）</label>
    <input type="number" id="set-rr" step="0.05" min="0.1" value="${esc(state.settings.rechargeRatio ?? '')}" style="max-width:140px" />
    <div class="row" style="margin-top:10px"><button class="btn primary" id="btn-save-settings2">保存</button></div>
  </section>
  <section class="card">
    <h3>备份保留</h3>
    <label class="field">每个配置文件保留的备份份数</label>
    <input type="number" id="set-keep" min="1" max="200" value="${esc(state.settings.backupKeep ?? 20)}" style="max-width:120px" />
    <div class="row" style="margin-top:10px"><button class="btn primary" id="btn-save-settings2">保存</button></div>
  </section>
  <section class="card">
    <h3>数据与备份</h3>
    <div class="row">
      <button class="btn" data-open="data">打开数据目录</button>
      <button class="btn" data-open="backups">打开备份目录</button>
      <button class="btn" id="btn-journal">查看写入日志</button>
    </div>
  </section>
  <section class="card">
    <div class="row" style="gap:12px;align-items:center">
      <svg viewBox="0 0 512 512" width="44" height="44" aria-hidden="true" style="border-radius:10px;flex:0 0 auto">
        <rect width="512" height="512" rx="116" fill="#0F172A"/>
        <g stroke="#22C55E" stroke-width="44" stroke-linecap="round">
          <line x1="256" y1="198" x2="256" y2="88"/>
          <line x1="305.6" y1="284.6" x2="401.4" y2="339.9"/>
          <line x1="206.4" y1="284.6" x2="110.6" y2="339.9"/>
        </g>
        <circle cx="256" cy="256" r="58" fill="#22C55E"/>
      </svg>
      <div>
        <h3 style="margin:0">Relay<span style="color:var(--accent)">Hub</span></h3>
        <div class="muted" style="font-family:var(--font-mono)">多中转站 · 一键下发 Key</div>
      </div>
    </div>
    <p class="muted" style="margin-top:10px">RelayHub v0.18.3 — 多中转站 API Key 管理器。每个 Agent 的写入均为 additive 合并，保留你原有的其它配置；覆盖前自动备份并校验文件指纹。</p>
    <div class="row" style="margin-top:8px">
      <button class="btn" id="btn-check-update">检查更新</button>
      <span class="muted" id="update-hint">自动更新走 GitHub Releases（启动 / 每 6 小时检查一次，下载后重启即装）</span>
      <span class="muted" id="update-status"></span>
    </div>
  </section>`;
}

/* ---------------- 对话框 ---------------- */
/** 浏览器代登流程：打开站点登录页窗口 → 用户手动完成人机验证并登录 → 自动抓会话 */
async function browserLoginFlow(stationId, statusEl) {
  const setStatus = (t) => { if (statusEl) { const el = $('#bl-status', statusEl.closest?.('.dialog') ?? document); if (el) el.textContent = t; } };
  try {
    setStatus?.('正在打开站点登录窗口…');
    const r = await api('stations:browserLogin', { stationId });
    if (r?.applied) {
      $$('.dialog').forEach((d) => d.remove());
      await refreshAll(); render();
      toast('登录会话已同步，余额与 Key 已拉取', 'ok');
      return true;
    }
    if (r?.cancelled) {
      $$('.dialog').forEach((d) => d.remove());
      toast('已取消浏览器登录');
      return false;
    }
    // 失败：保留对话框与窗口，用户可改密码/重试后点「立即抓取」
    const msg = r?.applyError ?? '未抓到有效会话';
    setStatus?.(`自动抓取失败：${msg}——可在窗口里重新登录后点「我已登录，立即抓取」`);
    toast(`自动抓取失败：${msg}`, 'err');
    const blOpen = $('#bl-open'); if (blOpen) blOpen.disabled = false;
    const blCapture = $('#bl-capture'); if (blCapture) blCapture.disabled = false;
    return false;
  } catch (err) {
    setStatus?.(`失败：${err.message}`);
    toast(err.message, 'err');
    return false;
  }
}

function dialog(html) {
  // 同类对话框只保留一个：防叠加导致点击/焦点落在被遮挡的旧弹窗上
  $$('.dialog').forEach((d) => d.remove());
  const el = document.createElement('div');
  el.className = 'dialog';
  el.innerHTML = `<div class="panel">${html}</div>`;
  el.addEventListener('mousedown', (e) => { if (e.target === el) el.remove(); });
  document.body.appendChild(el);
  // 打开后立即把焦点放进第一个可输入控件（否则需要用户盲点一次才能输入）
  const firstInput = el.querySelector('input:not([type=checkbox]), select, textarea');
  if (firstInput) {
    // 等 DOM 布局完成再聚焦，Chromium 偶发的 autofocus 失效就出在这里
    requestAnimationFrame(() => { try { firstInput.focus(); } catch { /* 元素已移除 */ } });
  }
  // Esc 关闭；输入过程中阻止全局快捷键干扰
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); el.remove(); }
  });
  return el;
}

function addStationDialog() {
  const el = dialog(`
    <h3>添加中转站</h3>
    <label class="field">名称（可留空，默认用域名）</label>
    <input id="ds-name" placeholder="例如 某某中转站" />
    <label class="field">站点地址</label>
    <input id="ds-url" placeholder="https://api.example.com" />
    <label class="field">协议</label>
    <select id="ds-proto">
      <option value="">自动检测（推荐：访问站点公开端点指纹识别）</option>
      <option value="newapi">new-api / one-api 系（账号密码登录、自动拉 Key）</option>
      <option value="sub2api">Sub2API（订阅号池：Claude/OpenAI/Gemini/Grok 转 API）</option>
      <option value="anthropic">Anthropic 直连（官方 / anthropic 协议透传）</option>
      <option value="generic">通用（手动粘贴 Key / 官方 API）</option>
    </select>
    <label class="field">站点分支（协议为 new-api 系时生效）</label>
    <select id="ds-flavor">
      <option value="auto">自动（标准 new-api）</option>
      <option value="onehub">One-Hub</option>
      <option value="voapi">VoAPI（登录走 JWT Bearer）</option>
      <option value="veloera">Veloera</option>
    </select>
    <label class="field">用户名 / 邮箱（new-api 系与 Sub2API）</label>
    <input id="ds-user" placeholder="登录用户名或邮箱" />
    <label class="field">密码</label>
    <input id="ds-pass" type="password" placeholder="登录密码" />
    <div class="row" style="margin-top:14px"><button class="btn primary" id="ds-ok">添加</button><button class="btn" id="ds-cancel">取消</button></div>
  `);
  $('#ds-cancel', el).onclick = () => el.remove();
  $('#ds-ok', el).onclick = async () => {
    try {
      const payload = {
        name: $('#ds-name', el).value.trim(),
        baseUrl: $('#ds-url', el).value.trim(),
        protocol: $('#ds-proto', el).value || null, // 空 → 自动探测
        flavor: $('#ds-flavor', el).value,
        username: $('#ds-user', el).value.trim() || null,
        password: $('#ds-pass', el).value || null,
      };
      if (!payload.baseUrl) return toast('请填写站点地址', 'err');
      const station = await api('stations:add', payload);
      if (station.protocol === 'generic' && payload.protocol === null) {
        toast('未识别出 new-api 协议特征，已按「通用模式」添加；若该站其实是 new-api 系，可手动改协议', 'err');
      } else if (station.probe) {
        toast(`已识别协议: ${station.protocol}${station.probe.version ? '（' + station.probe.version + '）' : ''}`, 'ok');
      }
      if (payload.username && payload.password) {
        let req = { needsTurnstile: false };
        try { req = await api('stations:loginRequirements', { stationId: station.id }); } catch { /* 探测失败按普通登录 */ }
        if (req.needsTurnstile) {
          el.remove();
          toast('该站点开启了人机验证（Turnstile），请在打开的窗口里手动登录', 'ok');
          await browserLoginFlow(station.id);
          return;
        }
        toast('正在登录…');
        try {
          await api('stations:login', { id: station.id });
        } catch (err) {
          if (/turnstile/i.test(err.message)) {
            el.remove();
            toast('站点要求人机验证，请在打开的窗口里手动登录', 'ok');
            await browserLoginFlow(station.id);
            return;
          }
          throw err;
        }
        toast('登录成功，已拉取 Key', 'ok');
      }
      el.remove();
      await refreshAll(); render();
    } catch (err) { toast(err.message, 'err'); }
  };
}

function addKeyDialog(stationId = null) {
  const el = dialog(`
    <h3>添加 API Key</h3>
    ${stationId ? '' : `
    <label class="field">Base URL（中转站地址）</label>
    <input id="dk-url" placeholder="https://api.example.com" />
    <label class="field">站点名称</label>
    <input id="dk-station" placeholder="可选" />`}
    <label class="field">Key</label>
    <input id="dk-key" placeholder="sk-..." />
    <label class="field">备注名</label>
    <input id="dk-name" placeholder="可选" />
    <div class="row" style="margin-top:14px"><button class="btn primary" id="dk-ok">添加</button><button class="btn" id="dk-cancel">取消</button></div>
  `);
  $('#dk-cancel', el).onclick = () => el.remove();
  $('#dk-ok', el).onclick = async () => {
    try {
      const payload = {
        stationId,
        baseUrl: stationId ? null : $('#dk-url', el).value.trim(),
        name: $('#dk-name', el).value.trim(),
        key: $('#dk-key', el).value.trim(),
      };
      if (!stationId) {
        payload.name = payload.name || ($('#dk-station', el).value.trim() || '手动 Key');
        if (!payload.baseUrl) return toast('请填写 Base URL', 'err');
      }
      await api('stations:addKey', payload);
      el.remove(); await refreshAll(); render();
      toast('Key 已添加', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };
}

function deployDialog(agentId) {
  const agent = state.agents.find((a) => a.id === agentId);
  const stations = state.stations.filter((s) => s.keys?.length);
  if (!stations.length) return toast('还没有可用的 Key —— 先去「中转站」登录或添加', 'err');
  const options = stations.map((s) => `<optgroup label="${esc(s.name)}">${s.keys.map((k) => `<option value="${esc(s.id)}::${esc(k.id)}">${esc(k.name)}（${esc(s.name)}）</option>`).join('')}</optgroup>`).join('');
  const el = dialog(`
    <h3>一键配置 → ${esc(agent.name)}</h3>
    <p class="muted">配置文件：${esc(agent.file)}</p>
    <label class="field">选择中转站 Key</label>
    <select id="dp-key">${options}</select>
    <label class="field">模型（可选，留空用站点默认路由；输入框支持自动补全）</label>
    <input id="dp-model" list="dp-models" placeholder="例如 gpt-5 / claude-sonnet-4-5" />
    <datalist id="dp-models"></datalist>
    <div class="muted" id="dp-model-hint"></div>
    ${['codex', 'grok'].includes(agentId) ? `
    <label class="field">wire_api</label>
    <select id="dp-wire"><option value="responses">responses（唯一可用；codex 0.169+ 已彻底移除 chat，写了会启动失败）</option></select>` : ''}
    <div class="row" style="margin-top:14px"><button class="btn primary" id="dp-ok">写入</button><button class="btn" id="dp-cancel">取消</button></div>
  `);
  $('#dp-cancel', el).onclick = () => el.remove();
  const loadModels = async () => {
    const [stationId, keyId] = $('#dp-key', el).value.split('::');
    const hint = $('#dp-model-hint', el);
    try {
      const { models, cached } = await api('stations:listModels', { stationId, keyId });
      $('#dp-models', el).innerHTML = (models ?? []).map((m) => `<option value="${esc(m)}"></option>`).join('');
      hint.textContent = models?.length ? `该 Key 可用 ${models.length} 个模型${cached ? '（缓存）' : ''}，输入可自动补全` : '该端点未返回模型列表，可手动填写';
    } catch (err) {
      hint.textContent = `模型列表不可用：${err.message}（可手动填写）`;
    }
  };
  $('#dp-key', el).addEventListener('change', loadModels);
  loadModels();
  $('#dp-ok', el).onclick = async () => {
    const [stationId, keyId] = $('#dp-key', el).value.split('::');
    try {
      const r = await api('deploy:run', {
        agentId,
        stationId,
        keyId,
        model: $('#dp-model', el).value.trim() || null,
        wireApi: $('#dp-wire', el)?.value ?? 'responses',
      });
      el.remove(); await refreshAll(); render(); rebuildTrayNote();
      const pending = r.restartPending?.length ? `（${r.restartPending.join('/')} 正在运行，重启后生效）` : '';
      toast(`已写入 ${agent.name}，${agent.hint}${pending}`, 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };
}

function probeModelDialog(stationId) {
  const s = state.stations.find((x) => x.id === stationId);
  if (!s) return;
  const usable = (s.keys ?? []).filter((k) => k.key);
  if (!usable.length) return toast('该站点没有可用 Key 内容，请先登录刷新或「加 Key」粘贴', 'err');
  const el = dialog(`
    <h3>模型验真 — ${esc(s.name)}</h3>
    <label class="field">选择 Key</label>
    <select id="pm-key">${usable.map((k) => `<option value="${esc(k.id)}">${esc(k.name)}${k.usdRemain != null ? '（剩 $' + k.usdRemain.toFixed(2) + '）' : k.unlimited ? '（无限）' : ''}</option>`).join('')}</select>
    <label class="field">检测模式</label>
    <select id="pm-mode">
      <option value="call">真实调用 — 验通道可用性</option>
      <option value="list">列表校验 — 免费查 /v1/models</option>
      <option value="identity">身份探测 — 判套壳/降智（消耗较多）</option>
      <option value="inject">注入检测 — 查是否被塞系统提示（中等消耗）</option>
    </select>
    <div class="muted" id="pm-cost" style="margin-top:6px"></div>
    <label class="field">模型（可一次填多个，逗号/空格分隔，最多 10 个）</label>
    <input id="pm-models" list="pm-model-list" placeholder="例如 gpt-5, claude-sonnet-4-5" />
    <datalist id="pm-model-list"></datalist>
    <div class="muted" id="pm-hint"></div>
    <div class="row" style="margin-top:14px"><button class="btn primary" id="pm-run">开始检测</button><button class="btn" id="pm-close">关闭</button></div>
    <div id="pm-results" style="margin-top:10px"></div>
  `);
  $('#pm-close', el).onclick = () => el.remove();

  const COST_HINTS = {
    call: '预估消耗 · 每模型 1 次请求，max_tokens=16，约 20–80 tokens（按站点倍率计费）。批量 10 个 ≈ 200–800 tokens。',
    list: '免费 · 0 tokens。只请求 /v1/models 列表，不调用模型。列表有 ≠ 真能调，建议再用「真实调用」复核。',
    identity: '预估消耗（较高）· 每模型 2 次问诊（中文+英文交叉），max_tokens=180，约 200–600 tokens/模型；若模型用英文回答，会额外补一次中译（约 +100–200 tokens）以便中文展示。多个模型消耗线性叠加，谨慎批量。',
    inject: '预估消耗 · 每模型 4 次调用（极短探针 ×2 + 泄漏问询 + 干扰测试），约 200–600 tokens。探针用 max_tokens=1，本身几乎不产生输出费用；泄漏问询是大头。部分站点按次计费。',
  };
  const applyCostHint = () => {
    $('#pm-cost', el).textContent = COST_HINTS[$('#pm-mode', el).value] ?? '';
  };
  $('#pm-mode', el).addEventListener('change', applyCostHint);
  applyCostHint();

  const loadModels = async () => {
    const keyId = $('#pm-key', el).value;
    const hint = $('#pm-hint', el);
    try {
      const { models } = await api('stations:listModels', { stationId: s.id, keyId });
      $('#pm-model-list', el).innerHTML = (models ?? []).map((m) => `<option value="${esc(m)}"></option>`).join('');
      hint.textContent = models?.length ? `该 Key 可用 ${models.length} 个模型，点击输入框自动补全；也可手动填任意模型名` : '端点未返回模型列表，可手动填写任意模型名';
    } catch (err) {
      hint.textContent = `模型列表不可用：${err.message}（可手动填写）`;
    }
  };
  $('#pm-key', el).addEventListener('change', loadModels);
  loadModels();

  const usageText = (usage) => {
    if (!usage) return null;
    if (usage.total != null) return `tokens ${usage.total}（prompt ${usage.prompt ?? '?'} + completion ${usage.completion ?? '?'}）`;
    return `tokens ${usage.total_tokens ?? '?'}`;
  };

  $('#pm-run', el).onclick = async () => {
    const models = $('#pm-models', el).value.split(/[\s,;，；]+/).filter(Boolean).slice(0, 10);
    if (!models.length) return toast('请填写要验真的模型名', 'err');
    const mode = $('#pm-mode', el).value;
    const keyId = $('#pm-key', el).value;
    const btn = $('#pm-run', el);
    const results = $('#pm-results', el);
    if (mode === 'identity' && models.length > 3) {
      if (!confirm(`身份探测将对 ${models.length} 个模型各发 2 次请求（约 ${models.length * 400} tokens）。继续？`)) return;
    }
    if (mode === 'inject' && models.length > 3) {
      if (!confirm(`注入检测将对 ${models.length} 个模型各发 4 次请求（约 ${models.length * 400} tokens）。继续？`)) return;
    }
    btn.disabled = true;
    let batchTokens = 0;
    for (const m of models) {
      const row = document.createElement('div');
      row.style.cssText = 'padding:8px 0;border-bottom:1px solid var(--border)';
      row.innerHTML = `<span class="muted">${esc(m)} — 检测中…</span>`;
      results.appendChild(row);
      try {
        const r = await api('stations:probeModel', { stationId: s.id, keyId, model: m, mode });
        if (mode === 'identity') {
          batchTokens += r.totalTokens ?? 0;
          const src = r.summary;
          const summaryHtml = src
            ? `<div style="margin:6px 0;padding:6px 8px;background:var(--surface-2);border-radius:6px">
                 <div><b>模型：</b>${esc(src.modelName ?? '未说明')}</div>
                 <div><b>知识截止：</b>${esc(src.cutoff ?? '未说明')}</div>
                 <div><b>自称官方第一方：</b>${esc(src.official ?? '未说明')}</div>
               </div>`
            : '<div class="muted" style="margin:6px 0">未解析出结构化字段（模型回答格式不符），见下方中文译文。</div>';
          const items = (r.items ?? []).map((it) => {
            const u = usageText(it.usage) ?? (it.tokens ? `${it.tokens} tokens` : '—');
            if (!it.ok) return `<div style="margin:4px 0"><b>${esc(it.tag)}</b> <span class="badge err">失败</span> ${esc(it.error ?? '')}</div>`;
            const zhBlock = `<div style="margin:4px 0"><b>${esc(it.tag)}</b> <span class="muted">(${esc(u)} · ${it.latencyMs}ms${it.translated ? ' · 已中译' : ''})</span><br><code>${esc(it.content ?? '(空回复)')}</code></div>`;
            const orig = it.original && it.original !== it.content
              ? `<details style="margin:2px 0 6px"><summary class="muted" style="cursor:pointer">查看原文</summary><code class="muted">${esc(it.original)}</code></details>`
              : '';
            return zhBlock + orig;
          }).join('');
          row.innerHTML = `
            <div><span class="badge ${r.ok ? 'ok' : 'err'}">${r.ok ? '✓ 已应答' : '✗ 失败'}</span> <code>${esc(m)}</code>
              <span class="muted">合计 ${r.totalTokens ?? 0} tokens</span></div>
            ${summaryHtml}
            ${items}
            <div class="muted" style="margin-top:4px">两条自述应一致；不一致或拒绝回答 = 大概率套壳/注入。自述仅供参考，套壳可能撒谎，请结合倍率与上下文质量判断。</div>`;
        } else if (mode === 'inject') {
          batchTokens += r.totalTokens ?? 0;
          const p = r.probe ?? {};
          const SUS = {
            high: ['err', '疑似被注入（系统提示体积明显偏大）'],
            medium: ['warn', '可能有注入（建议用泄漏问询交叉确认）'],
            low: ['ok', '✓ 探针数值正常，未见明显注入'],
            unknown: ['warn', '站点未返回 token 用量，无法判定'],
          };
          const sus = SUS[p.suspicion] ?? SUS.unknown;
          const probeHtml = `
            <div style="margin:6px 0;padding:6px 8px;background:var(--surface-2);border-radius:6px">
              <div><span class="badge ${sus[0]}">${esc(sus[1])}</span></div>
              <div style="margin-top:4px"><b>短探针「hi」</b> prompt_tokens = <code>${p.smallPrompt ?? '—'}</code>
                ${p.overhead != null ? `（扣掉本身的约 2 tokens，疑似注入约 <b>${p.overhead}</b> tokens）` : ''}</div>
              <div><b>长探针对照</b> prompt_tokens = <code>${p.largePrompt ?? '—'}</code>
                ${p.delta != null ? `（两次差值 ${p.delta}，预期约 ${p.deltaExpected}${p.deltaAnomaly ? ' · 差值异常，站点 token 计数可能不可信' : ' · 差值合理'}）` : ''}</div>
            </div>`;
          const leak = r.leak ?? {};
          const leakHtml = leak.ok
            ? `<div style="margin:6px 0"><b>系统指令泄漏问询</b> <span class="muted">(${leak.tokens} tokens${leak.translated ? ' · 已中译' : ''})</span>
                 <div style="white-space:pre-wrap;margin-top:3px"><code>${esc((leak.content ?? '(空)').slice(0, 1200))}</code></div>
                 ${leak.original && leak.original !== leak.content ? `<details style="margin-top:3px"><summary class="muted" style="cursor:pointer">查看原文</summary><code class="muted">${esc(leak.original.slice(0, 800))}</code></details>` : ''}
               </div>`
            : `<div style="margin:6px 0"><b>系统指令泄漏问询</b> <span class="badge err">失败</span></div>`;
          const it = r.interference ?? {};
          const itVerdict = !it.ok ? '测试失败'
            : it.exact ? '✓ 精确输出，未被干扰'
              : it.contains ? '输出被加前后缀（可能被注入话术干预）'
                : '输出被改写或拒绝（明显干预）';
          const itHtml = `<div style="margin:6px 0"><b>指令遵循干扰测试</b> <span class="muted">(${it.tokens ?? 0} tokens)</span>
              <div style="margin-top:3px">要求输出 <code>${esc(it.expected ?? '')}</code> → 实测 <code>${esc((it.actual ?? '').slice(0, 120) || '(空)')}</code></div>
              <div class="muted">${esc(itVerdict)}</div></div>`;
          row.innerHTML = `
            <div><span class="badge ${r.ok ? 'ok' : 'err'}">${r.ok ? '✓ 完成' : '✗ 失败'}</span> <code>${esc(m)}</code>
              <span class="muted">合计 ${r.totalTokens ?? 0} tokens</span></div>
            ${probeHtml}${leakHtml}${itHtml}
            <div class="muted" style="margin-top:4px">仅对粗糙注入有效：短小或语义融入的注入抓不到；数值偏大也可能来自站点合理的适配提示（如 Claude Code 工具规范），请结合泄漏问询自行判断。</div>`;
        } else if (mode === 'call') {
          const u = usageText(r.usage);
          if (u) batchTokens += r.usage?.total ?? 0;
          const detail = r.ok
            ? [`${r.latencyMs}ms`, u, r.content ? `「${esc(String(r.content).slice(0, 80))}」` : null].filter(Boolean).join(' · ')
            : (r.error ?? '失败');
          row.innerHTML = `<span class="badge ${r.ok ? 'ok' : 'err'}">${r.ok ? '✓ 可用' : '✗ 失败'}</span> <code>${esc(m)}</code>　${detail}`;
        } else {
          const detail = r.ok ? '在 /v1/models 列表中' : (r.error ?? '失败');
          row.innerHTML = `<span class="badge ${r.ok ? 'ok' : 'err'}">${r.ok ? '✓ 在列' : '✗ 不在列'}</span> <code>${esc(m)}</code>　${esc(detail)}`;
        }
      } catch (err) {
        row.innerHTML = `<span class="badge err">✗ 异常</span> <code>${esc(m)}</code>　${esc(err.message)}`;
      }
    }
    if (mode !== 'list' && models.length > 1) {
      const sum = document.createElement('div');
      sum.className = 'muted';
      sum.style.padding = '8px 0';
      sum.textContent = `本批合计消耗约 ${batchTokens} tokens（以站点账单为准）`;
      results.appendChild(sum);
    }
    btn.disabled = false;
  };
}

/** 充值比例设置：本站单独设置，或跟随全局 */
async function ratioDialog(stationId) {
  const s = state.stations.find((x) => x.id === stationId);
  if (!s) return;
  const eff = await api('stations:effectiveRatio', { stationId }).catch(() => ({ ratio: null, source: 'none' }));
  const global = state.settings.rechargeRatio ?? null;
  const srcLabel = eff.source === 'station' ? '本站单独设置' : eff.source === 'global' ? '跟随全局' : '未设置';
  const el = dialog(`
    <h3>充值比例 — ${esc(s.name)}</h3>
    <p class="muted">含义：充多少人民币得 1 美元额度。例：充 1.25 元得 $1 → 填 1.25。到手价 = 标价 × 组倍率 × 本站比例。</p>
    <div class="muted" style="margin:8px 0">当前生效：<b>${eff.ratio ?? '—'}</b>（${srcLabel}）· 全局默认：${global ?? '未设置'}</div>
    <label class="field">本站充值比例（元/$）</label>
    <input type="number" id="rt-val" step="0.05" min="0.1" placeholder="留空 = 跟随全局" value="${s.rechargeRatio ?? ''}" style="max-width:180px" />
    <div class="row" style="margin-top:14px">
      <button class="btn primary" id="rt-save">保存本站比例</button>
      <button class="btn" id="rt-follow">跟随全局（清除本站）</button>
      <button class="btn" onclick="this.closest('.dialog').remove()">取消</button>
    </div>
  `);
  const save = async (ratio) => {
    try {
      await api('stations:setRechargeRatio', { stationId, ratio });
      el.remove();
      await refreshAll(); render();
      toast(ratio != null ? `本站比例已设为 ${ratio} 元/$` : '已改为跟随全局设置', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  };
  $('#rt-save', el).onclick = () => {
    const v = $('#rt-val', el).value;
    if (v === '' || !(Number(v) > 0)) return toast('请填写大于 0 的数值（元/$）', 'err');
    save(Number(v));
  };
  $('#rt-follow', el).onclick = () => save(null);
}

/** 定价对话框：分组倍率联动 + 官方USD价 / 人民币到手价（充值比例可调） */
async function pricingDialog(stationId) {
  const s = state.stations.find((x) => x.id === stationId);
  if (!s) return;
  let p;
  try { p = await api('stations:fetchPricing', { stationId: stationId, force: true }); }
  catch (err) { return toast(`定价拉取失败：${err.message}`, 'err'); }
  let eff = await api('stations:effectiveRatio', { stationId }).catch(() => ({ ratio: null, source: 'none' }));
  let rechargeRatio = eff.ratio ?? null; // 元/USD（充 X 元得 1 USD 额度 → X）
  let ratioSource = eff.source;          // station | global | none
  let selectedGroup = '';
  const fx = p.usdExchangeRate ?? 1;

  const el = dialog(`
    <h3>模型定价 — ${esc(s.name)}</h3>
    <p class="muted">${esc(p.note ?? '')} · ${p.models?.length ?? 0} 条 · 拉取于 ${new Date(p.fetchedAt).toLocaleTimeString()}${p.cached ? '（缓存）' : ''}</p>
    <div class="row" style="margin:10px 0">
      <input id="pr-search" placeholder="搜索模型名…" style="flex:1;max-width:240px" />
      <select id="pr-group" style="max-width:220px"></select>
      <label class="row" style="gap:6px;margin:0"><span class="muted">本站充值比例(元/$)</span>
        <input type="number" id="pr-rr" step="0.05" min="0.1" placeholder="如 1.25" value="${rechargeRatio ?? ''}" style="width:90px" /></label>
      <button class="btn small" id="pr-rr-clear" title="清除本站设置，改为跟随全局">跟随全局</button>
      <button class="btn small" id="pr-refresh">强制刷新</button>
    </div>
    <div class="muted" id="pr-fx" style="margin-bottom:8px"></div>
    <div style="max-height:50vh;overflow:auto">
      <table id="pr-table">
        <thead><tr><th>模型</th><th>组倍率</th><th>标价 $入/出 每 M</th><th>到手价 ¥入/出 每 M</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="muted" style="margin-top:8px">到手价 = 官方USD价 × 分组倍率 × 充值比例（汇率强制 1:1，所有站点统一）。充值比例 = 充值金额 ÷ 到账美元额度。</div>
    <div class="row" style="margin-top:10px"><button class="btn" onclick="this.closest('.dialog').remove()">关闭</button></div>
  `);

  const allGroups = [...new Set([
    ...Object.keys(p.groupRatio ?? {}),
    ...(p.groups ?? []).map((g) => g.name),
  ])];
  $('#pr-group', el).innerHTML = `<option value="">全部分组（取最低倍率展示）</option>` + allGroups.map((g) => {
    const r = p.groupRatio?.[g] ?? (p.groups ?? []).find((x) => x.name === g)?.rateMultiplier;
    return `<option value="${esc(g)}">${esc(g)}${r != null ? ` ×${r}` : ''}</option>`;
  }).join('');
  $('#pr-group', el).addEventListener('change', () => { selectedGroup = $('#pr-group', el).value; render(); });

  const fxLine = $('#pr-fx', el);
  const fxText = () => {
    const srcLabel = ratioSource === 'station' ? '本站单独设置' : ratioSource === 'global' ? '跟随全局设置' : '未设置（人民币列隐藏）';
    fxLine.textContent = `汇率：固定 1:1 · 充值比例: ${rechargeRatio ?? '—'}（${srcLabel}）· 到手价 = 标价 × 组倍率 × 充值比例`;
  };
  fxText();

  const render = () => {
    const q = ($('#pr-search', el)?.value ?? '').toLowerCase();
    const grp = selectedGroup;
    const models = (p.models ?? []).filter((m) => {
      if (q && !m.model.toLowerCase().includes(q)) return false;
      // sub2api：模型归属单个分组（m.group 字符串）；new-api：m.groups 数组
      if (grp) {
        const inGroups = m.groups?.length ? m.groups.includes(grp) : (m.group === grp);
        if (!inGroups) return false;
      }
      return true;
    });
    const rowsOut = [];
    for (const m of models.slice(0, 300)) {
      // 展示所选分组的倍率；未选分组时取该模型所属分组中最低倍率（最划算）
      // 注意：sub2api 形态 usdPerMillionInput 已含组倍率（priceSource=official_table），渲染层 gr 必须为 1，
      // new-api 形态（表达式/倍率估算）标价不含组倍率，gr 才参与计算。
      const alreadyMultiplied = m.priceSource === 'official_table' || m.priceSource === 'group_only';
      const grpNames = m.groups?.length ? m.groups : (m.group ? [m.group] : []);
      const candidates = grpNames.map((g) => ({ g, r: alreadyMultiplied ? 1 : Number(p.groupRatio?.[g] ?? m.groupRateMultiplier ?? 1) }));
      const chosen = grp ? candidates.find((c) => c.g === grp) : candidates.sort((a, b) => a.r - b.r)[0];
      const gr = chosen?.r ?? 1;
      // 多档计费：未选分组时取最便宜档；选中分组时若模型有 tiers 则展示两档（带 len 范围标签）
      const src = m.priceSource === 'expr' ? '【计费表达式】' : m.priceSource === 'expr_fixed' ? '【表达式·按次】' : m.priceSource === 'per_call' ? '【按次】' : m.priceSource === 'official_table' ? '【官方参考价×组倍率】' : m.priceSource === 'group_only' ? '【分组占位】' : '【倍率估算】';
      const perReq = m.perRequest != null;
      const tag = m.quotaType === 1 ? '（按次）' : '';
      const tiers = perReq
        ? [{ name: null, rangeLabel: null, usdIn: m.usdPerMillionInput, usdOut: m.usdPerMillionOutput }]
        : (m.tiers?.length ?? 0) > 1 ? m.tiers : [{ name: null, rangeLabel: null, usdIn: m.usdPerMillionInput, usdOut: m.usdPerMillionOutput }];
      for (const t of tiers) {
        const usdIn = t.usdIn * gr;
        const usdOut = t.usdOut * gr;
        const cnyIn = fx && rechargeRatio ? usdIn * fx * rechargeRatio : null;
        const cnyOut = fx && rechargeRatio ? usdOut * fx * rechargeRatio : null;
        const unit = perReq ? '/次' : ' /M';
        const tierTag = (tiers.length > 1 && t.rangeLabel) ? `<span class="badge ${/plus|>/.test(t.rangeLabel) ? 'warn' : 'ok'}" style="font-size:10px">${esc(t.rangeLabel)}</span>` : '';
        const unknownPrice = m.usdPerMillionInput == null;
        rowsOut.push(`<tr>
          <td><code>${esc(m.model)}</code>${tierTag}${grp ? `<br><span class="muted" style="font-size:11px">${esc(chosen?.g ?? '')}</span>` : ''}${tiers.length === 1 ? `<br><span class="muted" style="font-size:10px">${src}</span>` : ''}${m.keyName ? `<br><span class="muted" style="font-size:10px">Key: ${esc(m.keyName)}</span>` : ''}</td>
          <td>${tag}×${gr}</td>
          <td>${unknownPrice ? '<span class="muted">—（官方表无此模型）</span>' : `$${usdIn.toFixed(2)} / $${usdOut.toFixed(2)}${perReq ? '/次' : ''}`}</td>
          <td>${unknownPrice ? '<span class="muted">—</span>' : (cnyIn != null ? `¥${cnyIn.toFixed(2)} / ¥${cnyOut.toFixed(2)}${perReq ? '/次' : ''}` : '<span class="muted">未设充值比例</span>')}</td>
        </tr>`);
      }
    }
    $('#pr-table tbody', el).innerHTML = rowsOut.join('') || '<tr><td colspan="4" class="muted">无匹配模型</td></tr>';
  };

  $('#pr-search', el).addEventListener('input', render);
  const applyRatio = async (value) => {
    const v = value == null || value === '' ? null : Number(value);
    rechargeRatio = Number.isFinite(v) && v > 0 ? v : null;
    ratioSource = rechargeRatio != null ? 'station' : 'global';
    try {
      const r = await api('stations:setRechargeRatio', { stationId, ratio: rechargeRatio });
      ratioSource = rechargeRatio != null ? 'station' : (r?.global != null ? 'global' : 'none');
      // 本站比例改变 → 服务端已清缓存，重新取一份定价（到手价重算）
      p = await api('stations:fetchPricing', { stationId, force: true }).catch(() => p);
      await refreshAll().catch(() => {});
    } catch (err) { toast(err.message, 'err'); return; }
    $('#pr-rr', el).value = rechargeRatio ?? '';
    fxText(); render();
    toast(rechargeRatio != null ? `本站充值比例已保存：${rechargeRatio} 元/$` : '已改为跟随全局设置', 'ok');
  };
  $('#pr-rr', el).addEventListener('change', () => applyRatio($('#pr-rr', el).value));
  $('#pr-rr-clear', el).addEventListener('click', () => applyRatio(null));
  $('#pr-refresh', el).onclick = async () => {
    try {
      p = await api('stations:fetchPricing', { stationId: stationId, force: true });
      toast('定价已强制刷新', 'ok');
      $('#pr-group', el).innerHTML = `<option value="">全部分组</option>` + allGroupsOf(p).map((g) => `<option value="${esc(g.name)}">${esc(g.name)}${g.r != null ? ` ×${g.r}` : ''}</option>`).join('');
      render();
    } catch (err) { toast(err.message, 'err'); }
  };
  render();
}

function allGroupsOf(p) {
  return [...new Set([...Object.keys(p.groupRatio ?? {}), ...(p.groups ?? []).map((g) => g.name)])].map((name) => ({ name, r: p.groupRatio?.[name] ?? (p.groups ?? []).find((x) => x.name === name)?.rateMultiplier }));
}

/* ---------------- 比价视图 ---------------- */
const COMPARE_DEFAULT = {
  q: '', stationIds: [], group: '', billing: 'all',
  vendor: '', modelKey: '',
  sort: 'cnyIn-asc', basis: 'in',
  knownOnly: true, cheapestOnly: false,
};

function compareState() {
  if (!state.compare) state.compare = { filters: { ...COMPARE_DEFAULT }, stats: null, rows: [], meta: null, syncing: false };
  return state.compare;
}

function renderCompare() {
  const c = compareState();
  const st = c.stats;
  const f = c.filters;
  const stations = st?.stations ?? [];
  const selectedStations = stations.filter((s) => f.stationIds.includes(s.id));
  const stationSummary = selectedStations.length === 0 ? `全部站点（${stations.length}）`
    : selectedStations.length === 1 ? selectedStations[0].name
      : `已选 ${selectedStations.length} 个站点`;
  const stationList = stations.map((s) => `
    <label class="cmp-opt ${f.stationIds.includes(s.id) ? 'on' : ''}" title="${esc(s.protocol)}${s.error ? ' · ' + esc(s.error) : ''}">
      <input type="checkbox" data-cmp-station="${esc(s.id)}" ${f.stationIds.includes(s.id) ? 'checked' : ''} />
      <span class="cmp-opt-name">${esc(s.name)}</span>
      <span class="muted">${s.entries}</span>
      ${s.error ? '<span class="badge err">!</span>' : ''}
    </label>`).join('');

  return `
  <div class="spread">
    <div><h2>比价</h2><p class="sub">本地价格库 · ${st ? `${st.models} 个模型 / ${st.entries} 条价格 · ${st.known} 条有价` : '尚未同步'}${st?.updatedAt ? ' · 更新于 ' + new Date(st.updatedAt).toLocaleString() : ''}</p></div>
    <div class="row">
      <button class="btn primary" id="cmp-sync">抓取全部价格</button>
      <button class="btn" id="cmp-clear">清空价格库</button>
    </div>
  </div>
  <section class="card">
    <div class="cmp-grid">
      <label class="cmp-field">
        <span>站点</span>
        <details class="cmp-dd" id="cmp-station-dd">
          <summary id="cmp-station-summary">${esc(stationSummary)}</summary>
          <div class="cmp-dd-panel">
            <div class="row" style="justify-content:space-between;margin-bottom:6px">
              <button class="btn small" id="cmp-station-all">全选</button>
              <button class="btn small" id="cmp-station-none">清空</button>
            </div>
            <div class="cmp-dd-list">${stationList || '<span class="muted">暂无站点</span>'}</div>
          </div>
        </details>
      </label>
      <label class="cmp-field">
        <span>公司</span>
        <select id="cmp-vendor" title="按模型所属公司筛选"><option value="">全部公司</option></select>
      </label>
      <label class="cmp-field">
        <span>模型</span>
        <select id="cmp-model" title="按具体模型筛选"><option value="">全部模型</option></select>
      </label>
      <label class="cmp-field">
        <span>分组</span>
        <select id="cmp-group" title="按分组筛选（随站点/公司/模型联动）"><option value="">全部分组</option></select>
      </label>
      <label class="cmp-field">
        <span>计费方式</span>
        <select id="cmp-billing">
          <option value="all" ${f.billing === 'all' ? 'selected' : ''}>全部</option>
          <option value="token" ${f.billing === 'token' ? 'selected' : ''}>按量 (token)</option>
          <option value="percall" ${f.billing === 'percall' ? 'selected' : ''}>按次</option>
        </select>
      </label>
      <label class="cmp-field">
        <span>比价基准</span>
        <select id="cmp-basis" title="用哪个价格比">
          <option value="in" ${f.basis === 'in' ? 'selected' : ''}>输入价</option>
          <option value="out" ${f.basis === 'out' ? 'selected' : ''}>输出价</option>
          <option value="sum" ${f.basis === 'sum' ? 'selected' : ''}>入+出合计</option>
        </select>
      </label>
      <label class="cmp-field">
        <span>排序</span>
        <select id="cmp-sort">
          <option value="cnyIn-asc" ${f.sort === 'cnyIn-asc' ? 'selected' : ''}>价格从低到高</option>
          <option value="cnyIn-desc" ${f.sort === 'cnyIn-desc' ? 'selected' : ''}>价格从高到低</option>
          <option value="cnyOut-asc" ${f.sort === 'cnyOut-asc' ? 'selected' : ''}>输出价从低到高</option>
          <option value="model-asc" ${f.sort === 'model-asc' ? 'selected' : ''}>按模型名</option>
          <option value="station-asc" ${f.sort === 'station-asc' ? 'selected' : ''}>按站点</option>
          <option value="fetchedAt-desc" ${f.sort === 'fetchedAt-desc' ? 'selected' : ''}>按更新时间</option>
        </select>
      </label>
      <div class="cmp-field">
        <span>过滤</span>
        <div class="cmp-checks">
          <label class="cmp-opt ${f.knownOnly ? 'on' : ''}"><input type="checkbox" id="cmp-known" ${f.knownOnly ? 'checked' : ''} /><span>仅已知价格</span></label>
          <label class="cmp-opt ${f.cheapestOnly ? 'on' : ''}"><input type="checkbox" id="cmp-cheapest" ${f.cheapestOnly ? 'checked' : ''} /><span>仅每模型最低价</span></label>
        </div>
      </div>
      <div class="cmp-field">
        <span>&nbsp;</span>
        <button class="btn" id="cmp-reset">重置筛选</button>
      </div>
    </div>
  </section>
  <section class="card">
    <div class="spread" style="margin-bottom:6px">
      <h3 style="margin:0">价格对比</h3>
      <span class="muted" id="cmp-meta">加载中…</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>站点</th><th>模型</th><th>公司</th><th>分组</th><th>组倍率</th>
          <th>输入 ¥/M</th><th>输出 ¥/M</th><th>相对最低</th><th>来源</th><th>更新</th>
        </tr></thead>
        <tbody id="cmp-tbody"><tr><td colspan="10" class="muted">加载中…</td></tr></tbody>
      </table>
    </div>
    <div class="muted" style="margin-top:8px">价格为本地库中的到手价（= 站点标价 × 分组倍率 × 本站充值比例，汇率固定 1:1）。点「抓取全部价格」会重新拉取并覆盖旧数据。</div>
  </section>`;
}

function collectCompareFilters() {
  const f = compareState().filters;
  f.q = ''; // 搜索框已移除，仅保留结构化筛选
  f.group = $('#cmp-group')?.value ?? '';
  f.billing = $('#cmp-billing')?.value ?? 'all';
  f.basis = $('#cmp-basis')?.value ?? 'in';
  f.sort = $('#cmp-sort')?.value ?? 'cnyIn-asc';
  f.vendor = $('#cmp-vendor')?.value ?? '';
  f.modelKey = $('#cmp-model')?.value ?? '';
  f.knownOnly = $('#cmp-known') ? $('#cmp-known').checked : true;
  f.cheapestOnly = $('#cmp-cheapest') ? $('#cmp-cheapest').checked : false;
  f.stationIds = $$('[data-cmp-station]').filter((el) => el.checked).map((el) => el.dataset.cmpStation);
  return f;
}

async function loadCompareRows() {
  const c = compareState();
  const f = collectCompareFilters();
  const tbody = $('#cmp-tbody');
  const meta = $('#cmp-meta');
  if (!tbody) return;
  try {
    const res = await api('book:query', f);
    c.rows = res.rows;
    c.meta = res;
    const srcLabel = { expr: '表达式', expr_fixed: '表达式按次', per_call: '按次', ratio: '倍率估算', official_table: '官方表', group_only: '分组占位', unknown: '未知' };
    tbody.innerHTML = res.rows.length ? res.rows.map((r) => {
      const isPerCall = r.perRequest != null;
      const fmt = (v, per) => (v == null ? '<span class="muted">—</span>' : `¥${v.toFixed(v < 1 ? 4 : 2)}${per ? '/次' : ''}`);
      const vs = r.vsLowestPct;
      const vsTxt = r.isCheapest ? '<span class="badge ok">最低</span>' : (vs == null ? '<span class="muted">—</span>' : `<span class="muted">+${vs.toFixed(1)}%</span>`);
      return `<tr class="${r.isCheapest ? 'cmp-best' : ''}">
        <td>${esc(r.stationName)}</td>
        <td><code>${esc(r.model)}</code></td>
        <td><span class="muted" style="font-size:11.5px">${esc(r.vendor ?? '其他')}</span></td>
        <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.group)}">${esc(r.group || '—')}</td>
        <td>×${r.groupRatio ?? 1}</td>
        <td class="num">${fmt(r.cnyIn, isPerCall)}</td>
        <td class="num">${fmt(r.cnyOut, isPerCall)}</td>
        <td>${vsTxt}</td>
        <td><span class="muted" style="font-size:11px">${esc(srcLabel[r.priceSource] ?? r.priceSource)}</span></td>
        <td><span class="muted" style="font-size:11px">${r.fetchedAt ? new Date(r.fetchedAt).toLocaleTimeString() : '—'}</span></td>
      </tr>`;
    }).join('') : `<tr><td colspan="10" class="muted">${res.total === 0 ? '没有匹配价格——先点「抓取全部价格」，或放宽筛选条件' : '无匹配'}</td></tr>`;
    meta.textContent = `${res.shown}/${res.total} 条 · 覆盖 ${res.modelsCompared} 个模型`;
    // 公司 / 模型 / 分组下拉：用后端级联 facet 填充
    updateFacetOptions(res);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="10" class="muted">查询失败：${esc(err.message)}</td></tr>`;
  }
}

/** 用后端 facet 刷新「公司 / 模型 / 分组」下拉（级联联动：站点 → 公司 → 模型 → 分组） */
function updateFacetOptions(res) {
  const f = compareState().filters;
  const vsel = $('#cmp-vendor');
  const msel = $('#cmp-model');
  const gsel = $('#cmp-group');
  if (!vsel || !msel || !gsel) return;
  const vendors = res?.facets?.vendors ?? [];
  const models = res?.facets?.models ?? [];
  const groups = res?.facets?.groups ?? [];

  // 公司（受站点/关键词影响）
  const curV = f.vendor ?? '';
  vsel.innerHTML = `<option value="">全部公司</option>` + vendors.map((v) =>
    `<option value="${esc(v.name)}" ${curV === v.name ? 'selected' : ''}>${esc(v.name)} (${v.count})</option>`).join('');
  if (curV && !vendors.some((v) => v.name === curV)) { vsel.value = ''; f.vendor = ''; }

  // 模型（受公司影响）
  const scope = f.vendor ? models.filter((m) => m.vendor === f.vendor) : models;
  const curM = f.modelKey ?? '';
  msel.innerHTML = `<option value="">全部模型</option>` + scope.slice(0, 400).map((m) =>
    `<option value="${esc(m.key)}" ${curM === m.key ? 'selected' : ''}>${esc(m.label)} (${m.count})</option>`).join('');
  if (curM && !scope.some((m) => m.key === curM)) { msel.value = ''; f.modelKey = ''; }
  msel.title = scope.length > 400 ? `模型过多（${scope.length}），仅列前 400 个，可用搜索框缩小范围` : '按具体模型筛选';

  // 分组（受站点/公司/模型影响）
  const curG = f.group ?? '';
  gsel.innerHTML = `<option value="">全部分组</option>` + groups.slice(0, 400).map((g) =>
    `<option value="${esc(g.name)}" ${curG === g.name ? 'selected' : ''}>${esc(g.name)} (${g.count})</option>`).join('');
  if (curG && !groups.some((g) => g.name === curG)) { gsel.value = ''; f.group = ''; }
  gsel.title = groups.length > 400 ? `分组过多（${groups.length}），可用搜索框缩小范围` : '按分组筛选（随站点/公司/模型联动）';
  gsel.disabled = groups.length === 0;
}

async function loadCompareStats() {
  const c = compareState();
  c.stats = await api('book:stats');
  return c.stats;
}

function bindCompare() {
  const reload = () => { loadCompareRows(); };
  ['#cmp-group', '#cmp-billing', '#cmp-basis', '#cmp-sort', '#cmp-vendor', '#cmp-model'].forEach((sel) => {
    $(sel)?.addEventListener('change', reload);
  });
  ['#cmp-known', '#cmp-cheapest'].forEach((sel) => {
    $(sel)?.addEventListener('change', (e) => {
      e.currentTarget.closest('.cmp-opt')?.classList.toggle('on', e.currentTarget.checked);
      reload();
    });
  });

  // 站点筛选（多选下拉）
  const dd = $('#cmp-station-dd');
  const summary = $('#cmp-station-summary');
  const syncSummary = () => {
    const boxes = $$('[data-cmp-station]');
    const picked = boxes.filter((b) => b.checked);
    const total = boxes.length;
    if (!summary) return;
    summary.textContent = picked.length === 0 ? `全部站点（${total}）`
      : picked.length === 1 ? (picked[0].closest('.cmp-opt')?.querySelector('.cmp-opt-name')?.textContent ?? '1 个站点')
        : `已选 ${picked.length} 个站点`;
    $$('.cmp-opt[data-cmp-station-wrap]').forEach(() => {});
  };
  $$('[data-cmp-station]').forEach((el) => el.addEventListener('change', () => {
    el.closest('.cmp-opt')?.classList.toggle('on', el.checked);
    syncSummary();
    reload();
  }));
  $('#cmp-station-all')?.addEventListener('click', (e) => {
    e.preventDefault();
    $$('[data-cmp-station]').forEach((el) => { el.checked = true; el.closest('.cmp-opt')?.classList.add('on'); });
    syncSummary(); reload();
  });
  $('#cmp-station-none')?.addEventListener('click', (e) => {
    e.preventDefault();
    $$('[data-cmp-station]').forEach((el) => { el.checked = false; el.closest('.cmp-opt')?.classList.remove('on'); });
    syncSummary(); reload();
  });
  // 点击外部收起站点下拉
  if (!window.__cmpOutsideBound) {
    window.__cmpOutsideBound = true;
    document.addEventListener('mousedown', (e) => {
      const cur = $('#cmp-station-dd');
      if (cur && cur.open && !cur.contains(e.target)) cur.open = false;
    });
  }
  syncSummary();

  $('#cmp-reset')?.addEventListener('click', () => {
    compareState().filters = { ...COMPARE_DEFAULT };
    render();
  });
  $('#cmp-sync')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = '抓取中…';
    try {
      const s = await api('book:sync', { force: true });
      toast(`已抓取 ${s.stations} 个站点、${s.entries} 条价格${s.failed.length ? `；${s.failed.length} 站失败` : ''}`, s.failed.length ? 'err' : 'ok');
      if (s.failed.length) console.warn('比价抓取失败站点:', s.failed);
      await loadCompareStats(); render();
    } catch (err) { toast(err.message, 'err'); btn.disabled = false; btn.textContent = '抓取全部价格'; }
  });
  $('#cmp-clear')?.addEventListener('click', async () => {
    if (!confirm('清空本地价格库？（不影响站点与 Key，只删价格数据）')) return;
    await api('book:clear');
    await loadCompareStats(); render();
    toast('价格库已清空', 'ok');
  });
}

/* ---------------- 事件 ---------------- */
function rebuildTrayNote() { /* 托盘由主进程自动重建 */ }

async function onMainClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  try {
    if (act === 'refresh') {
      const s = state.stations.find((x) => x.id === btn.dataset.id);
      btn.disabled = true; btn.textContent = '刷新中…';
      try {
        const r = await api('stations:refresh', { id: btn.dataset.id });
        await refreshAll(); render();
        toast(`已刷新「${s?.name ?? ''}」：${r?.keys?.length ?? 0} 个 Key，余额 ${r?.balance?.usd != null ? '$' + r.balance.usd.toFixed(2) : '—'}`, 'ok');
      } catch (err) {
        // 失败也要重渲染：服务端已置位 sessionInvalid，卡片需露出「重新登录」
        await refreshAll().catch(() => {});
        render();
        toast(err.message, 'err');
      }
    }
    if (act === 'login') {
      const s = state.stations.find((x) => x.id === btn.dataset.id);
      let req = { needsTurnstile: false };
      try { req = await api('stations:loginRequirements', { stationId: s.id }); } catch { /* 探测失败按普通登录处理 */ }
      if (req.needsTurnstile) {
        const el = dialog(`
          <h3>登录 ${esc(s.name)}</h3>
          <p class="muted" style="margin:8px 0">该站点开启了 <b>Cloudflare Turnstile 人机验证</b>，密码无法自动提交。</p>
          <p class="muted" style="margin:8px 0">点击下方按钮打开站点登录页，<b>在窗口里手动完成验证并登录</b>；RelayHub 检测到登录成功后会自动抓取会话、拉取余额与 Key，并关闭窗口。</p>
          <div class="row" style="margin-top:14px">
            <button class="btn primary" id="bl-open">打开站点登录页</button>
            <button class="btn green" id="bl-capture" disabled>我已登录，立即抓取</button>
            <button class="btn" id="bl-cancel">取消</button>
          </div>
          <div class="muted" id="bl-status" style="margin-top:10px">窗口打开后请完成人机验证并登录；登录成功会自动抓取。若未自动同步，登录后点「立即抓取」。</div>
        `);
        $('#bl-cancel', el).onclick = () => el.remove();
        $('#bl-open', el).onclick = async () => {
          $('#bl-open', el).disabled = true;
          $('#bl-capture', el).disabled = false;
          $('#bl-status', el).textContent = '登录窗口已打开，请在窗口里完成登录…';
          const r = await api('stations:browserLogin', { stationId: s.id }).catch((e) => ({ applyError: e.message, cancelled: true }));
          if (r?.applied) {
            el.remove(); await refreshAll(); render();
            toast('登录会话已同步，余额与 Key 已拉取', 'ok');
          } else if (r?.cancelled) {
            $('#bl-status', el).textContent = r.applyError ? `自动抓取失败：${r.applyError}` : '窗口已关闭。若你已在页面登录，点「立即抓取」。';
            $('#bl-open', el).disabled = false;
          } else {
            $('#bl-status', el).textContent = r?.applyError ? `自动抓取失败：${r.applyError}——可点「立即抓取」重试` : '等待登录…';
            $('#bl-open', el).disabled = false;
          }
        };
        $('#bl-capture', el).onclick = async () => {
          try {
            $('#bl-capture', el).disabled = true;
            $('#bl-status', el).textContent = '正在从登录窗口抓取会话…';
            const r = await api('stations:captureSession', { stationId: s.id });
            el.remove(); await refreshAll(); render();
            toast(`会话已同步：${r.keys ?? 0} 个 Key`, 'ok');
          } catch (err) {
            $('#bl-capture', el).disabled = false;
            $('#bl-status', el).textContent = `抓取失败：${err.message}`;
            toast(err.message, 'err');
          }
        };
        return;
      }
      const el = dialog(`
        <h3>登录 ${esc(s.name)}</h3>
        <label class="field">用户名</label><input id="lg-user" value="${esc(s.username ?? '')}" />
        <label class="field">密码</label><input id="lg-pass" type="password" />
        <div class="row" style="margin-top:14px"><button class="btn primary" id="lg-ok">登录</button><button class="btn" id="lg-cancel">取消</button></div>`);
      $('#lg-cancel', el).onclick = () => el.remove();
      $('#lg-ok', el).onclick = async () => {
        try {
          await api('stations:login', { id: s.id, username: $('#lg-user', el).value.trim(), password: $('#lg-pass', el).value });
          el.remove(); await refreshAll(); render(); toast('登录成功', 'ok');
        } catch (err) {
          if (/turnstile/i.test(err.message)) { el.remove(); return browserLoginFlow(s.id); }
          toast(err.message, 'err');
        }
      };
    }
    if (act === 'verify') {
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = '检测中…';
      try {
        const r = await api('stations:verifyKey', { id: btn.dataset.id, keyId: btn.dataset.key });
        toast(r.ok ? `Key 可用，模型数：${r.models?.length ?? 0}` : `Key 不可用：${r.status || r.error}`, r.ok ? 'ok' : 'err');
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = label;
      }
    }
    if (act === 'copykey') {
      btn.disabled = true;
      try {
        const r = await api('stations:revealKey', { stationId: btn.dataset.id, keyId: btn.dataset.key });
        await navigator.clipboard.writeText(r.key ?? '');
        toast('已复制', 'ok');
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        btn.disabled = false;
      }
    }
    if (act === 'delstation') {
      if (!confirm('删除这个中转站及保存的 Key？')) return;
      await api('stations:remove', { id: btn.dataset.id }); await refreshAll(); render();
    }
    if (act === 'addkey') addKeyDialog(btn.dataset.id);
    if (act === 'probe') probeModelDialog(btn.dataset.id);
    if (act === 'pricing') pricingDialog(btn.dataset.id);
    if (act === 'ratio') ratioDialog(btn.dataset.id);
    if (act === 'deployform') deployDialog(btn.dataset.agent);
    if (act === 'switchentry') {
      const r = await api('deploy:switch', { agentId: btn.dataset.agent, entryId: btn.dataset.entry });
      await refreshAll(); render();
      const pending = r.restartPending?.length ? `（检测到 ${r.restartPending.join('/')} 正在运行，重启后生效）` : '';
      toast(`已切换，${r.hint ?? '重启 Agent 生效'}${pending}`, 'ok');
    }
    if (act === 'delentry') {
      if (!confirm('移除这个配置入口？会同时从其配置文件里剥掉对应路由（有备份）。')) return;
      await api('deploy:remove', { agentId: btn.dataset.agent, entryId: btn.dataset.entry });
      await refreshAll(); render();
    }
  } catch (err) { toast(err.message, 'err'); }
}

function render() {
  const main = $('#main');
  main.innerHTML = state.view === 'dashboard' ? renderDashboard()
    : state.view === 'stations' ? renderStations()
      : state.view === 'deploy' ? renderDeploy()
        : state.view === 'compare' ? renderCompare()
          : state.view === 'aipaihangbang' ? (window.siteView?.mountAipaihangbangView('https://aipaihangbang.cn'), '<div id="site-view-host"></div>')
          : renderSettings();
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));

  if (state.view === 'compare') {
    bindCompare();
    loadCompareRows();
  }

  if (state.view === 'dashboard') {
    $('#btn-dash-reload')?.addEventListener('click', async () => {
      try { await api('sync:run'); } catch { /* 站点侧失败不影响看板 */ }
      await refreshAll(); render(); toast('看板已更新', 'ok');
    });
    $('#btn-dash-journal')?.addEventListener('click', async () => {
      const list = await api('stats:journal');
      dialog(`<h3>最近写入（${list.length} 条）</h3><div style="max-height:50vh;overflow:auto">${list.length ? list.map((j) => `<div class="muted" style="padding:6px 0;border-bottom:1px solid var(--border)"><code>${esc(j.at)}</code> · ${esc(j.agent)} · ${esc(j.op)}${j.undone ? ' · 已撤销' : ''}<br><code>${esc(j.path)}</code></div>`).join('') : '暂无'}</div><div class="row" style="margin-top:12px"><button class="btn" onclick="this.closest('.dialog').remove()">关闭</button></div>`);
    });
  }
  if (state.view === 'stations') {
    $('#btn-add-station').onclick = addStationDialog;
  }
  if (state.view === 'deploy') {
    $('#btn-undo').onclick = async () => {
      const r = await api('deploy:undo');
      toast(r.ok ? '已撤销上一笔写入' : r.message || '撤销失败', r.ok ? 'ok' : 'err');
      await refreshAll(); render();
    };
  }
  if (state.view === 'settings') {
    $('#btn-save-settings').onclick = saveSettings;
    $('#btn-save-settings2').onclick = saveSettings;
    $('#btn-sync-now').onclick = async () => {
      toast('正在同步…');
      const s = await api('sync:run');
      showSyncSummary(s);
    };
    $('#btn-journal').onclick = async () => {
      const list = await api('deploy:journal');
      dialog(`<h3>写入日志（最近 ${list.length} 条）</h3><div style="max-height:50vh;overflow:auto">${list.length ? list.map((j) => `<div class="muted" style="padding:6px 0;border-bottom:1px solid var(--border)"><code>${esc(j.at)}</code> · ${esc(j.agent)} · ${esc(j.op)}<br><code>${esc(j.path)}</code></div>`).join('') : '暂无'}</div><div class="row" style="margin-top:12px"><button class="btn" onclick="this.closest('.dialog').remove()">关闭</button></div>`);
    };
    $('#btn-check-update').onclick = async () => {
      const el = $('#update-status');
      el.textContent = '检查中…';
      const r = await api('update:check');
      if (r.dev) el.textContent = `开发模式 v${r.version}（打包后启用自动更新）`;
      else if (r.error) el.textContent = `检查失败：${r.error}`;
      else el.textContent = r.latest && r.latest !== r.version ? `发现新版本 ${r.latest}，下载完成后重启即装` : `已是最新 v${r.version}`;
    };
    $$('[data-open]').forEach((b) => b.onclick = () => api('settings:openPath', { target: b.dataset.open }));
  }
  $$('[data-act]').forEach(() => {}); // 事件走委托
}

async function saveSettings() {
  const rrRaw = $('#set-rr')?.value;
  await api('settings:set', {
    backupKeep: Number($('#set-keep').value) || 20,
    lowBalanceUsd: Number($('#set-lowbal')?.value) || 5,
    autoSync: $('#set-autosync')?.checked !== false,
    rechargeRatio: rrRaw != null && rrRaw !== '' && Number(rrRaw) > 0 ? Number(rrRaw) : null,
  });
  toast('已保存', 'ok');
}

function showSyncSummary(s) {
  if (!s) return;
  if (s.skipped) return toast(`同步跳过：${s.skipped}`);
  const parts = [`同步 ${s.stationsSynced} 个站点`];
  if (s.entriesRewritten.length) parts.push(`重写 ${s.entriesRewritten.length} 个入口`);
  const kind = s.notices?.some((n) => n.level === 'err') ? 'err' : s.notices?.length ? '' : 'ok';
  toast(parts.join('，') + (s.notices?.length ? `；${s.notices.map((n) => n.text).join('；')}` : ''), kind);
  // 有对话框打开时（用户正在输入）跳过重渲染，避免打断焦点/输入法
  if (!document.querySelector('.dialog')) refreshAll().then(render).catch(() => {});
}

$('#app').addEventListener('click', onMainClick);
$$('.nav-btn').forEach((b) => b.onclick = async () => {
  state.view = b.dataset.view;
  if (state.view === 'compare') {
    try { await loadCompareStats(); } catch { /* 库为空也能进页面 */ }
  }
  render();
});
window.relayhub.onChanged(({ agentId }) => { if (!document.querySelector('.dialog')) refreshAll().then(render).catch(() => {}); });
window.relayhub.onSynced((summary) => { showSyncSummary(summary); });
window.relayhub.onUpdate(({ stage }) => {
  if (stage === 'downloaded') toast('新版本已下载，重启应用即自动安装', 'ok');
});
window.relayhub.onError(({ message }) => toast(message, 'err'));

refreshAll().then(render).catch((err) => toast(`初始化失败：${err.message}`, 'err'));
