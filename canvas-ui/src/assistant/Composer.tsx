import type { SkillChip } from "./types"
import {
	PromptInput,
	PromptInputBody,
	PromptInputFooter,
	PromptInputTextarea,
	PromptInputTools,
} from "@/components/ai-elements/prompt-input"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { ArrowUpIcon, ChevronDownIcon, SparklesIcon, SquareIcon, XIcon } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { formatTokens } from "./format"
import type { AssistantStore } from "./store"

interface ComposerProps {
	store: AssistantStore
	pendingText: { text: string; token: number } | null
}

export const Composer = ({ store, pendingText }: ComposerProps) => {
	const { env } = store
	const textareaRef = useRef<HTMLTextAreaElement | null>(null)
	const [text, setText] = useState("")
	const [skillOpen, setSkillOpen] = useState(false)
	const activeSkill = useMemo(() => {
		const found = env.skills.find((skill) => skill.id === env.selectedSkillId)
		if (found) return found
		// 应用市场种子带的是 store:<id>，能力列表里没有，仍然要在 composer 上显示成一个技能 chip
		if (env.selectedSkillId) {
			return {
				id: env.selectedSkillId,
				name: env.selectedSkillName || env.selectedSkillId,
				icon: "✨",
			}
		}
		return null
	}, [env.skills, env.selectedSkillId, env.selectedSkillName])

	useEffect(() => {
		store.registerComposer((value: string) => {
			const node = textareaRef.current
			if (node) {
				node.value = value
				node.style.height = "auto"
				if (value) node.focus()
			}
			setText(value)
		})
		return () => store.registerComposer(null)
	}, [store])

	useEffect(() => {
		if (!pendingText) return
		const node = textareaRef.current
		if (!node) return
		node.value = pendingText.text
		node.focus()
		node.setSelectionRange(node.value.length, node.value.length)
		setText(pendingText.text)
	}, [pendingText])

	const submit = (message: { text: string }) => {
		const value = String(message.text || "").trim()
		if (!value) return
		if (env.running) {
			store.steer(value)
			setText("")
			return
		}
		store.send(value)
		setText("")
	}

	const handleSteer = () => {
		const value = String(textareaRef.current?.value || text || "").trim()
		if (!value) return
		store.steer(value)
		if (textareaRef.current) textareaRef.current.value = ""
		setText("")
	}

	const contextText = (() => {
		const usage = env.contextUsage
		if (!usage) return ""
		if (typeof usage.percentage === "number") return "上下文 " + Math.round(usage.percentage) + "%"
		if (typeof usage.used_tokens === "number") return "上下文 " + formatTokens(usage.used_tokens)
		return ""
	})()

	return (
		<div className="nvca-composer-wrap">
			{env.refs.length > 0 && (
				<div className="nvca-refs" role="list" aria-label="发送引用">
					{env.refs.map((ref) => (
						<span className="nvca-ref" key={ref.id} role="listitem">
							{ref.thumbUrl ? (
								<img className="nvca-ref-thumb" src={ref.thumbUrl} alt="" />
							) : (
								<span className="nvca-ref-thumb nvca-ref-thumb--fallback">
									{ref.kind === "video" ? "▶" : String(ref.name || "?").slice(0, 1)}
								</span>
							)}
							<span className="nvca-ref-name">{ref.name}</span>
							{ref.role ? <span className="nvca-ref-role">{ref.role}</span> : null}
							<button
								aria-label={"移除引用 " + ref.name}
								className="nvca-ref-remove"
								onClick={() => store.removeRef(ref.id)}
								type="button"
							>
								<XIcon className="nvca-i-xs" />
							</button>
						</span>
					))}
					{env.refs.length > 1 && (
						<button className="nvca-link-btn" onClick={() => store.clearRefs()} type="button">
							清除
						</button>
					)}
				</div>
			)}

			{activeSkill && (
				<div className="nvca-skill-row">
					<span className="nvca-skill-chip">
						<span className="nvca-skill-icon">{activeSkill.icon || "✨"}</span>
						<span className="nvca-skill-name">{activeSkill.name}</span>
						<button
							aria-label="取消本轮技能"
							className="nvca-skill-remove"
							onClick={() => store.clearSkill()}
							type="button"
						>
							<XIcon className="nvca-i-xs" />
						</button>
					</span>
				</div>
			)}

			<PromptInput className="nvca-prompt" onSubmit={submit}>
				<PromptInputBody>
					<PromptInputTextarea
						className="nvca-textarea"
						onChange={(event) => setText(event.currentTarget.value)}
						placeholder={env.running ? "运行中，输入内容按 Enter 插话" : "随心输入，Enter 发送，Shift + Enter 换行"}
						ref={textareaRef}
					/>
				</PromptInputBody>
				<PromptInputFooter className="nvca-prompt-footer">
					<PromptInputTools className="nvca-prompt-tools">
						<div className="nvca-skill-picker">
							<button
								aria-expanded={skillOpen}
								className={cn("nvca-pill-btn", activeSkill && "is-on")}
								onClick={() => setSkillOpen((open) => !open)}
								type="button"
							>
								<SparklesIcon className="nvca-i-sm" />
								<span>技能</span>
								<ChevronDownIcon className="nvca-i-xs" />
							</button>
							{skillOpen && (
								<div className="nvca-skill-menu" role="listbox">
									{env.skills.length === 0 ? (
										<div className="nvca-skill-empty">没有可用技能</div>
									) : (
										env.skills.map((skill: SkillChip) => (
											<button
												className={cn("nvca-skill-option", skill.id === env.selectedSkillId && "is-active")}
												key={skill.id}
												onClick={() => {
													store.chooseSkill(skill.id)
													setSkillOpen(false)
												}}
												role="option"
												aria-selected={skill.id === env.selectedSkillId}
												type="button"
											>
												<span className="nvca-skill-icon">{skill.icon || "✨"}</span>
												<span className="nvca-skill-option-body">
													<span className="nvca-skill-option-name">{skill.name}</span>
													{skill.description ? <span className="nvca-skill-option-desc">{skill.description}</span> : null}
												</span>
											</button>
										))
									)}
								</div>
							)}
						</div>
						<button
							aria-pressed={env.planConfirm}
							className={cn("nvca-pill-btn", env.planConfirm && "is-on")}
							onClick={() => store.togglePlanConfirm()}
							title={
								env.planConfirm
									? "写操作先出方案，点「开始」才动画布 / 消耗额度"
									: "关闭后只有聊天和只读动作直接执行；写操作服务端仍会先出方案"
							}
							type="button"
						>
							<span className={cn("nvca-dot", env.planConfirm && "is-on")} />
							<span>写操作先确认</span>
						</button>
						{contextText && (
							<span className="nvca-context" title="上下文占用为估算值">
								{contextText}
							</span>
						)}
					</PromptInputTools>
					<div className="nvca-prompt-actions">
						{env.running && text.trim() ? (
							<button className="nvca-steer-btn" onClick={handleSteer} title="把这句插给正在跑的这轮，下一轮生效" type="button">
								打断并发送
							</button>
						) : null}
						<TooltipProvider>
							<Tooltip>
								<TooltipTrigger
									render={
										<button
											aria-label={env.running ? "停止" : "发送"}
											className={cn("nvca-send-btn", env.running && "is-running")}
											onClick={() => {
												if (env.running) {
													store.abort()
													return
												}
												const value = String(textareaRef.current?.value || text || "").trim()
												if (value) submit({ text: value })
											}}
											type="button"
										/>
									}
								>
									{env.running ? <SquareIcon className="nvca-send-icon" /> : <ArrowUpIcon className="nvca-send-icon" />}
								</TooltipTrigger>
								<TooltipContent>{env.running ? "停止这一轮" : "发送（Enter）"}</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					</div>
				</PromptInputFooter>
			</PromptInput>
			<div className="nvca-composer-hint">
				<span>{env.notice || "引用选中的画布节点会随消息一起带上"}</span>
				{env.steerPending ? <span>插话发送中…</span> : null}
			</div>
		</div>
	)
}
