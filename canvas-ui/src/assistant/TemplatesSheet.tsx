import {
	AlertCircleIcon,
	LayersIcon,
	RefreshCwIcon,
	SearchIcon,
	WorkflowIcon,
	XIcon,
} from "lucide-react"
import { useState } from "react"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/hexta/empty"
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/hexta/item"
import { Skeleton } from "@/components/hexta/skeleton"
import { Spinner } from "@/components/hexta/spinner"
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

	/* 与产物侧栏同理：贴右邻助手面板、不遮罩不抢焦点，外壳保持非模态 aside。 */
	return (
		<aside className="nvca-artifacts-sheet nvca-sheet-v2 nvca-templates-sheet" aria-label="流程模板">
			<div className="nvca-sheet-head">
				<div className="nvca-sheet-title">
					<LayersIcon className="nvca-i-sm" />
					<span>流程模板</span>
					{state.items.length > 0 ? <span className="nvca-sheet-count">{state.items.length}</span> : null}
				</div>
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
						{[0, 1, 2].map((index) => <div className="nvca-skeleton-row" key={index}><Skeleton className="nvca-skeleton-line" /></div>)}
					</div>
				) : failed ? (
					<Empty className="nvca-sheet-state is-error" size="sm">
						<EmptyMedia>
							<AlertCircleIcon className="nvca-sheet-empty-icon" />
						</EmptyMedia>
						<EmptyHeader>
							<EmptyTitle>模板加载失败</EmptyTitle>
							<EmptyDescription>{state.error || "网络错误"}</EmptyDescription>
						</EmptyHeader>
						<button className="nvca-btn ghost" onClick={onReload} type="button">重试</button>
					</Empty>
				) : items.length === 0 ? (
					<Empty className="nvca-sheet-state" size="sm">
						<EmptyMedia>
							<LayersIcon className="nvca-sheet-empty-icon" />
						</EmptyMedia>
						<EmptyHeader>
							<EmptyTitle>{normalized ? "没有匹配的流程模板" : "还没有流程模板"}</EmptyTitle>
							{!normalized ? <EmptyDescription>先选中一组节点，通过助手「存成模板」。</EmptyDescription> : null}
						</EmptyHeader>
					</Empty>
				) : items.map((item) => {
					const covers = (item.covers || []).filter(Boolean).slice(0, 3)
					const meta = [item.contains || "完整工作流", `${item.node_count || 0} 个节点`]
					if (item.input_count) meta.push(`${item.input_count} 个素材位`)
					const applying = applyingId === item.id
					return (
						<Item className="nvca-template-card" key={item.id} render={<article />} size="xs">
							<ItemMedia className={"nvca-template-cover count-" + covers.length} variant="image">
								{covers.length ? covers.map((url) => <img alt="" key={url} loading="lazy" src={url} />) : <WorkflowIcon className="nvca-i-lg" />}
							</ItemMedia>
							<ItemContent className="nvca-template-copy">
								<ItemTitle><strong>{item.name || "未命名模板"}</strong></ItemTitle>
								<ItemDescription>{meta.join(" · ")}</ItemDescription>
							</ItemContent>
							<ItemActions>
								<button
									className="nvca-template-apply"
									disabled={Boolean(applyingId) || Boolean(item.error)}
									onClick={() => onApply(item.id)}
									type="button"
								>
									{applying ? <><Spinner aria-hidden size="sm" />{"克隆中…"}</> : item.error ? "不可用" : "克隆到画布"}
								</button>
							</ItemActions>
						</Item>
					)
				})}
			</div>
		</aside>
	)
}
