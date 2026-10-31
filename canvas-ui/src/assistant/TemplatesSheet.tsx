import {
	AlertCircleIcon,
	LayersIcon,
	RefreshCwIcon,
	SearchIcon,
	WorkflowIcon,
	XIcon,
} from "lucide-react"
import { useState } from "react"
import type { CanvasTemplateItem } from "./api"

export interface TemplatePanelState {
	status: "idle" | "loading" | "ready" | "error"
	items: CanvasTemplateItem[]
	error: string
}

export const TemplatesSheet = ({
	state,
	applyingId,
	onApply,
	onClose,
	onReload,
}: {
	state: TemplatePanelState
	applyingId: string
	onApply: (id: string) => void
	onClose: () => void
	onReload: () => void
}) => {
	const [query, setQuery] = useState("")
	const normalized = query.trim().toLowerCase()
	const items = state.items.filter((item) => !normalized || [item.name, item.contains].join(" ").toLowerCase().includes(normalized))
	const loading = state.status === "loading"
	const failed = state.status === "error"

	return (
		<aside className="nvca-artifacts-sheet nvca-templates-sheet" aria-label="流程模板">
			<div className="nvca-sheet-head">
				<div className="nvca-sheet-title"><LayersIcon className="nvca-i-sm" /><span>流程模板</span></div>
				<div className="nvca-sheet-actions">
					<button className="nvca-icon-btn" onClick={onReload} title="刷新模板" aria-label="刷新模板" type="button"><RefreshCwIcon className="nvca-i-sm" /></button>
					<button className="nvca-icon-btn" onClick={onClose} title="关闭" aria-label="关闭模板面板" type="button"><XIcon className="nvca-i-sm" /></button>
				</div>
			</div>
			<label className="nvca-plus-search nvca-template-search">
				<SearchIcon className="nvca-i-sm" />
				<input aria-label="搜索流程模板" onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索流程模板" value={query} />
			</label>
			<div className="nvca-sheet-body nvca-template-list">
				{loading ? (
					<div className="nvca-sheet-skeleton" aria-label="正在加载模板">
						{[0, 1, 2].map((index) => <div className="nvca-skeleton-row" key={index}><span className="nvca-skeleton-block nvca-skeleton-line" /></div>)}
					</div>
				) : failed ? (
					<div className="nvca-sheet-state is-error">
						<AlertCircleIcon className="nvca-i-lg" />
						<p>模板加载失败</p>
						<span>{state.error || "网络错误"}</span>
						<button className="nvca-btn ghost" onClick={onReload} type="button">重试</button>
					</div>
				) : items.length === 0 ? (
					<div className="nvca-sheet-state">
						<LayersIcon className="nvca-i-lg" />
						<p>{normalized ? "没有匹配的流程模板" : "还没有流程模板"}</p>
						{!normalized ? <span>先选中一组节点，通过助手「存成模板」。</span> : null}
					</div>
				) : items.map((item) => {
					const covers = (item.covers || []).filter(Boolean).slice(0, 3)
					const meta = [item.contains || "完整工作流", `${item.node_count || 0} 个节点`]
					if (item.input_count) meta.push(`${item.input_count} 个素材位`)
					const applying = applyingId === item.id
					return (
						<article className="nvca-template-card" key={item.id}>
							<div className={"nvca-template-cover count-" + covers.length}>
								{covers.length ? covers.map((url) => <img alt="" key={url} loading="lazy" src={url} />) : <WorkflowIcon className="nvca-i-lg" />}
							</div>
							<div className="nvca-template-copy">
								<strong>{item.name || "未命名模板"}</strong>
								<span>{meta.join(" · ")}</span>
							</div>
							<button
								className="nvca-template-apply"
								disabled={Boolean(applyingId) || Boolean(item.error)}
								onClick={() => onApply(item.id)}
								type="button"
							>
								{applying ? "克隆中…" : item.error ? "不可用" : "克隆到画布"}
							</button>
						</article>
					)
				})}
			</div>
		</aside>
	)
}
