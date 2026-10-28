import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { CheckIcon, ChevronRightIcon } from "lucide-react"
import { cn } from "@/lib/utils"

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

interface FlyoutPoint {
	left: number
	top: number
	maxHeight: number
	flipped: boolean
}

const FLYOUT_WIDTH = 252
const FLYOUT_GAP = 6
const FLYOUT_MAX_HEIGHT = 320
const VIEWPORT_MARGIN = 8
/* 离开供应商行到进入子弹层之间的宽限，斜着拖鼠标时子弹层不会消失 */
const LEAVE_DELAY = 120

export const ModelProviderMenu = ({ groups, chatModel, chatProvider, onPick }: ModelProviderMenuProps) => {
	const [active, setActive] = useState<number | null>(null)
	const [point, setPoint] = useState<FlyoutPoint>({ left: 0, top: 0, maxHeight: FLYOUT_MAX_HEIGHT, flipped: false })
	const rowRefs = useRef<(HTMLButtonElement | null)[]>([])
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
			setActive(null)
		}, LEAVE_DELAY)
	}

	const open = (index: number) => {
		cancelLeave()
		setActive(index)
	}

	useEffect(() => cancelLeave, [])

	useLayoutEffect(() => {
		if (active === null) return
		const place = () => {
			const row = rowRefs.current[active]
			if (!row || !row.isConnected) return
			const rect = row.getBoundingClientRect()
			const maxHeight = Math.min(FLYOUT_MAX_HEIGHT, window.innerHeight - VIEWPORT_MARGIN * 2)
			let left = rect.right + FLYOUT_GAP
			let flipped = false
			/* 右侧放不下就翻到供应商行左边 */
			if (left + FLYOUT_WIDTH > window.innerWidth - VIEWPORT_MARGIN) {
				left = rect.left - FLYOUT_WIDTH - FLYOUT_GAP
				flipped = true
			}
			left = Math.max(VIEWPORT_MARGIN, left)
			const top = Math.min(Math.max(VIEWPORT_MARGIN, rect.top - FLYOUT_GAP), window.innerHeight - maxHeight - VIEWPORT_MARGIN)
			setPoint((current) =>
				current.left === left && current.top === top && current.maxHeight === maxHeight && current.flipped === flipped
					? current
					: { left, top, maxHeight, flipped },
			)
		}
		place()
		window.addEventListener("resize", place)
		window.addEventListener("scroll", place, true)
		return () => {
			window.removeEventListener("resize", place)
			window.removeEventListener("scroll", place, true)
		}
	}, [active])

	const activeGroup = active === null ? null : groups[active]

	return (
		<>
			<div aria-label="对话模型供应商" className="nvca-tap-model-list" onMouseLeave={scheduleLeave} role="menu">
				{groups.length === 0 ? <div className="nvca-tap-menu-empty">没有可用模型</div> : null}
				{groups.map((group, index) => {
					const isCurrent = group.provider === chatProvider && group.models.includes(chatModel)
					return (
						<button
							aria-expanded={active === index}
							aria-haspopup="menu"
							className={cn("nvca-model-provider", isCurrent && "is-on", active === index && "is-active")}
							key={group.provider + ":" + index}
							onClick={() => open(index)}
							onFocus={() => open(index)}
							onMouseEnter={() => open(index)}
							ref={(node) => {
								rowRefs.current[index] = node
							}}
							role="menuitem"
							type="button"
						>
							<span className="nvca-model-provider-copy">
								<span className="nvca-model-provider-name">{group.providerName}</span>
								{isCurrent ? <span className="nvca-model-provider-hint">当前 · {chatModel}</span> : null}
							</span>
							<ChevronRightIcon className="nvca-model-provider-caret" />
						</button>
					)
				})}
			</div>
			{activeGroup
				? createPortal(
						<div
							aria-label={activeGroup.providerName + " 的对话模型"}
							className={cn("nvca-model-flyout", point.flipped && "is-flipped")}
							data-nvca-model-layer=""
							onMouseEnter={cancelLeave}
							onMouseLeave={scheduleLeave}
							role="menu"
							style={{ left: point.left, maxHeight: point.maxHeight, top: point.top }}
						>
							{activeGroup.models.length === 0 ? <div className="nvca-model-empty">这个供应商还没有模型</div> : null}
							{activeGroup.models.map((model) => {
								const isOn = model === chatModel && activeGroup.provider === chatProvider
								return (
									<button
										className={cn("nvca-model-option", isOn && "is-on")}
										key={model}
										onClick={() => onPick(model, activeGroup.provider)}
										role="menuitem"
										type="button"
									>
										<span className="nvca-model-option-name">{model}</span>
										{isOn ? <CheckIcon className="nvca-i-xs" /> : null}
									</button>
								)
							})}
						</div>,
						document.body,
					)
				: null}
		</>
	)
}
