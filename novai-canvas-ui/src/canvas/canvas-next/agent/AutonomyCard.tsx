/**
 * 托管授权卡（阶段四 §8.2）：开始托管前 / 收到 budget_required 时弹出。
 * 两级选择：先选平台（vendor），再选这个平台下的模型；图片 / 视频 / 配音各一组，**每次数的上限按模态给**（max）。
 * budget_required 事件形状：{ run_id, needs:{image,video,audio}, budget:{...}, used:{...}, modality, units }；
 *   remaining = budget - used 在这里算，needs 是各模态还缺多少次（预填到上限里，用户可再加）。
 * 样式：磨砂玻璃、无描边；按钮右对齐；不引入新依赖。
 */
import { useMemo, useState } from "react";
import { Icon } from "../../canvas-next/ui/Icon";
import type { ModelSpec } from "../../canvas-next/model";

export type ModalityBudget = { provider?: string; model?: string; max?: number };
export type AutonomyBudget = {
    image?: ModalityBudget;
    video?: ModalityBudget;
    audio?: ModalityBudget;
    /** 兼容旧契约的单个上限（以按模态的 max 为准） */
    limit?: number;
    budget?: Partial<Record<Kind, number>>;
    used?: Partial<Record<Kind, number>>;
    needs?: Partial<Record<Kind, number>>;
    /** 请求里的预计预算（budget_required 事件带）：只作展示，不作上限 / 预填依据 */
    requested?: Partial<Record<Kind, number>>;
    modality?: string;
    units?: string;
    [key: string]: unknown;
};
type Kind = "image" | "video" | "audio";
const KINDS: Array<{ kind: Kind; label: string; icon: "image" | "video" | "audio" }> = [
    { kind: "image", label: "图片", icon: "image" },
    { kind: "video", label: "视频", icon: "video" },
    { kind: "audio", label: "配音", icon: "audio" },
];

export function AutonomyCard({ models, reason, initial, busy, onConfirm, onCancel }: {
    models: ModelSpec[];
    reason: "start" | "budget_required";
    initial?: AutonomyBudget;
    busy?: boolean;
    onConfirm: (draft: AutonomyBudget) => void;
    onCancel: () => void;
}) {
    const byKind = useMemo(() => KINDS.map((row) => ({ ...row, models: models.filter((model) => model.kind === row.kind) })), [models]);
    const [picked, setPicked] = useState<Record<Kind, { provider: string; model: string }>>(() => {
        const start: Record<Kind, { provider: string; model: string }> = { image: { provider: "", model: "" }, video: { provider: "", model: "" }, audio: { provider: "", model: "" } };
        for (const row of KINDS) {
            const budget = initial?.[row.kind];
            start[row.kind] = { provider: budget?.provider || "", model: budget?.model || "" };
        }
        return start;
    });
    const [maxes, setMaxes] = useState<Record<Kind, string>>(() => {
        const start: Record<Kind, string> = { image: "", video: "", audio: "" };
        for (const row of KINDS) {
            const value = initial?.[row.kind]?.max ?? initial?.needs?.[row.kind] ?? initial?.budget?.[row.kind] ?? 10;
            start[row.kind] = String(Math.max(1, Number(value) || 1));
        }
        return start;
    });
    const setMax = (kind: Kind, value: string) => setMaxes((prev) => ({ ...prev, [kind]: value }));
    const normalize = (value: string) => Math.max(1, Math.min(200, Math.floor(Number(value) || 1)));
    const choose = (kind: Kind, provider: string, model: string) => setPicked((prev) => ({ ...prev, [kind]: { provider, model } }));
    const setAll = (value: number) => setMaxes({ image: String(value), video: String(value), audio: String(value) });
    const unified = Math.max(normalize(maxes.image), normalize(maxes.video), normalize(maxes.audio));
    const requestedRows = KINDS
        .map((row) => ({ ...row, count: Number(initial?.requested?.[row.kind] || 0) }))
        .filter((row) => row.count > 0);
    return <div className="ap2-auth" data-autonomy-card data-reason={reason}>
        <div className="ap2-auth-hd">
            <Icon name="shield" size="s" />
            <span>{reason === "budget_required" ? "托管额度用完 / 将尽" : "开始托管前，先定好预算"}</span>
            <span className="sp" />
            <button className="linkbtn" onClick={onCancel} type="button">{reason === "budget_required" ? "结束任务" : "取消托管"}</button>
        </div>
        <div className="ap2-auth-sub">
            {reason === "budget_required"
                ? "可继续补额度，或结束这次托管；每个模态的生成次数上限可以分开定，补完接着按下面的平台与模型自动推进。"
                : "托管会按下面选定的平台与模型自动生成；每个模态的生成次数上限分开定，到额度前会停下来问你，不会偷偷多花钱。"}
        </div>
        {requestedRows.length ? <div className="ap2-auth-req" data-requested>
            <span>预计需要：</span>
            {requestedRows.map((row) => <span key={row.kind} data-requested-kind={row.kind}>{row.label} {row.count} 次</span>)}
        </div> : null}
        {reason === "budget_required" ? <div className="ap2-auth-usage" data-usage>
            {KINDS.map((row) => {
                const used = Number(initial?.used?.[row.kind] || 0);
                const total = Number(initial?.budget?.[row.kind] || 0);
                const need = Number(initial?.needs?.[row.kind] || Math.max(0, total - used));
                return <span key={row.kind} data-modality={row.kind}>{row.label}已用 {used} / 上限 {total || "?"}{need ? "（还缺 " + need + " 次）" : "（已满）"}</span>;
            })}
        </div> : null}
        <div className="ap2-auth-rows">
            {byKind.map((row) => {
                const providers = [...new Set(row.models.map((model) => model.vendor || "默认"))];
                const provider = providers.includes(picked[row.kind].provider) ? picked[row.kind].provider : (providers[0] || "");
                const options = row.models.filter((model) => (model.vendor || "默认") === provider);
                const model = options.some((item) => item.name === picked[row.kind].model) ? picked[row.kind].model : (options[0]?.name || "");
                return <div className="ap2-auth-row" key={row.kind} data-kind={row.kind}>
                    <div className="ap2-auth-k"><Icon name={row.icon} size="xs" /><span>{row.label}</span></div>
                    <div className="ap2-auth-picks">
                        <div className="ap2-auth-chips" role="group" aria-label={row.label + "平台"}>
                            {providers.length ? providers.map((name) => <button key={name} type="button" className={"ap2-auth-chip" + (name === provider ? " on" : "")} data-provider={name} onClick={() => { const first = row.models.find((item) => (item.vendor || "默认") === name); choose(row.kind, name, first?.name || ""); }}>{name}</button>) : <span className="ap2-auth-empty">没有可用的{row.label}模型</span>}
                        </div>
                        <div className="ap2-auth-chips" role="group" aria-label={row.label + "模型"}>
                            {options.map((item) => <button key={item.id} type="button" className={"ap2-auth-chip" + (item.name === model ? " on" : "")} data-model={item.name} onClick={() => choose(row.kind, provider, item.name)}>{item.name}</button>)}
                        </div>
                    </div>
                    <label className="ap2-auth-max">
                        <span>上限</span>
                        <input aria-label={row.label + "生成次数上限"} className="ap2-auth-num" data-max-kind={row.kind} inputMode="numeric" min={1} max={200} type="number" value={maxes[row.kind]} onChange={(event) => setMax(row.kind, event.target.value)} />
                    </label>
                </div>;
            })}
        </div>
        <div className="ap2-auth-limit">
            <span>统一上限</span>
            <div className="ap2-auth-chips">
                {[5, 10, 20, 50].map((n) => <button key={n} type="button" className={"ap2-auth-chip" + (unified === n ? " on" : "")} onClick={() => setAll(n)}>{n}</button>)}
            </div>
        </div>
        <div className="ap2-auth-ft">
            <button type="button" className="ap2-auth-btn" onClick={onCancel}>{reason === "budget_required" ? "结束任务" : "取消"}</button>
            <button type="button" className="ap2-auth-btn primary" disabled={!!busy} onClick={() => onConfirm({
                image: { ...picked.image, max: normalize(maxes.image), provider: picked.image.provider, model: picked.image.model },
                video: { ...picked.video, max: normalize(maxes.video), provider: picked.video.provider, model: picked.video.model },
                audio: { ...picked.audio, max: normalize(maxes.audio), provider: picked.audio.provider, model: picked.audio.model },
                limit: unified,
            })}>{busy ? "提交中…" : reason === "budget_required" ? "补额度并继续" : "确认并开始托管"}</button>
        </div>
    </div>;
}
