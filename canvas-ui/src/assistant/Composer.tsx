import {
	ArrowUpIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	CircleIcon,
	HandIcon,
	ImageUpIcon,
	MicIcon,
	MousePointerSquareDashedIcon,
	PlusIcon,
	ScissorsIcon,
	ShieldIcon,
	SparklesIcon,
	SquareIcon,
	XIcon,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { cn } from "@/lib/utils"
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
	const [addOpen, setAddOpen] = useState(false)
	const [skillView, setSkillView] = useState(false)
	const [modelOpen, setModelOpen] = useState(false)
	const [contextOpen, setContextOpen] = useState(false)

	const activeSkill = useMemo(() => {
		const found = env.skills.find((skill) => skill.id === env.selectedSkillId)
		if (found) return found
		if (env.selectedSkillId) {
			return { id: env.selectedSkillId, name: env.selectedSkillName || env.selectedSkillId, icon: "✨" }
		}
		return null
	}, [env.skills, env.selectedSkillId, env.selectedSkillName])

	const modelGroups = useMemo(() => {
		const groups: { provider: string; providerName: string; models: string[] }[] = []
		for (const option of env.chatModels) {
			let group = groups.find((item) => item.provider === option.provider)
			if (!group) {
				group = { provider: option.provider, providerName: option.providerName || option.provider, models: [] }
				groups.push(group)
			}
			if (!group.models.includes(option.value)) group.models.push(option.value)
		}
		const hasCurrent = env.chatModels.some(
			(option) => option.provider === env.chatProvider && option.value === env.chatModel,
		)
		if (env.chatModel && !hasCurrent) {
			groups.unshift({ provider: env.chatProvider, providerName: env.chatProvider || "当前", models: [env.chatModel] })
		}
		return groups
	}, [env.chatModels, env.chatModel, env.chatProvider])

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

	const clearInput = () => {
		if (textareaRef.current) textareaRef.current.value = ""
		setText("")
	}

	const submit = () => {
		const value = String(textareaRef.current?.value ?? text ?? "").trim()
		if (!value) return
		if (env.running) {
			store.steer(value)
			clearInput()
			return
		}
		store.send(value)
		clearInput()
	}

	const voiceInput = () => {
		const Speech = (window as unknown as { SpeechRecognition?: new () => unknown; webkitSpeechRecognition?: new () => unknown })
		const Recognition = Speech.SpeechRecognition || Speech.webkitSpeechRecognition
		if (!Recognition) {
			store.notify("当前浏览器不支持语音输入")
			return
		}
		try {
			const recognition = new Recognition() as {
				lang: string
				onresult: (event: { results: { 0: { 0: { transcript: string } } } }) => void
				onerror: () => void
				start: () => void
			}
			recognition.lang = "zh-CN"
			recognition.onresult = (event) => {
				const transcript = event.results?.[0]?.[0]?.transcript || ""
				const node = textareaRef.current
				if (!node) return
				node.value = (node.value || "") + transcript
				setText(node.value)
			}
			recognition.onerror = () => store.notify("语音输入失败，请重试")
			recognition.start()
		} catch {
			store.notify("语音输入启动失败")
		}
	}

	const captureView = () => {
		const exportBtn = document.getElementById("smartExportToggle")
		if (exportBtn) {
			exportBtn.click()
			return
		}
		store.notify("画布截图入口还没准备好")
	}

	const contextLabel = (() => {
		const usage = env.contextUsage
		if (!usage) return "0%"
		if (typeof usage.percentage === "number") return Math.round(usage.percentage) + "%"
		if (typeof usage.used_tokens === "number") return formatTokens(usage.used_tokens)
		return "0%"
	})()

	const refCount = env.refs.length

	return (
		<div className="nvca-tap-composer">
			<div className="nvca-tap-composer-hint">
				<button className="nvca-tap-hint-btn" onClick={() => setAddOpen((open) => !open)} type="button">
					添加画布内容
				</button>
			</div>
			{(refCount > 0 || activeSkill) ? (
				<div className="nvca-tap-chips">
					{env.refs.map((ref) => (
						<span className="nvca-tap-chip" key={ref.id}>
							{ref.thumbUrl ? <img alt="" className="nvca-tap-chip-thumb" src={ref.thumbUrl} /> : <FolderClosedIcon className="nvca-i-xs" />}
							<span className="nvca-tap-chip-name">{ref.name}</span>
							<button aria-label={"移除引用 " + ref.name} onClick={() => store.removeRef(ref.id)} type="button">
								<XIcon className="nvca-i-xs" />
							</button>
						</span>
					))}
					{activeSkill ? (
						<span className="nvca-tap-chip is-skill">
							<span>{activeSkill.icon || "✨"}</span>
							<span className="nvca-tap-chip-name">{activeSkill.name}</span>
							<button aria-label="取消本轮技能" onClick={() => store.clearSkill()} type="button">
								<XIcon className="nvca-i-xs" />
							</button>
						</span>
					) : null}
				</div>
			) : null}

			<form
				className="nvca-tap-box"
				onSubmit={(event) => {
					event.preventDefault()
					submit()
				}}
			>
				<textarea
					aria-label="随心输入"
					className="nvca-tap-input"
					onChange={(event) => setText(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault()
							submit()
						}
					}}
					placeholder="随心输入"
					ref={textareaRef}
					rows={1}
					value={text}
				/>
				<div className="nvca-tap-toolbar">
					<div className="nvca-tap-tools-left">
						<div className="nvca-tap-add-wrap">
							<button
								aria-expanded={addOpen}
								className="nvca-tap-icon is-add"
								onClick={() => {
									setAddOpen((open) => !open)
									setSkillView(false)
								}}
								title="添加画布节点 / 素材"
								type="button"
							>
								<PlusIcon className="nvca-i-sm" />
							</button>
							{addOpen ? (
								<div className="nvca-tap-menu is-add">
									{skillView ? (
										<>
											<div className="nvca-tap-menu-label">选择技能</div>
											{env.skills.length === 0 ? (
												<div className="nvca-tap-menu-empty">没有可用技能</div>
											) : (
												env.skills.map((skill) => (
													<button
														className={cn("nvca-tap-menu-item", skill.id === env.selectedSkillId && "is-on")}
														key={skill.id}
														onClick={() => {
															store.chooseSkill(skill.id)
															setAddOpen(false)
															setSkillView(false)
														}}
														type="button"
													>
														<span className="nvca-tap-menu-icon">{skill.icon || "✨"}</span>
														<span className="nvca-tap-menu-text">{skill.name}</span>
														{skill.id === env.selectedSkillId ? <CheckIcon className="nvca-i-xs" /> : null}
													</button>
												))
											)}
										</>
									) : (
										<>
											<button
												className="nvca-tap-menu-item"
												onClick={() => {
													setAddOpen(false)
													store.addSelectedRefs()
												}}
												type="button"
											>
												<MousePointerSquareDashedIcon className="nvca-i-sm" />
												<span className="nvca-tap-menu-text">引用选中的画布节点</span>
											</button>
											<button
												className="nvca-tap-menu-item"
												onClick={() => {
													setAddOpen(false)
													store.pickUpload()
												}}
												type="button"
											>
												<ImageUpIcon className="nvca-i-sm" />
												<span className="nvca-tap-menu-text">上传素材（图片 / 视频）</span>
											</button>
											<button
												className="nvca-tap-menu-item"
												onClick={() => setSkillView(true)}
												type="button"
											>
												<SparklesIcon className="nvca-i-sm" />
												<span className="nvca-tap-menu-text">选择技能</span>
												<ChevronDownIcon className="nvca-i-xs nvca-tap-menu-caret" />
											</button>
										</>
									)}
								</div>
							) : null}
						</div>
						<button
							aria-label={"已选目录，当前 " + refCount + " 项"}
							className="nvca-tap-catalog"
							onClick={() => setAddOpen((open) => !open)}
							title={"已选目录（" + refCount + "）"}
							type="button"
						>
							<ShieldIcon className="nvca-i-sm" />
						</button>
						<button
							aria-pressed={env.planConfirm}
							className={cn("nvca-tap-manual", env.planConfirm && "is-on")}
							onClick={() => store.setPlanConfirm(!env.planConfirm)}
							title={env.planConfirm ? "手动生成：每轮先出方案" : "自动：只读步骤直接执行"}
							type="button"
						>
							<HandIcon className="nvca-i-sm" />
						</button>
						<button className="nvca-tap-icon is-shot" onClick={captureView} title="截图" type="button">
							<ScissorsIcon className="nvca-i-sm" />
						</button>
						<button className="nvca-tap-icon is-record" onClick={() => store.notify("截图与录屏接入中")} title="截图与录屏" type="button">
							<ChevronUpIcon className="nvca-i-sm" />
						</button>
					</div>
					<div className="nvca-tap-tools-right">
						<button
							aria-expanded={contextOpen}
							className="nvca-tap-context"
							onClick={() => setContextOpen((open) => !open)}
							title="上下文占用"
							type="button"
						>
							<CircleIcon className="nvca-i-sm" />
							<span className="nvca-sr-only">上下文占用 {contextLabel}</span>
						</button>
						{contextOpen ? (
							<div className="nvca-tap-menu is-context">
								<div className="nvca-tap-menu-label">上下文占用</div>
								<div className="nvca-tap-context-row">
									<span>已用</span>
									<span className="nvca-mono">
										{env.contextUsage && typeof env.contextUsage.used_tokens === "number"
											? formatTokens(env.contextUsage.used_tokens)
											: "—"}
									</span>
								</div>
								<div className="nvca-tap-context-row">
									<span>上限</span>
									<span className="nvca-mono">
										{env.contextUsage && typeof env.contextUsage.max_tokens === "number"
											? formatTokens(env.contextUsage.max_tokens)
											: "未设置"}
									</span>
								</div>
								<div className="nvca-tap-context-row">
									<span>本轮引用节点</span>
									<span className="nvca-mono">{refCount}</span>
								</div>
							</div>
						) : null}
						<button
							aria-expanded={modelOpen}
							aria-label="Auto：模型 / 生图平台"
							className="nvca-tap-auto"
							onClick={() => setModelOpen((open) => !open)}
							title="Auto（模型 / 生图平台）"
							type="button"
						>
							<SparklesIcon className="nvca-i-sm" />
						</button>
						{modelOpen ? (
							<div className="nvca-tap-menu is-model">
								<div className="nvca-tap-menu-label">对话模型</div>
								<div className="nvca-tap-model-list">
									{modelGroups.length === 0 ? <div className="nvca-tap-menu-empty">没有可用模型</div> : null}
									{modelGroups.map((group) => (
										<div key={group.provider || group.providerName}>
											<div className="nvca-tap-model-group">{group.providerName}</div>
											{group.models.map((model) => (
												<button
													className={cn(
														"nvca-tap-menu-item",
														env.chatModel === model && env.chatProvider === group.provider && "is-on",
													)}
													key={group.provider + ":" + model}
													onClick={() => {
														store.setChatModel(model, group.provider)
														setModelOpen(false)
													}}
													type="button"
												>
													<span className="nvca-tap-menu-text">{model}</span>
													{env.chatModel === model && env.chatProvider === group.provider ? (
														<CheckIcon className="nvca-i-xs" />
													) : null}
												</button>
											))}
										</div>
									))}
								</div>
								{env.imageProviders.length > 0 ? (
									<>
										<div className="nvca-tap-menu-label">生图平台</div>
										<button
											className={cn("nvca-tap-menu-item", !env.imageProvider && "is-on")}
											onClick={() => {
												store.setImageProvider("")
												setModelOpen(false)
											}}
											type="button"
										>
											<span className="nvca-tap-menu-text">自动（跟随模型）</span>
											{!env.imageProvider ? <CheckIcon className="nvca-i-xs" /> : null}
										</button>
										{env.imageProviders.map((provider) => (
											<button
												className={cn("nvca-tap-menu-item", env.imageProvider === provider.value && "is-on")}
												key={provider.value}
												onClick={() => {
													store.setImageProvider(provider.value)
													setModelOpen(false)
												}}
												type="button"
											>
												<span className="nvca-tap-menu-text">{provider.label}</span>
												{env.imageProvider === provider.value ? <CheckIcon className="nvca-i-xs" /> : null}
											</button>
										))}
									</>
								) : null}
							</div>
						) : null}
						<button className="nvca-tap-icon is-voice" onClick={voiceInput} title="语音输入" type="button">
							<MicIcon className="nvca-i-sm" />
						</button>
						<button
							aria-label={env.running ? "停止" : "发送"}
							className={cn("nvca-tap-send", env.running && "is-running")}
							disabled={!env.running && !text.trim()}
							onClick={() => {
								if (env.running) {
									store.abort()
									return
								}
								submit()
							}}
							type="button"
						>
							{env.running ? <SquareIcon className="nvca-i-sm" /> : <ArrowUpIcon className="nvca-i-sm" />}
						</button>
					</div>
				</div>
			</form>
			{env.notice ? <div className="nvca-tap-notice">{env.notice}</div> : null}
		</div>
	)
}
