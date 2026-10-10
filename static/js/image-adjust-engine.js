/* ════════════════════════════════════════════════════════════════
 * NOVAI 专业调色 · 渲染引擎（WebGL1，自写着色器，取代 glfx 的调色部分）
 * 管线：大半径模糊（缩小纹理上做可分离高斯）→ 主着色器一遍完成：
 *   降噪 → 白平衡/曝光（线性空间）→ 去朦胧 → 高光/阴影/白色/黑色 → 对比度 → 纹理/清晰度
 *   → 曲线（RGB+分通道 LUT）→ HSL 八色 → 色彩分级（三向+全局）→ 自然饱和度/饱和度
 *   → 锐化 → 柔光/辉光 → 晕影 → 颗粒
 * 预览用降采样纹理；导出用原图全分辨率跑同一套着色器。
 * 对外：window.NovaAdjustEngine = { create(canvas), exportBlob(img, params), neutral(), ... }
 * ════════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    const HUE_CENTERS = [0, 30, 60, 120, 180, 225, 275, 320];
    const HUE_WIDTHS = [30, 30, 45, 60, 52, 48, 45, 42];

    function neutral() {
        return {
            temp: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
            texture: 0, clarity: 0, dehaze: 0, vibrance: 0, saturation: 0,
            curve: { l: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] },
            hsl: { h: [0, 0, 0, 0, 0, 0, 0, 0], s: [0, 0, 0, 0, 0, 0, 0, 0], l: [0, 0, 0, 0, 0, 0, 0, 0] },
            grade: { sh: { h: 0, s: 0, l: 0 }, mid: { h: 0, s: 0, l: 0 }, hi: { h: 0, s: 0, l: 0 }, gl: { h: 0, s: 0, l: 0 }, blend: 50, balance: 0 },
            sharpen: 0, sharpRadius: 10, sharpDetail: 25, sharpMask: 0,
            nrLuma: 0, nrColor: 0,
            vignette: 0, vigMid: 50, vigFeather: 50,
            grain: 0, grainSize: 25, grainRough: 50,
            soft: 0, glow: 0,
            off: {}
        };
    }

    /* 各模块包含的参数（模块「隐藏」时这些参数按中性值渲染） */
    const MODULE_KEYS = {
        basic: ['temp', 'tint', 'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'],
        presence: ['texture', 'clarity', 'dehaze', 'vibrance', 'saturation'],
        curve: ['curve'], hsl: ['hsl'], grade: ['grade'],
        detail: ['sharpen', 'sharpRadius', 'sharpDetail', 'sharpMask', 'nrLuma', 'nrColor'],
        effects: ['vignette', 'vigMid', 'vigFeather', 'grain', 'grainSize', 'grainRough', 'soft', 'glow']
    };

    function effective(p) {
        const n = neutral();
        const out = Object.assign({}, p);
        const off = p.off || {};
        for (const m in MODULE_KEYS) if (off[m]) for (const k of MODULE_KEYS[m]) out[k] = n[k];
        return out;
    }

    /* ── 曲线：单调三次插值（Fritsch–Carlson）→ 256 级 ── */
    function curveTable(points) {
        const pts = (points && points.length >= 2 ? points : [[0, 0], [1, 1]]).slice().sort((a, b) => a[0] - b[0]);
        const n = pts.length, xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        const d = [], m = new Array(n).fill(0);
        for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
        m[0] = d[0]; m[n - 1] = d[n - 2];
        for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
        for (let i = 0; i < n - 1; i++) {
            if (Math.abs(d[i]) < 1e-9) { m[i] = 0; m[i + 1] = 0; continue; }
            const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
            if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
        }
        const out = new Float32Array(256);
        let seg = 0;
        for (let k = 0; k < 256; k++) {
            const x = k / 255;
            if (x <= xs[0]) { out[k] = ys[0]; continue; }
            if (x >= xs[n - 1]) { out[k] = ys[n - 1]; continue; }
            while (seg < n - 2 && x > xs[seg + 1]) seg++;
            const h = xs[seg + 1] - xs[seg], t = (x - xs[seg]) / h, t2 = t * t, t3 = t2 * t;
            out[k] = (2 * t3 - 3 * t2 + 1) * ys[seg] + (t3 - 2 * t2 + t) * h * m[seg] + (-2 * t3 + 3 * t2) * ys[seg + 1] + (t3 - t2) * h * m[seg + 1];
        }
        for (let k = 0; k < 256; k++) out[k] = Math.min(1, Math.max(0, out[k]));
        return out;
    }
    function lutBytes(curve) {
        const L = curveTable(curve.l), R = curveTable(curve.r), G = curveTable(curve.g), B = curveTable(curve.b);
        const look = (t, v) => t[Math.min(255, Math.max(0, Math.round(v * 255)))];
        const buf = new Uint8Array(256 * 4);
        for (let i = 0; i < 256; i++) {
            const l = L[i];
            buf[i * 4] = Math.round(look(R, l) * 255);
            buf[i * 4 + 1] = Math.round(look(G, l) * 255);
            buf[i * 4 + 2] = Math.round(look(B, l) * 255);
            buf[i * 4 + 3] = 255;
        }
        return buf;
    }
    function curveIsIdentity(curve) {
        for (const k of ['l', 'r', 'g', 'b']) {
            const pts = curve[k] || [];
            if (pts.some(p => Math.abs(p[0] - p[1]) > 0.002)) return false;
        }
        return true;
    }

    /* 色轮（色相°, 饱和度 0–100）→ RGB 偏移量（亮度中性） */
    function tintVec(h, s, k) {
        if (!s) return [0, 0, 0];
        const a = (h % 360) / 60, c = 1, x = c * (1 - Math.abs(a % 2 - 1));
        let r = 0, g = 0, b = 0;
        if (a < 1) { r = c; g = x; } else if (a < 2) { r = x; g = c; } else if (a < 3) { g = c; b = x; }
        else if (a < 4) { g = x; b = c; } else if (a < 5) { r = x; b = c; } else { r = c; b = x; }
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const f = (s / 100) * k;
        return [(r - l) * f, (g - l) * f, (b - l) * f];
    }

    const VS = 'attribute vec2 p;varying vec2 uv;void main(){uv=p*0.5+0.5;gl_Position=vec4(p,0.0,1.0);}';
    const FS_COPY = 'precision highp float;varying vec2 uv;uniform sampler2D src;uniform vec2 texel;void main(){vec3 c=texture2D(src,uv+texel*vec2(-0.5,-0.5)).rgb+texture2D(src,uv+texel*vec2(0.5,-0.5)).rgb+texture2D(src,uv+texel*vec2(-0.5,0.5)).rgb+texture2D(src,uv+texel*vec2(0.5,0.5)).rgb;gl_FragColor=vec4(c*0.25,1.0);}';
    const FS_BLUR = 'precision highp float;varying vec2 uv;uniform sampler2D src;uniform vec2 dir;void main(){vec3 c=texture2D(src,uv).rgb*0.2270270270;c+=(texture2D(src,uv+dir*1.3846153846).rgb+texture2D(src,uv-dir*1.3846153846).rgb)*0.3162162162;c+=(texture2D(src,uv+dir*3.2307692308).rgb+texture2D(src,uv-dir*3.2307692308).rgb)*0.0702702703;gl_FragColor=vec4(c,1.0);}';
    const FS_MAIN = `
precision highp float;
varying vec2 uv;
uniform sampler2D src, big, lut;
uniform vec2 texel;
uniform float sr, useLut, aspect, seed, grainScale;
uniform vec3 wb;
uniform float exposure, contrast, highlights, shadows, whites, blacks, texAmt, clarity, dehaze, vibrance, saturation;
uniform float hslH[8], hslS[8], hslL[8], hueC[8], hueW[8];
uniform vec3 gSh, gMid, gHi, gGl;
uniform vec4 gLum;
uniform float gBlend, gBalance;
uniform float sharpen, sharpDetail, sharpMask, nrLuma, nrColor;
uniform vec3 vig, grain;
uniform float soft, glow;
float luma(vec3 c){return dot(c,vec3(0.2126,0.7152,0.0722));}
vec3 rgb2hsl(vec3 c){float mx=max(c.r,max(c.g,c.b)),mn=min(c.r,min(c.g,c.b));float l=(mx+mn)*0.5;float h=0.0,s=0.0;float d=mx-mn;
 if(d>1e-5){s=l>0.5?d/(2.0-mx-mn):d/(mx+mn);if(mx==c.r)h=(c.g-c.b)/d+(c.g<c.b?6.0:0.0);else if(mx==c.g)h=(c.b-c.r)/d+2.0;else h=(c.r-c.g)/d+4.0;h/=6.0;}return vec3(h,s,l);}
float h2r(float p,float q,float t){t=fract(t);if(t<1.0/6.0)return p+(q-p)*6.0*t;if(t<0.5)return q;if(t<2.0/3.0)return p+(q-p)*(2.0/3.0-t)*6.0;return p;}
vec3 hsl2rgb(vec3 h){if(h.y<1e-5)return vec3(h.z);float q=h.z<0.5?h.z*(1.0+h.y):h.z+h.y-h.z*h.y;float p=2.0*h.z-q;return vec3(h2r(p,q,h.x+1.0/3.0),h2r(p,q,h.x),h2r(p,q,h.x-1.0/3.0));}
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
void main(){
 vec3 o=texture2D(src,uv).rgb;
 vec2 t=texel*sr;
 vec3 s=o*0.25+(texture2D(src,uv+vec2(t.x,0)).rgb+texture2D(src,uv-vec2(t.x,0)).rgb+texture2D(src,uv+vec2(0,t.y)).rgb+texture2D(src,uv-vec2(0,t.y)).rgb)*0.125
   +(texture2D(src,uv+t).rgb+texture2D(src,uv-t).rgb+texture2D(src,uv+vec2(t.x,-t.y)).rgb+texture2D(src,uv+vec2(-t.x,t.y)).rgb)*0.0625;
 vec3 bg=texture2D(big,uv).rgb;
 vec3 c=o;
 if(nrLuma>0.0){float e=smoothstep(0.02,0.16,length(o-s));c=mix(c,s,nrLuma*(1.0-e));}
 if(nrColor>0.0){float l=luma(c);vec3 ch=bg-luma(bg);vec3 ch2=s-luma(s);c=mix(c,vec3(l)+mix(ch2,ch,0.5),nrColor);}
 vec3 lin=pow(max(c,0.0),vec3(2.2))*wb*exp2(exposure);
 c=pow(max(lin,0.0),vec3(1.0/2.2));
 if(dehaze>0.0){float hz=min(min(bg.r,bg.g),bg.b);float k=dehaze*0.75*hz;c=(c-k)/max(1.0-k,0.25);c=mix(vec3(luma(c)),c,1.0+dehaze*0.25);}
 else if(dehaze<0.0){c=mix(c,vec3(luma(bg))*0.85+0.15,-dehaze*0.55);}
 float L=luma(c);
 float wS=1.0-smoothstep(0.0,0.55,L),wH=smoothstep(0.45,1.0,L),wB=1.0-smoothstep(0.0,0.3,L),wW=smoothstep(0.7,1.0,L);
 float dL=shadows*0.32*wS+highlights*0.36*wH+blacks*0.18*wB+whites*0.22*wW;
 float L2=max(L+dL,0.0);
 c=mix(c+dL,c*(L2/max(L,1e-4)),smoothstep(0.02,0.12,L));
 c=(c-0.5)*(1.0+contrast*(contrast>0.0?0.7:0.55))+0.5;
 c+=(o-s)*texAmt*2.2;
 float Lc=luma(c),Lb=luma(bg);
 c+=vec3((luma(o)-Lb)*clarity*0.85*(1.0-abs(Lc*2.0-1.0)*0.6));
 c=clamp(c,0.0,1.0);
 if(useLut>0.5){c=vec3(texture2D(lut,vec2(c.r*0.99609375+0.001953125,0.5)).r,texture2D(lut,vec2(c.g*0.99609375+0.001953125,0.5)).g,texture2D(lut,vec2(c.b*0.99609375+0.001953125,0.5)).b);}
 vec3 h=rgb2hsl(c);float hue=h.x*360.0;float dh=0.0,ds=0.0,dl=0.0;
 for(int i=0;i<8;i++){float d=abs(mod(hue-hueC[i]+540.0,360.0)-180.0);float w=clamp(1.0-d/hueW[i],0.0,1.0);w=w*w*(3.0-2.0*w);dh+=hslH[i]*w;ds+=hslS[i]*w;dl+=hslL[i]*w;}
 if(abs(dh)+abs(ds)+abs(dl)>1e-4){float sw=smoothstep(0.02,0.18,h.y);h.x=fract(h.x+dh*sw*30.0/360.0);h.y=clamp(h.y*(1.0+ds*sw),0.0,1.0);h.z=clamp(h.z+dl*0.22*h.y*sw,0.0,1.0);c=hsl2rgb(h);}
 L=luma(c);
 float piv=clamp(0.5+gBalance*0.3,0.15,0.85);float ex=mix(2.2,0.6,gBlend);
 float gs=pow(clamp(1.0-L/piv,0.0,1.0),ex*0.8),gh=pow(clamp((L-piv)/(1.0-piv),0.0,1.0),ex*0.8);float gm=clamp(1.0-gs-gh,0.0,1.0);
 c+=gSh*gs+gMid*gm+gHi*gh+gGl;
 c+=vec3(gLum.x*gs+gLum.y*gm+gLum.z*gh+gLum.w)*0.22;
 L=luma(c);float sat=max(c.r,max(c.g,c.b))-min(c.r,min(c.g,c.b));
 c=mix(vec3(L),c,(1.0+vibrance*(1.0-clamp(sat*1.6,0.0,1.0))*1.1)*(1.0+saturation));
 if(sharpen>0.0){vec3 d=o-s;float m=smoothstep(sharpMask*0.12,sharpMask*0.12+0.03,length(d));c+=d*sharpen*mix(0.9,2.2,sharpDetail)*m;}
 if(soft>0.0){vec3 sc=1.0-(1.0-c)*(1.0-bg*0.9);c=mix(c,mix(sc,bg,0.35),soft*0.55);}
 if(glow>0.0){vec3 hi=max(bg-0.55,0.0)*2.2;c=1.0-(1.0-c)*(1.0-clamp(hi*glow,0.0,1.0));}
 if(vig.x!=0.0){vec2 q=(uv-0.5)*vec2(aspect,1.0);float d=length(q)/(0.5*sqrt(aspect*aspect+1.0));float inner=mix(0.15,0.95,vig.y);float outer=inner+mix(0.08,0.9,vig.z);float w=smoothstep(inner,outer,d);
  if(vig.x<0.0)c*=1.0+vig.x*w*0.92;else c=mix(c,vec3(1.0),vig.x*w*0.8);}
 if(grain.x>0.0){vec2 gp=uv*grainScale/mix(0.7,3.2,grain.y);float n=mix(vnoise(gp+seed),hash(floor(gp)+seed),grain.z);L=luma(c);c+=(n-0.5)*grain.x*0.32*(1.0-abs(L*2.0-1.0)*0.55);}
 gl_FragColor=vec4(clamp(c,0.0,1.0),1.0);
}`;

    function compile(gl, vs, fs) {
        const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader'); return s; };
        const p = gl.createProgram();
        gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
        gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
        const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); const name = info.name.replace(/\[0\]$/, ''); u[name] = gl.getUniformLocation(p, info.name); }
        return { p, u };
    }
    function makeTex(gl, w, h, data) {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        if (data && data.nodeName) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, data);
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data || null);
        return t;
    }
    function makeFbo(gl, w, h) {
        const tex = makeTex(gl, w, h, null);
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return { tex, fb, w, h };
    }

    function create(canvas, opts) {
        opts = opts || {};
        const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false, antialias: false }) || canvas.getContext('experimental-webgl', { preserveDrawingBuffer: true });
        if (!gl) throw new Error('WebGL 不可用');
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        const P = { copy: compile(gl, VS, FS_COPY), blur: compile(gl, VS, FS_BLUR), main: compile(gl, VS, FS_MAIN) };
        const lutTex = makeTex(gl, 256, 1, new Uint8Array(256 * 4));
        gl.bindTexture(gl.TEXTURE_2D, lutTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
        const st = { w: 0, h: 0, srcTex: null, chain: [], blurA: null, blurB: null, lutKey: '', fullW: 0 };

        function quad() { gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); }
        function pass(prog, target, w, h) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
            gl.viewport(0, 0, w, h);
            gl.useProgram(prog.p);
        }
        function freeChain() {
            for (const f of st.chain.concat([st.blurA, st.blurB])) if (f) { gl.deleteTexture(f.tex); gl.deleteFramebuffer(f.fb); }
            st.chain = []; st.blurA = st.blurB = null;
        }

        /* 载入源图：source 为 <img>/<canvas>；maxSide 限制预览分辨率 */
        function setSource(source, maxSide, fullWidth) {
            const nw = source.naturalWidth || source.width, nh = source.naturalHeight || source.height;
            const limit = Math.min(maxSide || nw, maxTex);
            const sc = Math.min(1, limit / Math.max(nw, nh));
            const w = Math.max(1, Math.round(nw * sc)), h = Math.max(1, Math.round(nh * sc));
            let up = source;
            if (sc < 1 || !source.nodeName || source.nodeName === 'IMG') {
                up = document.createElement('canvas'); up.width = w; up.height = h;
                const cx = up.getContext('2d'); cx.imageSmoothingQuality = 'high'; cx.drawImage(source, 0, 0, w, h);
            }
            if (st.srcTex) gl.deleteTexture(st.srcTex);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            st.srcTex = makeTex(gl, w, h, up);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            st.w = w; st.h = h; st.fullW = fullWidth || nw;
            canvas.width = w; canvas.height = h;
            freeChain();
            /* 逐级减半到长边 ≈ 220px，作为大半径模糊的底 */
            let cw = w, ch = h;
            while (Math.max(cw, ch) > 440) { cw = Math.max(1, Math.round(cw / 2)); ch = Math.max(1, Math.round(ch / 2)); st.chain.push(makeFbo(gl, cw, ch)); }
            if (!st.chain.length) st.chain.push(makeFbo(gl, cw, ch));
            const last = st.chain[st.chain.length - 1];
            st.blurA = makeFbo(gl, last.w, last.h); st.blurB = makeFbo(gl, last.w, last.h);
            st.bigDirty = true;
            return { w, h };
        }
        function buildBig() {
            let prevTex = st.srcTex, pw = st.w, ph = st.h;
            for (const f of st.chain) {
                pass(P.copy, f, f.w, f.h);
                gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, prevTex);
                gl.uniform1i(P.copy.u.src, 0); gl.uniform2f(P.copy.u.texel, 1 / pw, 1 / ph); quad();
                prevTex = f.tex; pw = f.w; ph = f.h;
            }
            const last = st.chain[st.chain.length - 1];
            /* 两轮可分离高斯（半径≈长边的 3%） */
            let inTex = last.tex;
            for (let k = 0; k < 2; k++) {
                pass(P.blur, st.blurA, last.w, last.h);
                gl.bindTexture(gl.TEXTURE_2D, inTex); gl.uniform1i(P.blur.u.src, 0); gl.uniform2f(P.blur.u.dir, (1.6 + k) / last.w, 0); quad();
                pass(P.blur, st.blurB, last.w, last.h);
                gl.bindTexture(gl.TEXTURE_2D, st.blurA.tex); gl.uniform2f(P.blur.u.dir, 0, (1.6 + k) / last.h); quad();
                inTex = st.blurB.tex;
            }
            st.bigDirty = false;
        }

        function render(params, target) {
            if (!st.srcTex) return;
            if (st.bigDirty) buildBig();
            const p = effective(params || neutral());
            const curveKey = JSON.stringify(p.curve);
            const useLut = !curveIsIdentity(p.curve);
            if (useLut && curveKey !== st.lutKey) {
                gl.bindTexture(gl.TEXTURE_2D, lutTex);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lutBytes(p.curve));
                st.lutKey = curveKey;
            }
            const m = P.main, u = m.u;
            pass(m, target || null, st.w, st.h);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, st.srcTex); gl.uniform1i(u.src, 0);
            gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, st.blurB.tex); gl.uniform1i(u.big, 1);
            gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, lutTex); gl.uniform1i(u.lut, 2);
            gl.activeTexture(gl.TEXTURE0);
            const scale = st.w / Math.max(1, st.fullW); /* 预览是缩小图：像素级半径按比例缩 */
            gl.uniform2f(u.texel, 1 / st.w, 1 / st.h);
            gl.uniform1f(u.sr, Math.max(0.5, (p.sharpRadius / 10) * Math.max(scale, 0.35)));
            gl.uniform1f(u.useLut, useLut ? 1 : 0);
            gl.uniform1f(u.aspect, st.w / st.h);
            gl.uniform1f(u.seed, (opts.seed || 0.37));
            gl.uniform1f(u.grainScale, st.fullW * (st.w > 0 ? 1 : 1) / 2.2);
            const T = p.temp / 100, Ti = p.tint / 100;
            let wb = [1 + T * 0.32, 1 - Ti * 0.26, 1 - T * 0.32];
            const wl = 0.2126 * wb[0] + 0.7152 * wb[1] + 0.0722 * wb[2]; wb = wb.map(v => v / wl);
            gl.uniform3f(u.wb, wb[0], wb[1], wb[2]);
            gl.uniform1f(u.exposure, p.exposure / 100);
            gl.uniform1f(u.contrast, p.contrast / 100);
            gl.uniform1f(u.highlights, p.highlights / 100);
            gl.uniform1f(u.shadows, p.shadows / 100);
            gl.uniform1f(u.whites, p.whites / 100);
            gl.uniform1f(u.blacks, p.blacks / 100);
            gl.uniform1f(u.texAmt, p.texture / 100);
            gl.uniform1f(u.clarity, p.clarity / 100);
            gl.uniform1f(u.dehaze, p.dehaze / 100);
            gl.uniform1f(u.vibrance, p.vibrance / 100);
            gl.uniform1f(u.saturation, p.saturation / 100);
            gl.uniform1fv(u.hslH, p.hsl.h.map(v => v / 100));
            gl.uniform1fv(u.hslS, p.hsl.s.map(v => v / 100));
            gl.uniform1fv(u.hslL, p.hsl.l.map(v => v / 100));
            gl.uniform1fv(u.hueC, HUE_CENTERS);
            gl.uniform1fv(u.hueW, HUE_WIDTHS);
            const g = p.grade;
            gl.uniform3fv(u.gSh, tintVec(g.sh.h, g.sh.s, 0.3));
            gl.uniform3fv(u.gMid, tintVec(g.mid.h, g.mid.s, 0.26));
            gl.uniform3fv(u.gHi, tintVec(g.hi.h, g.hi.s, 0.26));
            gl.uniform3fv(u.gGl, tintVec(g.gl.h, g.gl.s, 0.18));
            gl.uniform4f(u.gLum, g.sh.l / 100, g.mid.l / 100, g.hi.l / 100, g.gl.l / 100);
            gl.uniform1f(u.gBlend, g.blend / 100);
            gl.uniform1f(u.gBalance, g.balance / 100);
            gl.uniform1f(u.sharpen, p.sharpen / 100);
            gl.uniform1f(u.sharpDetail, p.sharpDetail / 100);
            gl.uniform1f(u.sharpMask, p.sharpMask / 100);
            gl.uniform1f(u.nrLuma, p.nrLuma / 100);
            gl.uniform1f(u.nrColor, p.nrColor / 100);
            gl.uniform3f(u.vig, p.vignette / 100, p.vigMid / 100, p.vigFeather / 100);
            gl.uniform3f(u.grain, p.grain / 100, p.grainSize / 100, p.grainRough / 100);
            gl.uniform1f(u.soft, p.soft / 100);
            gl.uniform1f(u.glow, p.glow / 100);
            quad();
        }

        /* 直方图：从当前画布缩读（≤256 宽）；hover 取色也用这份数据 */
        const probe = document.createElement('canvas');
        let probeData = null;
        function analyze() {
            const pw = Math.min(256, st.w), ph = Math.max(1, Math.round(st.h * pw / st.w));
            probe.width = pw; probe.height = ph;
            const cx = probe.getContext('2d', { willReadFrequently: true });
            cx.drawImage(canvas, 0, 0, pw, ph);
            const d = cx.getImageData(0, 0, pw, ph).data;
            probeData = { d, w: pw, h: ph };
            const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
            let hi = 0, lo = 0;
            for (let i = 0; i < d.length; i += 4) {
                r[d[i]]++; g[d[i + 1]]++; b[d[i + 2]]++;
                l[Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])]++;
                if (d[i] >= 254 || d[i + 1] >= 254 || d[i + 2] >= 254) hi++;
                if (d[i] <= 1 && d[i + 1] <= 1 && d[i + 2] <= 1) lo++;
            }
            const n = d.length / 4;
            return { r, g, b, l, clipHi: hi / n > 0.004, clipLo: lo / n > 0.004 };
        }
        function sample(fx, fy) {
            if (!probeData) return null;
            const x = Math.min(probeData.w - 1, Math.max(0, Math.floor(fx * probeData.w)));
            const y = Math.min(probeData.h - 1, Math.max(0, Math.floor(fy * probeData.h)));
            const i = (y * probeData.w + x) * 4, d = probeData.d;
            return [d[i], d[i + 1], d[i + 2]];
        }
        function dispose() {
            freeChain();
            if (st.srcTex) gl.deleteTexture(st.srcTex);
            gl.deleteTexture(lutTex);
            const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext();
        }
        return { gl, setSource, render, analyze, sample, dispose, size: () => ({ w: st.w, h: st.h }), maxTex };
    }

    /* 全分辨率导出：同一套着色器跑原图尺寸 */
    async function exportBlob(img, params) {
        const cv = document.createElement('canvas');
        const eng = create(cv);
        try {
            const nw = img.naturalWidth || img.width, nh = img.naturalHeight || img.height;
            eng.setSource(img, Math.min(eng.maxTex, 8192), nw);
            eng.render(params);
            return await new Promise(res => cv.toBlob(res, 'image/png'));
        } finally { eng.dispose(); }
    }

    /* 自动校色：灰世界白平衡 + 自动色阶（基于原图统计） */
    function autoParams(img) {
        const c = document.createElement('canvas');
        const w = 200, h = Math.max(1, Math.round(200 * (img.naturalHeight || img.height) / (img.naturalWidth || img.width)));
        c.width = w; c.height = h;
        const cx = c.getContext('2d', { willReadFrequently: true }); cx.drawImage(img, 0, 0, w, h);
        const d = cx.getImageData(0, 0, w, h).data;
        let sr = 0, sg = 0, sb = 0, n = 0; const hist = new Uint32Array(256);
        for (let i = 0; i < d.length; i += 4) {
            const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
            hist[Math.round(l)]++;
            if (l > 30 && l < 225) { sr += d[i]; sg += d[i + 1]; sb += d[i + 2]; n++; }
        }
        const tot = d.length / 4;
        const pct = q => { let acc = 0; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= tot * q) return i; } return 255; };
        const lo = pct(0.005), hi = pct(0.995), mid = pct(0.5);
        const out = {};
        if (n > 50) {
            sr /= n; sg /= n; sb /= n;
            const temp = Math.round(Math.max(-60, Math.min(60, ((sb - sr) / Math.max(1, (sr + sb) / 2)) * 160)));
            const tint = Math.round(Math.max(-50, Math.min(50, ((sg - (sr + sb) / 2) / Math.max(1, sg)) * 180)));
            out.temp = temp; out.tint = tint;
        }
        out.exposure = Math.round(Math.max(-150, Math.min(150, Math.log2(118 / Math.max(8, mid)) * 60)));
        out.whites = Math.round(Math.max(-40, Math.min(60, (250 - hi) * 0.9)));
        out.blacks = Math.round(Math.max(-60, Math.min(40, -(lo - 4) * 1.2)));
        out.contrast = Math.round(Math.max(0, Math.min(30, (200 - (hi - lo)) * 0.2)));
        out.vibrance = 10;
        return out;
    }

    /* 吸管白平衡：让点到的颜色变中性 */
    function wbFromSample(rgb) {
        const [r, g, b] = rgb.map(v => Math.max(1, v));
        const temp = Math.round(Math.max(-100, Math.min(100, ((b - r) / ((r + b) / 2)) * 150)));
        const tint = Math.round(Math.max(-100, Math.min(100, ((g - (r + b) / 2) / g) * 190)));
        return { temp, tint };
    }

    function hueBandOf(rgb) {
        const [r, g, b] = rgb.map(v => v / 255);
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
        if (d < 0.04) return -1;
        let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
        h *= 60;
        let best = 0, bd = 999;
        HUE_CENTERS.forEach((c, i) => { const dd = Math.abs(((h - c + 540) % 360) - 180); if (dd < bd) { bd = dd; best = i; } });
        return best;
    }

    window.NovaAdjustEngine = { create, exportBlob, neutral, effective, autoParams, wbFromSample, hueBandOf, curveTable, MODULE_KEYS, HUE_CENTERS };
})();
