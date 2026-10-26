import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import {
	ChevronRightIcon,
	FolderPlusIcon,
	LayoutGridIcon,
	LightbulbIcon,
	PaperclipIcon,
	PuzzleIcon,
	SquareArrowDownIcon,
} from "lucide-react"
import { fetchStoreCatalog, type StoreCatalogItem } from "./api"
import { chooseFolder, folderSupported } from "./folder"
import type { AssistantStore } from "./store"

type Submenu = "skills" | "apps" | null
type Point = { left: number; top: number }

interface PlusMenuProps {
	open: boolean
	anchor: HTMLElement | null
	store: AssistantStore
	onClose: () => void
	onPickCanvas: () => void
	onUpload: () => void
	onBrainstorm: () => void
}

const MENU_WIDTH = 358
const SUBMENU_WIDTH = 320
const ITEM_INDEX: Record<Exclude<Submenu, null>, number> = { skills: 3, apps: 5 }

const visibleAnchor = (anchor: HTMLElement | null): DOMRect | null => {
	if (!anchor || !anchor.isConnected) return null
	const rect = anchor.getBoundingClientRect()
	if (rect.width <= 0 || rect.height <= 0) return null
	if (rect.bottom < 0 || rect.top > window.innerHeight) return null
	return rect
}

export const PlusMenu = ({ open, anchor, store, onClose, onPickCanvas, onUpload, onBrainstorm }: PlusMenuProps) => {
	const [submenu, setSubmenu] = useState<Submenu>(null)
	const [menuPoint, setMenuPoint] = useState<Point>({ left: 12, top: 200 })
	const [submenuPoint, setSubmenuPoint] = useState<Point>({ left: 12, top: 200 })
	const [active, setActive] = useState(0)
	const [subActive, setSubActive] = useState(0)
	const [catalog, setCatalog] = useState<StoreCatalogItem[]>([])
	const [loading, setLoading] = useState(false)
	const menuRef = useRef<HTMLDivElement | null>(null)
	const submenuRef = useRef<HTMLDivElement | null>(null)

	const skills = catalog.filter((item) => item.kind === "skill").slice(0, 10)
	const apps = catalog.filter((item) => item.kind === "app").slice(0, 10)

	useLayoutEffect(() => {
		if (!open) return
		const place = () => {
			const rect = visibleAnchor(anchor)
			if (!rect) {
				onClose()
				return
			}
			const menu = menuRef.current
			const height = menu ? menu.offsetHeight : 330
			let left = rect.left
			if (left + MENU_WIDTH > window.innerWidth - 8) left = window.innerWidth - MENU_WIDTH - 8
			left = Math.max(8, left)
			let top = rect.top - 8 - height
			if (top < 8) top = Math.min(window.innerHeight - height - 8, rect.bottom + 8)
			setMenuPoint((current) => (current.left === left && current.top === top ? current : { left, top }))
		}
		place()
		const onViewport = () => place()
		window.addEventListener("resize", onViewport)
		window.addEventListener("scroll", onViewport, true)
		const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null
		if (anchor) observer?.observe(anchor)
		if (menuRef.current) observer?.observe(menuRef.current)
		return () => {
			window.removeEventListener("resize", onViewport)
			window.removeEventListener("scroll", onViewport, true)
			observer?.disconnect()
		}
	}, [open, anchor, onClose])

	useLayoutEffect(() => {
		if (!open || !submenu) return
		const place = () => {
			const row = menuRef.current?.querySelectorAll<HTMLElement>(".nvca-plus-item")[ITEM_INDEX[submenu]]
			const menu = menuRef.current
			if (!row || !menu) return
			const rowRect = row.getBoundingClientRect()
			let left = rowRect.right + 8
			if (left + SUBMENU_WIDTH > window.innerWidth - 8) left = rowRect.left - SUBMENU_WIDTH - 8
			left = Math.max(8, left)
			const top = Math.max(8, rowRect.top)
			setSubmenuPoint((current) => (current.left === left && current.top === top ? current : { left, top }))
		}
		place()
		const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null
		if (submenuRef.current) observer?.observe(submenuRef.current)
		return () => observer?.disconnect()
	}, [open, submenu, skills.length, apps.length, menuPoint])

	useEffect(() => {
		if (!open) {
			setSubmenu(null)
			setActive(0)
			return
		}
		setActive(0)
		setSubActive(0)
	}, [open])

	useEffect(() => {
		if (!open) return
		const onKey = (event: KeyboardEvent) => {
			const key = event.key
			if (key === "Escape") {
				event.preventDefault()
				if (submenu) setSubmenu(null)
				else onClose()
				return
			}
			if (submenu) {
				const rows = (submenu === "skills" ? skills.length : apps.length) + 1
				if (key === "ArrowDown") {
					event.preventDefault()
					setSubActive((value) => (value + 1) % rows)
				} else if (key === "ArrowUp") {
					event.preventDefault()
					setSubActive((value) => (value - 1 + rows) % rows)
				} else if (key === "Enter") {
					event.preventDefault()
					if (submenu === "skills" && skills[subActive]) chooseSkill(skills[subActive])
					else if (submenu === "apps" && apps[subActive]) chooseApp(apps[subActive])
					else openAll(submenu)
				}
				return
			}
			if (key === "ArrowDown") {
				event.preventDefault()
				setActive((value) => (value + 1) % 6)
			} else if (key === "ArrowUp") {
				event.preventDefault()
				setActive((value) => (value + 5) % 6)
			} else if (key === "Enter") {
				event.preventDefault()
				runItem(active)
			}
		}
		document.addEventListener("keydown", onKey, true)
		return () => document.removeEventListener("keydown", onKey, true)
	}, [open, submenu, skills, apps, active, subActive])

	useEffect(() => {
		if (!open) return
		const onDown = (event: PointerEvent) => {
			const target = event.target as Node | null
			if (!target) return
			if (menuRef.current?.contains(target) || submenuRef.current?.contains(target)) return
			if (anchor?.contains(target)) return
			onClose()
		}
		document.addEventListener("pointerdown", onDown, true)
		return () => document.removeEventListener("pointerdown", onDown, true)
	}, [open, anchor, onClose])

	useEffect(() => {
		if (!open || !submenu || catalog.length > 0) return
		setLoading(true)
		fetchStoreCatalog()
			.then((items) => setCatalog(items))
			.catch(() => store.notify("应用市场列表加载失败"))
			.finally(() => setLoading(false))
	}, [open, submenu, catalog.length, store])

	const chooseSkill = (item: StoreCatalogItem) => {
		store.addSkillRef({
			id: item.id,
			name: item.name,
			description: item.description,
			storeRef: "store:" + item.name,
		})
		store.notify("已添加技能引用：" + item.name)
		onClose()
	}

	const chooseApp = (item: StoreCatalogItem) => {
		store.addAppRef({
			id: item.id,
			name: item.name,
			description: item.description,
			activationSkill: item.activationSkill,
		})
		store.notify("已添加应用引用：" + item.name)
		onClose()
	}

	const openAll = (kind: Exclude<Submenu, null>) => {
		try {
			window.parent.postMessage({ type: "navigate", route: "store" }, location.origin)
		} catch {
			store.notify("打开应用市场失败")
		}
		onClose()
	}

	const addFolder = async () => {
		if (!folderSupported()) {
			store.notify("当前浏览器不支持本地文件夹授权")
			return
		}
		try {
			const info = await chooseFolder()
			if (!info) return
			store.addFolderRef(info.name, info.count)
			store.notify("已记住文件夹：" + info.name)
			onClose()
		} catch (error) {
			const name = String((error as Error)?.name || "")
			if (name !== "AbortError") store.notify((error as Error)?.message || "选择文件夹失败")
		}
	}

	const runItem = (index: number) => {
		switch (index) {
			case 0:
				onPickCanvas()
				break
			case 1:
				onUpload()
				break
			case 2:
				void addFolder()
				break
			case 3:
				setSubmenu("skills")
				setSubActive(0)
				break
			case 4:
				onBrainstorm()
				break
			case 5:
				setSubmenu("apps")
				setSubActive(0)
				break
		}
	}

	if (!open || !visibleAnchor(anchor)) return null

	const items = [
		{ label: "从画布添加", icon: SquareArrowDownIcon, disabled: false, chevron: false },
		{ label: "上传附件", icon: PaperclipIcon, disabled: false, chevron: false },
		{ label: "添加本地文件夹并记住授权", icon: FolderPlusIcon, disabled: !folderSupported(), chevron: false },
		{ label: "技能", icon: PuzzleIcon, disabled: false, chevron: true },
		{ label: "头脑风暴", icon: LightbulbIcon, disabled: false, chevron: false },
		{ label: "全部应用", icon: LayoutGridIcon, disabled: false, chevron: true },
	]

	return createPortal(
		<>
			<div className="nvca-plus-menu" ref={menuRef} role="menu" style={{ left: menuPoint.left, top: menuPoint.top }}>
				{items.map((item, index) => (
					<div key={item.label}>
						<button
							aria-disabled={item.disabled || undefined}
							className={"nvca-plus-item" + (active === index ? " is-active" : "") + (item.disabled ? " is-disabled" : "")}
							onClick={() => {
								if (item.disabled) {
									store.notify("当前浏览器不支持本地文件夹授权")
									return
								}
								runItem(index)
							}}
							onMouseEnter={() => setActive(index)}
							role="menuitem"
							type="button"
						>
							<item.icon className="nvca-plus-icon" />
							<span>{item.label}</span>
							{item.chevron ? <ChevronRightIcon className="nvca-plus-chevron" /> : null}
						</button>
						{index === 2 || index === 3 ? <div className="nvca-plus-separator" role="separator" /> : null}
					</div>
				))}
			</div>

			{submenu ? (
				<div
					className="nvca-plus-submenu"
					ref={submenuRef}
					role="menu"
					style={{ left: submenuPoint.left, top: submenuPoint.top, maxHeight: Math.max(48, window.innerHeight - submenuPoint.top - 12) }}
				>
					{loading && catalog.length === 0 ? (
						<div className="nvca-plus-empty">加载应用市场…</div>
					) : (
						<>
							{(submenu === "skills" ? skills : apps).map((item, index) => (
								<button
									className={"nvca-plus-subitem" + (subActive === index ? " is-active" : "")}
									key={item.id}
									onClick={() => (submenu === "skills" ? chooseSkill(item) : chooseApp(item))}
									onMouseEnter={() => setSubActive(index)}
									role="menuitem"
									type="button"
								>
									{submenu === "skills" ? <PuzzleIcon className="nvca-plus-icon" /> : <LayoutGridIcon className="nvca-plus-icon" />}
									<span className="nvca-plus-subcopy">
										<span className="nvca-plus-subname">{item.name}</span>
										<span className="nvca-plus-subdesc">{item.description}</span>
									</span>
								</button>
							))}
							<button
								className={"nvca-plus-subitem is-all" + (subActive === (submenu === "skills" ? skills.length : apps.length) ? " is-active" : "")}
								onClick={() => openAll(submenu)}
								onMouseEnter={() => setSubActive(submenu === "skills" ? skills.length : apps.length)}
								role="menuitem"
								type="button"
							>
								<span>{submenu === "skills" ? "查看全部技能" : "查看全部应用"}</span>
							</button>
						</>
					)}
				</div>
			) : null}
		</>,
		document.body,
	)
}
