/**
 * 模型强度滑块的动态流体填充（照 HextaUI Prompt Input 的 effort-fill.tsx）：
 * 片元着色器用 fbm 噪声做流场，配色按参考截图走「近白 / 浅灰蓝 → 中段蓝 → 右端紫」：
 * start = 左端近白，end = 中段蓝（0~45%），glow = 右端（高档起逐步到 #8b5cf6 / #a855f7 紫）；
 * 档位越高，流速、亮度和高光越强。
 *
 * 约束：
 * - 只在 EffortSlider 挂载时创建、卸载时销毁；模块级 live 句柄保证同一时刻最多一个 WebGL 上下文。
 * - 拿不到 WebGL 或着色器编译失败返回 null，调用方回退 CSS 渐变（fallback）。
 * - prefers-reduced-motion 下不跑 rAF，只画一帧静态渐变，档位变化时重画。
 * - 卸载时通过 WEBGL_lose_context 主动释放上下文，避免反复开合菜单耗尽浏览器的 context 配额。
 */

export type EffortFillHandle = {
  /** 0..1：当前档位在 [最低, 最高] 里的位置 */
  setLevel: (level: number) => void;
  destroy: () => void;
};

type Palette = [string, string, string];

/** 五档配色 [左端近白, 中段蓝, 右端/高光]：低档浅蓝、中档蓝、高档/极高/Max 右端逐步过渡到紫（对齐参考截图） */
export const EFFORT_PALETTES: Palette[] = [
  ["#f7fbff", "#bcd8fb", "#d3e6fd"],
  ["#eef6ff", "#74b3fb", "#4f97f5"],
  ["#ebf2ff", "#6aa4fa", "#818cf8"],
  ["#e9f0ff", "#6b93f8", "#8b5cf6"],
  ["#e7efff", "#6f86f6", "#a855f7"],
];

/** 无 WebGL 时的回退：同色系的静态线性渐变（和上面五档一一对应，45% 处为中段色） */
export const EFFORT_FALLBACKS: string[] = [
  "linear-gradient(90deg, #f7fbff 0%, #bcd8fb 45%, #d3e6fd 100%)",
  "linear-gradient(90deg, #eef6ff 0%, #74b3fb 45%, #4f97f5 100%)",
  "linear-gradient(90deg, #ebf2ff 0%, #6aa4fa 45%, #818cf8 100%)",
  "linear-gradient(90deg, #e9f0ff 0%, #6b93f8 45%, #8b5cf6 100%)",
  "linear-gradient(90deg, #e7efff 0%, #6f86f6 45%, #a855f7 100%)",
];

/** 纯蓝回退（视频时长滑块用）：只走蓝，不带「模型强度」那套靛蓝 / 紫的高档色 */
export const BLUE_FALLBACKS: string[] = [
  "linear-gradient(90deg, #eef6ff 0%, #a9cdfb 55%, #7fb6f8 100%)",
  "linear-gradient(90deg, #e9f3ff 0%, #8fc1fa 55%, #5ba0f6 100%)",
  "linear-gradient(90deg, #e6f0ff 0%, #7bb4f9 55%, #3f8ef2 100%)",
  "linear-gradient(90deg, #e4efff 0%, #6aabf9 55%, #2f7fe8 100%)",
];

export const effortTier = (level: number) =>
  Math.max(0, Math.min(EFFORT_PALETTES.length - 1, Math.round(Math.max(0, Math.min(1, level)) * (EFFORT_PALETTES.length - 1))));

export const effortFallback = (level: number) => EFFORT_FALLBACKS[effortTier(level)];

/** 蓝色档位（0..3）：低位浅、高位是同一支蓝的深一档，不出现紫 */
export const blueTier = (level: number) =>
  Math.max(0, Math.min(BLUE_FALLBACKS.length - 1, Math.round(Math.max(0, Math.min(1, level)) * (BLUE_FALLBACKS.length - 1))));

export const blueFallback = (level: number) => BLUE_FALLBACKS[blueTier(level)];

const vertexShader = `
attribute vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const fragmentShader = `
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

function toRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

const reducedMotion = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 同一时刻只允许一个填充上下文：新滑块创建前先释放旧的 */
let live: EffortFillHandle | null = null;

export function createEffortFill(canvas: HTMLCanvasElement, level = 0, options: { reduced?: boolean; onLost?: () => void } = {}): EffortFillHandle | null {
  live?.destroy();
  let gl: WebGLRenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: "low-power" });
  } catch {
    gl = null;
  }
  if (!gl) return null;
  const context = gl;
  /** 任一失败分支都释放刚拿到的上下文，避免着色器编译反复失败时耗尽浏览器的 context 配额 */
  const dispose = () => { try { context.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* 上下文可能已丢失 */ } };
  const vertex = compile(context, context.VERTEX_SHADER, vertexShader);
  const fragment = compile(context, context.FRAGMENT_SHADER, fragmentShader);
  const program = context.createProgram();
  if (!vertex || !fragment || !program) { dispose(); return null; }
  context.attachShader(program, vertex);
  context.attachShader(program, fragment);
  context.linkProgram(program);
  if (!context.getProgramParameter(program, context.LINK_STATUS)) { dispose(); return null; }
  context.useProgram(program);

  const buffer = context.createBuffer();
  context.bindBuffer(context.ARRAY_BUFFER, buffer);
  context.bufferData(context.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), context.STATIC_DRAW);
  const position = context.getAttribLocation(program, "position");
  context.enableVertexAttribArray(position);
  context.vertexAttribPointer(position, 2, context.FLOAT, false, 0, 0);

  const uniforms = {
    resolution: context.getUniformLocation(program, "resolution"),
    time: context.getUniformLocation(program, "time"),
    level: context.getUniformLocation(program, "level"),
    start: context.getUniformLocation(program, "start"),
    end: context.getUniformLocation(program, "end"),
    glow: context.getUniformLocation(program, "glow"),
  };

  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const resize = () => {
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      context.viewport(0, 0, width, height);
    }
    context.uniform2f(uniforms.resolution, width, height);
  };

  const still = options.reduced ?? reducedMotion();
  const clamped = Math.max(0, Math.min(1, level));
  const target = { level: clamped, palette: EFFORT_PALETTES[effortTier(clamped)] };
  const current = { level: clamped, colors: target.palette.map(toRgb) as [number, number, number][] };
  const offset = Math.random() * 50;
  let previous = performance.now();
  let frame = 0;
  let destroyed = false;

  const paint = (time: number) => {
    resize();
    context.uniform1f(uniforms.time, time);
    context.uniform1f(uniforms.level, current.level);
    context.uniform3fv(uniforms.start, current.colors[0]);
    context.uniform3fv(uniforms.end, current.colors[1]);
    context.uniform3fv(uniforms.glow, current.colors[2]);
    context.clearColor(0, 0, 0, 0);
    context.clear(context.COLOR_BUFFER_BIT);
    context.drawArrays(context.TRIANGLES, 0, 3);
  };

  const blendTo = (goal: { level: number; palette: Palette }, blend: number) => {
    current.level += (goal.level - current.level) * blend;
    current.colors = current.colors.map((rgb, index) => {
      const next = toRgb(goal.palette[index]);
      return rgb.map((channel, part) => channel + (next[part] - channel) * blend) as [number, number, number];
    });
  };

  const loop = (now: number) => {
    if (destroyed) return;
    const blend = 1 - Math.exp(-((now - previous) / 1000) * 9);
    previous = now;
    blendTo(target, blend);
    paint(offset + now / 1000);
    frame = requestAnimationFrame(loop);
  };

  const onContextLost = (event: Event) => {
    event.preventDefault();
    handle.destroy();
    // 上下文被系统回收：调回组件切成 CSS 渐变，别留一块空白
    options.onLost?.();
  };
  canvas.addEventListener("webglcontextlost", onContextLost);

  const handle: EffortFillHandle = {
    setLevel(next: number) {
      if (destroyed) return;
      const value = Math.max(0, Math.min(1, Number.isFinite(next) ? next : 0));
      target.level = value;
      target.palette = EFFORT_PALETTES[effortTier(value)];
      if (still) {
        current.level = value;
        current.colors = target.palette.map(toRgb) as [number, number, number][];
        paint(offset);
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelAnimationFrame(frame);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      context.getExtension("WEBGL_lose_context")?.loseContext();
      if (live === handle) live = null;
    },
  };

  // 首次挂载先画一帧再决定是否继续跑 rAF：偶尔浏览器会在 getContext 之后才真正建好绘图缓冲
  if (still) paint(offset);
  else frame = requestAnimationFrame(loop);
  live = handle;
  return handle;
}
