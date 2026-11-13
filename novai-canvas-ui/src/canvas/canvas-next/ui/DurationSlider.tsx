/**
 * 视频时长：改成拖动选择（原先是「3s 4s 5s …」一排按钮，长档位模型有 20 多个格子，点不过来）。
 *
 * 档位来自后端能力表（/api/model-caps → ModelSpec.durs）：
 *  * 声明了 -1 的模型（apimart-zoe / seedance-2.5 …）最左端就是「自动」，交给模型自选；
 *  * 只有一个档位的模型（veo3.1 固定 8 秒）没有可拖区间，退化成一行只读说明，不硬塞拖不动的滑轨；
 *  * 没有档位声明的模型保持原来的「由模型自动决定」。
 * 轨道 / 拇指 / 键盘（← → Home End）全部复用模型强度滑块（EffortSlider），视觉一致：
 * 28px 胶囊软底 + 流体渐变填充 + 白色胶囊拇指，零边框零发丝线。
 */
import type { CanvasNode } from "../../react-canvas/reactCanvasStore";
import { durationSliderLevels, durationTiers, genOf, type ModelSpec, type VideoParams } from "../model";
import { EffortSlider } from "./EffortSlider";
import { useCtl, useS } from "./ctx";

type Props = { node: CanvasNode; model: ModelSpec; disabled?: boolean };

export function DurationSlider({ node, model, disabled = false }: Props) {
    const store = useCtl().store;
    // 弹层打开那一刻就定稿，父组件不会跟着参数重渲染：这里订阅节点，拖动时数值实时跟手
    const live = useS((s) => s.doc.nodes.find((x) => x.id === node.id)) || node;
    const params = genOf(live).params as VideoParams;
    const tiers = durationTiers(model.durs);
    const positive = tiers.positive;
    const { levels, labels } = durationSliderLevels(model.durs);
    if (!levels.length) return <div className="ds-note" data-dur-note="auto"><span>生成时长</span><em>由模型自动决定</em></div>;
    if (levels.length === 1) return <div className="ds-note" data-dur-note="fixed"><span>生成时长</span><b>{labels[levels[0]]}</b><em>该模型只有这一档</em></div>;
    const current = String(Number(params.dur));
    const value = levels.includes(current) ? current : levels[tiers.auto ? 1 : 0];
    return <EffortSlider
        usage="duration"
        size="sm"
        tone="blue"
        disabled={disabled}
        label="生成时长"
        levels={levels}
        labels={labels}
        value={value}
        recommended={null}
        showRestore={false}
        hint={tiers.auto ? "拖动选择，越右越长；最左「自动」交给模型决定" : "拖动选择，越右越长"}
        leftLabel={tiers.auto ? "自动" : positive[0] + "s"}
        rightLabel={positive[positive.length - 1] + "s"}
        onChange={(level) => store.patchGen(node.id, (g) => ({ params: { ...(g.params as VideoParams), dur: Number(level) } }))}
    />;
}
