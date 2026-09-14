/* Photoshop 侧操作：下载到临时文件、置入文档、导出当前文档为 PNG、外部打开。 */
(function () {
  const photoshop = require('photoshop');
  const app = photoshop.app;
  const core = photoshop.core;
  const action = photoshop.action;
  const imaging = photoshop.imaging;
  const uxp = require('uxp');
  const fs = uxp.storage.localFileSystem;
  const formats = uxp.storage.formats;
  const shell = uxp.shell;

  const net = DX.net;
  const itemIsImage = DX.sources.itemIsImage;

  function hasDocument() { return app.documents.length > 0; }

  // 当前文档像素尺寸（用于"适配当前尺寸"），无文档返回 null
  function docSize() {
    const d = app.activeDocument;
    if (!d) return null;
    try { return { w: Math.round(d.width), h: Math.round(d.height) }; }
    catch (e) { return null; }
  }

  async function downloadToTemp(item) {
    // WebP 等 PS 可能打不开的格式：取后端转好的整张 JPEG；其余直接取原图
    const unsupported = net.needsJpeg(item.url);
    const buffer = await net.fetchBytes(unsupported ? net.displayUrl(item.url, 0) : item.url);
    let ext = unsupported ? 'jpg' : (String(item.url || '').split(/[?#]/)[0].split('.').pop() || 'png').toLowerCase();
    if (!/^[a-z0-9]{1,5}$/.test(ext)) ext = 'png';
    const safe = String(item.name || 'asset').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 48) || 'asset';
    const folder = await fs.getTemporaryFolder();
    const file = await folder.createFile(`dx_${safe}_${Date.now()}.${ext}`, { overwrite: true });
    await file.write(buffer, { format: formats.binary });
    return file;
  }

  // 资产 → PS：置入为智能对象（无文档时直接打开）
  async function placeImage(item) {
    if (!itemIsImage(item)) throw new Error('该素材不是图片');
    const file = await downloadToTemp(item);
    const token = await fs.createSessionToken(file);
    await core.executeAsModal(async () => {
      if (!app.documents.length) { await app.open(file); return; }
      await action.batchPlay([{
        _obj: 'placeEvent',
        null: { _path: token, _kind: 'local' },
        freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' },
        offset: {
          _obj: 'offset',
          horizontal: { _unit: 'pixelsUnit', _value: 0 },
          vertical: { _unit: 'pixelsUnit', _value: 0 },
        },
      }], {});
    }, { commandName: '置入素材' });
  }

  // PS → 后端：导出当前文档为合并 PNG（asCopy=true，不改动用户文档），返回字节
  async function exportDocPng() {
    const folder = await fs.getTemporaryFolder();
    const file = await folder.createFile(`dx_export_${Date.now()}.png`, { overwrite: true });
    let docName = 'document';
    await core.executeAsModal(async () => {
      const doc = app.activeDocument;
      docName = (doc && doc.name) || 'document';
      await doc.saveAs.png(file, {}, true);
    }, { commandName: '导出文档' });
    const buffer = await file.read({ format: formats.binary });
    return { buffer, name: String(docName).replace(/\.[^.]+$/, '') || 'PS文档' };
  }

  // PS → 后端：只导出「当前激活图层」为 PNG。
  // 做法：用当前图层新建一个临时文档（= 图层 > 复制图层 > 目标:新建文档），存 PNG，再关掉临时文档；
  // 全程不改动用户的原文档。
  async function exportActiveLayerPng() {
    const folder = await fs.getTemporaryFolder();
    const file = await folder.createFile(`dx_layer_${Date.now()}.png`, { overwrite: true });
    let layerName = 'layer';
    await core.executeAsModal(async () => {
      const srcDoc = app.activeDocument;
      if (!srcDoc) throw new Error('没有打开的文档');
      const srcId = srcDoc.id;
      const layers = srcDoc.activeLayers || [];
      if (!layers.length) throw new Error('请先在图层面板选中要上传的图层');
      layerName = layers[0].name || 'layer';
      // 把当前选中图层复制成一个新文档
      await action.batchPlay([{
        _obj: 'make',
        _target: [{ _ref: 'document' }],
        name: 'dx_tmp_layer_export',
        using: {
          _ref: [
            { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' },
            { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' },
          ],
        },
      }], { synchronousExecution: true });
      const tmpDoc = app.activeDocument;
      // 安全护栏：确认确实新建了文档，否则绝不关闭（避免误关用户原文档）
      if (!tmpDoc || tmpDoc.id === srcId) throw new Error('未能从图层创建临时文档');
      await tmpDoc.saveAs.png(file, {}, true);
      await tmpDoc.closeWithoutSaving();
    }, { commandName: '导出当前图层' });
    const buffer = await file.read({ format: formats.binary });
    return { buffer, name: String(layerName).replace(/\.[^.]+$/, '') || 'layer' };
  }

  async function exportCurrentPng() {
    return DX.state.exportLayer ? exportActiveLayerPng() : exportDocPng();
  }

  // 读当前矩形选区边界（原文档像素坐标）。无选区/无效返回 null。需在 executeAsModal 内调用。
  async function readSelectionBounds() {
    const [res] = await action.batchPlay([{
      _obj: 'get',
      _target: [{ _property: 'selection' }, { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }],
    }], { synchronousExecution: true });
    const s = res && res.selection;
    if (!s) return null;
    const val = (v) => Math.round(typeof v === 'object' && v !== null ? v._value : v);
    const left = val(s.left), top = val(s.top), right = val(s.right), bottom = val(s.bottom);
    const width = right - left, height = bottom - top;
    if (!(width > 0 && height > 0)) return null;
    return { left, top, width, height, right, bottom };
  }

  // 读当前矩形选区，直接抓「选区那块的合并画面」像素（imaging.getPixels + sourceBounds）。
  // 不复制文档、不裁剪，一步到位，绝不改动用户原文档。无选区返回 null。
  // 返回 { base64, mime, name, bounds:{left,top,width,height} }（bounds 为原文档像素坐标，jpeg base64）。
  async function exportSelectionPng() {
    let out = null;
    await core.executeAsModal(async () => {
      const srcDoc = app.activeDocument;
      if (!srcDoc) throw new Error('没有打开的文档');
      const sb = await readSelectionBounds();
      if (!sb) return;   // 无选区/无效
      const { left, top, right, bottom, width, height } = sb;
      const bounds = { left, top, width, height };
      // 直接抓选区那块的合并像素（composite = 所有可见图层）
      const pix = await imaging.getPixels({
        documentID: srcDoc.id,
        sourceBounds: { left, top, right, bottom },
        applyAlpha: true,
      });
      // 编码成 jpeg base64（UXP imaging 输出 jpeg/base64）
      const base64 = await imaging.encodeImageData({ imageData: pix.imageData, base64: true });
      try { pix.imageData.dispose(); } catch (e) {}
      out = { base64, mime: 'image/jpeg', name: 'selection', bounds };
    }, { commandName: '导出选区' });
    return out;
  }

  // 扩图用：导出选区那块，但【保留透明】（画布外/透明区不填白），输出透明 PNG。
  // 做法：复制文档 → 裁到选区矩形 → 合并 → saveAs.png（PNG 保住 alpha）。绝不改动用户原文档。
  // 返回 { base64, mime:'image/png', name, bounds }；无选区返回 null。
  async function exportSelectionTransparent() {
    const doc = app.activeDocument;
    if (!doc) throw new Error('没有打开的文档');
    const srcId = doc.id;
    let bounds = null;
    const folder = await fs.getTemporaryFolder();
    const file = await folder.createFile(`dx_selpng_${Date.now()}.png`, { overwrite: true });
    await core.executeAsModal(async () => {
      const sb = await readSelectionBounds();
      if (!sb) return;
      bounds = { left: sb.left, top: sb.top, width: sb.width, height: sb.height };
      // 复制文档，在副本上裁到选区、合并（保留透明），存 PNG
      await action.batchPlay([{
        _obj: 'duplicate',
        _target: [{ _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }],
        name: 'dx_tmp_selpng',
      }], { synchronousExecution: true });
      const tmp = app.activeDocument;
      if (!tmp || tmp.id === srcId) throw new Error('未能复制文档用于导出选区');
      await action.batchPlay([{
        _obj: 'crop',
        to: {
          _obj: 'rectangle',
          top: { _unit: 'pixelsUnit', _value: sb.top },
          left: { _unit: 'pixelsUnit', _value: sb.left },
          bottom: { _unit: 'pixelsUnit', _value: sb.bottom },
          right: { _unit: 'pixelsUnit', _value: sb.right },
        },
        delete: true,
      }], { synchronousExecution: true });
      await tmp.flatten().catch(() => {});   // 合并可见图层，保留透明像素
      await tmp.saveAs.png(file, {}, true);
      await tmp.closeWithoutSaving();
    }, { commandName: '导出选区(透明)' });
    if (!bounds) return null;
    const base64 = net.toBase64(await file.read({ format: formats.binary }));
    return { base64, mime: 'image/png', name: 'selection', bounds };
  }

  // 方向扩图：按勾选方向(left/right/top/bottom) + 扩展像素 n，为每个方向生成一张「块」透明 PNG。
  // 每块 = 「原图靠该侧边缘 n 一条（有像素，做参考/接口）」+「该侧 n 透明扩展区（待补）」，尺寸 2n×边长。
  // 不依赖 PS 选区、不改动用户原文档（全程临时文档）。
  // 返回 { blocks:[{ dir, base64, mime, name, size, bounds:{left,top,width,height} }] }，bounds 为原文档坐标（供 placeImageAt 贴回，可为负=贴到画布外）。
  async function outpaintDirections(dirs, n) {
    const doc = app.activeDocument;
    if (!doc) throw new Error('没有打开的文档');
    const OW = Math.round(doc.width), OH = Math.round(doc.height);
    const srcId = doc.id;
    const N = Math.max(1, Math.round(n));
    const wanted = ['left', 'right', 'top', 'bottom'].filter((d) => dirs && dirs[d]);
    if (!wanted.length) return { error: '请至少选择一个扩展方向（左/右/上/下）。' };

    const folder = await fs.getTemporaryFolder();
    // 先把原图合并导出成一张 PNG（作为要贴进各块透明画布的素材）
    const origPng = await folder.createFile(`dx_op_src_${Date.now()}.png`, { overwrite: true });
    await core.executeAsModal(async () => {
      await action.batchPlay([{
        _obj: 'duplicate',
        _target: [{ _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }],
        name: 'dx_tmp_op_src',
      }], { synchronousExecution: true });
      const tmp = app.activeDocument;
      if (!tmp || tmp.id === srcId) throw new Error('未能复制文档用于扩图');
      await tmp.flatten().catch(() => {});
      await tmp.saveAs.png(origPng, {}, true);
      await tmp.closeWithoutSaving();
    }, { commandName: '扩图·导出原图' });
    const origToken = await fs.createSessionToken(origPng);

    // 每个方向的块几何：块尺寸(BW×BH)、原图在块坐标系里的原点(px,py)、贴回原文档的 bounds
    // 约定：块坐标系里「有图的一半」是原图边缘条，「透明的一半」是扩展区。
    function geom(dir) {
      if (dir === 'right')  return { BW: 2 * N, BH: OH, px: -(OW - N), py: 0, bounds: { left: OW - N, top: 0, width: 2 * N, height: OH } };
      if (dir === 'left')   return { BW: 2 * N, BH: OH, px: N,          py: 0, bounds: { left: -N,      top: 0, width: 2 * N, height: OH } };
      if (dir === 'bottom') return { BW: OW, BH: 2 * N, px: 0, py: -(OH - N), bounds: { left: 0, top: OH - N, width: OW, height: 2 * N } };
      /* top */              return { BW: OW, BH: 2 * N, px: 0, py: N,          bounds: { left: 0, top: -N,      width: OW, height: 2 * N } };
    }

    const blocks = [];
    for (const dir of wanted) {
      const g = geom(dir);
      const file = await folder.createFile(`dx_op_${dir}_${Date.now()}.png`, { overwrite: true });
      await core.executeAsModal(async () => {
        const blkDoc = await app.documents.add({ width: g.BW, height: g.BH, resolution: 72, fill: 'transparent' });
        if (!blkDoc || blkDoc.id === srcId) throw new Error('未能新建扩图块文档');
        // place 默认居中；把原图中心平移到它在块坐标系里应有的中心 (px+OW/2, py+OH/2)
        const dx = (g.px + OW / 2) - g.BW / 2;
        const dy = (g.py + OH / 2) - g.BH / 2;
        await action.batchPlay([{
          _obj: 'placeEvent',
          null: { _path: origToken, _kind: 'local' },
          freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' },
          offset: { _obj: 'offset', horizontal: { _unit: 'pixelsUnit', _value: dx }, vertical: { _unit: 'pixelsUnit', _value: dy } },
        }], {});
        await blkDoc.saveAs.png(file, {}, true);
        await blkDoc.closeWithoutSaving();
      }, { commandName: `扩图·${dir}` });
      const base64 = net.toBase64(await file.read({ format: formats.binary }));
      blocks.push({ dir, base64, mime: 'image/png', name: `outpaint_${dir}`, size: `${g.BW}x${g.BH}`, bounds: g.bounds });
    }
    return { blocks };
  }

  // 按选区位置+尺寸置入图片：API 有最低分辨率（如 1K），返回图往往比选区大（等比放大）。
  // 这里置入后读图层实际 bounds，缩放并平移，让它精确覆盖选区矩形（左上对齐、宽高=选区）。
  // 作为新图层盖在上面，不改动原图层（非破坏性）。
  async function placeImageAt(item, bounds) {
    if (!itemIsImage(item)) throw new Error('该素材不是图片');
    if (!bounds) return placeImage(item);   // 无 bounds 回退到居中置入
    const file = await downloadToTemp(item);
    const token = await fs.createSessionToken(file);
    await core.executeAsModal(async () => {
      const doc = app.activeDocument;
      if (!doc) { await app.open(file); return; }
      // 1) 先置入（位置先不管，默认置于文档中心）
      await action.batchPlay([{
        _obj: 'placeEvent',
        null: { _path: token, _kind: 'local' },
        freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' },
      }], {});
      // 2) 读刚置入图层的实际边界（像素）
      const [res] = await action.batchPlay([{
        _obj: 'get',
        _target: [
          { _property: 'boundsNoEffects' },
          { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' },
        ],
      }], { synchronousExecution: true });
      const b = (res && (res.boundsNoEffects || res.bounds)) || null;
      if (!b) return;   // 拿不到 bounds 就保持居中，不强行变换
      const val = (v) => (typeof v === 'object' && v !== null ? v._value : v);
      const curLeft = val(b.left), curTop = val(b.top), curRight = val(b.right), curBottom = val(b.bottom);
      const curW = curRight - curLeft, curH = curBottom - curTop;
      if (!(curW > 0 && curH > 0)) return;
      // 3) 缩放到选区尺寸（按各自比例；返回图与选区同比时 sx≈sy）
      const sx = (bounds.width / curW) * 100;
      const sy = (bounds.height / curH) * 100;
      // transform 的缩放以图层左上角为锚点，缩放后再把左上角平移到选区左上角
      await action.batchPlay([{
        _obj: 'transform',
        _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
        freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSIndependent' },
        offset: { _obj: 'offset', horizontal: { _unit: 'pixelsUnit', _value: 0 }, vertical: { _unit: 'pixelsUnit', _value: 0 } },
        width: { _unit: 'percentUnit', _value: sx },
        height: { _unit: 'percentUnit', _value: sy },
      }], {});
      // 4) 缩放后重读 bounds，把左上角对齐到选区左上角
      const [res2] = await action.batchPlay([{
        _obj: 'get',
        _target: [
          { _property: 'boundsNoEffects' },
          { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' },
        ],
      }], { synchronousExecution: true });
      const b2 = (res2 && (res2.boundsNoEffects || res2.bounds)) || null;
      if (!b2) return;
      const newLeft = val(b2.left), newTop = val(b2.top);
      const dx = bounds.left - newLeft;
      const dy = bounds.top - newTop;
      if (dx !== 0 || dy !== 0) {
        await action.batchPlay([{
          _obj: 'move',
          _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
          to: { _obj: 'offset', horizontal: { _unit: 'pixelsUnit', _value: dx }, vertical: { _unit: 'pixelsUnit', _value: dy } },
        }], {});
      }
    }, { commandName: '置入选区结果' });
  }

  async function openExternal(item) { await shell.openExternal(net.absUrl(item.url)); }

  async function openUrl(url) { await shell.openExternal(url); }

  // 文档开关/切换时回调（用于刷新导出按钮可用性）
  function onDocChange(cb) {
    try { action.addNotificationListener(['open', 'close', 'select', 'newDocument'], cb); }
    catch (e) { /* 部分版本不支持 */ }
  }

  DX.ps = { hasDocument, docSize, placeImage, placeImageAt, exportDocPng, exportActiveLayerPng, exportCurrentPng, exportSelectionPng, exportSelectionTransparent, outpaintDirections, openExternal, openUrl, onDocChange };
})();
