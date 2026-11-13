/**
 * 记忆弹窗里的「记忆策略」三个开关 + 「这张画布的项目档案」（阶段二收口）。
 *
 * 两个区块都只做展示与调用：读不到就如实说「暂时读不到」，不拿默认值假装开关状态，
 * 也不在空档案时留空壳（空档案给一句「还没积累档案」+ 什么时候会有）。
 * 样式复用现有 .row / .sw / .btn / .mh 与本次新增的 .ap2-prof-*（软底、无描边）。
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../ui/Icon";
import type { AgentState } from "./state";
import {
    MEMORY_SETTINGS_LABEL,
    MemoryExtrasError,
    clearCanvasProfile,
    fetchCanvasProfile,
    fetchMemorySettings,
    saveCanvasProfile,
    updateMemorySettings,
    type CanvasProfileData,
    type MemorySettingKey,
    type MemorySettings,
    type ProfileFields,
} from "./memoryExtras";

const EMPTY_FIELDS: ProfileFields = { intro: "", style: "", progress: "", key_nodes: [] };

const reasonOf = (error: unknown): string => (error instanceof MemoryExtrasError || error instanceof Error ? error.message : "未知错误");

export function MemorySettingsPanel({ a }: { a: AgentState }) {
    const canvasId = a.canvasId;
    const [settings, setSettings] = useState<MemorySettings | null>(null);
    const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
    const [busy, setBusy] = useState<MemorySettingKey | null>(null);

    useEffect(() => {
        let live = true;
        setStatus("loading");
        setSettings(null);
        fetchMemorySettings(canvasId)
            .then((value) => { if (live) { setSettings(value); setStatus("ready"); } })
            .catch(() => { if (live) setStatus("unavailable"); });
        return () => { live = false; };
    }, [canvasId]);

    const toggle = async (key: MemorySettingKey) => {
        if (!settings || busy || status !== "ready") return;
        const before = settings;
        const next = { ...settings, [key]: !settings[key] };
        setSettings(next);
        setBusy(key);
        try { setSettings(await updateMemorySettings(canvasId, { [key]: next[key] })); }
        catch (error) {
            setSettings(before);
            a.businessError = "改不了这个开关：" + reasonOf(error);
            a.emit();
        } finally { setBusy(null); }
    };

    return <>
        <div className="mh ap2-mem-h">记忆策略</div>
        {status === "unavailable"
            ? <p className="ap2-mem-note" data-mem-settings-unavailable>暂时读不到记忆策略（服务端接口未就绪或不可用），接上后这里可以开关。</p>
            : MEMORY_SETTINGS_LABEL.map(([key, label, hint]) => <div className="row ap2-mem-row" data-mem-setting={key} key={key}>
                <span>{label}<small>{hint}</small></span>
                <button className={"sw" + (settings && settings[key] ? " on" : "")} data-mem-toggle={key}
                    role="switch" aria-checked={!!(settings && settings[key])} aria-label={label}
                    disabled={status !== "ready" || busy === key} onClick={() => void toggle(key)} />
            </div>)}
    </>;
}

export function CanvasProfilePanel({ a }: { a: AgentState }) {
    const canvasId = a.canvasId;
    const [data, setData] = useState<CanvasProfileData | null>(null);
    const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState<ProfileFields>(EMPTY_FIELDS);
    const [nodesText, setNodesText] = useState("");
    const [busy, setBusy] = useState(false);
    const [clearArmed, setClearArmed] = useState(false);
    const armTimer = useRef<number | null>(null);

    useEffect(() => {
        let live = true;
        setStatus("loading");
        setData(null);
        setEditing(false);
        fetchCanvasProfile(canvasId)
            .then((value) => { if (live) { setData(value); setStatus("ready"); } })
            .catch(() => { if (live) setStatus("unavailable"); });
        return () => { live = false; };
    }, [canvasId]);
    useEffect(() => () => { if (armTimer.current !== null) window.clearTimeout(armTimer.current); }, []);

    const startEdit = () => {
        if (!data) return;
        setDraft(data.fields);
        setNodesText(data.fields.key_nodes.join("\n"));
        setEditing(true);
        setClearArmed(false);
    };
    const save = async () => {
        setBusy(true);
        try {
            const fields: ProfileFields = { ...draft, key_nodes: nodesText.split("\n").map((line) => line.trim()).filter(Boolean) };
            setData(await saveCanvasProfile(canvasId, fields));
            setEditing(false);
        } catch (error) {
            a.businessError = "档案没保存成功：" + reasonOf(error);
            a.emit();
        } finally { setBusy(false); }
    };
    const clear = async () => {
        if (!clearArmed) {
            setClearArmed(true);
            armTimer.current = window.setTimeout(() => setClearArmed(false), 4000);
            return;
        }
        if (armTimer.current !== null) window.clearTimeout(armTimer.current);
        setClearArmed(false);
        setBusy(true);
        try {
            await clearCanvasProfile(canvasId);
            setData(await fetchCanvasProfile(canvasId));
            setEditing(false);
        } catch (error) {
            a.businessError = "档案没清空：" + reasonOf(error);
            a.emit();
        } finally { setBusy(false); }
    };

    return <>
        <div className="mh ap2-mem-h">这张画布的项目档案</div>
        {status === "loading" ? <p className="ap2-mem-note">正在读取档案…</p> : null}
        {status === "unavailable" ? <p className="ap2-mem-note" data-prof-unavailable>暂时读不到项目档案（服务端接口未就绪或不可用）。</p> : null}
        {status === "ready" && data ? (editing ? <div className="ap2-prof-form" data-prof-form>
            <label>简介<textarea data-prof-intro rows={2} value={draft.intro} placeholder="这张画布是做什么的、给谁看" onChange={(event) => setDraft({ ...draft, intro: event.target.value })} onKeyDown={(event) => event.stopPropagation()} /></label>
            <label>风格 / 视觉偏好<textarea data-prof-style rows={2} value={draft.style} placeholder="例如：冷白光、低饱和、左上留白放标题" onChange={(event) => setDraft({ ...draft, style: event.target.value })} onKeyDown={(event) => event.stopPropagation()} /></label>
            <label>关键节点<textarea data-prof-nodes rows={2} value={nodesText} placeholder="" onChange={(event) => setNodesText(event.target.value)} onKeyDown={(event) => event.stopPropagation()} /></label>
            <label>方案进度<textarea data-prof-progress rows={2} value={draft.progress} placeholder="例如：卖点已确认，等出 3 张封面" onChange={(event) => setDraft({ ...draft, progress: event.target.value })} onKeyDown={(event) => event.stopPropagation()} /></label>
            <div className="ap2-prof-acts">
                <button className="btn" data-prof-cancel disabled={busy} onClick={() => setEditing(false)}>取消</button>
                <button className="btn solid" data-prof-save disabled={busy} onClick={() => void save()}>保存档案</button>
            </div>
        </div> : (data.text.trim() ? <>
            <pre className="ap2-prof-text" data-prof-text>{data.text}</pre>
            <div className="ap2-prof-acts">
                <span className="ap2-prof-count">{data.chars} / {data.limit} 字</span>
                <button className="btn" data-prof-clear disabled={busy} onClick={() => void clear()}>{clearArmed ? "确认清空" : "清空"}</button>
                <button className="btn" data-prof-edit disabled={busy} onClick={startEdit}><Icon name="pencil" size="xs" />编辑档案</button>
            </div>
        </> : <div className="ap2-prof-empty" data-prof-empty>
            <b>还没积累档案</b>
            <p>跑过几轮真实对话后，这里会攒出这张画布的简介、风格、关键节点和方案进度；也可以直接自己写一份。</p>
            <div className="ap2-prof-acts"><button className="btn" data-prof-edit disabled={busy} onClick={startEdit}><Icon name="plus" size="xs" />写一份档案</button></div>
        </div>)) : null}
    </>;
}
