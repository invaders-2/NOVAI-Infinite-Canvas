/**
 * 画布侧模型显示名的**唯一真源**：供应商真实模型名优先 + label ⇄ configId 双向索引。
 *
 * 画布页把模型名当**不透明字符串**：既做下拉选项值、也存进节点文档、还作为 `/api/canvas-llm` /
 * `/api/canvas-image-tasks` 的 `model` 回传宿主。所以这套命名必须同时满足两条硬约束：
 *
 *   1) **双射**：每个 label 唯一映射到一个 configId（宿主 `labelToConfig` 反查），
 *      且同一 configId 只产出一个 label —— 否则下拉会出现"看着两个、其实一个"或选错配置；
 *   2) **稳定**：同一份清单无论数组顺序如何都产出同样的 label（宿主每次刷新投影 / 页面每次
 *      重渲染都靠它对齐，label 漂移会被守卫当成"清单外的旧值"清掉）。
 *
 * 命名规则（输入顺序无关）：
 *   · 基础名 = remoteModelId > displayName > configId（供应商真实模型名优先，缺失才回退）；
 *   · 基础名在**多条配置间撞车** → 追加供应商显示名：`deepseek-chat · DeepSeek`；
 *   · 同一供应商下仍撞车（同 id 多条配置 / 供应商显示名也相同）→ 再追加 configId 的最短唯一后缀
 *     （从末 4 位起，撞车就加长，最长到完整 configId）；
 *   · 极端兜底（基础名里本身含分隔符等）若仍撞车 → 追加完整 configId，保证双射。
 */

export const CANVAS_MODEL_LABEL_SEPARATOR = " · ";

export type CanvasModelNameSource = {
  configId: string;
  remoteModelId?: string | null;
  displayName?: string | null;
  providerId?: string | null;
  providerName?: string | null;
};

export type CanvasModelLabelIndex = {
  /** configId → label */
  labelOf: Map<string, string>;
  /** label → configId（唯一，故是双射） */
  configOf: Map<string, string>;
};

/** 基础名：供应商真实模型名 > 本地显示名 > configId。 */
export function canvasModelBaseName(m: CanvasModelNameSource): string {
  const remote = String((m && m.remoteModelId) || "").trim();
  if (remote) return remote;
  const display = String((m && m.displayName) || "").trim();
  if (display) return display;
  return String((m && m.configId) || "").trim();
}

/** 消歧用的供应商身份：显示名优先，缺失时退回 providerId，再退回中性占位。 */
function providerLabelOf(m: CanvasModelNameSource): string {
  const name = String((m && m.providerName) || "").trim();
  if (name) return name;
  const id = String((m && m.providerId) || "").trim();
  return id || "未知供应商";
}

/** 同值分组（保留首次出现顺序，但输出不依赖顺序，只依赖值集合）。 */
function groupIndexes(values: string[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  values.forEach((v, i) => {
    const list = out.get(v);
    if (list) list.push(i);
    else out.set(v, [i]);
  });
  return out;
}

/**
 * configId 的**最短唯一后缀**：先试 4 个字符，同组内仍撞车就加长，直到整串。
 * 同一组内 configId 必不同（configId 是主键），所以一定能在整串处唯一。
 */
function shortestUniqueConfigSuffix(ids: string[]): number {
  const max = Math.max(1, ...ids.map((id) => id.length));
  for (let len = 4; len <= max; len += 1) {
    const seen = new Set<string>();
    let unique = true;
    for (const id of ids) {
      const suffix = id.slice(-len);
      if (seen.has(suffix)) { unique = false; break; }
      seen.add(suffix);
    }
    if (unique) return len;
  }
  return Number.POSITIVE_INFINITY;
}

export function buildCanvasModelLabelIndex(models: CanvasModelNameSource[]): CanvasModelLabelIndex {
  const rows = (Array.isArray(models) ? models : []).map((m) => ({
    configId: String((m && m.configId) || ""),
    base: canvasModelBaseName(m),
    provider: providerLabelOf(m),
  }));
  const labels = rows.map((r) => r.base);

  // ① 基础名撞车 → 追加供应商显示名（只对撞车的那一组加，唯一名保持供应商给的纯模型名）。
  for (const group of groupIndexes(rows.map((r) => r.base)).values()) {
    if (group.length < 2) continue;
    for (const i of group) labels[i] = rows[i].base + CANVAS_MODEL_LABEL_SEPARATOR + rows[i].provider;
  }

  // ② 追加供应商后仍在同组撞车（同供应商下同 id 多条配置）→ 追加 configId 最短唯一后缀。
  for (const group of groupIndexes(labels.slice()).values()) {
    if (group.length < 2) continue;
    const len = shortestUniqueConfigSuffix(group.map((i) => rows[i].configId));
    for (const i of group) labels[i] = labels[i] + CANVAS_MODEL_LABEL_SEPARATOR + rows[i].configId.slice(-len);
  }

  // ③ 兜底：基础名/供应商名里自带分隔符等极端情况下仍撞车 → 追加完整 configId，保证双射。
  for (const group of groupIndexes(labels.slice()).values()) {
    if (group.length < 2) continue;
    for (const i of group) labels[i] = labels[i] + CANVAS_MODEL_LABEL_SEPARATOR + rows[i].configId;
  }

  const labelOf = new Map<string, string>();
  const configOf = new Map<string, string>();
  rows.forEach((r, i) => {
    labelOf.set(r.configId, labels[i]);
    configOf.set(labels[i], r.configId);
  });
  return { labelOf, configOf };
}
