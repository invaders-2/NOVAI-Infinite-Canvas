import { AlertCircleIcon, XIcon } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/hexta/dialog"
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/hexta/empty"
import { Progress } from "@/components/hexta/progress"
import { Spinner } from "@/components/hexta/spinner"
import { fetchModelContext } from "./api"
import type { ModelContext } from "./api"
import { formatTokens, sectionLabel } from "./format"

const CONTEXT_COLLAPSED_TOOLS = 8
const CONTEXT_MAX_TOOLS = 60

export const ModelContextDialog = ({ runId, onClose }: { runId: string; onClose: () => void }) => {
	const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
	const [data, setData] = useState<ModelContext | null>(null)
	const [error, setError] = useState("")
	const [expired, setExpired] = useState(false)
	const [toolsOpen, setToolsOpen] = useState(false)
	const [tick, setTick] = useState(0)

	useEffect(() => {
		let alive = true
		setStatus("loading")
		setExpired(false)
		setError("")
		fetchModelContext(runId).then((result) => {
			if (!alive) return
			if (result.ok === true) {
				setData(result.data)
				setStatus("ready")
			} else {
				setExpired(result.expired)
				setError(result.message)
				setStatus("error")
			}
		})
		return () => {
			alive = false
		}
	}, [runId, tick])

	const tools = useMemo(() => (Array.isArray(data?.tool_names) ? data?.tool_names || [] : []), [data])
	const sections = Array.isArray(data?.system_prompt_sections) ? data?.system_prompt_sections || [] : []
	const percent = typeof data?.percentage === "number" ? Math.max(0, Math.min(100, data.percentage)) : null
	const shownTools = toolsOpen ? tools.slice(0, CONTEXT_MAX_TOOLS) : tools.slice(0, CONTEXT_COLLAPSED_TOOLS)

	return (
		<Dialog
			onOpenChange={(next) => {
				if (!next) onClose()
			}}
			open
		>
			<DialogContent aria-label="本轮上下文" className="nvca-dialog nvca-context-dialog" showCloseButton={false}>
				<div className="nvca-dialog-head">
					<div>
						<DialogTitle className="nvca-dialog-title">本轮上下文</DialogTitle>
						<DialogDescription className="nvca-dialog-sub">看这轮实际发给模型的内容规模</DialogDescription>
					</div>
					<button aria-label="关闭上下文" className="nvca-icon-btn" onClick={onClose} title="关闭" type="button">
						<XIcon className="nvca-i-sm" />
					</button>
				</div>

				{status === "loading" ? (
					<div className="nvca-context-loading">
						<Spinner aria-hidden size="sm" />
						<span>正在读取上下文摘要…</span>
					</div>
				) : status === "error" ? (
					<Empty className="nvca-context-error" size="sm">
						<EmptyMedia>
							<AlertCircleIcon className="nvca-i-lg" />
						</EmptyMedia>
						<EmptyHeader>
							<EmptyTitle>{expired ? "这轮已过期，无法查看上下文" : "上下文读取失败"}</EmptyTitle>
							{expired ? null : <EmptyDescription>{error}</EmptyDescription>}
						</EmptyHeader>
						{expired ? null : (
							<EmptyContent>
								<button className="nvca-btn ghost" onClick={() => setTick((value) => value + 1)} type="button">重试</button>
							</EmptyContent>
						)}
					</Empty>
				) : data ? (
					<div className="nvca-context-body">
						<div className="nvca-context-row">
							<span className="nvca-context-key">模型</span>
							<span className="nvca-context-value nvca-mono">{data.model || "未记录"}</span>
						</div>
						<div className="nvca-context-row">
							<span className="nvca-context-key">估算 tokens</span>
							<span className="nvca-context-value nvca-mono">
								{typeof data.estimated_tokens === "number" ? formatTokens(data.estimated_tokens) : "—"}
								{typeof data.context_max === "number" ? " / " + formatTokens(data.context_max) : ""}
							</span>
						</div>
						{typeof data.context_max === "number" ? (
							<Progress className="nvca-context-progress" size="sm" value={percent ?? 0} />
						) : (
							<div className="nvca-context-hint">未设置上下文上限，只显示估算值。</div>
						)}
						<div className="nvca-context-row">
							<span className="nvca-context-key">系统提示</span>
							<span className="nvca-context-value nvca-mono">
								{typeof data.system_prompt_chars === "number" ? data.system_prompt_chars.toLocaleString("zh-CN") + " 字" : "—"}
							</span>
						</div>
						{sections.length ? (
							<div className="nvca-context-block">
								<span className="nvca-context-key">分段</span>
								<div className="nvca-context-chips">
									{sections.map((section) => (
										<span className="nvca-context-chip" key={section}>{sectionLabel(section)}</span>
									))}
								</div>
							</div>
						) : null}
						<div className="nvca-context-block">
							<div className="nvca-context-block-head">
								<span className="nvca-context-key">工具</span>
								<span className="nvca-context-value nvca-mono">{typeof data.tool_count === "number" ? data.tool_count + " 个" : "—"}</span>
								{tools.length > CONTEXT_COLLAPSED_TOOLS ? (
									<button className="nvca-link-btn" onClick={() => setToolsOpen((open) => !open)} type="button">
										{toolsOpen ? "收起" : "展开全部（" + tools.length + "）"}
									</button>
								) : null}
							</div>
							{tools.length ? (
								<div className="nvca-context-tools">
									{shownTools.map((tool) => (
										<span className="nvca-context-tool" key={tool} title={tool}>{tool}</span>
									))}
									{toolsOpen && tools.length > CONTEXT_MAX_TOOLS ? (
										<span className="nvca-context-tool is-more">仅展示前 {CONTEXT_MAX_TOOLS} 个</span>
									) : null}
								</div>
							) : null}
						</div>
						<div className="nvca-context-row">
							<span className="nvca-context-key">历史 / 指令</span>
							<span className="nvca-context-value nvca-mono">
								{typeof data.history_chars === "number" ? data.history_chars.toLocaleString("zh-CN") : "—"}
								{" / "}
								{typeof data.instruction_chars === "number" ? data.instruction_chars.toLocaleString("zh-CN") : "—"}
								{" 字"}
							</span>
						</div>
						<div className="nvca-context-foot">本地估算，不等于计费口径；不展示提示词原文</div>
					</div>
				) : null}
			</DialogContent>
		</Dialog>
	)
}
