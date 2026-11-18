// 自动同步：拉取各站点最新 Key/余额 → 检测变更 → 只重写引用了变更 Key 的入口
// 对齐 GPTZZZ 语义：供应商永不被自动切换，只更新已在用 GPTZZZ（此处为中转站）的入口。
export function createSyncService({ store, deploy, stations }) {
  async function runOnce({ manual = false } = {}) {
    const settings = store.state.settings;
    const summary = { at: new Date().toISOString(), manual, stationsSynced: 0, entriesRewritten: [], notices: [] };
    if (settings.autoSync === false && !manual) {
      summary.skipped = 'autoSync 关闭';
      return summary;
    }
    for (const station of store.state.stations) {
      if (station.protocol !== 'newapi') continue;
      if (!(station.session?.cookie || station.session?.accessToken)) continue;
      try {
        const prevKeys = new Map((station.keys ?? []).map((k) => [k.id, k.key]));
        const prevNames = new Map((station.keys ?? []).map((k) => [k.id, k.name]));
        await stations.refresh(station.id);
        summary.stationsSynced += 1;
        const cur = store.findStation(station.id);
        for (const w of cur.warnings ?? []) summary.notices.push({ level: 'warn', text: `「${cur.name}」${w.text}` });

        for (const agentId of Object.keys(store.state.agents)) {
          const st = store.agentState(agentId);
          for (const entry of st.entries) {
            if (entry.stationId !== station.id || !entry.keyId) continue;
            const prev = prevKeys.get(entry.keyId);
            const key = (cur.keys ?? []).find((k) => k.id === entry.keyId);
            if (prev && key?.key && prev !== key.key) {
              const isCurrent = st.currentEntryId === entry.id;
              if (isCurrent) await deploy.deploy({ agentId, entryId: entry.id });
              summary.entriesRewritten.push({ agentId, entryId: entry.id, live: isCurrent });
            } else if (prev && !key) {
              summary.notices.push({ level: 'warn', text: `「${cur.name}」入口「${entry.name}」引用的 Key 已从站点消失` });
            }
            // Key 改名 → 同步入口标签
            if (key && prevNames.get(entry.keyId) && prevNames.get(entry.keyId) !== key.name) {
              entry.name = `${cur.name} · ${key.name}`;
            }
          }
        }
      } catch (err) {
        const msg = String(err.message ?? err);
        const authFail = /会话|401|登录|Unauthorized|token/i.test(msg);
        if (authFail) {
          const st = store.findStation(station.id);
          if (st) {
            st.sessionInvalid = true;
            st.sessionError = msg;
            st.sessionInvalidAt = new Date().toISOString();
          }
        }
        summary.notices.push({ level: 'err', text: `同步「${station.name}」失败：${msg}${authFail ? '（请点「重新登录」）' : ''}` });
      }
    }
    settings.lastSyncAt = summary.at;
    await store.save();
    return summary;
  }
  return { runOnce };
}
