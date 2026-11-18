// 数据看板：聚合 store 里的站点/Key/入口/健康度数据
// 设计：全部从现有状态推导，不新增持久化结构；健康度由 probe/balance/warnings 综合得出。
export function buildDashboard(store, agentsProbe = null, todayUsageRows = null) {
  const stations = store.state.stations ?? [];
  const agentIds = Object.keys(store.state.agents ?? {});

  // —— 汇总 ——
  const summary = {
    stations: stations.length,
    stationsHealthy: 0,
    stationsInvalid: 0,
    stationsWarn: 0,
    keys: 0,
    keysUnlimited: 0,
    keysMasked: 0,
    keysExpiring: 0, // 7 天内到期
    balanceUsd: 0,
    balanceUsdKnown: 0, // 已知余额的站点数
    entriesTotal: 0,
    entriesActive: 0,
    warnings: 0,
    lastSyncAt: store.state.settings?.lastSyncAt ?? null,
  };

  // —— 每站点 ——
  const stationRows = stations.map((s) => {
    const keys = s.keys ?? [];
    const usd = s.balance?.usd;
    const invalid = Boolean(s.sessionInvalid);
    const warns = s.warnings ?? [];
    const status = invalid ? 'invalid' : warns.length ? 'warn' : (s.updatedAt ? 'ok' : 'unknown');
    return {
      id: s.id,
      name: s.name,
      baseUrl: s.baseUrl,
      protocol: s.protocol,
      status,
      balanceUsd: usd != null ? Number(usd) : null,
      frozenUsd: s.balance?.frozen != null ? Number(s.balance.frozen) : null,
      keyCount: keys.length,
      keysUnlimited: keys.filter((k) => k.unlimited).length,
      keysMasked: keys.filter((k) => k.masked).length,
      keysExpired: keys.filter((k) => k.expired).length,
      keysLowQuota: keys.filter((k) => !k.unlimited && k.usdRemain != null && k.usdRemain < 1).length,
      modelsKnown: keys.reduce((n, k) => n + (k.models?.length ?? 0), 0),
      warnings: warns.map((w) => w.text),
      updatedAt: s.updatedAt,
      sessionError: s.sessionError ?? null,
      // 站点级风险分：0-100，越高越健康
      health: invalid ? 0 : warns.length ? Math.max(40, 80 - warns.length * 15) : s.updatedAt ? 95 : 60,
    };
  });

  for (const r of stationRows) {
    summary.keys += r.keyCount;
    summary.keysUnlimited += r.keysUnlimited;
    summary.keysMasked += r.keysMasked;
    summary.keysExpiring += r.keysExpired;
    summary.warnings += r.warnings.length;
    if (r.balanceUsd != null) { summary.balanceUsd += r.balanceUsd; summary.balanceUsdKnown += 1; }
    if (r.status === 'ok') summary.stationsHealthy += 1;
    else if (r.status === 'invalid') summary.stationsInvalid += 1;
    else if (r.status === 'warn') summary.stationsWarn += 1;
  }

  // —— Agent 入口矩阵 ——
  const agentRows = agentIds.map((id) => {
    const st = store.agentState(id);
    const entries = st.entries ?? [];
    const current = entries.find((e) => e.id === st.currentEntryId) ?? null;
    const curStation = current?.stationId ? stations.find((s) => s.id === current.stationId) : null;
    return {
      id,
      entryCount: entries.length,
      currentEntry: current ? { name: current.name, baseUrl: current.baseUrl, model: current.model ?? null } : null,
      currentStationName: curStation?.name ?? (current ? (current.rawKey ? '手动 Key' : null) : null),
      currentStationInvalid: curStation ? Boolean(curStation.sessionInvalid) : false,
      lastAppliedAt: current?.appliedAt ?? null,
    };
  });
  for (const a of agentRows) { summary.entriesTotal += a.entryCount; if (a.currentEntry) summary.entriesActive += 1; }

  // —— agent 安装状态（来自最近一次 probe，主进程注入）——
  const agentInstall = (agentsProbe ?? []).map((a) => ({
    id: a.id,
    dirExists: Boolean(a.dirExists),
    launcherBroken: Boolean(a.launcherBroken),
    cliVersion: a.cliVersion ?? null,
    parseError: a.parseError ?? null,
  }));

  // —— 时间线：journal 最近写入（若提供）——
  // 今日消费：主进程并发拉好的各站数据
  const usage = { totalUsd: 0, stationsKnown: 0, stationsTotal: stations.length, rpm: 0, tpm: 0, rows: [] };
  for (const r of stationRows) {
    const u = todayUsageRows?.[r.id] ?? null;
    usage.rows.push({
      stationId: r.id,
      name: r.name,
      usd: u?.usd ?? null,
      rpm: u?.rpm ?? null,
      tpm: u?.tpm ?? null,
      supported: Boolean(u?.supported),
    });
    if (u?.supported && u.usd != null) { usage.totalUsd += u.usd; usage.stationsKnown += 1; }
    usage.rpm += u?.rpm ?? 0;
    usage.tpm += u?.tpm ?? 0;
  }
  return { summary, stationRows, agentRows, agentInstall, usage, generatedAt: new Date().toISOString() };
}
