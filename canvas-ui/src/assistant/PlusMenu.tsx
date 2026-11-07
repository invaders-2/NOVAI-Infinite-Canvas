import { useEffect, useMemo, useRef, useState } from "react"
import {
	ChevronRightIcon,
	FolderPlusIcon,
	LayoutGridIcon,
	LightbulbIcon,
	PaperclipIcon,
	PlusIcon,
	PuzzleIcon,
	SquareArrowDownIcon,
	UploadIcon,
} from "lucide-react"
import { Item, ItemSeparator } from "@/components/hexta/item"
import { Popover, PopoverContent } from "@/components/hexta/popover"
import { fetchSkills, fetchStoreCatalog, importSkill, type SkillRow, type StoreCatalogItem } from "./api"
import { ComboboxMenu } from "./combobox"
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
	const [submenuOpen, setSubmenuOpen] = useState(false)
	const [active, setActive] = useState(0)
	const [catalog, setCatalog] = useState<StoreCatalogItem[]>([])
	const [skillRows, setSkillRows] = useState<SkillRow[]>([])
	const [loading, setLoading] = useState(false)
	const [importing, setImporting] = useState(false)
	const rowRefs = useRef<(HTMLElement | null)[]>([])
	const hoverTimer = useRef<number | null>(null)
	const closeTimer = useRef<number | null>(null)
	const skillFileInputRef = useRef<HTMLInputElement | null>(null)
	const skillFolderInputRef = useRef<HTMLInputElement | null>(null)

	const apps = useMemo(
		() => catalog.filter((item) => item.kind === "app" && item.installed && item.storeVisible).slice(0, 10),
		[catalog],
	)

	useEffect(() => {
		if (open) {
			setActive(0)
			return
		}
		clearTimers()
		setSubmenu(null)
		setSubmenuOpen(false)
		setActive(0)
	}, [open])

	useEffect(() => {
		if (!open) return
		const onKey = (event: KeyboardEvent) => {
			const key = event.key
			if (key === "Escape") {
				event.preventDefault()
				if (submenuOpen) {
					/* 拦住输入框自己的 Esc 处理，否则关闭动画里列表会先被清空搜索词 */
					event.stopPropagation()
					closeSubmenu(true)
				} else if (!submenu) {
					onClose()
				}
				return
			}
			/* 子菜单的 ↑/↓/Enter/Tab 交给 HextaUI combobox，这里只管父菜单 */
			if (submenu) return
			if (key === "ArrowDown") {
				event.preventDefault()
				setActive((value) => (value + 1) % 4)
			} else if (key === "ArrowUp") {
				event.preventDefault()
				setActive((value) => (value + 3) % 4)
			} else if (key === "Enter") {
				event.preventDefault()
				runItem(active)
			}
		}
		document.addEventListener("keydown", onKey, true)
		return () => document.removeEventListener("keydown", onKey, true)
	}, [open, submenu, submenuOpen, active, onClose])

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

	const clearTimers = () => {
		if (hoverTimer.current) {
			window.clearTimeout(hoverTimer.current)
			hoverTimer.current = null
		}
		if (closeTimer.current) {
			window.clearTimeout(closeTimer.current)
			closeTimer.current = null
		}
	}

	const cancelClose = () => {
		if (!closeTimer.current) return
		window.clearTimeout(closeTimer.current)
		closeTimer.current = null
	}

	const cancelOpen = () => {
		if (!hoverTimer.current) return
		window.clearTimeout(hoverTimer.current)
		hoverTimer.current = null
	}

	/* 悬停开二级：进到带箭头的行 150ms 后开，行与二级面板之间留 180ms 宽限，斜着移到面板里不会闪关 */
	const scheduleOpen = () => {
		cancelOpen()
		hoverTimer.current = window.setTimeout(() => {
			hoverTimer.current = null
			openSubmenu("skills")
		}, 150)
	}

	const scheduleClose = () => {
		cancelClose()
		closeTimer.current = window.setTimeout(() => {
			closeTimer.current = null
			setSubmenuOpen(false)
		}, 180)
	}

	useEffect(() => clearTimers, [])

	const openSubmenu = (kind: Exclude<Submenu, null>) => {
		setSubmenu(kind)
		setSubmenuOpen(true)
	}

	const closeSubmenu = (restoreFocus = false) => {
		setSubmenuOpen(false)
		if (!restoreFocus) return
		const index = submenu ? ITEM_INDEX[submenu] : ITEM_INDEX.skills
		rowRefs.current[index]?.focus()
	}

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
				openSubmenu("skills")
				break
			case 3:
				onBrainstorm()
				break
		}
	}

	if (!open || !visibleAnchor(anchor)) return null

	const items = [
		{ label: "从画布添加", icon: SquareArrowDownIcon, disabled: false, chevron: false },
		{ label: "上传附件", icon: PaperclipIcon, disabled: false, chevron: false },
		{ label: "技能", icon: PuzzleIcon, disabled: false, chevron: true },
		{ label: "头脑风暴", icon: LightbulbIcon, disabled: false, chevron: false },
	]

	const submenuAnchor = submenu ? rowRefs.current[ITEM_INDEX[submenu]] ?? null : null

	return (
		<>
			<Popover onOpenChange={(next) => { if (!next) onClose() }} open>
				<PopoverContent
					align="start"
					anchor={anchor}
					className="nvca-plus-menu is-t6"
					initialFocus={false}
					role="menu"
					side="top"
					sideOffset={8}
				>
					{items.map((item, index) => (
						<div key={item.label}>
							<Item
								aria-disabled={item.disabled || undefined}
								className={"nvca-plus-item" + (active === index ? " is-active" : "") + (item.disabled ? " is-disabled" : "")}
								onClick={() => {
									if (item.disabled) {
										store.notify("当前浏览器不支持本地文件夹授权")
										return
									}
									runItem(index)
								}}
								onMouseEnter={() => {
									setActive(index)
									cancelClose()
									if (item.chevron) {
										scheduleOpen()
									} else {
										cancelOpen()
										if (submenu) scheduleClose()
									}
								}}
								onMouseLeave={() => {
									cancelOpen()
									if (submenu) scheduleClose()
								}}
								ref={(node) => {
									rowRefs.current[index] = node
								}}
								render={<button type="button" />}
								role="menuitem"
								size="xs"
							>
								<item.icon className="nvca-plus-icon" />
								<span>{item.label}</span>
								{item.chevron ? <ChevronRightIcon className="nvca-plus-chevron" /> : null}
							</Item>
							{index === 1 || index === 2 ? <ItemSeparator className="nvca-plus-separator" /> : null}
						</div>
					))}
				</PopoverContent>
			</Popover>

			{submenu === "skills" ? (
				<ComboboxMenu<SkillRow>
					anchorEl={submenuAnchor}
					autoFocus
					empty={loading && skillRows.length === 0 ? "加载技能…" : "没有匹配的技能"}
					filterText={(item) => item.name + " " + item.id + " " + item.description}
					footer={
						<>
							<button className="nvca-plus-subitem nvca-combo-action" disabled={importing} onClick={() => skillFileInputRef.current?.click()} type="button">
								<UploadIcon className="nvca-plus-icon" />
								<span>上传技能文件</span>
							</button>
							<button className="nvca-plus-subitem nvca-combo-action" disabled={importing} onClick={() => skillFolderInputRef.current?.click()} type="button">
								<FolderPlusIcon className="nvca-plus-icon" />
								<span>上传技能文件夹</span>
							</button>
							<button className="nvca-plus-subitem nvca-combo-action" onClick={createSkill} type="button">
								<PlusIcon className="nvca-plus-icon" />
								<span>创建技能</span>
							</button>
						</>
					}
					itemClassName="nvca-plus-subitem nvca-combo-item"
					items={skillRows}
					onHoverEnd={scheduleClose}
					onHoverStart={cancelClose}
					label={(item) => item.name}
					onExited={() => setSubmenu(null)}
					onKeyClose={() => closeSubmenu(true)}
					onPick={chooseSkill}
					open={submenuOpen}
					panelClassName="nvca-plus-submenu is-skills is-t6"
					renderItem={(item) => (
						<>
							<PuzzleIcon className="nvca-plus-icon" />
							<span className="nvca-plus-subcopy"><span className="nvca-plus-subname">{item.name}</span></span>
						</>
					)}
					searchLabel="搜索技能"
					searchPlaceholder="搜索技能"
					side="right"
					sideOffset={8}
					value={(item) => item.id}
				/>
			) : submenu === "apps" ? (
				<ComboboxMenu<StoreCatalogItem>
					anchorEl={submenuAnchor}
					autoFocus
					empty={loading && catalog.length === 0 ? "加载应用市场…" : "没有匹配的应用"}
					filterText={(item) => item.name + " " + item.id + " " + item.description}
					footer={
						<button className="nvca-plus-subitem is-all nvca-combo-action" onClick={() => openAll("apps")} type="button">
							<span>管理应用</span>
						</button>
					}
					itemClassName="nvca-plus-subitem nvca-combo-item"
					items={apps}
					onHoverEnd={scheduleClose}
					onHoverStart={cancelClose}
					label={(item) => item.name}
					onExited={() => setSubmenu(null)}
					onKeyClose={() => closeSubmenu(true)}
					onPick={chooseApp}
					open={submenuOpen}
					panelClassName="nvca-plus-submenu is-apps is-t6"
					renderItem={(item) => (
						<>
							<LayoutGridIcon className="nvca-plus-icon" />
							<span className="nvca-plus-subcopy">
								<span className="nvca-plus-subname">{item.name}</span>
								<span className="nvca-plus-subdesc">{item.description}</span>
							</span>
						</>
					)}
					searchLabel="搜索应用"
					searchPlaceholder="搜索应用"
					side="right"
					sideOffset={8}
					value={(item) => item.id}
				/>
			) : null}
			<input accept=".md,.markdown" className="nvca-sr-only" multiple onChange={(event) => void importSkillFiles(event.currentTarget.files)} ref={skillFileInputRef} type="file" />
			<input accept=".md,.markdown" className="nvca-sr-only" multiple onChange={(event) => void importSkillFiles(event.currentTarget.files)} ref={skillFolderInputRef} type="file" {...({ webkitdirectory: "" } as Record<string, string>)} />
		</>
	)
}
