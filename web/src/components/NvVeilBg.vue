<script setup>
/*
 * 首页动态背景「原版光幕」——跟随深浅色主题。
 * 浅色：白底上的淡灰光幕；深色：黑底上的灰色光幕。无噪点、无扫描线。
 *
 * 着色器来自 React Bits 的 DarkVeil 组件（SpectraNoise 使用的同一段动画）：
 *   https://github.com/DavidHDev/react-bits  © David Haz
 *   Licensed under MIT + Commons Clause —— 可作为产品的一部分使用，
 *   不得将该组件单独再分发或出售；本版权声明须保留。
 * 本项目的改动：噪点固定为 0；加入彩色程度（此处为 0，黑白）与浅色主题映射。
 */
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';

/* hold：前台要让出 GPU 时（比如首页鼠标停在输入框上）暂停绘制，不再排新的 rAF */
const props = defineProps({ hold: { type: Boolean, default: false } });

/* 用户在预览里定下的参数 */
const SETTINGS = { hue: 180, sat: 0, warp: 0, scan: 0, speed: 1.0 };
const RES_SCALE = 0.5;   // 渲染分辨率 = CSS 像素 × 0.5
const FRAME_MS = 1000 / 30;

const FRAG = "\n#ifdef GL_ES\nprecision lowp float;\n#endif\nuniform vec2 uResolution;\nuniform float uTime;\nuniform float uHueShift;\nuniform float uNoise;\nuniform float uScan;\nuniform float uScanFreq;\nuniform float uWarp;\nuniform float uSat;\nuniform float uLight;\n#define iTime uTime\n#define iResolution uResolution\n\nvec4 buf[8];\nfloat rand(vec2 c){return fract(sin(dot(c,vec2(12.9898,78.233)))*43758.5453);}\n\nmat3 rgb2yiq=mat3(0.299,0.587,0.114,0.596,-0.274,-0.322,0.211,-0.523,0.312);\nmat3 yiq2rgb=mat3(1.0,0.956,0.621,1.0,-0.272,-0.647,1.0,-1.106,1.703);\n\nvec3 hueShiftRGB(vec3 col,float deg){\n    vec3 yiq=rgb2yiq*col;\n    float rad=radians(deg);\n    float cosh=cos(rad),sinh=sin(rad);\n    vec3 yiqShift=vec3(yiq.x,yiq.y*cosh-yiq.z*sinh,yiq.y*sinh+yiq.z*cosh);\n    return clamp(yiq2rgb*yiqShift,0.0,1.0);\n}\n\nvec4 sigmoid(vec4 x){return 1./(1.+exp(-x));}\n\nvec4 cppn_fn(vec2 coordinate,float in0,float in1,float in2){\n    buf[6]=vec4(coordinate.x,coordinate.y,0.3948333106474662+in0,0.36+in1);\n    buf[7]=vec4(0.14+in2,sqrt(coordinate.x*coordinate.x+coordinate.y*coordinate.y),0.,0.);\n    buf[0]=mat4(vec4(6.5404263,-3.6126034,0.7590882,-1.13613),vec4(2.4582713,3.1660357,1.2219609,0.06276096),vec4(-5.478085,-6.159632,1.8701609,-4.7742867),vec4(6.039214,-5.542865,-0.90925294,3.251348))*buf[6]+mat4(vec4(0.8473259,-5.722911,3.975766,1.6522468),vec4(-0.24321538,0.5839259,-1.7661959,-5.350116),vec4(0.,0.,0.,0.),vec4(0.,0.,0.,0.))*buf[7]+vec4(0.21808943,1.1243913,-1.7969975,5.0294676);\n    buf[1]=mat4(vec4(-3.3522482,-6.0612736,0.55641043,-4.4719114),vec4(0.8631464,1.7432913,5.643898,1.6106541),vec4(2.4941394,-3.5012043,1.7184316,6.357333),vec4(3.310376,8.209261,1.1355612,-1.165539))*buf[6]+mat4(vec4(5.24046,-13.034365,0.009859298,15.870829),vec4(2.987511,3.129433,-0.89023495,-1.6822904),vec4(0.,0.,0.,0.),vec4(0.,0.,0.,0.))*buf[7]+vec4(-5.9457836,-6.573602,-0.8812491,1.5436668);\n    buf[0]=sigmoid(buf[0]);buf[1]=sigmoid(buf[1]);\n    buf[2]=mat4(vec4(-15.219568,8.095543,-2.429353,-1.9381982),vec4(-5.951362,4.3115187,2.6393783,1.274315),vec4(-7.3145227,6.7297835,5.2473326,5.9411426),vec4(5.0796127,8.979051,-1.7278991,-1.158976))*buf[6]+mat4(vec4(-11.967154,-11.608155,6.1486754,11.237008),vec4(2.124141,-6.263192,-1.7050359,-0.7021966),vec4(0.,0.,0.,0.),vec4(0.,0.,0.,0.))*buf[7]+vec4(-4.17164,-3.2281182,-4.576417,-3.6401186);\n    buf[3]=mat4(vec4(3.1832156,-13.738922,1.879223,3.233465),vec4(0.64300746,12.768129,1.9141049,0.50990224),vec4(-0.049295485,4.4807224,1.4733979,1.801449),vec4(5.0039253,13.000481,3.3991797,-4.5561905))*buf[6]+mat4(vec4(-0.1285731,7.720628,-3.1425676,4.742367),vec4(0.6393625,3.714393,-0.8108378,-0.39174938),vec4(0.,0.,0.,0.),vec4(0.,0.,0.,0.))*buf[7]+vec4(-1.1811101,-21.621881,0.7851888,1.2329718);\n    buf[2]=sigmoid(buf[2]);buf[3]=sigmoid(buf[3]);\n    buf[4]=mat4(vec4(5.214916,-7.183024,2.7228765,2.6592617),vec4(-5.601878,-25.3591,4.067988,0.4602802),vec4(-10.57759,24.286327,21.102104,37.546658),vec4(4.3024497,-1.9625226,2.3458803,-1.372816))*buf[0]+mat4(vec4(-17.6526,-10.507558,2.2587414,12.462782),vec4(6.265566,-502.75443,-12.642513,0.9112289),vec4(-10.983244,20.741234,-9.701768,-0.7635988),vec4(5.383626,1.4819539,-4.1911616,-4.8444734))*buf[1]+mat4(vec4(12.785233,-16.345072,-0.39901125,1.7955981),vec4(-30.48365,-1.8345358,1.4542528,-1.1118771),vec4(19.872723,-7.337935,-42.941723,-98.52709),vec4(8.337645,-2.7312303,-2.2927687,-36.142323))*buf[2]+mat4(vec4(-16.298317,3.5471997,-0.44300047,-9.444417),vec4(57.5077,-35.609753,16.163465,-4.1534753),vec4(-0.07470326,-3.8656476,-7.0901804,3.1523974),vec4(-12.559385,-7.077619,1.490437,-0.8211543))*buf[3]+vec4(-7.67914,15.927437,1.3207729,-1.6686112);\n    buf[5]=mat4(vec4(-1.4109162,-0.372762,-3.770383,-21.367174),vec4(-6.2103205,-9.35908,0.92529047,8.82561),vec4(11.460242,-22.348068,13.625772,-18.693201),vec4(-0.3429052,-3.9905605,-2.4626114,-0.45033523))*buf[0]+mat4(vec4(7.3481627,-4.3661838,-6.3037653,-3.868115),vec4(1.5462853,6.5488915,1.9701879,-0.58291394),vec4(6.5858274,-2.2180402,3.7127688,-1.3730392),vec4(-5.7973905,10.134961,-2.3395722,-5.965605))*buf[1]+mat4(vec4(-2.5132585,-6.6685553,-1.4029363,-0.16285264),vec4(-0.37908727,0.53738135,4.389061,-1.3024765),vec4(-0.70647055,2.0111287,-5.1659346,-3.728635),vec4(-13.562562,10.487719,-0.9173751,-2.6487076))*buf[2]+mat4(vec4(-8.645013,6.5546675,-6.3944063,-5.5933375),vec4(-0.57783127,-1.077275,36.91025,5.736769),vec4(14.283112,3.7146652,7.1452246,-4.5958776),vec4(2.7192075,3.6021907,-4.366337,-2.3653464))*buf[3]+vec4(-5.9000807,-4.329569,1.2427121,8.59503);\n    buf[4]=sigmoid(buf[4]);buf[5]=sigmoid(buf[5]);\n    buf[6]=mat4(vec4(-1.61102,0.7970257,1.4675229,0.20917463),vec4(-28.793737,-7.1390953,1.5025433,4.656581),vec4(-10.94861,39.66238,0.74318546,-10.095605),vec4(-0.7229728,-1.5483948,0.7301322,2.1687684))*buf[0]+mat4(vec4(3.2547753,21.489103,-1.0194173,-3.3100595),vec4(-3.7316632,-3.3792162,-7.223193,-0.23685838),vec4(13.1804495,0.7916005,5.338587,5.687114),vec4(-4.167605,-17.798311,-6.815736,-1.6451967))*buf[1]+mat4(vec4(0.604885,-7.800309,-7.213122,-2.741014),vec4(-3.522382,-0.12359311,-0.5258442,0.43852118),vec4(9.6752825,-22.853785,2.062431,0.099892326),vec4(-4.3196306,-17.730087,2.5184598,5.30267))*buf[2]+mat4(vec4(-6.545563,-15.790176,-6.0438633,-5.415399),vec4(-43.591583,28.551912,-16.00161,18.84728),vec4(4.212382,8.394307,3.0958717,8.657522),vec4(-5.0237565,-4.450633,-4.4768,-5.5010443))*buf[3]+mat4(vec4(1.6985557,-67.05806,6.897715,1.9004834),vec4(1.8680354,2.3915145,2.5231109,4.081538),vec4(11.158006,1.7294737,2.0738268,7.386411),vec4(-4.256034,-306.24686,8.258898,-17.132736))*buf[4]+mat4(vec4(1.6889864,-4.5852966,3.8534803,-6.3482175),vec4(1.3543309,-1.2640043,9.932754,2.9079645),vec4(-5.2770967,0.07150358,-0.13962056,3.3269649),vec4(28.34703,-4.918278,6.1044083,4.085355))*buf[5]+vec4(6.6818056,12.522166,-3.7075126,-4.104386);\n    buf[7]=mat4(vec4(-8.265602,-4.7027016,5.098234,0.7509808),vec4(8.6507845,-17.15949,16.51939,-8.884479),vec4(-4.036479,-2.3946867,-2.6055532,-1.9866527),vec4(-2.2167742,-1.8135649,-5.9759874,4.8846445))*buf[0]+mat4(vec4(6.7790847,3.5076547,-2.8191125,-2.7028968),vec4(-5.743024,-0.27844876,1.4958696,-5.0517144),vec4(13.122226,15.735168,-2.9397483,-4.101023),vec4(-14.375265,-5.030483,-6.2599335,2.9848232))*buf[1]+mat4(vec4(4.0950394,-0.94011575,-5.674733,4.755022),vec4(4.3809423,4.8310084,1.7425908,-3.437416),vec4(2.117492,0.16342592,-104.56341,16.949184),vec4(-5.22543,-2.994248,3.8350096,-1.9364246))*buf[2]+mat4(vec4(-5.900337,1.7946124,-13.604192,-3.8060522),vec4(6.6583457,31.911177,25.164474,91.81147),vec4(11.840538,4.1503043,-0.7314397,6.768467),vec4(-6.3967767,4.034772,6.1714606,-0.32874924))*buf[3]+mat4(vec4(3.4992442,-196.91893,-8.923708,2.8142626),vec4(3.4806502,-3.1846354,5.1725626,5.1804223),vec4(-2.4009497,15.585794,1.2863957,2.0252278),vec4(-71.25271,-62.441242,-8.138444,0.50670296))*buf[4]+mat4(vec4(-12.291733,-11.176166,-7.3474145,4.390294),vec4(10.805477,5.6337385,-0.9385842,-4.7348723),vec4(-12.869276,-7.039391,5.3029537,7.5436664),vec4(1.4593618,8.91898,3.5101583,5.840625))*buf[5]+vec4(2.2415268,-6.705987,-0.98861027,-2.117676);\n    buf[6]=sigmoid(buf[6]);buf[7]=sigmoid(buf[7]);\n    buf[0]=mat4(vec4(1.6794263,1.3817469,2.9625452,0.),vec4(-1.8834411,-1.4806935,-3.5924516,0.),vec4(-1.3279216,-1.0918057,-2.3124623,0.),vec4(0.2662234,0.23235129,0.44178495,0.))*buf[0]+mat4(vec4(-0.6299101,-0.5945583,-0.9125601,0.),vec4(0.17828953,0.18300213,0.18182953,0.),vec4(-2.96544,-2.5819945,-4.9001055,0.),vec4(1.4195864,1.1868085,2.5176322,0.))*buf[1]+mat4(vec4(-1.2584374,-1.0552157,-2.1688404,0.),vec4(-0.7200217,-0.52666044,-1.438251,0.),vec4(0.15345335,0.15196142,0.272854,0.),vec4(0.945728,0.8861938,1.2766753,0.))*buf[2]+mat4(vec4(-2.4218085,-1.968602,-4.35166,0.),vec4(-22.683098,-18.0544,-41.954372,0.),vec4(0.63792,0.5470648,1.1078634,0.),vec4(-1.5489894,-1.3075932,-2.6444845,0.))*buf[3]+mat4(vec4(-0.49252132,-0.39877754,-0.91366625,0.),vec4(0.95609266,0.7923952,1.640221,0.),vec4(0.30616966,0.15693925,0.8639857,0.),vec4(1.1825981,0.94504964,2.176963,0.))*buf[4]+mat4(vec4(0.35446745,0.3293795,0.59547555,0.),vec4(-0.58784515,-0.48177817,-1.0614829,0.),vec4(2.5271258,1.9991658,4.6846647,0.),vec4(0.13042648,0.08864098,0.30187556,0.))*buf[5]+mat4(vec4(-1.7718065,-1.4033192,-3.3355875,0.),vec4(3.1664357,2.638297,5.378702,0.),vec4(-3.1724713,-2.6107926,-5.549295,0.),vec4(-2.851368,-2.249092,-5.3013067,0.))*buf[6]+mat4(vec4(1.5203838,1.2212278,2.8404984,0.),vec4(1.5210563,1.2651345,2.683903,0.),vec4(2.9789467,2.4364579,5.2347264,0.),vec4(2.2270417,1.8825914,3.8028636,0.))*buf[7]+vec4(-1.5468478,-3.6171484,0.24762098,0.);\n    buf[0]=sigmoid(buf[0]);\n    return vec4(buf[0].x,buf[0].y,buf[0].z,1.);\n}\n\nvoid mainImage(out vec4 fragColor,in vec2 fragCoord){\n    vec2 uv=fragCoord/uResolution.xy*2.-1.;\n    uv.y*=-1.;\n    uv+=uWarp*vec2(sin(uv.y*6.283+uTime*0.5),cos(uv.x*6.283+uTime*0.5))*0.05;\n    fragColor=cppn_fn(uv,0.1*sin(0.3*uTime),0.1*sin(0.69*uTime),0.1*sin(0.44*uTime));\n}\n\nvoid main(){\n    vec4 col;mainImage(col,gl_FragCoord.xy);\n    col.rgb=hueShiftRGB(col.rgb,uHueShift);\n    /* NOVAI \u540e\u5904\u7406\uff1a\u5f69\u8272\u7a0b\u5ea6\uff080 = \u9ed1\u767d\uff09*/\n    float L=dot(col.rgb,vec3(0.299,0.587,0.114));\n    col.rgb=mix(vec3(L),col.rgb,uSat);\n    float scanline_val=sin(gl_FragCoord.y*uScanFreq)*0.5+0.5;\n    col.rgb*=1.-(scanline_val*scanline_val)*uScan;\n    /* NOVAI \u540e\u5904\u7406\uff1a\u6d45\u8272\u4e3b\u9898\u2014\u2014\u767d\u5e95\u4e0a\u900f\u51fa\u6de1\u6de1\u7684\u5149\u5e55\uff08\u4eae\u7684\u5730\u65b9\u67d3\u8272\uff0c\u6697\u7684\u5730\u65b9\u7559\u767d\uff09*/\n    if(uLight>0.5){\n        float m=max(max(col.r,col.g),col.b);\n        float g=smoothstep(0.0,0.85,m);\n        col.rgb=mix(vec3(0.98),vec3(0.80),g);\n    }else{\n        col.rgb=max(col.rgb,vec3(0.039)); /* \u6df1\u8272\u5e95\u548c --bg #0a0a0a \u5bf9\u9f50 */\n    }\n    gl_FragColor=vec4(clamp(col.rgb,0.0,1.0),1.0);\n}\n";
const VERT = 'attribute vec2 position;void main(){gl_Position=vec4(position,0.0,1.0);}';

const el = ref(null);
let gl = null, prog = null, u = {}, raf = 0, visible = false, t0 = 0, last = 0, acc = 0;
let ro = null, io = null, mo = null;
const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const isDark = () => document.documentElement.classList.contains('theme-dark') || document.documentElement.dataset.theme === 'dark';

function resize() {
    const c = el.value; if (!c || !gl) return;
    /* 光幕本身很柔，按 CSS 像素的一半渲染再拉伸，看不出差别；
       原来按 2 倍屏全分辨率跑，每帧要算 16 倍的像素，再加上标题栏/输入框/卡片的磨砂都要跟着重模糊，
       整页掉帧，导航切换的胶囊动画也跟着卡 */
    /* 首页被 v-show 藏起来时尺寸变成 0：别把画布缩成 1×1（回到首页又要整块重新分配、同步重画，
       实测切页时卡 50~60ms），保持原尺寸不动 */
    if (!c.clientWidth || !c.clientHeight) return;
    const r = RES_SCALE;
    const w = Math.max(1, Math.round(c.clientWidth * r)), h = Math.max(1, Math.round(c.clientHeight * r));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; gl.viewport(0, 0, w, h); }
    /* 不在 ResizeObserver 回调里同步画（会把 GPU 等待算进切页那一帧），放到下一帧 */
    if (!raf && !props.hold) raf = requestAnimationFrame(draw);
}
function draw(now) {
    raf = 0; if (!prog) return;
    /* 限 30 帧：背景动得很慢，30 帧肉眼一样顺，GPU 和磨砂重绘的开销减半，留给前景交互 */
    if (last && now - last < FRAME_MS - 2 && visible && !reduce && !document.hidden) { raf = requestAnimationFrame(draw); return; }
    const c = el.value;
    if (last) acc += Math.min(now - last, 100);   // 隐藏/切页回来时不跳帧
    last = now;
    gl.uniform2f(u.uResolution, c.width, c.height);
    gl.uniform1f(u.uTime, (acc / 1000) * SETTINGS.speed);
    gl.uniform1f(u.uHueShift, SETTINGS.hue); gl.uniform1f(u.uNoise, 0);
    gl.uniform1f(u.uScan, SETTINGS.scan); gl.uniform1f(u.uScanFreq, 0); gl.uniform1f(u.uWarp, SETTINGS.warp);
    gl.uniform1f(u.uSat, SETTINGS.sat); gl.uniform1f(u.uLight, isDark() ? 0 : 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (visible && !reduce && !document.hidden && !busy && !props.hold) raf = requestAnimationFrame(draw);
}
function start() { if (!raf && prog && !busy && !props.hold) { last = 0; raf = requestAnimationFrame(draw); } }
/* 导航胶囊等前景动画进行时暂停（见 GooeyNav 的 nv-motion-busy），结束后自动继续 */
let busy = false, busyTimer = 0;
function onBusy(e) {
    const ms = Math.min(2000, Number(e && e.detail && e.detail.ms) || 500);
    busy = true; stop();
    clearTimeout(busyTimer);
    busyTimer = setTimeout(() => { busy = false; if (visible && !document.hidden) start(); }, ms);
}
function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }
const onVis = () => (document.hidden ? stop() : visible && start());
watch(() => props.hold, (v) => {
    if (v) stop();
    else if (visible && !document.hidden && !busy) start();
});

onMounted(() => {
    const c = el.value;
    gl = c.getContext('webgl', { antialias: false, premultipliedAlpha: false, alpha: false });
    if (!gl) return;   // 不支持 WebGL 时保持原来的纯色背景
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn('[NvVeilBg]', gl.getProgramInfoLog(prog)); prog = null; return; }
    gl.useProgram(prog);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'position'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    ['uResolution', 'uTime', 'uHueShift', 'uNoise', 'uScan', 'uScanFreq', 'uWarp', 'uSat', 'uLight'].forEach((k) => (u[k] = gl.getUniformLocation(prog, k)));
    c.classList.add('on');
    ro = new ResizeObserver(resize); ro.observe(c);
    /* 首页用 v-show 隐藏时停掉动画，回到首页再继续 */
    io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; visible ? start() : stop(); });
    io.observe(c);
    /* 切换深浅色时立刻重画（动画关闭时也要更新） */
    mo = new MutationObserver(() => { if (!raf && !props.hold) raf = requestAnimationFrame(draw); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('nv-motion-busy', onBusy);
    resize();
});
onBeforeUnmount(() => {
    stop(); ro?.disconnect(); io?.disconnect(); mo?.disconnect();
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('nv-motion-busy', onBusy);
    clearTimeout(busyTimer);
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
});
</script>

<template>
    <canvas ref="el" class="nv-veil" aria-hidden="true"></canvas>
</template>

<style scoped>
.nv-veil { position: absolute; inset: 0; width: 100%; height: 100%; display: block; pointer-events: none; opacity: 0; transition: opacity .8s ease; }
.nv-veil.on { opacity: 1; }
</style>
