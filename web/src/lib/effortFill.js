// 首页（Vue 构建）的模型强度流体填充，和画布 React 端 EffortSlider 同源：
// fbm 噪声流场，配色「近白 / 浅灰蓝 → 中段蓝 → 右端紫」（低档浅蓝、中档蓝、高档/极高/Max 右端紫），
// 档位越高流速 / 亮度越强。只在滑块挂载时创建、卸载时销毁；同一时刻最多一个 WebGL 上下文；拿不到 WebGL 回退 CSS 渐变。

// [左端近白, 中段蓝, 右端/高光]：低档浅蓝、中档蓝、高档/极高/Max 右端逐步过渡到紫
const PALETTES = [
    ['#f7fbff', '#bcd8fb', '#d3e6fd'],
    ['#eef6ff', '#74b3fb', '#4f97f5'],
    ['#ebf2ff', '#6aa4fa', '#818cf8'],
    ['#e9f0ff', '#6b93f8', '#8b5cf6'],
    ['#e7efff', '#6f86f6', '#a855f7'],
];

const FALLBACKS = [
    'linear-gradient(90deg, #f7fbff 0%, #bcd8fb 45%, #d3e6fd 100%)',
    'linear-gradient(90deg, #eef6ff 0%, #74b3fb 45%, #4f97f5 100%)',
    'linear-gradient(90deg, #ebf2ff 0%, #6aa4fa 45%, #818cf8 100%)',
    'linear-gradient(90deg, #e9f0ff 0%, #6b93f8 45%, #8b5cf6 100%)',
    'linear-gradient(90deg, #e7efff 0%, #6f86f6 45%, #a855f7 100%)',
];

const VERTEX_SHADER = `
attribute vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform vec2 resolution;
uniform float time;
uniform float level;
uniform vec3 start;
uniform vec3 end;
uniform vec3 glow;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    value += amplitude * noise(p);
    p = p * 2.02 + vec2(3.1, 1.7);
    amplitude *= 0.5;
  }
  return value;
}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  float aspect = resolution.x / resolution.y;
  float speed = 0.18 + 1.4 * level;
  vec2 p = vec2(uv.x * aspect * 0.55, uv.y * 0.9);
  vec2 warp = vec2(
    fbm(p + vec2(-time * speed, time * 0.15)),
    fbm(p + vec2(4.3, 2.1) - vec2(time * speed * 0.8, 0.0))
  );
  float field = fbm(p * 1.4 + warp * 1.6 - vec2(time * speed * 1.2, 0.0));

  vec3 color = mix(start, end, smoothstep(0.0, 0.45, uv.x));
  color = mix(color, glow, smoothstep(0.45, 1.0, uv.x));
  float sheen = smoothstep(0.35, 0.95, field) * (0.35 + 0.65 * uv.x);
  color = mix(color, glow, sheen * (0.35 + 0.45 * level));

  float core = exp(-pow((1.0 - uv.x) * aspect * 1.6, 2.0)) * level;
  color = mix(color, glow, core * 0.55);

  float sparkle = 0.0;
  if (level > 0.6) {
    vec2 cell = floor(vec2(uv.x * aspect * 7.0 - time * 0.6, uv.y * 7.0));
    float seed = hash(cell);
    vec2 local = fract(vec2(uv.x * aspect * 7.0 - time * 0.6, uv.y * 7.0)) - 0.5;
    float twinkle = pow(0.5 + 0.5 * sin(time * (2.5 + seed * 5.0) + seed * 40.0), 4.0);
    float dot = smoothstep(0.2, 0.0, length(local + (vec2(hash(cell + 3.1), hash(cell + 7.7)) - 0.5) * 0.5));
    sparkle = step(0.55, seed) * dot * twinkle * smoothstep(0.6, 1.0, level) * smoothstep(0.15, 0.6, uv.x);
  }
  color = mix(color, vec3(1.0), sparkle);

  float alpha = smoothstep(0.0, 0.45, uv.x) * (0.55 + 0.45 * level);
  alpha = max(alpha, sparkle);
  gl_FragColor = vec4(color * alpha, alpha);
}
`;

const clamp01 = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

export const effortTier = (level) => Math.round(clamp01(level) * (PALETTES.length - 1));

export const effortFallback = (level) => FALLBACKS[effortTier(level)];

function toRgb(hex) {
    const value = Number.parseInt(hex.replace('#', ''), 16);
    return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function compile(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

const reducedMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let live = null;

/** 返回 { setLevel, destroy }；没有 WebGL 返回 null（调用方回退静态渐变） */
export function createEffortFill(canvas, level = 0, options = {}) {
    if (live) live.destroy();
    let gl = null;
    try {
        gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'low-power' });
    } catch (e) {
        gl = null;
    }
    if (!gl) return null;

    // 任一失败分支都释放刚拿到的上下文，避免着色器编译反复失败时耗尽浏览器的 context 配额
    const dispose = () => {
        try {
            const ext = gl.getExtension('WEBGL_lose_context');
            if (ext) ext.loseContext();
        } catch (e) { /* 上下文可能已丢失 */ }
    };
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) { dispose(); return null; }
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { dispose(); return null; }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const uniforms = {
        resolution: gl.getUniformLocation(program, 'resolution'),
        time: gl.getUniformLocation(program, 'time'),
        level: gl.getUniformLocation(program, 'level'),
        start: gl.getUniformLocation(program, 'start'),
        end: gl.getUniformLocation(program, 'end'),
        glow: gl.getUniformLocation(program, 'glow'),
    };

    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
        const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
        const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
            gl.viewport(0, 0, width, height);
        }
        gl.uniform2f(uniforms.resolution, width, height);
    };

    const still = options.reduced !== undefined ? options.reduced : reducedMotion();
    const startLevel = clamp01(level);
    const target = { level: startLevel, palette: PALETTES[effortTier(startLevel)] };
    const current = { level: startLevel, colors: target.palette.map(toRgb) };
    const offset = Math.random() * 50;
    let previous = performance.now();
    let frame = 0;
    let destroyed = false;

    const paint = (time) => {
        resize();
        gl.uniform1f(uniforms.time, time);
        gl.uniform1f(uniforms.level, current.level);
        gl.uniform3fv(uniforms.start, current.colors[0]);
        gl.uniform3fv(uniforms.end, current.colors[1]);
        gl.uniform3fv(uniforms.glow, current.colors[2]);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    const blendTo = (goal, blend) => {
        current.level += (goal.level - current.level) * blend;
        current.colors = current.colors.map((rgb, index) => {
            const next = toRgb(goal.palette[index]);
            return rgb.map((channel, part) => channel + (next[part] - channel) * blend);
        });
    };

    const loop = (now) => {
        if (destroyed) return;
        const blend = 1 - Math.exp(-((now - previous) / 1000) * 9);
        previous = now;
        blendTo(target, blend);
        paint(offset + now / 1000);
        frame = requestAnimationFrame(loop);
    };

    const handle = {
        setLevel(next) {
            if (destroyed) return;
            const value = clamp01(next);
            target.level = value;
            target.palette = PALETTES[effortTier(value)];
            if (still) {
                current.level = value;
                current.colors = target.palette.map(toRgb);
                paint(offset);
            }
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            cancelAnimationFrame(frame);
            canvas.removeEventListener('webglcontextlost', onLost);
            const lose = gl.getExtension('WEBGL_lose_context');
            if (lose) lose.loseContext();
            if (live === handle) live = null;
        },
    };

    function onLost(event) {
        event.preventDefault();
        handle.destroy();
        // 上下文被系统回收：调回组件切成 CSS 渐变，别留一块空白
        if (options.onLost) options.onLost();
    }
    canvas.addEventListener('webglcontextlost', onLost);

    if (still) paint(offset);
    else frame = requestAnimationFrame(loop);
    live = handle;
    return handle;
}
