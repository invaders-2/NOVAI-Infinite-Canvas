import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import {
	Combobox,
	ComboboxCollection,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "@/components/hexta/combobox"

/* 对齐 animate-ui combobox 的节奏：选项 33ms 错峰、300ms 滑入；面板进出场交给 HextaUI 的 data-starting/ending-style */
const PANEL_OUT_MS = 150
const ITEM_IN_MS = 300
const ITEM_STAGGER_MS = 33
const ITEM_STAGGER_BASE = 10

const reducedMotion = () =>
	typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches

export type ComboCloseReason = "tab"

export interface ComboboxMenuProps<T> {
	open: boolean
	items: readonly T[]
	label: (item: T) => string
	value: (item: T) => string
	filterText?: (item: T) => string
	renderItem: (item: T) => ReactNode
	itemClassName: string | ((item: T) => string)
	onPick: (item: T) => void
	searchLabel: string
	searchPlaceholder: string
	empty: ReactNode
	footer?: ReactNode
	panelClassName: string
	panelAttrs?: Record<string, string>
	panelRef?: RefObject<HTMLDivElement | null>
	anchorEl?: HTMLElement | null
	side?: "top" | "right" | "bottom" | "left"
	sideOffset?: number
	autoFocus?: boolean
	resetKey?: string
	onHoverStart?: () => void
	onHoverEnd?: () => void
	onKeyClose?: (reason: ComboCloseReason) => void
	onExited?: () => void
}

export const ComboboxMenu = <T,>({
	open,
	items,
	label,
	value,
	filterText,
	renderItem,
	itemClassName,
	onPick,
	searchLabel,
	searchPlaceholder,
	empty,
	footer,
	panelClassName,
	panelAttrs,
	panelRef: externalPanelRef,
	anchorEl,
	side = "bottom",
	sideOffset = 6,
	autoFocus,
	resetKey,
	onHoverStart,
	onHoverEnd,
	onKeyClose,
	onExited,
}: ComboboxMenuProps<T>) => {
	const [visible, setVisible] = useState(open)
	const [query, setQuery] = useState("")
	const [box, setBox] = useState<{ top: number; height: number } | null>(null)
	const nodeRef = useRef<HTMLDivElement | null>(null)
	const listRef = useRef<HTMLDivElement | null>(null)
	const resizeFrame = useRef(0)
	const footerRef = useRef<HTMLDivElement | null>(null)
	const staggeredRef = useRef(false)
	const exitedRef = useRef(onExited)
	exitedRef.current = onExited

	const setNode = useCallback(
		(node: HTMLDivElement | null) => {
			nodeRef.current = node
			if (externalPanelRef) externalPanelRef.current = node
		},
		[externalPanelRef],
	)

	const inputNode = useCallback(() => nodeRef.current?.querySelector<HTMLInputElement>('[data-slot="combobox-input"]') ?? null, [])

	useEffect(() => {
		if (open) {
			setVisible(true)
			return
		}
		if (!visible) return
		/* 关闭时内容再留一拍，HextaUI 的 data-ending-style 过渡播完再卸载 */
		const timer = window.setTimeout(() => {
			setVisible(false)
			setBox(null)
			exitedRef.current?.()
		}, reducedMotion() ? 0 : PANEL_OUT_MS)
		return () => window.clearTimeout(timer)
	}, [open, visible])

	useEffect(() => {
		staggeredRef.current = false
	}, [open, resetKey])

	useEffect(() => {
		if (!open) return
		if (items.length === 0 || staggeredRef.current) return
		const frame = requestAnimationFrame(() => {
			const node = nodeRef.current
			if (!node || staggeredRef.current) return
			const rows = Array.from(node.querySelectorAll<HTMLElement>('[data-slot="combobox-item"], .nvca-combo-footer button'))
			if (!rows.length) return
			staggeredRef.current = true
			if (reducedMotion()) return
			const step = rows.length <= ITEM_STAGGER_BASE ? ITEM_STAGGER_MS : ITEM_STAGGER_MS * Math.sqrt(ITEM_STAGGER_BASE / rows.length)
			rows.forEach((row, index) => {
				row.animate(
					[
						{ opacity: 0, transform: "translate3d(8px, 0, 0)", filter: "blur(4px)" },
						{ opacity: 1, transform: "translate3d(0, 0, 0)", filter: "blur(0px)" },
					],
					{ duration: ITEM_IN_MS, delay: index * step, easing: "cubic-bezier(0.215, 0.61, 0.355, 1)", fill: "backwards" },
				)
			})
		})
		return () => cancelAnimationFrame(frame)
	}, [open, items.length, resetKey])

	useEffect(() => {
		if (open) setQuery("")
	}, [open, resetKey])

	useLayoutEffect(() => {
		if (!open || !autoFocus) return
		inputNode()?.focus()
	}, [open, autoFocus, resetKey, inputNode])

	useLayoutEffect(() => {
		if (!open || !visible) return
		const node = nodeRef.current
		const list = listRef.current
		if (!node || !list) return
		let frame = 0
		const sync = () => {
			frame = 0
			const active = list.querySelector<HTMLElement>("[data-highlighted]")
			if (!active) {
				setBox((current) => (current ? null : current))
				return
			}
			const rect = active.getBoundingClientRect()
			const base = list.getBoundingClientRect()
			const top = rect.top - base.top + list.scrollTop
			const height = rect.height
			setBox((current) => (current && Math.abs(current.top - top) < 0.5 && Math.abs(current.height - height) < 0.5 ? current : { top, height }))
		}
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(sync)
		}
		const observer = new MutationObserver(schedule)
		observer.observe(node, { attributes: true, attributeFilter: ["data-highlighted"], subtree: true })
		list.addEventListener("scroll", schedule, { passive: true })
		schedule()
		return () => {
			observer.disconnect()
			list.removeEventListener("scroll", schedule)
			if (frame) cancelAnimationFrame(frame)
		}
	}, [open, visible])

	/* 内容异步长高（技能/应用列表晚到）时，Base UI 不会自己重排，弹层会顶出视口；
	   尺寸一变就发一次 resize，让 Floating UI 的 autoUpdate 重新算位置和可用高度。 */
	useLayoutEffect(() => {
		if (!open) return
		const node = nodeRef.current
		if (!node || typeof ResizeObserver === "undefined") return
		const observer = new ResizeObserver(() => {
			if (resizeFrame.current) return
			resizeFrame.current = requestAnimationFrame(() => {
				resizeFrame.current = 0
				window.dispatchEvent(new Event("resize"))
			})
		})
		observer.observe(node)
		return () => {
			observer.disconnect()
			if (resizeFrame.current) {
				cancelAnimationFrame(resizeFrame.current)
				resizeFrame.current = 0
			}
		}
	}, [open, visible])

	/* 焦点在弹层外时（比如落在父菜单行上），↑/↓ 先把焦点送进搜索框 */
	useEffect(() => {
		if (!open) return
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
			const node = nodeRef.current
			const input = inputNode()
			if (!node || !input) return
			if (node.contains(document.activeElement)) return
			event.preventDefault()
			input.focus()
		}
		document.addEventListener("keydown", onKey, true)
		return () => document.removeEventListener("keydown", onKey, true)
	}, [open, inputNode])

	const onPanelKeyDownCapture = (event: React.KeyboardEvent<HTMLDivElement>) => {
		const key = event.key
		if (key === "Tab") {
			event.preventDefault()
			onKeyClose?.("tab")
			return
		}
		const footer = footerRef.current
		const buttons = footer ? Array.from(footer.querySelectorAll<HTMLButtonElement>("button:not([disabled])")) : []
		if (!buttons.length) return
		const focused = document.activeElement
		const inFooter = !!focused && footer!.contains(focused)
		if (key === "ArrowDown") {
			event.preventDefault()
			if (inFooter) {
				const next = buttons[buttons.indexOf(focused as HTMLButtonElement) + 1]
				if (next) next.focus()
				else inputNode()?.focus()
				return
			}
			if (!nodeRef.current) return
			const rows = Array.from(nodeRef.current.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]'))
			const highlighted = nodeRef.current.querySelector<HTMLElement>("[data-highlighted]")
			/* 选项列表走到头之后把 ↑/↓ 交给下面的管理动作，父菜单那份 document 级导航已经不管这里了 */
			if (highlighted ? rows[rows.length - 1] !== highlighted : rows.length > 0) return
			event.stopPropagation()
			buttons[0].focus()
			return
		}
		if (key === "ArrowUp" && inFooter) {
			event.preventDefault()
			event.stopPropagation()
			const prev = buttons[buttons.indexOf(focused as HTMLButtonElement) - 1]
			if (prev) prev.focus()
			else inputNode()?.focus()
		}
	}

	const matches = (item: T, nextQuery: string) => ((filterText ?? label)(item) || "").toLowerCase().includes(nextQuery.trim().toLowerCase())

	if (!visible) return null

	return (
		<Combobox
			filter={matches}
			highlightItemOnHover
			inputValue={query}
			itemToStringLabel={label}
			itemToStringValue={value}
			items={items}
			{...({ keepHighlight: true } as Record<string, unknown>)}
			onInputValueChange={(next) => setQuery(next)}
			open={open}
		>
			<ComboboxContent
				{...panelAttrs}
				align="start"
				anchor={anchorEl ?? undefined}
				className={panelClassName}
				data-combo-panel=""
				data-state={open ? "open" : "closed"}
				initialFocus={autoFocus ? undefined : false}
				onKeyDownCapture={onPanelKeyDownCapture}
				onMouseEnter={onHoverStart}
				onMouseLeave={onHoverEnd}
				ref={setNode}
				side={side}
				sideOffset={sideOffset}
			>
				<ComboboxInput aria-label={searchLabel} autoComplete="off" placeholder={searchPlaceholder} />
				<ComboboxEmpty className="nvca-combo-empty">{empty}</ComboboxEmpty>
				<ComboboxList className="nvca-combo-list" ref={listRef}>
					<div
						aria-hidden="true"
						className="nvca-combo-highlight"
						data-shown={box ? "true" : "false"}
						style={box ? { height: box.height, transform: "translate3d(0, " + box.top + "px, 0)" } : undefined}
					/>
					<ComboboxCollection>
						{(item: T) => (
							<ComboboxItem
								className={typeof itemClassName === "function" ? itemClassName(item) : itemClassName}
								data-combo-item=""
								key={value(item)}
								onClick={() => onPick(item)}
								value={value(item)}
							>
								{renderItem(item)}
							</ComboboxItem>
						)}
					</ComboboxCollection>
				</ComboboxList>
				{footer ? (
					<div className="nvca-combo-footer" ref={footerRef}>
						{footer}
					</div>
				) : null}
			</ComboboxContent>
		</Combobox>
	)
}
