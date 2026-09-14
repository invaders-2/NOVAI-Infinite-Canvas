/* Agent（对话生图）：选 LLM(对话) + 生图模型 → 走后端 /api/chat/agent（自带意图路由：聊天/生成/改图）
 * → 返回图片自动置入图层。多轮对话用 conversation_id 维持。 */
(function () {
  const net = DX.net;
  const ps = DX.ps;
  const state = DX.state;

  const $ = (id) => document.getElementById(id);
  const els = {
    newBtn: $('agNew'),
    deleteBtn: $('agDelete'),
    history: $('agHistory'),
    toggleModels: $('agToggleModels'),
    models: $('agModels'),
    llmProvider: $('agLlmProvider'),
    llmModel: $('agLlmModel'),
    imgProvider: $('agImgProvider'),
    imgModel: $('agImgModel'),
    messages: $('agMessages'),
    attach: $('agAttach'),
    attachBtn: $('agAttachBtn'),
    regionBtn: $('agRegionBtn'),
    outpaintBtn: $('agOutpaintBtn'),
    retryBtn: $('agRetryBtn'),
    outpaintBar: $('agOutpaintBar'),
    dirLeft: $('agDirLeft'),
    dirRight: $('agDirRight'),
    dirTop: $('agDirTop'),
    dirBottom: $('agDirBottom'),
    outpaintPx: $('agOutpaintPx'),
    input: $('agInput'),
    send: $('agSend'),
    status: $('agStatus'),
  };

  const a = {
    loaded: false,
    chatProviders: [],
    imgProviders: [],
    conversationId: '',
    busy: false,
    regionMode: false,  // 「改选区」模式：发送时读矩形选区、只改这块、结果贴回原位
    outpaintMode: false, // 「扩图」模式：框一个包住原图的更大选区，四周补画（与 regionMode 互斥）
    msgs: [],           // {role, text, images:[]}
    attachments: [],    // 待发送的参考图 {url,name}
  };

  function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function setStatus(t, k = '') { els.status.textContent = t || ''; els.status.className = `push-msg ${k}`; }
  function snap16(n) {
    return Math.max(16, Math.ceil((Number(n) || 0) / 16) * 16);
  }
  function boundsSizeForApi(bounds) {
    if (!bounds) return '1024x1024';
    return `${snap16(bounds.width)}x${snap16(bounds.height)}`;
  }
  function sizeTextForApi(size) {
    const m = String(size || '').match(/^\s*(\d+)\s*[xX*]\s*(\d+)\s*$/);
    if (!m) return size || '1024x1024';
    return `${snap16(m[1])}x${snap16(m[2])}`;
  }

  // 稳定的用户 id（让对话历史按本插件持久化）
  function userId() {
    let id = localStorage.getItem('daxiong.agent.uid');
    if (!id) { id = `ps_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`; localStorage.setItem('daxiong.agent.uid', id); }
    return id;
  }

  // 带 X-User-Id 的 GET（对话历史按本插件用户隔离）
  async function apiGetU(path) {
    const res = await fetch(`${net.httpBase()}${path}`, { cache: 'no-store', headers: { 'X-User-Id': userId() } });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`.trim());
    return JSON.parse(text || '{}');
  }
  async function apiSendU(method, path, body) {
    const res = await fetch(`${net.httpBase()}${path}`, {
      method,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': userId() },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`.trim());
    return JSON.parse(text || '{}');
  }

  function applyCollapse() {
    const collapsed = localStorage.getItem('daxiong.agent.collapsed') === '1';
    els.models.classList.toggle('hidden', collapsed);
  }

  function applyRegion() {
    if (els.regionBtn) els.regionBtn.classList.toggle('active', a.regionMode);
    if (els.outpaintBtn) els.outpaintBtn.classList.toggle('active', a.outpaintMode);
    if (els.outpaintBar) els.outpaintBar.classList.toggle('show', a.outpaintMode);
  }

  /* ---------- 模型 + 历史加载 ---------- */
  async function ensureLoaded() {
    applyCollapse();
    a.regionMode = localStorage.getItem('daxiong.agent.region') === '1';
    a.outpaintMode = false;
    localStorage.setItem('daxiong.agent.outpaint', '0');
    if (a.regionMode && a.outpaintMode) a.outpaintMode = false;   // 互斥
    // 恢复扩图方向勾选 + px 记忆
    try {
      const saved = JSON.parse(localStorage.getItem('daxiong.agent.outpaintDirs') || '{}');
      if (els.dirLeft) els.dirLeft.checked = !!saved.left;
      if (els.dirRight) els.dirRight.checked = !!saved.right;
      if (els.dirTop) els.dirTop.checked = !!saved.top;
      if (els.dirBottom) els.dirBottom.checked = !!saved.bottom;
    } catch (e) {}
    const savedPx = localStorage.getItem('daxiong.agent.outpaintPx');
    if (savedPx && els.outpaintPx) els.outpaintPx.value = savedPx;
    applyRegion();
    if (a.loaded || !state.connected) return;
    setStatus('正在加载模型 …');
    try {
      const data = await net.apiGet('/api/providers');
      const all = data.providers || data.api_providers || [];
      a.chatProviders = all.filter((p) => Array.isArray(p.chat_models) && p.chat_models.length);
      a.imgProviders = all.filter((p) => Array.isArray(p.image_models) && p.image_models.length);
      DX.ui.fillPicker(els.llmProvider, a.chatProviders.map((p) => ({ value: p.id, label: p.name || p.id })), localStorage.getItem('daxiong.agent.llmp'));
      DX.ui.fillPicker(els.imgProvider, a.imgProviders.map((p) => ({ value: p.id, label: p.name || p.id })), localStorage.getItem('daxiong.agent.imgp'));
      renderLlmModels(localStorage.getItem('daxiong.agent.llmm'));
      renderImgModels(localStorage.getItem('daxiong.agent.imgm'));
      a.loaded = true;
      setStatus(a.chatProviders.length ? '' : '没有可用的对话模型，请先在网页端配置 chat 模型。', a.chatProviders.length ? '' : 'err');
      await loadHistory();
    } catch (err) { setStatus(`加载模型失败：${err.message || err}`, 'err'); }
    updateSend();
  }

  async function loadHistory() {
    try {
      const data = await apiGetU('/api/conversations');
      const list = data.conversations || [];
      DX.ui.fillPicker(els.history, [{ value: '', label: `历史对话（${list.length}）` }]
        .concat(list.map((c) => ({ value: c.id, label: c.title || '未命名对话' }))), a.conversationId || '');
      updateDelete();
    } catch (e) { /* 历史拉取失败不致命 */ }
  }

  async function openConversation(id) {
    if (!id) return;
    setStatus('正在载入对话 …');
    try {
      const data = await apiGetU(`/api/conversations/${encodeURIComponent(id)}`);
      const conv = data.conversation || {};
      a.conversationId = conv.id || id;
      a.msgs = (conv.messages || []).filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({
        role: m.role,
        text: m.content || m.agent_reply || '',
        images: m.image_urls || (m.image_url ? [m.image_url] : []),
      }));
      renderMsgs();
      setStatus('');
      updateDelete();
    } catch (err) { setStatus(`载入对话失败：${err.message || err}`, 'err'); }
  }

  function newConversation() {
    a.conversationId = '';
    a.msgs = [];
    renderMsgs();
    DX.ui.fillPicker(els.history, els.history._options || [{ value: '', label: '历史对话' }], '');
    updateDelete();
    setStatus('已开始新对话。', 'ok');
  }
  function selectedConversationId() {
    return DX.ui.pickerValue(els.history) || a.conversationId || '';
  }
  function updateDelete() {
    if (els.deleteBtn) els.deleteBtn.disabled = !selectedConversationId() || a.busy;
  }
  async function deleteConversation() {
    const id = selectedConversationId();
    if (!id || a.busy) return;
    const ok = window.confirm ? window.confirm('删除当前历史对话？') : true;
    if (!ok) return;
    const wasCurrent = id === a.conversationId;
    els.deleteBtn.disabled = true;
    setStatus('正在删除对话 …');
    try {
      await apiSendU('DELETE', `/api/conversations/${encodeURIComponent(id)}`);
      if (wasCurrent) {
        a.conversationId = '';
        a.msgs = [];
        a.attachments = [];
        renderMsgs();
        renderAttach();
      }
      await loadHistory();
      DX.ui.fillPicker(els.history, els.history._options || [{ value: '', label: '历史对话' }], '');
      updateDelete();
      setStatus('已删除对话。', 'ok');
    } catch (err) {
      setStatus(`删除失败：${err.message || err}`, 'err');
      updateDelete();
    }
  }
  function llmProvider() { const v = DX.ui.pickerValue(els.llmProvider); return a.chatProviders.find((p) => p.id === v) || a.chatProviders[0] || null; }
  function imgProvider() { const v = DX.ui.pickerValue(els.imgProvider); return a.imgProviders.find((p) => p.id === v) || a.imgProviders[0] || null; }
  function renderLlmModels(sel) { const p = llmProvider(); DX.ui.fillPicker(els.llmModel, ((p && p.chat_models) || []).map((m) => ({ value: m, label: m })), sel); }
  function renderImgModels(sel) { const p = imgProvider(); DX.ui.fillPicker(els.imgModel, ((p && p.image_models) || []).map((m) => ({ value: m, label: m })), sel); }

  /* ---------- 对话渲染 ---------- */
  function renderMsgs() {
    if (!a.msgs.length) {
      els.messages.innerHTML = '<div class="empty-state">选好模型，直接说想画/想改的内容，生成的图会自动加到图层。</div>';
      return;
    }
    els.messages.innerHTML = a.msgs.map((m) => {
      const imgs = (m.images || []).map((u) =>
        `<div class="agent-imgtile">
          <img src="${escapeHtml(net.displayUrl(u, 320))}" alt="">
          <button class="agent-dl" type="button" data-addurl="${escapeHtml(u)}" title="下载到图层">下载</button>
        </div>`).join('');
      const text = m.text ? `<div class="agent-text">${escapeHtml(m.text)}</div>` : '';
      const note = m.note ? `<div class="agent-note">${escapeHtml(m.note)}</div>` : '';
      return `<div class="agent-msg ${m.role}">${text}${note}${imgs}</div>`;
    }).join('');
    els.messages.querySelectorAll('[data-addurl]').forEach((b) => b.addEventListener('click', async () => {
      const u = b.getAttribute('data-addurl');
      b.disabled = true;
      setStatus('正在加到图层 …');
      try { await ps.placeImage({ url: u, name: `agent_${Date.now()}` }); setStatus('已加到图层。', 'ok'); }
      catch (err) { setStatus(`加图层失败：${err.message || err}`, 'err'); }
      finally { b.disabled = false; }
    }));
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  // 待发送参考图（缩略图 chip）
  function renderAttach() {
    els.attach.innerHTML = a.attachments.map((r, i) =>
      `<div class="attach-chip"><img src="${escapeHtml(net.displayUrl(r.url, 120))}" alt=""><div class="ref-x" data-ax="${i}">×</div></div>`).join('');
    els.attach.querySelectorAll('[data-ax]').forEach((x) => x.addEventListener('click', () => { a.attachments.splice(Number(x.getAttribute('data-ax')), 1); renderAttach(); }));
  }
  async function attachCurrent() {
    if (!ps.hasDocument()) { setStatus('没有打开的文档。', 'err'); return; }
    els.attachBtn.disabled = true;
    try {
      setStatus('正在上传当前画面 …');
      const { buffer, name } = await ps.exportCurrentPng();
      const url = await net.uploadInputBase64(buffer, name);
      a.attachments.push({ url, name });
      renderAttach();
      setStatus('已添加参考图，发送时会带上。', 'ok');
    } catch (err) { setStatus(`上传失败：${err.message || err}`, 'err'); }
    finally { els.attachBtn.disabled = false; }
  }

  /* ---------- 发送 ---------- */
  function updateSend() {
    els.send.disabled = !(state.connected && !a.busy && llmProvider() && DX.ui.pickerValue(els.llmModel) && imgProvider() && DX.ui.pickerValue(els.imgModel) && els.input.value.trim());
    updateDelete();
  }

  async function chatAgent(body) {
    const res = await fetch(`${net.httpBase()}/api/chat/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': userId() },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`.trim());
    return JSON.parse(text || '{}');
  }

  function showRetry(on) { if (els.retryBtn) els.retryBtn.classList.toggle('show', !!on); }

  const DIR_LABEL = { left: '左', right: '右', top: '上', bottom: '下' };

  // 扩图（方向并发）：勾选方向 + 扩多少 px → 每个方向截一小块（边缘条+透明区）→ 并发生成 → 各自贴回。
  async function sendOutpaint(msg, lp, ip) {
    if (!ps.hasDocument()) { setStatus('没有打开的文档。', 'err'); return; }
    const dirs = {
      left: !!(els.dirLeft && els.dirLeft.checked),
      right: !!(els.dirRight && els.dirRight.checked),
      top: !!(els.dirTop && els.dirTop.checked),
      bottom: !!(els.dirBottom && els.dirBottom.checked),
    };
    if (!dirs.left && !dirs.right && !dirs.top && !dirs.bottom) { setStatus('请至少选择一个扩展方向（左/右/上/下）。', 'err'); return; }
    const px = Math.max(16, Math.round(Number(els.outpaintPx && els.outpaintPx.value) || 256));

    a.busy = true; updateSend();
    let blocks;
    try {
      setStatus('正在按方向合成扩图块 …');
      const r = await ps.outpaintDirections(dirs, px);
      if (r && r.error) { setStatus(r.error, 'err'); a.busy = false; updateSend(); return; }
      blocks = (r && r.blocks) || [];
      if (!blocks.length) { setStatus('没有生成扩图块。', 'err'); a.busy = false; updateSend(); return; }
      // 上传每块透明 PNG，拿到 url
      for (const b of blocks) { b.url = await net.uploadBase64Raw(b.base64, b.name, b.mime); }
    } catch (e) {
      setStatus(`合成扩图块失败：${e.message || e}`, 'err');
      a.busy = false; updateSend(); showRetry(true); return;
    }

    // 记忆所选模型
    localStorage.setItem('daxiong.agent.llmp', lp.id);
    localStorage.setItem('daxiong.agent.llmm', DX.ui.pickerValue(els.llmModel));
    localStorage.setItem('daxiong.agent.imgp', ip.id);
    localStorage.setItem('daxiong.agent.imgm', DX.ui.pickerValue(els.imgModel));

    // 用户消息：挂上各方向块的缩略图 + 标签
    const dirNames = blocks.map((b) => DIR_LABEL[b.dir] || b.dir).join('、');
    a.msgs.push({ role: 'user', text: msg, images: blocks.map((b) => b.url), note: `扩图 ${dirNames}（各 ${px}px，${blocks.length} 块并发）` });
    renderMsgs();
    els.input.value = '';
    els.input.style.height = '';

    const sendMsg = `这张图有透明的空白区域，请在透明空白处自然延展、补全画面（扩图/outpainting），已有内容保持不变，返回把空白填满的完整图片（不要只用文字回答）。要求：${msg}`;

    setStatus(`正在并发生成 ${blocks.length} 块 …`);
    // 每块独立并发：各自不带 conversation_id（互不干扰），各自贴回自己那块位置
    const results = await Promise.all(blocks.map(async (b) => {
      try {
        const res = await chatAgent({
          conversation_id: '',
          message: sendMsg,
          provider: lp.id,
          model: DX.ui.pickerValue(els.llmModel),
          image_provider: ip.id,
          image_model: DX.ui.pickerValue(els.imgModel),
          size: sizeTextForApi(b.size),
          quality: 'auto',
          reference_images: [{ url: b.url, name: b.name, kind: 'image' }],
        });
        const m = res.message || {};
        const images = m.image_urls || (m.image_url ? [m.image_url] : []);
        return { b, images, text: m.content || m.agent_reply || '', ok: true };
      } catch (err) {
        return { b, images: [], text: `出错了：${err.message || err}`, ok: false };
      }
    }));

    // 汇总助手消息（各块结果图 + 文字），并各自贴回
    const allImages = [];
    let placed = 0, failed = 0;
    for (const rr of results) {
      if (!rr.ok || !rr.images.length) { failed += 1; continue; }
      for (const u of rr.images) {
        allImages.push(u);
        try { await ps.placeImageAt({ url: u, name: `outpaint_${rr.b.dir}_${Date.now()}` }, rr.b.bounds); placed += 1; }
        catch (e) {}
      }
    }
    a.msgs.push({ role: 'assistant', text: `扩图完成：${placed} 块已贴回${failed ? `，${failed} 块失败` : ''}。`, images: allImages });
    renderMsgs();
    if (failed) showRetry(true);
    setStatus(failed ? `完成 ${placed} 块，${failed} 块失败（可重试）。` : `已把 ${placed} 块扩展贴回画面。`, failed ? 'err' : 'ok');
    a.busy = false; updateSend();
  }

  async function send() {
    const msg = els.input.value.trim();
    if (!msg) return;
    const lp = llmProvider(); const ip = imgProvider();
    if (!lp || !ip) { setStatus('请选择对话模型和生图模型。', 'err'); return; }
    a.lastInput = msg;   // 记住本次输入，失败可一键重试
    showRetry(false);

    // 扩图模式：走独立的「方向并发」流程（一次点击、多方向各自并发生成、各自贴回）
    if (a.outpaintMode) { return sendOutpaint(msg, lp, ip); }

    // 改选区模式：读选区、导出参考图（在清空输入前做，失败不丢用户文案）
    let placeBounds = null;   // 改选区=选区
    let previewUrl = '';      // 上传给 AI 的图（用于对话缩略图）
    let noteText = '';        // 消息上的小灰字
    let editKind = '';        // 'region' | ''，决定 message 兜底文案
    if (a.regionMode) {
      if (!ps.hasDocument()) { setStatus('没有打开的文档。', 'err'); return; }
      a.busy = true; updateSend();
      try {
        setStatus('正在读取选区 …');
        const sel = await ps.exportSelectionPng();
        if (!sel) { setStatus('请先用矩形选框工具框选一块区域。', 'err'); a.busy = false; updateSend(); return; }
        previewUrl = await net.uploadBase64Raw(sel.base64, sel.name, sel.mime);
        a.attachments.push({ url: previewUrl, name: sel.name });
        placeBounds = sel.bounds;
        editKind = 'region';
        noteText = `上传选区 ${sel.bounds.width}×${sel.bounds.height}`;
        renderAttach();
        setStatus(`已截取选区 ${sel.bounds.width}×${sel.bounds.height}，发送中 …`);
      } catch (e) {
        setStatus(`读取选区失败：${e.message || e}`, 'err');
        a.busy = false; updateSend();
        return;
      }
    }

    a.busy = true; updateSend();
    // 用户消息里带上本次上传的缩略图 + 尺寸，留在对话里方便排查
    const userImages = previewUrl ? [previewUrl] : [];
    a.msgs.push({ role: 'user', text: msg, images: userImages, note: noteText });
    renderMsgs();
    els.input.value = '';
    els.input.style.height = '';   // 复位高度

    // 记忆所选模型
    localStorage.setItem('daxiong.agent.llmp', lp.id);
    localStorage.setItem('daxiong.agent.llmm', DX.ui.pickerValue(els.llmModel));
    localStorage.setItem('daxiong.agent.imgp', ip.id);
    localStorage.setItem('daxiong.agent.imgm', DX.ui.pickerValue(els.imgModel));

    try {
      const refs = a.attachments.map((r) => ({ url: r.url, name: r.name, kind: 'image' }));
      // 改选区/扩图：本质是"编辑参考图"。给后端 message 加明确编辑指令，强制走 edit_image 出图
      // （否则像"增加一只狗"这种没编辑关键词的会被判成聊天，只回文字不出图）。只影响发给后端的文案，显示仍是原文。
      let sendMsg = msg;
      if (editKind === 'region') {
        sendMsg = `请编辑修改这张参考图并返回修改后的图片（不要只用文字回答）。修改要求：${msg}`;
      }
      setStatus('Agent 处理中 …');
      const res = await chatAgent({
        conversation_id: a.conversationId,
        message: sendMsg,
        provider: lp.id,
        model: DX.ui.pickerValue(els.llmModel),
        image_provider: ip.id,
        image_model: DX.ui.pickerValue(els.imgModel),
        size: boundsSizeForApi(placeBounds),
        quality: 'auto',
        reference_images: refs,
      });
      const firstTurn = !a.conversationId;
      if (res.conversation && res.conversation.id) a.conversationId = res.conversation.id;
      if (firstTurn) loadHistory();   // 新对话产生了标题，刷新历史下拉
      const m = res.message || {};
      const images = m.image_urls || (m.image_url ? [m.image_url] : []);
      a.msgs.push({ role: 'assistant', text: m.content || m.agent_reply || '', images });
      renderMsgs();
      a.attachments = []; renderAttach();   // 发送后清空待发参考图

      if (images.length) {
        setStatus(`生成 ${images.length} 张，正在加到图层 …`);
        let placed = 0;
        for (const u of images) {
          try {
            if (placeBounds) await ps.placeImageAt({ url: u, name: `agent_${Date.now()}` }, placeBounds);
            else await ps.placeImage({ url: u, name: `agent_${Date.now()}` });
            placed += 1;
          } catch (e) {}
        }
        setStatus(placeBounds ? `已把 ${placed}/${images.length} 张贴回画面。` : `已加 ${placed}/${images.length} 张到图层。`, 'ok');
      } else {
        setStatus('');
      }
    } catch (err) {
      a.msgs.push({ role: 'assistant', text: `出错了：${err.message || err}` });
      renderMsgs();
      // 改选区/扩图：本次自动带上的参考图失败后要丢掉，避免下次重复附带
      if (placeBounds) { a.attachments = []; renderAttach(); }
      setStatus(`失败：${err.message || err}`, 'err');
      showRetry(true);   // 失败后可一键用上次输入重试
    } finally {
      a.busy = false; updateSend();
    }
  }

  /* ---------- 事件 ---------- */
  DX.ui.onPick(els.llmProvider, () => renderLlmModels());
  DX.ui.onPick(els.imgProvider, () => renderImgModels());
  DX.ui.onPick(els.llmModel, updateSend);
  DX.ui.onPick(els.imgModel, updateSend);
  DX.ui.onPick(els.history, () => { const id = DX.ui.pickerValue(els.history); updateDelete(); if (id) openConversation(id); });
  els.newBtn.addEventListener('click', newConversation);
  if (els.deleteBtn) els.deleteBtn.addEventListener('click', deleteConversation);
  els.toggleModels.addEventListener('click', () => {
    const c = localStorage.getItem('daxiong.agent.collapsed') === '1';
    localStorage.setItem('daxiong.agent.collapsed', c ? '0' : '1');
    applyCollapse();
  });
  function autoGrow() { els.input.style.height = 'auto'; els.input.style.height = `${Math.min(els.input.scrollHeight, 160)}px`; }
  els.input.addEventListener('input', () => { autoGrow(); updateSend(); });
  els.input.addEventListener('keydown', (e) => {
    // 回车发送，Shift+回车换行；中文输入法拼字中（isComposing）回车不误发
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!els.send.disabled) send();
    }
  });
  els.send.addEventListener('click', send);
  els.attachBtn.addEventListener('click', attachCurrent);
  if (els.regionBtn) els.regionBtn.addEventListener('click', () => {
    a.regionMode = !a.regionMode;
    if (a.regionMode) a.outpaintMode = false;   // 与扩图互斥
    localStorage.setItem('daxiong.agent.region', a.regionMode ? '1' : '0');
    localStorage.setItem('daxiong.agent.outpaint', a.outpaintMode ? '1' : '0');
    applyRegion();
    setStatus(a.regionMode ? '已开启「改选区」：发送时会读取矩形选区，只改这一块。' : '已关闭「改选区」。', a.regionMode ? 'ok' : '');
  });
  if (els.retryBtn) els.retryBtn.addEventListener('click', () => {
    if (a.busy) return;
    const last = a.lastInput || '';
    if (!last) { showRetry(false); return; }
    els.input.value = last;   // 回填上次输入
    updateSend();
    showRetry(false);
    send();
  });
  if (els.outpaintBtn) els.outpaintBtn.addEventListener('click', () => {
    a.outpaintMode = !a.outpaintMode;
    if (a.outpaintMode) a.regionMode = false;   // 与改选区互斥
    localStorage.setItem('daxiong.agent.outpaint', a.outpaintMode ? '1' : '0');
    localStorage.setItem('daxiong.agent.region', a.regionMode ? '1' : '0');
    applyRegion();
    setStatus(a.outpaintMode ? '已开启「扩图」：勾选方向+填扩多少 px，点发送自动往各方向补画（各方向并发、各自贴回）。' : '已关闭「扩图」。', a.outpaintMode ? 'ok' : '');
  });
  // 扩图方向/px 记忆
  function saveOutpaintDirs() {
    localStorage.setItem('daxiong.agent.outpaintDirs', JSON.stringify({
      left: !!(els.dirLeft && els.dirLeft.checked),
      right: !!(els.dirRight && els.dirRight.checked),
      top: !!(els.dirTop && els.dirTop.checked),
      bottom: !!(els.dirBottom && els.dirBottom.checked),
    }));
  }
  [els.dirLeft, els.dirRight, els.dirTop, els.dirBottom].forEach((el) => { if (el) el.addEventListener('change', saveOutpaintDirs); });
  if (els.outpaintPx) els.outpaintPx.addEventListener('change', () => localStorage.setItem('daxiong.agent.outpaintPx', String(els.outpaintPx.value || 256)));

  DX.agent = {
    ensureLoaded,
    reset() {
      a.loaded = false; a.chatProviders = []; a.imgProviders = []; a.conversationId = ''; a.msgs = []; a.attachments = [];
      DX.ui.fillPicker(els.llmProvider, []); DX.ui.fillPicker(els.llmModel, []);
      DX.ui.fillPicker(els.imgProvider, []); DX.ui.fillPicker(els.imgModel, []);
      DX.ui.fillPicker(els.history, []);
      a.lastInput = ''; showRetry(false);
      renderMsgs(); renderAttach();
      updateSend();
    },
  };
})();
