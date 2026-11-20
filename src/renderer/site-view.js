// 站点视图：主窗口内嵌的 <webview>，承载外部网页（AI 排行榜等）
// 注意：webview 需要主窗口 webPreferences.webviewTag = true（已在 main.cjs 开启）
// IPC 通道：aip:back / aip:reload / aip:open-external 由 preload 转发到主进程
(function () {
  const $ = (sel, root = document) => (root.querySelector ? root.querySelector(sel) : null);

  let webviewEl = null;

  /** 创建/复用站点视图容器；url 为要加载的外部站点 */
  function mountAipaihangbangView(url) {
    const main = $('#main');
    if (!main) return;
    main.innerHTML = `
      <div class="site-view">
        <div class="site-bar">
          <button class="btn small" id="aip-back">← 后退</button>
          <button class="btn small" id="aip-reload">刷新</button>
          <span class="site-url mono" id="aip-url"></span>
          <button class="btn small" id="aip-external">在浏览器打开 ↗</button>
        </div>
        <div class="site-frame">
          <webview id="aip-webview" src="${url}" allowpopups></webview>
        </div>
      </div>`;

    webviewEl = $('#aip-webview', main);
    const urlEl = $('#aip-url', main);

    webviewEl.addEventListener('dom-ready', () => {
      if (urlEl) urlEl.textContent = webviewEl.getURL();
    });
    webviewEl.addEventListener('did-navigate', () => {
      if (urlEl) urlEl.textContent = webviewEl.getURL();
    });
    webviewEl.addEventListener('did-navigate-in-page', () => {
      if (urlEl) urlEl.textContent = webviewEl.getURL();
    });

    $('#aip-back', main)?.addEventListener('click', () => {
      if (webviewEl.canGoBack()) webviewEl.goBack();
    });
    $('#aip-reload', main)?.addEventListener('click', () => webviewEl.reload());
    $('#aip-external', main)?.addEventListener('click', () => {
      const u = webviewEl.getURL();
      if (window.relayhub?.openExternal) window.relayhub.openExternal(u);
    });
  }

  function unmountSiteView() {
    webviewEl = null;
  }

  window.siteView = { mountAipaihangbangView, unmountSiteView };
})();
