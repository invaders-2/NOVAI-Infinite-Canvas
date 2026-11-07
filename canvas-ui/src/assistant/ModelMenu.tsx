import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { CheckIcon, ChevronRightIcon } from "lucide-react"
import { Item } from "@/components/hexta/item"
import { cn } from "@/lib/utils"
import { ComboboxMenu } from "./combobox"

export interface ModelGroup {
	provider: string
	providerName: string
	models: string[]
}

interface ModelProviderMenuProps {
	groups: ModelGroup[]
	chatModel: string
	chatProvider: string
	onPick: (model: string, provider: string) => void
}

/* 离开供应商行到进入子弹层之间的宽限，斜着拖鼠标时子弹层不会消失 */
const LEAVE_DELAY = 120

export const ModelProviderMenu = ({ groups, chatModel, chatProvider, onPick }: ModelProviderMenuProps) => {
	const [active, setActive] = useState<number | null>(null)
	const [flyoutOpen, setFlyoutOpen] = useState(false)
	const [focusSearch, setFocusSearch] = useState(false)
	const rowRefs = useRef<(HTMLElement | null)[]>([])
	const leaveTimer = useRef<number | null>(null)

	const cancelLeave = () => {
		if (leaveTimer.current === null) return
		window.clearTimeout(leaveTimer.current)
		leaveTimer.current = null
	}

	const scheduleLeave = () => {
		cancelLeave()
		leaveTimer.current = window.setTimeout(() => {
			leaveTimer.current = null
			setFlyoutOpen(false)
		}, LEAVE_DELAY)
	}

	const open = (index: number, focus: boolean) => {
		cancelLeave()
		setActive(index)
		setFlyoutOpen(true)
		setFocusSearch(focus)
	}

	const closeFlyout = () => {
		cancelLeave()
		setFlyoutOpen(false)
		if (active === null) return
		rowRefs.current[active]?.focus()
	}

	useEffect(() => cancelLeave, [])

	useEffect(() => {
		if (active === null) return
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return
			if (!flyoutOpen) return
			event.preventDefault()
			event.stopPropagation()
			closeFlyout()
		}
		document.addEventListener("keydown", onKey, true)
		return () => document.removeEventListener("keydown", onKey, true)
	}, [active, flyoutOpen])

	const activeGroup = active === null ? null : groups[active]
	/* 子弹层锚在供应商行上，右侧放不下由 HextaUI 的碰撞避让自动翻到左边 */
	const anchorEl = active === null ? null : rowRefs.current[active] ?? null

	return (
		<>
			<div aria-label="对话模型供应商" className="nvca-tap-model-list" onMouseLeave={scheduleLeave} role="menu">
				{groups.length === 0 ? <div className="nvca-tap-menu-empty">没有可用模型</div> : null}
				{groups.map((group, index) => {
					const isCurrent = group.provider === chatProvider && group.models.includes(chatModel)
					return (
						<Item
							aria-expanded={active === index}
							aria-haspopup="menu"
							className={cn("nvca-model-provider", isCurrent && "is-on", active === index && "is-active")}
							key={group.provider + ":" + index}
							onClick={() => open(index, true)}
							onFocus={() => open(index, false)}
							onMouseEnter={() => open(index, false)}
							ref={(node) => {
								rowRefs.current[index] = node
							}}
							render={<button type="button" />}
							role="menuitem"
							size="xs"
						>
							<span className="nvca-model-provider-copy">
								<span className="nvca-model-provider-name">{group.providerName}</span>
								{isCurrent ? <span className="nvca-model-provider-hint">当前 · {chatModel}</span> : null}
							</span>
							<ChevronRightIcon className="nvca-model-provider-caret" />
						</Item>
					)
				})}
			</div>
			{activeGroup
				? createPortal(
						<ComboboxMenu<string>
							anchorEl={anchorEl}
							autoFocus={focusSearch}
							empty={activeGroup.models.length === 0 ? "这个供应商还没有模型" : "没有匹配的模型"}
							itemClassName={(model) => cn("nvca-model-option nvca-combo-item", model === chatModel && activeGroup.provider === chatProvider && "is-on")}
							items={activeGroup.models}
							label={(model) => model}
							onExited={() => setActive(null)}
							onHoverEnd={scheduleLeave}
							onHoverStart={cancelLeave}
							onKeyClose={closeFlyout}
							onPick={(model) => onPick(model, activeGroup.provider)}
							open={flyoutOpen}
							panelAttrs={{ "data-nvca-model-layer": "" }}
							panelClassName="nvca-model-flyout is-t6"
							renderItem={(model) => (
								<>
									<span className="nvca-model-option-name">{model}</span>
									{model === chatModel && activeGroup.provider === chatProvider ? <CheckIcon className="nvca-i-xs" /> : null}
								</>
							)}
							resetKey={activeGroup.provider}
							searchLabel="搜索模型"
							searchPlaceholder="搜索模型"
							side="right"
							value={(model) => model}
						/>,
						document.body,
					)
				: null}
		</>
	)
}
