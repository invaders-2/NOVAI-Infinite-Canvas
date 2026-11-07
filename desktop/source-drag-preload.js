// NOVAI 在线素材 —— 拖拽元素记录 preload（sandbox）
// 只做一件事：拖拽开始时把被拖元素的真实媒体地址回传给主进程，供画布落节点使用。
// 不注入 UI、不改页面样式/结构（只给 video 与其覆盖容器补 draggable 属性），所有异常都吞掉。
const { ipcRenderer } = require('electron');

(function () {
  'use strict';

  let lastPointerVideo = null;   // 最近一次 pointerdown 命中的视频（dragstart 兜底用）
  let lastPointerMedia = null;   // 最近一次 pointerdown 按坐标命中的图片/背景图元素
  let lastPointerGuardAt = 0;    // 最近一次 pointerdown guard 命中媒体的时间
  let lastPointerAt = 0;

  // srcset 解析为 [{url,w}]：w 描述符优先；x 描述符按密度换算成可比较的 w
  function srcsetEntries(value) {
    const entries = [];
    String(value || '').split(',').forEach((part) => {
      const text = String(part || '').trim();
      if (!text) return;
      const pieces = text.split(/\s+/);
      const url = pieces[0];
      if (!url) return;
      const descriptor = pieces[1] || '';
      const widthMatch = /^(\d+)w$/i.exec(descriptor);
      const densityMatch = /^([\d.]+)x$/i.exec(descriptor);
      let w = widthMatch ? Number(widthMatch[1]) : 0;
      if (!w && densityMatch) w = Math.round(Number(densityMatch[1]) * 1000);
      entries.push({ url: url, w: w || 0 });
    });
    return entries;
  }

  // srcset 里 descriptor 最大的一项（w 或 x 换算后最大）
  function largestSrcsetUrl(value) {
    const entries = srcsetEntries(value);
    if (!entries.length) return '';
    entries.sort((a, b) => b.w - a.w);
    return entries[0].url;
  }

  // 兼容旧调用：取第一个候选
  function firstSrcset(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    const first = text.split(',')[0].trim();
    return first ? first.split(/\s+/)[0] : '';
  }

  // 花瓣缩略图 → 原图：去掉 _fwNNN/_sqNNN 后缀，/236x|474x|736x/ 段换成 /originals/
  function huabanOriginalUrl(url) {
    const text = String(url || '').trim();
    if (!/^https?:/i.test(text)) return '';
    try {
      const parsed = new URL(text);
      if (!/(^|\.)huabanimg\.com$/i.test(parsed.hostname)) return '';
      let pathname = parsed.pathname;
      pathname = pathname.replace(/_(?:fw|sq)\d+(?=\.|$)/gi, '');
      pathname = pathname.replace(/\/(?:236x|474x|736x)\//gi, '/originals/');
      if (pathname === parsed.pathname) return '';
      parsed.pathname = pathname;
      return parsed.toString();
    } catch (_) {
      return '';
    }
  }

  // Pinterest 缩略图 → 原图：/236x|474x|736x|75x75/ 段替换为 /originals/
  function pinterestOriginalUrl(url) {
    const text = String(url || '').trim();
    if (!/^https?:/i.test(text)) return '';
    try {
      const parsed = new URL(text);
      if (!/(^|\.)pinimg\.com$/i.test(parsed.hostname)) return '';
      const pathname = parsed.pathname.replace(/\/(?:236x|474x|736x|75x75)\//gi, '/originals/');
      if (pathname === parsed.pathname) return '';
      parsed.pathname = pathname;
      return parsed.toString();
    } catch (_) {
      return '';
    }
  }

  // 背景图：解析元素的 background-image url(...)（仅大图，避免图标）
  function backgroundImageUrls(el) {
    const urls = [];
    try {
      if (!el || !el.style) return urls;
      const value = String(el.style.backgroundImage || '');
      if (!value || value === 'none') return urls;
      const pattern = /url\((['"]?)([^'")]+)\1\)/g;
      let match = null;
      while ((match = pattern.exec(value))) {
        const url = String(match[2] || '').trim();
        if (url && urls.indexOf(url) < 0) urls.push(url);
      }
    } catch (_) {}
    return urls;
  }

  function backgroundMediaFor(el) {
    try {
      if (!el) return null;
      const urls = backgroundImageUrls(el);
      if (!urls.length) return null;
      let rect = null;
      try { rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null; } catch (_) {}
      if (rect && rect.width > 120 && rect.height > 120) return { el: el, urls: urls };
    } catch (_) {}
    return null;
  }

  // 坐标下的元素栈（穿透覆盖层）；不支持时退回 elementFromPoint
  function elementsAtPoint(x, y) {
    try {
      if (Number.isFinite(x) && Number.isFinite(y) && document.elementsFromPoint) {
        return document.elementsFromPoint(x, y) || [];
      }
      if (document.elementFromPoint) {
        const el = document.elementFromPoint(x, y);
        return el ? [el] : [];
      }
    } catch (_) {}
    return [];
  }

  function findMediaInStack(stack) {
    for (let index = 0; index < stack.length; index += 1) {
      if (isMedia(stack[index])) return stack[index];
    }
    return null;
  }

  function findBackgroundInStack(stack) {
    for (let index = 0; index < stack.length; index += 1) {
      const found = backgroundMediaFor(stack[index]);
      if (found) return found;
    }
    return null;
  }

  function pointerCoords(event) {
    let x = Number(event && event.clientX);
    let y = Number(event && event.clientY);
    if ((!Number.isFinite(x) || !Number.isFinite(y)) && event && event.touches && event.touches[0]) {
      x = Number(event.touches[0].clientX);
      y = Number(event.touches[0].clientY);
    }
    return { x: x, y: y };
  }

  // 页面自己的 pointerdown/mousedown 可能 preventDefault，导致 Chromium 不启动原生拖拽。
  // 在 window capture 阶段（preload document-start 先注册）命中媒体时只 stopImmediatePropagation，绝不 preventDefault。
  function handleMediaPointerGuard(event) {
    try {
      const target = event && event.target;
      if (!target) return;
      const point = pointerCoords(event);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
      const stack = elementsAtPoint(point.x, point.y);
      if (!stack.length) return;
      const mediaHit = findMediaInStack(stack);
      const bgHit = mediaHit ? null : findBackgroundInStack(stack);
      const picked = mediaHit || (bgHit && bgHit.el);
      if (!picked) return;  // 只拦媒体命中，其它区域交给页面
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      markDraggableEl(picked);
      for (let index = 0; index < stack.length; index += 1) {
        const node = stack[index];
        try {
          if (node === picked || (node.contains && node.contains(picked))) {
            markDraggableEl(node);
            break;
          }
        } catch (_) {}
      }
      lastPointerGuardAt = Date.now();
      lastPointerAt = Date.now();
      lastPointerMedia = picked;
      if (tagOf(picked) === 'VIDEO') lastPointerVideo = picked;
      try {
        ipcRenderer.send('novai:guest-pointer', {
          tag: tagOf(target),
          targetTag: tagOf(target),
          foundVideo: tagOf(picked) === 'VIDEO',
          pointerGuard: true,
          at: Date.now(),
        });
      } catch (_) {}
    } catch (_) {}
  }

  // 背景图卡片：优先 target 自身，其次 elementsFromPoint 栈（穿透覆盖层）
  function findBackgroundMedia(target, event) {
    try {
      const self = backgroundMediaFor(target);
      if (self) return self;
      const x = Number(event && event.clientX);
      const y = Number(event && event.clientY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const stack = elementsAtPoint(x, y);
      const found = findBackgroundInStack(stack);
      if (found) return found;
    } catch (_) {}
    return null;
  }

  // 小红书等 CDN 的缩略参数 / !h5 后缀：去参后的原图 URL（作备选）
  function stripCdnThumbUrl(url) {
    const text = String(url || '').trim();
    if (!/^https?:/i.test(text)) return '';
    try {
      const parsed = new URL(text);
      let changed = false;
      ['h5', 'w', 'quality', 'width', 'height', 'resize', 'thumbnail', 'x-oss-process', 'imageView2', 'imageMogr2'].forEach((key) => {
        if (parsed.searchParams.has(key)) {
          parsed.searchParams.delete(key);
          changed = true;
        }
      });
      // 小红书图片常见 ?imageView2/2/w/1080/quality/90 这种路径式参数：整段去掉
      if (parsed.search && /imageView2|imageMogr2|\/w\/\d+|\/quality\/\d+|\/format\/\w+/i.test(parsed.search)) {
        parsed.search = '';
        changed = true;
      }
      if (/![^/]*$/i.test(parsed.pathname)) {
        parsed.pathname = parsed.pathname.replace(/![^/]*$/i, '');
        changed = true;
      }
      return changed ? parsed.toString() : '';
    } catch (_) {
      return '';
    }
  }

  // 图片候选（优先级：currentSrc > 最大 srcset > data-original/data-src/data-actualsrc/data-lazy-src > src）
  // 花瓣原图置顶；去缩略参数的版本作为备选；返回 [{url,w}]
  function imageCandidates(el) {
    const ordered = [];
    const seen = {};
    function push(url, w) {
      const value = String(url || '').trim();
      if (!value || seen[value]) return;
      seen[value] = true;
      ordered.push({ url: value, w: Number(w) || 0 });
    }
    try { push(el.currentSrc, 0); } catch (_) {}
    srcsetEntries(attr(el, 'srcset')).sort((a, b) => b.w - a.w).forEach((entry) => push(entry.url, entry.w));
    push(attr(el, 'data-original'), 0);
    push(attr(el, 'data-src'), 0);
    push(attr(el, 'data-actualsrc'), 0);
    push(attr(el, 'data-lazy-src'), 0);
    push(attr(el, 'src'), 0);

    const original = [];
    const stripped = [];
    ordered.forEach((entry) => {
      const upgraded = huabanOriginalUrl(entry.url) || pinterestOriginalUrl(entry.url);
      if (upgraded) original.push({ url: upgraded, w: entry.w });
      const clean = stripCdnThumbUrl(entry.url);
      if (clean) stripped.push({ url: clean, w: entry.w });
    });

    const result = [];
    const seenResult = {};
    function add(entry) {
      const value = String(entry && entry.url || '').trim();
      if (!value || seenResult[value]) return;
      seenResult[value] = true;
      result.push({ url: value, w: Number(entry.w) || 0 });
    }
    original.forEach(add);   // 花瓣 originals 置顶
    ordered.forEach(add);
    stripped.forEach(add);   // 去缩略参数的备选
    return result;
  }

  function attr(el, name) {
    try { return el && el.getAttribute ? String(el.getAttribute(name) || '') : ''; } catch (_) { return ''; }
  }

  function tagOf(el) {
    return String((el && el.tagName) || '').toUpperCase();
  }

  function isMedia(el) {
    const tag = tagOf(el);
    return tag === 'IMG' || tag === 'VIDEO';
  }

  // 让元素本身可拖：draggable 属性 + 真正生效的 -webkit-user-drag
  // 强制清掉站点内联的 draggable=false / -webkit-user-drag:none（img/picture/背景图卡片都适用）
  function markDraggableEl(el) {
    try {
      if (!el || !el.setAttribute) return;
      if (!el.getAttribute || el.getAttribute('draggable') !== 'true') el.setAttribute('draggable', 'true');
      if (el.style) {
        let value = '';
        try { value = el.style.getPropertyValue ? String(el.style.getPropertyValue('-webkit-user-drag') || '') : ''; } catch (_) {}
        if (/none/i.test(value) && el.style.removeProperty) {
          try { el.style.removeProperty('-webkit-user-drag'); } catch (_) {}
        }
        try { if (el.style.setProperty) el.style.setProperty('-webkit-user-drag', 'element'); } catch (_) {}
      }
    } catch (_) {}
  }

  // HTML 里 <video> 默认不可拖（只有 img/a 默认 draggable），不设的话 dragstart 根本不触发。
  // 只改 video 自己的属性，不动父容器/样式/结构。
  function markVideoDraggable(video) {
    try {
      if (!video || tagOf(video) !== 'VIDEO') return;
      markDraggableEl(video);
    } catch (_) {}
  }

  // 拖拽样式（-webkit-user-drag:element !important 等）由主进程 webContents.insertCSS 注入，
  // 不用 <style> 标签，避免被站点 CSP 拦截。
  function ensureStyle() {
    return Boolean(document && document.documentElement);
  }

  function markImageEl(el) {
    try {
      const tag = tagOf(el);
      if (tag === 'PICTURE') {
        markDraggableEl(el);
        const img = el.querySelector ? el.querySelector('img') : null;
        if (img) markImageEl(img);
        return;
      }
      if (tag !== 'IMG') {
        markBackgroundEl(el);
        return;
      }
      markDraggableEl(el);
      if (el.style) {
        let value = '';
        try { value = el.style.getPropertyValue ? String(el.style.getPropertyValue('-webkit-user-drag') || '') : ''; } catch (_) {}
        if (/none/i.test(value) && el.style.removeProperty) {
          try { el.style.removeProperty('-webkit-user-drag'); } catch (_) {}
        }
        try { if (el.style.setProperty) el.style.setProperty('-webkit-user-drag', 'element'); } catch (_) {}
      }
      // 懒加载：图片 load 后重新标一次（只挂一次监听）
      if (!el.__novaiImageLoadHooked && el.addEventListener) {
        el.__novaiImageLoadHooked = true;
        try { el.addEventListener('load', function () { markImageEl(el); }); } catch (_) {}
      }
    } catch (_) {}
  }

  // 小红书轮播常用带 background-image 的 div：大图也补 draggable + -webkit-user-drag
  function markBackgroundEl(el) {
    try {
      if (!el || !el.style || !el.style.backgroundImage) return;
      const value = String(el.style.backgroundImage || '');
      if (!value || value === 'none') return;
      let rect = null;
      try { rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null; } catch (_) {}
      if (!rect || rect.width <= 120 || rect.height <= 120) return;
      markDraggableEl(el);
      try { if (el.style.setProperty) el.style.setProperty('-webkit-user-drag', 'element'); } catch (_) {}
    } catch (_) {}
  }

  function scanImages(root) {
    try {
      const scope = root || document;
      if (tagOf(scope) === 'IMG' || tagOf(scope) === 'PICTURE') markImageEl(scope);
      else markBackgroundEl(scope);
      const nodes = scope.querySelectorAll ? scope.querySelectorAll('img, picture, [style*="background-image"]') : [];
      Array.prototype.forEach.call(nodes, markImageEl);
    } catch (_) {}
  }

  let imageWatchStarted = false;
  function watchImages() {
    try {
      ensureStyle();
      scanImages(document);
      if (imageWatchStarted || typeof MutationObserver !== 'function' || !document.documentElement) return;
      imageWatchStarted = true;
      const observer = new MutationObserver((records) => {
        records.forEach((record) => {
          try {
            if (record.type === 'attributes') {
              markImageEl(record.target);
              return;
            }
            Array.prototype.forEach.call(record.addedNodes || [], (node) => {
              if (node && node.nodeType === 1) scanImages(node);
            });
          } catch (_) {}
        });
        ensureStyle();
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['draggable', 'style', 'src', 'srcset', 'data-src', 'data-original'],
      });
    } catch (_) {}
  }

  function scanVideos(root) {
    try {
      const scope = root || document;
      if (tagOf(scope) === 'VIDEO') markVideoDraggable(scope);
      if (scope && scope.querySelectorAll) {
        const videos = scope.querySelectorAll('video');
        Array.prototype.forEach.call(videos, markVideoDraggable);
      }
    } catch (_) {}
  }

  // preload 可能早于 documentElement 创建：此时别放弃，等 DOMContentLoaded 或短延时重试。
  let videoWatchScheduled = false;
  let videoWatchRetries = 0;
  const VIDEO_WATCH_MAX_RETRIES = 10;

  // 初始扫一遍 + 持续监听新插入的 video（懒加载、无限滚动、切换 tab 都会新建）
  function watchVideos() {
    try {
      if (!document.documentElement) {
        if (videoWatchScheduled) return;
        videoWatchScheduled = true;
        if (document.readyState === 'loading' && document.addEventListener) {
          document.addEventListener('DOMContentLoaded', watchVideos, { once: true });
          return;
        }
        if (videoWatchRetries < VIDEO_WATCH_MAX_RETRIES && typeof setTimeout === 'function') {
          videoWatchRetries += 1;
          setTimeout(() => { videoWatchScheduled = false; watchVideos(); }, 50);
          return;
        }
        videoWatchScheduled = false;
        return;
      }
      videoWatchScheduled = false;
      if (typeof MutationObserver === 'function') {
        const observer = new MutationObserver((records) => {
          records.forEach((record) => {
            try {
              Array.prototype.forEach.call(record.addedNodes || [], (node) => {
                if (node && node.nodeType === 1) scanVideos(node);
              });
            } catch (_) {}
          });
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
      // observer 挂上后再扫一次，补上「DOM 已就绪但视频刚插入」的窗口
      scanVideos(document);
      watchImages();
    } catch (_) {}
  }

  // 按坐标命中媒体（避免同一卡片里抓错图）：target 自身 → elementFromPoint 命中的元素；
  // 命中的不是媒体就放弃（最多在 target 祖先 2 层内确认命中元素属于该祖先）。
  function findMedia(target, event) {
    try {
      if (isMedia(target)) return target;
      const x = Number(event && event.clientX);
      const y = Number(event && event.clientY);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !document.elementFromPoint) return null;
      const stack = elementsAtPoint(x, y);
      const hit = findMediaInStack(stack);
      if (hit) return hit;
    } catch (_) {}
    return null;
  }

  function rectHasPoint(rect, x, y) {
    if (!rect) return false;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  // 放宽的「视频上下文」：target 是 video → 直接用；否则向上最多 4 层找
  // 「后代里有 <video> 且 rect 包含点击点」的祖先容器（xgplayer 的覆盖层常盖在 video 上）。
  function resolveVideoContext(target, event) {
    try {
      if (tagOf(target) === 'VIDEO') return { video: target, container: target };
      const direct = target && target.closest ? target.closest('video') : null;
      if (direct) return { video: direct, container: direct };
      const x = Number(event && event.clientX);
      const y = Number(event && event.clientY);
      let node = target && target.parentElement;
      for (let depth = 0; node && depth < 4; depth += 1) {
        const tag = tagOf(node);
        if (tag !== 'BODY' && tag !== 'HTML' && node.querySelector) {
          const video = node.querySelector('video');
          if (video && node.getBoundingClientRect && rectHasPoint(node.getBoundingClientRect(), x, y)) {
            return { video: video, container: node };
          }
        }
        node = node.parentElement;
      }
    } catch (_) {}
    return { video: null, container: null };
  }

  // 媒体地址优先级：currentSrc → src → srcset 首项 → data-src → data-original
  // → <video> 的 data-video-url / <source>；poster 只作信息，不当视频媒体地址。
  function mediaUrl(el) {
    const tag = tagOf(el);
    const candidates = [];
    try { candidates.push(el.currentSrc); } catch (_) {}
    candidates.push(attr(el, 'src'));
    candidates.push(firstSrcset(attr(el, 'srcset')));
    candidates.push(attr(el, 'data-src'));
    candidates.push(attr(el, 'data-original'));
    if (tag === 'VIDEO') {
      candidates.push(attr(el, 'data-video-url'));
      try {
        const sources = el.querySelectorAll ? el.querySelectorAll('source') : [];
        Array.prototype.forEach.call(sources, (source) => {
          candidates.push(attr(source, 'src'));
          try { candidates.push(source.currentSrc); } catch (_) {}
        });
        candidates.push(el.currentSrc);
      } catch (_) {}
    } else {
      candidates.push(attr(el, 'poster'));
    }
    for (let i = 0; i < candidates.length; i += 1) {
      const value = String(candidates[i] || '').trim();
      if (value) return value;
    }
    return '';
  }

  // VIDEO 的候选地址集合（blob: 原样保留，前端会用 fetch-bytes 在页面上下文里取）
  function videoUrls(el) {
    const urls = [];
    const push = (value) => {
      const text = String(value || '').trim();
      if (text && urls.indexOf(text) < 0) urls.push(text);
    };
    try { push(el.currentSrc); } catch (_) {}
    push(attr(el, 'src'));
    push(attr(el, 'data-src'));
    push(attr(el, 'data-video-url'));
    try {
      const sources = el.querySelectorAll ? el.querySelectorAll('source') : [];
      Array.prototype.forEach.call(sources, (source) => {
        push(attr(source, 'src'));
        try { push(source.currentSrc); } catch (_) {}
      });
    } catch (_) {}
    return urls;
  }

  function handleDragStart(event) {
    try {
      const target = event && event.target;
      if (!target || !target.tagName) return;
      const dt = event && event.dataTransfer;
      // 优先 target 自身 / 坐标命中的 img/video；找不到就放弃，不抓同容器另一张
      let media = findMedia(target, event);
      let usedPointerVideo = false;
      // 兜底：pointerdown 已经按坐标定位到视频，但 dragstart 的 target 是覆盖层时用它
      if (!media && lastPointerVideo && lastPointerAt && (Date.now() - lastPointerAt) <= 5000) {
        media = lastPointerVideo;
        usedPointerVideo = true;
      }
      // 没有 img/video 时看背景图卡片（仅 >120×120，避免图标）
      let bgMedia = null;
      if (!media) bgMedia = findBackgroundMedia(target, event);
      const el = media || (bgMedia && bgMedia.el) || target;
      const targetTag = tagOf(target);
      const hitMethod = media
        ? (isMedia(target) ? 'self' : usedPointerVideo ? 'pointer-video' : 'point')
        : bgMedia
          ? (bgMedia.el === target ? 'self-background' : 'background-point')
          : 'none';
      const payload = {
        tagName: tagOf(el),
        sourceTag: tagOf(el),
        hitMethod: hitMethod,
        pointerGuard: Boolean(lastPointerGuardAt && (Date.now() - lastPointerGuardAt) <= 30000),
        targetTag: targetTag,
        currentSrc: '',
        src: attr(el, 'src'),
        srcset: firstSrcset(attr(el, 'srcset')),
        dataSrc: attr(el, 'data-src'),
        dataOriginal: attr(el, 'data-original'),
        poster: attr(el, 'poster'),
        mediaUrl: mediaUrl(el),
        url: '',
        imageCandidates: [],
        videoUrls: [],
        videoCandidates: [],
        anchorHref: '',
        linkHref: targetTag === 'A' ? String(target.href || attr(target, 'href') || '') : '',
        types: [],
        uriList: '',
        html: '',
        pageUrl: String(location.href || ''),
        pageTitle: String(document.title || ''),
        at: Date.now(),
      };
      try { payload.currentSrc = String(el.currentSrc || ''); } catch (_) {}
      if (tagOf(el) === 'VIDEO') {
        try { payload.videoUrls = videoUrls(el); } catch (_) { payload.videoUrls = []; }
        try {
          payload.videoCandidates = payload.videoUrls.map((value) => ({ url: value }));
        } catch (_) { payload.videoCandidates = []; }
      } else {
        try { payload.imageCandidates = imageCandidates(el); } catch (_) { payload.imageCandidates = []; }
        if (bgMedia) {
          const extras = [];
          bgMedia.urls.forEach((url) => {
            const upgraded = huabanOriginalUrl(url) || pinterestOriginalUrl(url);
            if (upgraded) extras.push({ url: upgraded, w: 0 });
            const text = String(url || '').trim();
            if (text) extras.push({ url: text, w: 0 });
          });
          const seen = {};
          payload.imageCandidates = extras.concat(payload.imageCandidates).filter((item) => {
            if (!item || !item.url || seen[item.url]) return false;
            seen[item.url] = true;
            return true;
          });
        }
        if (payload.imageCandidates.length) payload.mediaUrl = payload.imageCandidates[0].url;
      }
      payload.url = payload.mediaUrl;
      try {
        const anchor = el.closest ? el.closest('a') : null;
        if (anchor) payload.anchorHref = String(anchor.href || attr(anchor, 'href') || '');
      } catch (_) {}
      // 图片/<a> 内图片：不放 preventDefault（否则原生拖拽不会启动，画布收不到 drop）。
      // 只拦截页面自己的 drag handler，并把最高清 URL 写进 dataTransfer 供画布 drop 使用。
      const mediaTag = tagOf(media);
      const imageDrag = !!media && (mediaTag === 'IMG' || mediaTag === 'PICTURE');
      const linkImageDrag = targetTag === 'A' && imageDrag;
      if (imageDrag || linkImageDrag || !!bgMedia) {
        if (typeof event.stopPropagation === 'function') event.stopPropagation();
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      }
      const bestUrl = String(
        (payload.imageCandidates[0] && payload.imageCandidates[0].url) ||
        (payload.videoCandidates[0] && payload.videoCandidates[0].url) ||
        payload.mediaUrl || ''
      ).trim();
      if (bestUrl) payload.bestUrl = bestUrl;
      if (dt && bestUrl) {
        try { dt.setData('text/uri-list', bestUrl); } catch (_) {}
        try { dt.setData('text/plain', bestUrl); } catch (_) {}
        try { dt.effectAllowed = 'copy'; } catch (_) {}
        payload.uriList = bestUrl;
      }
      if (dt) {
        try { payload.types = Array.prototype.slice.call(dt.types || []); } catch (_) {}
        try {
          const uri = String(dt.getData('text/uri-list') || '').trim();
          if (uri) payload.uriList = uri.slice(0, 4000);
        } catch (_) {}
        try { payload.html = String(dt.getData('text/html') || '').slice(0, 4000); } catch (_) {}
      }
      // 真机排查：记录坐标栈前 3 个 tag/class
      try {
        const describe = (node) => {
          const tag = tagOf(node);
          const className = node && typeof node.className === 'string' ? node.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
          return className ? tag + '.' + className : tag;
        };
        const stack = elementsAtPoint(event && event.clientX, event && event.clientY).slice(0, 3).map(describe);
        if (!stack.length) {
          let node = target;
          for (let depth = 0; node && depth < 3; depth += 1) {
            stack.push(describe(node));
            node = node.parentElement;
          }
        }
        payload.elementsStack = stack;
      } catch (_) {
        payload.elementsStack = [];
      }
      ipcRenderer.send('novai:guest-drag', payload);
    } catch (_) {
      // 拖拽记录失败绝不能影响页面
    }
  }

  // xgplayer 这类播放器会在 pointerdown / mousedown 上拦截，导致浏览器默认拖拽被取消。
  // 捕获阶段只挡站点的处理器（stopImmediatePropagation），绝不 preventDefault。
  function handlePointer(event) {
    try {
      const target = event && event.target;
      if (!target || !target.tagName) return;
      const ctx = resolveVideoContext(target, event);
      if (ctx.video) {
        if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
        // 覆盖容器也可拖：从盖在 video 上的那层按住也能起拖
        markDraggableEl(ctx.video);
        if (ctx.container && ctx.container !== ctx.video) markDraggableEl(ctx.container);
        lastPointerVideo = ctx.video;
        lastPointerAt = Date.now();
      }
      // 小红书等：覆盖层挡住 img；按 elementsFromPoint 找到媒体，并把最上层包含它的元素设为可拖
      const stack = elementsAtPoint(event.clientX, event.clientY);
      const mediaHit = findMediaInStack(stack);
      const bgHit = mediaHit ? null : findBackgroundInStack(stack);
      const picked = mediaHit || (bgHit && bgHit.el);
      if (picked) {
        markDraggableEl(picked);
        for (let index = 0; index < stack.length; index += 1) {
          const node = stack[index];
          try {
            if (node === picked || (node.contains && node.contains(picked))) {
              markDraggableEl(node);
              break;
            }
          } catch (_) {}
        }
        lastPointerMedia = picked;
        lastPointerAt = Date.now();
      }
      try {
        ipcRenderer.send('novai:guest-pointer', {
          tag: tagOf(target),
          targetTag: tagOf(target),
          foundVideo: Boolean(ctx.video),
          at: Date.now(),
        });
      } catch (_) {}
    } catch (_) {}
  }

  // ---------- macOS 触控板双指左右滑动：返回 / 前进 ----------
  // 只处理横向位移；在可横向滚动容器里交给页面；累积超过阈值触发，200ms 无事件衰减清零。
  const SWIPE_THRESHOLD = 120;
  const SWIPE_DECAY_MS = 200;
  const SWIPE_COOLDOWN_MS = 300;
  let swipeAccumulator = 0;
  let swipeLastEventAt = 0;
  let swipeLastSentAt = 0;

  function isInHorizontalScroller(node) {
    try {
      let el = node;
      for (let depth = 0; el && depth < 6; depth += 1) {
        const scrollWidth = Number(el.scrollWidth) || 0;
        const clientWidth = Number(el.clientWidth) || 0;
        const scrollLeft = Number(el.scrollLeft) || 0;
        if (scrollWidth > clientWidth + 2) {
          // scrollLeft > 0（已经滚开）或仍有横向余量 → 页面自己处理
          if (scrollLeft > 0 || scrollLeft < scrollWidth - clientWidth - 1) return true;
        }
        el = el.parentElement;
      }
    } catch (_) {}
    return false;
  }

  function handleWheel(event) {
    try {
      const deltaX = Number(event && event.deltaX);
      const deltaY = Number(event && event.deltaY);
      if (!Number.isFinite(deltaX) || Math.abs(deltaX) < 2) return;
      if (Math.abs(deltaX) <= Math.abs(deltaY || 0)) return;
      if (isInHorizontalScroller(event && event.target)) return;
      const now = Date.now();
      if (now - swipeLastEventAt > SWIPE_DECAY_MS) swipeAccumulator = 0;
      swipeLastEventAt = now;
      swipeAccumulator += deltaX;
      if (Math.abs(swipeAccumulator) <= SWIPE_THRESHOLD) return;
      if (now - swipeLastSentAt < SWIPE_COOLDOWN_MS) return;
      const direction = swipeAccumulator > 0 ? 'back' : 'forward';
      swipeAccumulator = 0;
      swipeLastSentAt = now;
      try { if (typeof event.preventDefault === 'function') event.preventDefault(); } catch (_) {}
      ipcRenderer.send('novai:guest-swipe', { direction: direction, at: now });
    } catch (_) {}
  }

  // ---------- 悬浮控件（WebContentsView 会盖住主窗口 HTML，所以必须注入到页面里） ----------
  const CONTROLS_ID = 'novai-source-controls';
  const ICONS = {
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 5.5 8 12l7.5 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    forward: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 5.5 16 12l-7.5 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    minus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12M6 12h12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  };
  let controlsHost = null;
  let controlsRefs = null;
  let controlsState = { theme: 'dark', zoomPercent: 100, canGoBack: false, canGoForward: false };
  let controlsReadyReported = false;

  function makeControlButton(control, html, label, className) {
    const button = document.createElement('button');
    button.className = 'novai-controls-btn' + (className ? ' ' + className : '');
    button.setAttribute('data-novai-control', control);
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
    button.innerHTML = html;
    return button;
  }

  function buildControls() {
    try {
      if (!document.documentElement || !document.createElement) return null;
      const host = document.createElement('div');
      host.id = CONTROLS_ID;
      host.setAttribute('data-theme', controlsState.theme === 'light' ? 'light' : 'dark');
      host.setAttribute('data-visible', controlsVisible ? 'true' : 'false');

      const left = document.createElement('div');
      left.className = 'novai-controls-group novai-controls-left';
      const backBtn = makeControlButton('back', ICONS.back, '后退');
      const forwardBtn = makeControlButton('forward', ICONS.forward, '前进');
      left.appendChild(backBtn);
      left.appendChild(forwardBtn);

      const right = document.createElement('div');
      right.className = 'novai-controls-group novai-controls-right';
      const zoomCluster = document.createElement('div');
      zoomCluster.className = 'novai-zoom-cluster';
      const zoomOut = makeControlButton('zoom-out', ICONS.minus, '缩小');
      const zoomValue = makeControlButton('zoom-reset', '<span class="novai-zoom-value">100%</span>', '恢复 100%');
      zoomValue.className += ' novai-zoom-value-btn';
      const zoomIn = makeControlButton('zoom-in', ICONS.plus, '放大');
      zoomCluster.appendChild(zoomOut);
      zoomCluster.appendChild(zoomValue);
      zoomCluster.appendChild(zoomIn);
      const refreshBtn = makeControlButton('refresh', ICONS.refresh, '刷新');
      const closeBtn = makeControlButton('close', ICONS.close, '关闭');
      closeBtn.className += ' novai-controls-close';
      right.appendChild(zoomCluster);
      right.appendChild(refreshBtn);
      right.appendChild(closeBtn);

      // 底部一行：[←][→] | [−][%][+][刷新][×]
      const bottom = document.createElement('div');
      bottom.className = 'novai-controls-bottom';
      bottom.appendChild(left);
      bottom.appendChild(right);
      host.appendChild(bottom);

      host.addEventListener('click', handleControlsClick, true);

      const parent = document.body || document.documentElement;
      parent.appendChild(host);
      controlsHost = host;
      controlsRefs = {
        back: backBtn,
        forward: forwardBtn,
        zoomValue: zoomValue,
      };
      applyControlsState({});
      return host;
    } catch (_) {
      return null;
    }
  }

  function applyControlsState(next) {
    try {
      if (next && typeof next === 'object') {
        if (next.theme) controlsState.theme = next.theme === 'light' ? 'light' : 'dark';
        if (typeof next.zoomPercent === 'number') controlsState.zoomPercent = next.zoomPercent;
        if (typeof next.canGoBack === 'boolean') controlsState.canGoBack = next.canGoBack;
        if (typeof next.canGoForward === 'boolean') controlsState.canGoForward = next.canGoForward;
      }
      if (!controlsHost) return;
      controlsHost.setAttribute('data-theme', controlsState.theme === 'light' ? 'light' : 'dark');
      // setZoomFactor 会连 fixed 元素一起放大：用 1/zoom 反向缩放抵消尺寸变化
      const factor = Number(controlsState.zoomPercent) > 0 ? 100 / Number(controlsState.zoomPercent) : 1;
      if (controlsHost.style && controlsHost.style.setProperty) {
        controlsHost.style.setProperty('--novai-ui-compensate', String(factor));
      }
      if (!controlsRefs) return;
      if (controlsRefs.back) controlsRefs.back.disabled = !controlsState.canGoBack;
      if (controlsRefs.forward) controlsRefs.forward.disabled = !controlsState.canGoForward;
      if (controlsRefs.zoomValue) {
        const label = controlsRefs.zoomValue.querySelector ? controlsRefs.zoomValue.querySelector('.novai-zoom-value') : null;
        if (label) label.textContent = Math.round(controlsState.zoomPercent) + '%';
      }
    } catch (_) {}
  }

  function handleControlsClick(event) {
    try {
      const target = event && event.target;
      const button = target && target.closest ? target.closest('[data-novai-control]') : null;
      if (!button) return;
      const control = button.getAttribute ? String(button.getAttribute('data-novai-control') || '') : '';
      if (!control) return;
      if (typeof event.stopPropagation === 'function') event.stopPropagation();
      if (typeof event.preventDefault === 'function') event.preventDefault();
      if (control === 'zoom-in' || control === 'zoom-out' || control === 'zoom-reset') {
        ipcRenderer.send('novai:guest-control', { action: 'zoom', mode: control === 'zoom-in' ? 'in' : control === 'zoom-out' ? 'out' : 'reset' });
        return;
      }
      if (control === 'back' || control === 'forward' || control === 'refresh' || control === 'close') {
        ipcRenderer.send('novai:guest-control', { action: control });
      }
    } catch (_) {}
  }

  // ---------- 悬停唤起（顶部 56px / 底部 64px / 指针进入控件） ----------
  const CONTROLS_BOTTOM_ZONE = 96;
  const CONTROLS_HIDE_DELAY = 1500;
  let controlsVisible = false;
  let controlsHideTimer = null;

  function setControlsVisible(next) {
    controlsVisible = Boolean(next);
    try {
      if (controlsHost) controlsHost.setAttribute('data-visible', controlsVisible ? 'true' : 'false');
    } catch (_) {}
  }

  function clearControlsHideTimer() {
    if (controlsHideTimer) {
      clearTimeout(controlsHideTimer);
      controlsHideTimer = null;
    }
  }

  function scheduleControlsHide() {
    clearControlsHideTimer();
    controlsHideTimer = setTimeout(function () {
      controlsHideTimer = null;
      setControlsVisible(false);
    }, CONTROLS_HIDE_DELAY);
  }

  function pointerInControls(x, y) {
    try {
      if (!controlsHost || !controlsHost.querySelectorAll) return false;
      const nodes = controlsHost.querySelectorAll('.novai-controls-group');
      for (let index = 0; index < nodes.length; index += 1) {
        const rect = nodes[index].getBoundingClientRect && nodes[index].getBoundingClientRect();
        if (rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
      }
    } catch (_) {}
    return false;
  }

  function handleControlsHover(event) {
    try {
      if (!INJECTED_CONTROLS_ENABLED || !controlsHost) return;
      const y = Number(event && event.clientY);
      const x = Number(event && event.clientX);
      if (!Number.isFinite(y)) return;
      let viewportHeight = 0;
      try {
        viewportHeight = Number(document.documentElement && document.documentElement.clientHeight) || 0;
        if (!viewportHeight && typeof window !== 'undefined') viewportHeight = Number(window.innerHeight) || 0;
      } catch (_) {}
      const inBottomZone = viewportHeight > 0 && y >= viewportHeight - CONTROLS_BOTTOM_ZONE;
      if (inBottomZone || pointerInControls(x, y)) {
        clearControlsHideTimer();
        setControlsVisible(true);
      } else if (controlsVisible) {
        scheduleControlsHide();
      }
    } catch (_) {}
  }

  let controlsRetryScheduled = false;
  let controlsRetries = 0;
  const CONTROLS_MAX_RETRIES = 40;

  function reportControlsReady(ok, reason) {
    if (controlsReadyReported) return;
    controlsReadyReported = true;
    try { ipcRenderer.send('novai:guest-controls-ready', { ok: Boolean(ok), reason: reason || '', at: Date.now() }); } catch (_) {}
  }

  // 注入式悬浮控件默认开启（方案 A：悬停唤起）。
  const INJECTED_CONTROLS_ENABLED = true;

  function ensureControls() {
    try {
      if (!INJECTED_CONTROLS_ENABLED) return true;
      if (!document.documentElement) {
        if (!controlsRetryScheduled && controlsRetries < CONTROLS_MAX_RETRIES) {
          controlsRetryScheduled = true;
          controlsRetries += 1;
          setTimeout(function () { controlsRetryScheduled = false; ensureControls(); }, 50);
        }
        return false;
      }
      if (document.getElementById && document.getElementById(CONTROLS_ID)) {
        controlsHost = document.getElementById(CONTROLS_ID);
        applyControlsState({});
        reportControlsReady(true, 'existing');
        return true;
      }
      const host = buildControls();
      if (!host) {
        reportControlsReady(false, 'build-failed');
        return false;
      }
      // 注入后再检查一次：站点 CSP/DOM 重写可能把节点搬走
      setTimeout(function () {
        const alive = document.getElementById && document.getElementById(CONTROLS_ID);
        reportControlsReady(Boolean(alive), alive ? 'ok' : 'removed');
      }, 80);
      return true;
    } catch (_) {
      reportControlsReady(false, 'exception');
      return false;
    }
  }

  try {
    ipcRenderer.on('novai:source-ui-state', function (e, payload) { applyControlsState(payload || {}); });
    ipcRenderer.on('novai:source-theme', function (e, payload) { applyControlsState({ theme: (payload && payload.theme) || 'dark' }); });
  } catch (_) {}

  // window 级 capture：在页面自己的 dragstart 监听之前拿到事件，避免被页面 preventDefault/改数据
  const dragRoot = (typeof window !== 'undefined' && window.addEventListener) ? window : document;
  dragRoot.addEventListener('dragstart', handleDragStart, true);
  // 页面 pointerdown/mousedown 抢先 preventDefault 会杀掉原生拖拽：媒体命中时在 window capture 拦掉页面 handler
  dragRoot.addEventListener('pointerdown', handleMediaPointerGuard, true);
  dragRoot.addEventListener('mousedown', handleMediaPointerGuard, true);
  try {
    dragRoot.addEventListener('touchstart', handleMediaPointerGuard, { capture: true, passive: true });
  } catch (_) {
    try { dragRoot.addEventListener('touchstart', handleMediaPointerGuard, true); } catch (_) {}
  }
  document.addEventListener('wheel', handleWheel, { passive: false, capture: true });
  document.addEventListener('mousemove', handleControlsHover, true);
  ensureControls();
  if (document.readyState === 'loading' && document.addEventListener) {
    document.addEventListener('DOMContentLoaded', ensureControls, { once: true });
  }
  setTimeout(ensureControls, 300);
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('load', ensureControls, { once: true });
  }
  // 站点在 SPA 下可能整体换掉 body，也可能清空 body.innerHTML：监听 <html> 和当前 body 的直接子节点
  // （不做 subtree），只有发现 #novai-source-controls 不在了才补一次；重建沿用当前显示状态，避免闪一下。
  // 纯 Node 测试环境不挂 MutationObserver。
  const IS_PLAIN_NODE = typeof process !== 'undefined' && process && process.versions && !process.versions.electron;
  let observedBody = null;
  function observeControlsHosts(observer) {
    try {
      if (document.documentElement) observer.observe(document.documentElement, { childList: true });
      if (document.body && document.body !== observedBody) {
        observedBody = document.body;
        observer.observe(observedBody, { childList: true });
      }
    } catch (_) {}
  }
  if (!IS_PLAIN_NODE && typeof MutationObserver === 'function' && document.documentElement) {
    try {
      const controlsObserver = new MutationObserver(function () {
        try {
          observeControlsHosts(controlsObserver);
          if (!document.getElementById || !document.getElementById(CONTROLS_ID)) ensureControls();
        } catch (_) {}
      });
      observeControlsHosts(controlsObserver);
    } catch (_) {}
  }
  document.addEventListener('pointerdown', handlePointer, true);
  document.addEventListener('mousedown', handlePointer, true);
  watchVideos();
})();
