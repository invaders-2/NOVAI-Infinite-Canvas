// ============================================================================
// NOVAI OS · E2E — Phase 5.2.1 Shared Runtime + Assets Hardening
//
// 覆盖：
//   Case 1 Chat   : minimize → **真实 Dock click** → restore（instanceId/windowId 不变）
//   Case 2 Assets : 同上 + iframe identity（元素未被重建、contentWindow.name 保留 → 未重载）
//   Case 3 可见态 : 再 activate 只 focus，不重建、不 duplicate
//   Case 4 background session : 复用同 instance，NEW window
//   Case 5 error  : ENTRY_UNAVAILABLE → clean retry，无 ghost window / stale minimized
//   A1-A6 Assets  : 5 tab 回归 + loadAll() Promise.all 修复的**确定性**证明
//                   （给 /api/local-assets 注入 500ms 延迟，观测 #assetStatus 回到
//                     「准备就绪」的耗时；不靠 sleep 掩盖 race condition）
//
// ⚠️ 这是**浏览器** E2E，不能由 Node 直接跑（它会 import 页面内的 /static/os/core/* 模块）。
//    故意不命名为 *.test.js，避免被 `node --test tests/` 自动拾取。
//
// 运行方式（需后端跑在 3100，即 NOVAI_PORT=3100 python3 main.py）：
//   agent-browser open http://127.0.0.1:3100/os-preview
//   agent-browser eval "$(cat tests/e2e/minimized-restore.e2e.js)"
//   输出为 JSON：{ pass, fail, failed[], info{}, passed[] }
//
// 最近一次结果：47 passed / 0 failed（Console 0 error）
// ============================================================================
(async () => {
  const R = { pass: [], fail: [], info: {} };
  const ok = (c, m) => (c ? R.pass.push(m) : R.fail.push(m));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  window.__errs = [];
  window.addEventListener('error', (e) => window.__errs.push('error: ' + (e.message || '')));
  window.addEventListener('unhandledrejection', (e) =>
    window.__errs.push('rejection: ' + String((e.reason && e.reason.message) || e.reason))
  );

  const B = '/static/os/core/';
  const reg = await import(B + 'osAppRegistry.js');
  const rt = await import(B + 'osAppRuntime.js');
  const wm = await import(B + 'osWindowManager.js');

  await reg.loadApps();
  const W = () => wm.getState().windows;
  const findWin = (id) => W().find((x) => x.id === id);
  const dockBtn = (appId) =>
    document.querySelector('.os-dock__item[data-app-id=' + appId + '] button');
  const ifrFor = (appId) =>
    Array.from(document.querySelectorAll('iframe')).find(
      (f) => (f.getAttribute('src') || '').indexOf('/apps/' + appId + '/') >= 0
    );

  /* ============ Case 1: Chat minimize → 真实 Dock click → restore ============ */
  const c1 = await rt.launch('chat', 'user');
  await sleep(1700);
  const cInst = c1.instanceId;
  const cWin = c1.windowIds[0];
  ok(!!cWin, 'C1-1 chat 启动 windowId=' + cWin);

  wm.minimize(cWin, 'user');
  await sleep(400);
  ok(findWin(cWin).state === 'minimized', 'C1-2 minimize → ' + findWin(cWin).state);

  const cbt = dockBtn('chat');
  ok(!!cbt, 'C1-3 找到 Chat Dock 按钮');
  cbt.click();
  await sleep(800);
  ok(findWin(cWin).state === 'normal', 'C1-4 真实 Dock click → restored (got ' + findWin(cWin).state + ')');
  ok(wm.getState().focusedId === cWin, 'C1-5 activeWindowId==原 windowId (got ' + wm.getState().focusedId + ')');
  const cAfter = rt.getAppInstance(cInst);
  ok(!!cAfter && cAfter.instanceId === cInst, 'C1-6 instanceId 不变 ' + cInst);
  ok(!!cAfter && cAfter.windowIds[0] === cWin, 'C1-7 windowId 不变 ' + cWin);
  ok(W().filter((x) => x.appId === 'chat').length === 1, 'C1-8 chat 窗口数=1');
  ok(rt.listInstances().filter((i) => i.appId === 'chat').length === 1, 'C1-9 chat 实例数=1');
  ok(cAfter.state === 'running', 'C1-10 实例仍 running（minimize 未被当 close/background）');
  R.info.chat = {
    instanceIdBefore: cInst, windowIdBefore: cWin,
    instanceIdAfter: cAfter.instanceId, windowIdAfter: cAfter.windowIds[0],
    stateAfter: cAfter.state
  };

  /* ============ Case 3: already visible → 只 focus，不得重建 ============ */
  const totalBefore = W().length;
  cbt.click();
  await sleep(700);
  ok(findWin(cWin).state === 'normal', 'C3-1 可见态再 Dock click → 仍 normal（restore 未误执行）');
  ok(W().filter((x) => x.appId === 'chat').length === 1, 'C3-2 无 duplicate window（singleton）');
  ok(rt.listInstances().filter((i) => i.appId === 'chat').length === 1, 'C3-3 无 duplicate instance');
  ok(wm.getState().focusedId === cWin, 'C3-4 仍聚焦原 window');
  ok(W().length === totalBefore, 'C3-5 总窗口数不变 ' + totalBefore);

  /* ============ Case 2: Assets minimize → Dock click → restore + iframe identity ============ */
  const a1 = await rt.launch('assets', 'user');
  await sleep(2500);
  const aInst = a1.instanceId;
  const aWin = a1.windowIds[0];
  ok(!!aWin, 'C2-1 assets 启动 windowId=' + aWin);

  const ifr = ifrFor('assets');
  ok(!!ifr, 'C2-2 找到 assets iframe');
  ifr.dataset.e2eMark = 'orig-iframe';
  try { ifr.contentWindow.name = 'e2e-orig'; } catch (e) {}
  let innerPath = 'n/a';
  try { innerPath = ifr.contentWindow.location.pathname; } catch (e) {}
  ok(innerPath === '/static/asset-manager.html', 'C2-3 已导航到 Legacy ' + innerPath);

  wm.minimize(aWin, 'user');
  await sleep(450);
  ok(findWin(aWin).state === 'minimized', 'C2-4 assets minimize → ' + findWin(aWin).state);

  const abt = dockBtn('assets');
  ok(!!abt, 'C2-5 找到 Assets Dock 按钮');
  abt.click();
  await sleep(900);
  ok(findWin(aWin).state === 'normal', 'C2-6 真实 Dock click → assets restored (got ' + findWin(aWin).state + ')');
  ok(wm.getState().focusedId === aWin, 'C2-7 activeWindowId==原 windowId');
  const aAfter = rt.getAppInstance(aInst);
  ok(!!aAfter && aAfter.instanceId === aInst, 'C2-8 instanceId 不变 ' + aInst);
  ok(!!aAfter && aAfter.windowIds[0] === aWin, 'C2-9 windowId 不变 ' + aWin);

  const ifr2 = ifrFor('assets');
  ok(ifr2 === ifr, 'C2-10 iframe 元素未被重建（同一 DOM 节点）');
  ok(!!ifr2 && ifr2.dataset.e2eMark === 'orig-iframe', 'C2-11 iframe 标记保留');
  let cwName = 'ERR';
  try { cwName = ifr2.contentWindow.name; } catch (e) {}
  ok(cwName === 'e2e-orig', 'C2-12 iframe 未重新加载（contentWindow.name 保留，got ' + cwName + ')');
  R.info.assets = {
    instanceIdBefore: aInst, windowIdBefore: aWin,
    instanceIdAfter: aAfter.instanceId, windowIdAfter: aAfter.windowIds[0]
  };

  /* ============ Assets 5 tab 回归 + loadAll Promise.all 修复（确定性，不靠 sleep） ============ */
  let bodyLen = 0, tabCount = 0;
  try {
    const d = ifr2.contentDocument;
    bodyLen = d && d.body ? d.body.innerHTML.length : 0;
    tabCount = d ? d.querySelectorAll('[data-tab]').length : 0;
  } catch (e) {}
  ok(tabCount === 5, 'A1 Assets 5 个 tab 均渲染 (got ' + tabCount + ')');
  ok(bodyLen > 1000, 'A2 Legacy 真实加载 (body ' + bodyLen + ' chars)');

  let localTabOk = false;
  try {
    const d = ifr2.contentDocument;
    const t = d.querySelector('[data-tab=local]');
    if (t) { t.click(); await sleep(600); localTabOk = true; }
  } catch (e) {}
  ok(localTabOk, 'A3 本地素材 tab 可切换');

  // ★ 确定性证明 loadAll 现在真正 await 本地素材任务：
  //   给 iframe 内 /api/local-assets 注入 DELAY 延迟 → 点 refreshBtn 触发 loadAll()
  //   → 用 MutationObserver（事件驱动）等 #assetStatus 回到「准备就绪」并测耗时。
  //   旧代码未 await 该任务，耗时会远小于 DELAY；修复后必须 >= DELAY。
  const DELAY = 500;
  let elapsed = -1, statusStart = '', loadErr = null;
  try {
    const iw = ifr2.contentWindow;
    const od = ifr2.contentDocument;
    const origFetch = iw.fetch;
    iw.fetch = function (u, init) {
      const p = origFetch.call(iw, u, init);
      if (String(u).indexOf('/api/local-assets') >= 0) {
        return p.then((r) => new Promise((res) => setTimeout(() => res(r), DELAY)));
      }
      return p;
    };
    const st = od.getElementById('assetStatus');
    const ready = new Promise((res) => {
      const obs = new MutationObserver(() => {
        if (st && st.textContent && st.textContent.indexOf('准备就绪') >= 0) { obs.disconnect(); res(); }
      });
      obs.observe(st, { childList: true, characterData: true, subtree: true });
      setTimeout(() => { obs.disconnect(); res(); }, 20000); // 仅兜底，不参与判定
    });
    const btn = od.getElementById('refreshBtn');
    const t0 = performance.now();
    btn.click();
    await sleep(60);
    statusStart = st ? st.textContent : '';
    await ready;
    elapsed = performance.now() - t0;
    iw.fetch = origFetch;
  } catch (e) { loadErr = String((e && e.message) || e); }

  ok(loadErr === null, 'A4 loadAll 观测无异常' + (loadErr ? ': ' + loadErr : ''));
  ok(statusStart.indexOf('加载中') >= 0, 'A5 刷新后 status=加载中（loadAll 在途，got ' + statusStart + ')');
  ok(elapsed >= DELAY * 0.8, 'A6 loadAll 真正 await 本地素材：耗时 ' + Math.round(elapsed) + 'ms >= ' + Math.round(DELAY * 0.8) + 'ms');
  R.info.loadAllDelayMs = DELAY;
  R.info.loadAllElapsedMs = Math.round(elapsed);

  /* ============ Case 4: background session → 复用实例 + NEW window ============ */
  wm.close(aWin, 'user');
  await sleep(800);
  ok(a1.state === 'background', 'C4-1 close → background (got ' + a1.state + ')');
  ok(a1.windowIds.length === 0, 'C4-2 windowIds=0');
  const a2 = await rt.activate(aInst, 'dock');
  await sleep(2500);
  ok(!!a2 && a2.instanceId === aInst, 'C4-3 same instanceId ' + aInst);
  ok(!!a2 && a2.windowIds[0] !== aWin, 'C4-4 NEW windowId (' + aWin + ' → ' + a2.windowIds[0] + ')');
  R.info.case4 = { instanceIdSame: a2.instanceId === aInst, oldWin: aWin, newWin: a2.windowIds[0] };

  /* ============ Case 5: error state clean retry ============ */
  const origTopFetch = window.fetch;
  window.fetch = function (u, init) {
    if (String(u).indexOf('/api/apps') >= 0) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            apps: [{
              id: '__restore_entry_test__', title: 'Restore Entry Test', description: '',
              version: '0.0.0', state: 'healthy', entry: '/apps/assets/__missing__.html',
              keepAlive: 'session', singleton: true, permissions: [], capabilities: []
            }]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
    }
    return origTopFetch(u, init);
  };
  await reg.loadApps();
  window.fetch = origTopFetch;

  const td = reg.getApp('__restore_entry_test__');
  ok(!!td, 'C5-0 缺失 entry 定义已注入（未写入真实 registry）');
  const ti = await rt.launch('__restore_entry_test__', 'user');
  await sleep(900);
  ok(ti.state === 'error', 'C5-1 launch → error (got ' + ti.state + ')');
  ok(ti.windowIds.length === 0, 'C5-2 0 Window');
  const winBefore = W().length;

  const ti2 = await rt.activate(ti.instanceId, 'dock');
  await sleep(900);
  ok(!!ti2 && ti2.state === 'error', 'C5-3 再次 activate → 仍 error（clean retry）');
  ok(!!ti2 && ti2.windowIds.length === 0, 'C5-4 retry 仍 0 Window');
  ok(W().length === winBefore, 'C5-5 无 ghost window (' + winBefore + ' → ' + W().length + ')');
  ok(!W().some((x) => x.appId === '__restore_entry_test__'), 'C5-6 无该 App 任何窗口');
  ok(!W().some((x) => x.appId === '__restore_entry_test__' && x.state === 'minimized'), 'C5-7 无 stale minimized');
  ok(!rt.getAliveAppIds().has('__restore_entry_test__'), 'C5-8 Dock 不 running（无 ghost Dock）');
  R.info.case5 = { instanceId: ti.instanceId, retryInstanceId: ti2.instanceId };

  /* ============ Console ============ */
  ok(window.__errs.length === 0, 'Z1 全程 Console 0 error (got ' + window.__errs.length + ' ' + window.__errs.join(' | ') + ')');

  return JSON.stringify({ pass: R.pass.length, fail: R.fail.length, failed: R.fail, info: R.info, passed: R.pass }, null, 1);
})()
