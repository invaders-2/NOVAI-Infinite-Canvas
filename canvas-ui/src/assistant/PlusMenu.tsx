import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import {
	ArrowLeftIcon,
	ChevronRightIcon,
	FolderPlusIcon,
	LayoutGridIcon,
	LightbulbIcon,
	PaperclipIcon,
	PuzzleIcon,
	SquareArrowDownIcon,
} from "lucide-react"
import { fetchSkills, fetchStoreApps, type SkillRow, type StoreAppRow } from "./api"
import { chooseFolder, folderSupported } from "./folder"
import type { AssistantStore } from "./store"

type Submenu = "skills" | "apps" | null

interface PlusMenuProps {
	open: boolean
	anchor: HTMLElement | null
	store: AssistantStore
	onClose: () => void
	onPickCanvas: () => void
	onUpload: () => void
	onBrainstorm: () => void
}

const MENU_WIDTH = 360
const SUBMENU_WIDTH = 280

const isVisible = (element: HTMLElement | null) => Boolean(element && element.isConnected)

export const PlusMenu = ({ open, anchor, store, onClose, onPickCanvas, onUpload, onBrainstorm }: PlusMenuProps) => {
	const [submenu, setSubmenu] = useState<Submenu>(null)
	const [position, setPosition] = useState({ left: 12, top: 200 })
	const [active, setActive] = useState(0)
	const [subActive, setSubActive] = useState(0)
	const [skills, setSkills] = useState<SkillRow[]>([])
	const [apps, setApps] = useState<StoreAppRow[]>([])
	const [loading, setLoading] = useState(false)
	const menuRef = useRef<HTMLDivElement | null>(null)
	const submenuRef = useRef<HTMLDivElement | null>(null)

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
		if (!open || !anchor) return
		const place = () => {
			const rect = anchor.getBoundingClientRect()
			const width = Math.min(MENU_WIDTH, window.innerWidth - 24)
			const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
			const below = Math.max(200, window.innerHeight - rect.top + 8)
			setPosition({ left, top: below })
		}
		place()
		window.addEventListener("resize", place)
		return () => window.removeEventListener("resize", place)
	}, [open, anchor])

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
				const rows = submenu === "skills" ? skills.length : apps.length + 1
				if (key === "ArrowDown") {
					event.preventDefault()
					setSubActive((value) => (rows ? (value + 1) % rows : 0))
				} else if (key === "ArrowUp") {
					event.preventDefault()
					setSubActive((value) => (rows ? (value - 1 + rows) % rows : 0))
				} else if (key === "Enter") {
					event.preventDefault()
					if (submenu === "skills") {
						const skill = skills[subActive]
						if (skill) chooseSkill(skill)
					} else if (apps[subActive]) {
						chooseApp(apps[subActive])
					} else if (subActive === apps.length) {
						openAllApps()
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
			if (menuRef.current && menuRef.current.contains(target)) return
			if (submenuRef.current && submenuRef.current.contains(target)) return
			if (anchor && anchor.contains(target)) return
			onClose()
		}
		document.addEventListener("pointerdown", onDown, true)
		return () => document.removeEventListener("pointerdown", onDown, true)
	}, [open, anchor, onClose])

	useEffect(() => {
		if (!open || submenu !== "skills" || skills.length > 0) return
		setLoading(true)
		fetchSkills()
			.then((rows) => setSkills(rows))
			.catch(() => store.notify("技能列表加载失败"))
			.finally(() => setLoading(false))
	}, [open, submenu, skills.length, store])

	useEffect(() => {
		if (!open || submenu !== "apps" || apps.length > 0) return
		setLoading(true)
		fetchStoreApps()
			.then((rows) => setApps(rows))
			.catch(() => store.notify("应用列表加载失败"))
			.finally(() => setLoading(false))
	}, [open, submenu, apps.length, store])

	const chooseSkill = (skill: SkillRow) => {
		store.addSkillRef({ id: skill.id, name: skill.name, description: skill.description })
		store.notify("已添加技能引用：" + skill.name)
		onClose()
	}

	const chooseApp = (app: StoreAppRow) => {
		store.addAppRef({
			id: app.id,
			name: app.name,
			description: app.description,
			activationSkill: app.activationSkill,
		})
		store.notify("已添加应用引用：" + app.name)
		onClose()
	}

	const openAllApps = () => {
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

	const submenuPosition = () => {
		const menu = menuRef.current
		if (!menu) return { left: position.left, top: position.top }
		const rect = menu.getBoundingClientRect()
		const left = rect.left - SUBMENU_WIDTH - 8
		const top = Math.max(8, Math.min(rect.top, window.innerHeight - Math.min(420, window.innerHeight - 16) - 8))
		return { left: left >= 8 ? left : rect.right + 8, top }
	}

	if (!open || !isVisible(anchor)) return null

	const submenuStyle = submenuPosition()
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
			<div
				className="nvca-plus-menu"
				ref={menuRef}
				role="menu"
				style={{ left: position.left, bottom: position.top }}
			>
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
					style={{ left: submenuStyle.left, top: submenuStyle.top }}
				>
					<button className="nvca-plus-subhead" onClick={() => setSubmenu(null)} type="button">
						<ArrowLeftIcon className="nvca-plus-chevron" />
						<span>{submenu === "skills" ? "技能" : "全部应用"}</span>
					</button>
					{submenu === "skills" ? (
						loading && skills.length === 0 ? (
							<div className="nvca-plus-empty">加载技能…</div>
						) : skills.length === 0 ? (
							<div className="nvca-plus-empty">暂时没有可用技能</div>
						) : (
							skills.map((skill, index) => (
								<button
									className={"nvca-plus-subitem" + (subActive === index ? " is-active" : "")}
									key={skill.id}
									onClick={() => chooseSkill(skill)}
									onMouseEnter={() => setSubActive(index)}
									role="menuitem"
									type="button"
								>
									<PuzzleIcon className="nvca-plus-icon" />
									<span>{skill.name}</span>
								</button>
							))
						)
					) : loading && apps.length === 0 ? (
						<div className="nvca-plus-empty">加载应用…</div>
					) : apps.length === 0 ? (
						<div className="nvca-plus-empty">暂时没有可用应用</div>
					) : (
						<>
							{apps.map((app, index) => (
								<button
									className={"nvca-plus-subitem" + (subActive === index ? " is-active" : "")}
									key={app.id}
									onClick={() => chooseApp(app)}
									onMouseEnter={() => setSubActive(index)}
									role="menuitem"
									type="button"
								>
									<LayoutGridIcon className="nvca-plus-icon" />
									<span>{app.name}</span>
								</button>
							))}
							<div className="nvca-plus-separator" role="separator" />
							<button
								className={"nvca-plus-subitem is-all" + (subActive === apps.length ? " is-active" : "")}
								onClick={openAllApps}
								onMouseEnter={() => setSubActive(apps.length)}
								role="menuitem"
								type="button"
							>
								<span>查看全部</span>
								<ChevronRightIcon className="nvca-plus-chevron" />
							</button>
						</>
					)}
				</div>
			) : null}
		</>,
		document.body,
	)
}
