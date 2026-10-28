import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import {
	ChevronRightIcon,
	FolderPlusIcon,
	LayoutGridIcon,
	LightbulbIcon,
	PaperclipIcon,
	PlusIcon,
	PuzzleIcon,
	SearchIcon,
	Settings2Icon,
	SquareArrowDownIcon,
	UploadIcon,
} from "lucide-react"
import { fetchSkills, fetchStoreCatalog, importSkill, type SkillRow, type StoreCatalogItem } from "./api"
import { chooseFolder, folderSupported } from "./folder"
import type { AssistantStore } from "./store"

type Submenu = "skills" | "apps" | null
type Point = { left: number; top: number }
type SubmenuPoint = { left: number; maxHeight: number; top?: number; bottom?: number }

interface PlusMenuProps {
	open: boolean
	anchor: HTMLElement | null
	store: AssistantStore
	onClose: () => void
	onPickCanvas: () => void
	onUpload: () => void
	onBrainstorm: () => void
}

const MENU_WIDTH = 252
const SUBMENU_WIDTH = 288
const ITEM_INDEX: Record<Exclude<Submenu, null>, number> = { skills: 2, apps: 4 }

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
	const [submenuPoint, setSubmenuPoint] = useState<SubmenuPoint>({ left: 12, top: 200, maxHeight: 400 })
	const [active, setActive] = useState(0)
	const [subActive, setSubActive] = useState(0)
	const [catalog, setCatalog] = useState<StoreCatalogItem[]>([])
	const [skillRows, setSkillRows] = useState<SkillRow[]>([])
	const [skillQuery, setSkillQuery] = useState("")
	const [appQuery, setAppQuery] = useState("")
	const [loading, setLoading] = useState(false)
	const [importing, setImporting] = useState(false)
	const menuRef = useRef<HTMLDivElement | null>(null)
	const submenuRef = useRef<HTMLDivElement | null>(null)
	const skillFileInputRef = useRef<HTMLInputElement | null>(null)
	const skillFolderInputRef = useRef<HTMLInputElement | null>(null)

	const normalizedSkillQuery = skillQuery.trim().toLowerCase()
	const normalizedAppQuery = appQuery.trim().toLowerCase()
	const skills = skillRows.filter((item) => !normalizedSkillQuery || (item.name + " " + item.id + " " + item.description).toLowerCase().includes(normalizedSkillQuery))
	const apps = catalog.filter((item) => item.kind === "app" && item.installed && (!normalizedAppQuery || (item.name + " " + item.id + " " + item.description).toLowerCase().includes(normalizedAppQuery))).slice(0, 10)

	useLayoutEffect(() => {
		if (!open) return
		const place = () => {
			const rect = visibleAnchor(anchor)
			if (!rect) {
				onClose()
				return
			}
			const menu = menuRef.current
			const height = menu ? menu.offsetHeight : 220
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
			const spaceBelow = window.innerHeight - rowRect.bottom - 12
			const maxHeight = Math.min(420, window.innerHeight - 16)
			const next: SubmenuPoint = submenu === "skills" && spaceBelow < 420
				? { left, maxHeight, top: Math.max(8, window.innerHeight - maxHeight - 8) }
				: spaceBelow >= 150
					? { left, maxHeight: Math.min(maxHeight, window.innerHeight - rowRect.top - 12), top: Math.max(8, rowRect.top) }
					: { left, maxHeight, top: Math.max(8, window.innerHeight - maxHeight - 8) }
			setSubmenuPoint((current) => (current.left === next.left && current.top === next.top && current.bottom === next.bottom && current.maxHeight === next.maxHeight ? current : next))
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
				if ((event.target as HTMLElement | null)?.tagName === "INPUT" && key !== "Escape") return
				const rows = (submenu === "skills" ? skills.length + 4 : apps.length + 1)
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
					else if (submenu === "apps") openAll(submenu)
					else {
						const action = subActive - skills.length
						if (action === 0) skillFileInputRef.current?.click()
						else if (action === 1) skillFolderInputRef.current?.click()
						else if (action === 2) createSkill()
						else openAll("skills")
					}
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
		if (!open || !submenu) return
		if (submenu === "skills" && skillRows.length === 0) {
			setLoading(true)
			fetchSkills()
				.then(setSkillRows)
				.catch(() => store.notify("技能列表加载失败"))
				.finally(() => setLoading(false))
		}
		if (submenu === "apps") {
			setLoading(true)
			fetchStoreCatalog()
				.then(setCatalog)
				.catch(() => store.notify("应用市场列表加载失败"))
				.finally(() => setLoading(false))
		}
	}, [open, submenu, skillRows.length, store])

	const chooseSkill = (item: SkillRow) => {
		store.addSkillRef({ id: item.id, name: item.name, description: item.description })
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

	const importSkillFiles = async (files: FileList | null) => {
		if (!files?.length || importing) return
		setImporting(true)
		let completed = 0
		try {
			for (const file of Array.from(files)) {
				try {
					const skill = await importSkill(await file.text())
					completed += 1
					setSkillRows((current) => [...current.filter((item) => item.id !== skill.id), skill])
				} catch (error) {
					store.notify(file.name + "：" + ((error as Error)?.message || "导入失败"))
				}
			}
			if (completed) {
				store.notify("已导入 " + completed + " 个技能")
				onClose()
			}
		} finally {
			setImporting(false)
			if (skillFileInputRef.current) skillFileInputRef.current.value = ""
			if (skillFolderInputRef.current) skillFolderInputRef.current.value = ""
		}
	}

	const createSkill = () => {
		store.fillComposer("请帮我创建一个可复用的 SKILL.md 技能。先询问这个技能要完成什么、输入和输出是什么，再生成完整技能文件。\n")
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
				setSubmenu("skills")
				setSubActive(0)
				break
			case 3:
				onBrainstorm()
				break
			case 4:
				setSubmenu("apps")
				setSubActive(0)
				break
		}
	}

	if (!open || !visibleAnchor(anchor)) return null

	const items = [
		{ label: "从画布添加", icon: SquareArrowDownIcon, disabled: false, chevron: false },
		{ label: "上传附件", icon: PaperclipIcon, disabled: false, chevron: false },
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
						{index === 1 || index === 2 ? <div className="nvca-plus-separator" role="separator" /> : null}
					</div>
				))}
			</div>

			{submenu ? (
				<div
					className={"nvca-plus-submenu" + (submenu === "skills" ? " is-skills" : " is-apps")}
					ref={submenuRef}
					role="menu"
					style={{ left: submenuPoint.left, top: submenuPoint.top, maxHeight: submenuPoint.maxHeight }}
				>
					{submenu === "skills" ? (
						<>
							<label className="nvca-plus-search"><SearchIcon className="nvca-i-sm" /><input aria-label="搜索技能" onChange={(event) => { setSkillQuery(event.currentTarget.value); setSubActive(0) }} placeholder="搜索技能" value={skillQuery} /></label>
							<div className="nvca-plus-sublist">
								{loading && skillRows.length === 0 ? <div className="nvca-plus-empty">加载技能…</div> : null}
								{!loading && skills.length === 0 ? <div className="nvca-plus-empty">没有匹配的技能</div> : null}
								{skills.map((item, index) => (
									<button className={"nvca-plus-subitem" + (subActive === index ? " is-active" : "")} key={item.id} onClick={() => chooseSkill(item)} onMouseEnter={() => setSubActive(index)} role="menuitem" type="button">
										<PuzzleIcon className="nvca-plus-icon" />
										<span className="nvca-plus-subcopy"><span className="nvca-plus-subname">{item.name}</span></span>
									</button>
								))}
							</div>
							<div className="nvca-plus-management">
								<button className={"nvca-plus-subitem" + (subActive === skills.length ? " is-active" : "")} disabled={importing} onClick={() => skillFileInputRef.current?.click()} role="menuitem" type="button"><UploadIcon className="nvca-plus-icon" /><span>上传技能文件</span></button>
								<button className={"nvca-plus-subitem" + (subActive === skills.length + 1 ? " is-active" : "")} disabled={importing} onClick={() => skillFolderInputRef.current?.click()} role="menuitem" type="button"><FolderPlusIcon className="nvca-plus-icon" /><span>上传技能文件夹</span></button>
								<button className={"nvca-plus-subitem" + (subActive === skills.length + 2 ? " is-active" : "")} onClick={createSkill} role="menuitem" type="button"><PlusIcon className="nvca-plus-icon" /><span>创建技能</span></button>
								<button className={"nvca-plus-subitem is-all" + (subActive === skills.length + 3 ? " is-active" : "")} onClick={() => openAll("skills")} role="menuitem" type="button"><Settings2Icon className="nvca-plus-icon" /><span>管理技能</span></button>
							</div>
						</>
					) : (
						<>
							<label className="nvca-plus-search"><SearchIcon className="nvca-i-sm" /><input aria-label="搜索应用" onChange={(event) => { setAppQuery(event.currentTarget.value); setSubActive(0) }} placeholder="搜索应用" value={appQuery} /></label>
							<div className="nvca-plus-sublist">
								{loading && catalog.length === 0 ? <div className="nvca-plus-empty">加载应用市场…</div> : null}
								{!loading && apps.length === 0 ? <div className="nvca-plus-empty">{normalizedAppQuery ? "没有匹配的应用" : "暂无已安装应用"}</div> : null}
								{apps.map((item, index) => (
									<button className={"nvca-plus-subitem" + (subActive === index ? " is-active" : "")} key={item.id} onClick={() => chooseApp(item)} onMouseEnter={() => setSubActive(index)} role="menuitem" type="button">
										<LayoutGridIcon className="nvca-plus-icon" />
										<span className="nvca-plus-subcopy"><span className="nvca-plus-subname">{item.name}</span><span className="nvca-plus-subdesc">{item.description}</span></span>
									</button>
								))}
							</div>
							<button className={"nvca-plus-subitem is-all" + (subActive === apps.length ? " is-active" : "")} onClick={() => openAll("apps")} role="menuitem" type="button"><span>管理应用</span></button>
						</>
					)}
				</div>
			) : null}
			<input accept=".md,.markdown" className="nvca-sr-only" multiple onChange={(event) => void importSkillFiles(event.currentTarget.files)} ref={skillFileInputRef} type="file" />
			<input accept=".md,.markdown" className="nvca-sr-only" multiple onChange={(event) => void importSkillFiles(event.currentTarget.files)} ref={skillFolderInputRef} type="file" {...({ webkitdirectory: "" } as Record<string, string>)} />
		</>,
		document.body,
	)
}
