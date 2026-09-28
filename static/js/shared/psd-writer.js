/* ══ NovaPsd：最小 PSD(Photoshop 8BPS) 写入器 ══════════════════════════════════
   只做我们导出要用的那点事：分层 RGB + alpha、图层名（中文走 luni 块）、可选图层组。
   不引入任何构建依赖、不联网。所有多字节字段都是大端。

   用法：
     const blob = NovaPsd.write({
         width, height,
         layers: [{name, canvas}]      // canvas 尺寸 = 图层尺寸，(left, top) 是图层左上角（默认 0,0）
     });
   图层顺序：数组第 0 个是 PSD 里最下面那层（Photoshop 的显示顺序与数组一致）。
   ───────────────────────────────────────────────────────────────────────── */
(function(){
    'use strict';
    /* 直接往数组里推字节，长度靠占位回填；所有方法都返回 api 以便链式调用 */
    function ByteBuffer(){
        /* 字节先写进一块会自动翻倍的 Uint8Array：像素级通道数据动辄上亿字节，
           早先那种「一个字节 push 进普通数组」的写法在 4 亿个元素处会直接 RangeError: Invalid array length。 */
        let buf = new Uint8Array(1 << 16);
        let len = 0;
        const ensure = (n) => {
            if(len + n <= buf.length) return;
            let size = buf.length;
            while(size < len + n) size *= 2;
            const next = new Uint8Array(size);
            next.set(buf.subarray(0, len));
            buf = next;
        };
        const push = (arr) => { ensure(arr.length); buf.set(arr, len); len += arr.length; };
        const api = {
            get out(){ return {length:len}; },
            bytes(arr){ push(arr); return api; },
            u8(v){ ensure(1); buf[len++] = v & 0xff; return api; },
            u16(v){ ensure(2); buf[len++] = (v >> 8) & 0xff; buf[len++] = v & 0xff; return api; },
            u32(v){ ensure(4); buf[len++] = (v >>> 24) & 0xff; buf[len++] = (v >>> 16) & 0xff; buf[len++] = (v >>> 8) & 0xff; buf[len++] = v & 0xff; return api; },
            i16(v){ return api.u16(v < 0 ? v + 0x10000 : v); },
            i32(v){ return api.u32(v < 0 ? v + 0x100000000 : v); },
            ascii(text){ push(new TextEncoder().encode(String(text))); return api; },
            /* Pascal 串：1 字节长度 + 内容，整体补齐到 4 的倍数 */
            pascal(text){
                const bytes = new TextEncoder().encode(String(text)).slice(0, 255);
                api.u8(bytes.length);
                push(bytes);
                let pad = 4 - ((bytes.length + 1) % 4);
                if(pad === 4) pad = 0;
                while(pad--) api.u8(0);
                return api;
            },
            /* UTF-16BE 字符串（luni 用）：先写 4 字节字符数，再写 UTF-16BE */
            unicode(text){
                const chars = Array.from(String(text));
                const encoded = [];
                chars.forEach(ch => {
                    const code = ch.codePointAt(0);
                    if(code > 0xffff){
                        const high = 0xd800 + ((code - 0x10000) >> 10);
                        const low = 0xdc00 + ((code - 0x10000) & 0x3ff);
                        encoded.push((high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff);
                    } else {
                        encoded.push((code >> 8) & 0xff, code & 0xff);
                    }
                });
                api.u32(encoded.length >> 1);
                push(encoded);
                return api;
            },
            mark(){ return len; },
            patchU32(offset, value){
                buf[offset] = (value >>> 24) & 0xff;
                buf[offset + 1] = (value >>> 16) & 0xff;
                buf[offset + 2] = (value >>> 8) & 0xff;
                buf[offset + 3] = value & 0xff;
                return api;
            },
            blob(){ return new Blob([buf.subarray(0, len)], {type: 'image/vnd.adobe.photoshop'}); }
        };
        return api;
    }
    function layerChannels(layer){
        const canvas = layer.canvas;
        const ctx = canvas.getContext('2d');
        const {width, height} = canvas;
        const data = ctx.getImageData(0, 0, width, height).data;
        const n = width * height;
        const r = new Uint8Array(n), g = new Uint8Array(n), b = new Uint8Array(n), a = new Uint8Array(n);
        for(let i = 0; i < n; i++){
            r[i] = data[i * 4];
            g[i] = data[i * 4 + 1];
            b[i] = data[i * 4 + 2];
            a[i] = data[i * 4 + 3];
        }
        return {r, g, b, a, width, height};
    }
    function writeLayer(buf, layer){
        const canvas = layer.canvas;
        const left = Math.round(layer.left || 0);
        const top = Math.round(layer.top || 0);
        const width = canvas.width;
        const height = canvas.height;
        const ch = layerChannels(layer);
        buf.i32(top).i32(left).i32(top + height).i32(left + width);
        buf.u16(4);
        /* 通道顺序：-1(alpha) 0(R) 1(G) 2(B)；每段先写 2 字节压缩方式(0=raw) */
        const channelIds = [-1, 0, 1, 2];
        const channelData = [ch.a, ch.r, ch.g, ch.b];
        channelIds.forEach((id, i) => {
            buf.i16(id).u32(2 + channelData[i].length);
        });
        buf.ascii('8BIM').ascii('norm');
        buf.u8(255).u8(0).u8(0).u8(0);   /* opacity / clipping / flags / filler */
        const extraMark = buf.mark();
        buf.u32(0);                       /* extra length 占位 */
        buf.u32(0);                       /* layer mask data length */
        buf.u32(0);                       /* blending ranges length */
        buf.pascal(layer.name || 'Layer');
        /* luni：Unicode 图层名（中文名靠它才读得对）
           结构 = '8BIM' + 'luni' + 长度(4) + [字符数(4) + UTF-16BE]，长度字段必须显式占位后再回填 */
        const luniMark = buf.mark();
        buf.ascii('8BIM').ascii('luni');
        const luniLenMark = buf.mark();
        buf.u32(0);
        buf.unicode(layer.name || 'Layer');
        buf.patchU32(luniLenMark, buf.out.length - luniLenMark - 4);
        while((buf.out.length - luniMark) % 4 !== 0) buf.u8(0);
        buf.patchU32(extraMark, buf.out.length - extraMark - 4);
        return channelData;
    }
    /* 通道数据必须排在「所有图层记录」之后（PSD 规范：layer records → channel image data），
       边写记录边写通道数据的话，解析器读到第二条记录就会跑偏。 */
    function writeLayerChannels(buf, channelData){
        channelData.forEach(data => {
            buf.u16(0);                    /* compression = raw */
            buf.bytes(data);
        });
    }
    function write(options){
        const width = Math.max(1, Math.round(options.width));
        const height = Math.max(1, Math.round(options.height));
        const layers = (options.layers || []).filter(layer => layer && layer.canvas);
        if(!layers.length) return null;
        const buf = ByteBuffer();
        /* 文件头 */
        buf.ascii('8BPS').u16(1);
        for(let i = 0; i < 6; i++) buf.u8(0);
        buf.u16(4).u32(height).u32(width).u16(8).u16(3);
        buf.u32(0);                        /* color mode data */
        buf.u32(0);                        /* image resources */
        /* Layer and Mask Info */
        const layerMaskMark = buf.mark();
        buf.u32(0);
        const layerInfoMark = buf.mark();
        buf.u32(0);
        buf.i16(layers.length);
        const channelSets = layers.map(layer => writeLayer(buf, layer));
        channelSets.forEach(set => writeLayerChannels(buf, set));
        const layerInfoLen = buf.out.length - layerInfoMark - 4;
        buf.patchU32(layerInfoMark, layerInfoLen);
        buf.u32(0);                        /* global layer mask info */
        const unifiedLen = buf.out.length - layerMaskMark - 4;
        buf.patchU32(layerMaskMark, unifiedLen);
        /* 合成预览（Image Data）：把各层按顺序叠一遍 */
        let merged = null;
        if(options.mergedCanvas){
            merged = options.mergedCanvas;
        } else {
            merged = document.createElement('canvas');
            merged.width = width;
            merged.height = height;
            const mctx = merged.getContext('2d');
            layers.forEach(layer => mctx.drawImage(layer.canvas, Math.round(layer.left || 0), Math.round(layer.top || 0)));
        }
        const mctx = merged.getContext('2d');
        const mergedData = mctx.getImageData(0, 0, width, height).data;
        buf.u16(0);                        /* compression = raw */
        const n = width * height;
        [0, 1, 2, 3].forEach(offset => {
            const plane = new Uint8Array(n);
            for(let i = 0; i < n; i++) plane[i] = mergedData[i * 4 + offset];
            buf.bytes(plane);
        });
        return buf.blob();
    }
    window.NovaPsd = {write, version: 1};
})();
