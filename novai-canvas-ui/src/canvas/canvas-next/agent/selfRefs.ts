/**
 * 「这次生成别拿自己的产物当参考图」（阶段三·2 后端标记 → 画布引擎消费）
 *
 * 后端在 BEAT 节点上打两种标记：
 *   · agentRun.excludeSelfRefs = true            —— 助手交给画布跑的节点
 *   · agentPendingExcludeSelfRefs = true         —— 待生成卡片里的节点（用户点「执行生成」后由后端转成 agentRun）
 * 语义：默认可以用自己的旧图当参考（既有产品功能）；只有标记为 true 的这一次生成要剔除自产物。
 * 自产物三种：节点自己、由它生成的结果节点（data.sourceNodeId 指向它）、分组展开出来的自己。
 *
 * 纯函数放这里，方便 tests/test_novai_canvas_agent_self_refs.js 直接加载断言。
 */

type MaybeNode = { id?: unknown; data?: unknown };

/** 节点上是否带着「本次生成剔除自产物」的标记（两种路径都认） */
export function excludeSelfRefsFlag(data: unknown): boolean {
    if (!data || typeof data !== "object") return false;
    const row = data as { agentRun?: unknown; agentPendingExcludeSelfRefs?: unknown };
    const run = row.agentRun && typeof row.agentRun === "object" ? row.agentRun as { excludeSelfRefs?: unknown } : null;
    return run?.excludeSelfRefs === true || row.agentPendingExcludeSelfRefs === true;
}

/** 一个输入节点是不是「这次目标节点自己的产物」：自己 / 由它生成的结果节点 */
export function isSelfProductNode(candidate: MaybeNode | null | undefined, targetId: string): boolean {
    const target = String(targetId || "");
    if (!target || !candidate) return false;
    if (String(candidate.id || "") === target) return true;
    const data = candidate.data && typeof candidate.data === "object" ? candidate.data as { sourceNodeId?: unknown } : null;
    return !!data && typeof data.sourceNodeId === "string" && data.sourceNodeId === target;
}

/** 组装参考图前按标记过一遍输入：exclude=false 时原样返回（手动重跑保持既有行为） */
export function filterSelfRefs<T extends { node: MaybeNode }>(inputs: T[], targetId: string, exclude: boolean): T[] {
    if (!exclude) return inputs;
    return inputs.filter((row) => !isSelfProductNode(row.node, targetId));
}
