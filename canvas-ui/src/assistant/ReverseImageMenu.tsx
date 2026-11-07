import { ImageOffIcon, ScanSearchIcon, UploadIcon } from "lucide-react"
import { useRef, useState, type ChangeEvent } from "react"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/hexta/item"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/hexta/popover"
import { Spinner } from "@/components/hexta/spinner"
import { cn } from "@/lib/utils"
import { uploadImageFile } from "./api"
import type { AssistantStore } from "./store"

/* 面板里的「以图搜图」入口：来源只用画布选中节点或本地上传，拿到本地图后走
   POST /api/agent/images/reverse（见 docs/agent-web-image-search.md 第 4 节），
   结果以参考图选择卡的形式进消息流。 */

export const ReverseImageMenu = ({ store }: { store: AssistantStore }) => {
	const [open, setOpen] = useState(false)
	const [selected, setSelected] = useState<{ url: string; title: string } | null>(null)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState("")
	const fileRef = useRef<HTMLInputElement | null>(null)

	const refresh = () => setSelected(store.selectedCanvasImage())

	const run = async (url: string, title: string) => {
		if (busy) return
		setBusy(true)
		setError("")
		const ok = await store.reverseImageSearch({ url, title })
		setBusy(false)
		if (ok) setOpen(false)
	}

	const runSelected = () => {
		if (!selected) {
			setError("先在画布上选中一张图，再点这里")
			return
		}
		void run(selected.url, selected.title)
	}

	const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files && event.target.files[0]
		event.target.value = ""
		if (!file) return
		setBusy(true)
		setError("")
		const uploaded = await uploadImageFile(file)
		if (!uploaded.ok) {
			setBusy(false)
			setError(uploaded.message || "图片上传失败")
			return
		}
		await run(uploaded.url, uploaded.name || file.name)
	}

	return (
		<div className="nvca-rev-wrap">
			<Popover
				onOpenChange={(next) => {
					setOpen(next)
					setError("")
					if (next) refresh()
				}}
				open={open}
			>
				<PopoverTrigger
					render={
						<button
							aria-label="以图搜图"
							className={cn("nvca-tap-icon", (open || busy) && "is-on")}
							title="以图搜图：用画布选中的图或本地上传的图找相似参考图"
							type="button"
						/>
					}
				>
					{busy ? <Spinner aria-hidden size="sm" /> : <ScanSearchIcon className="nvca-i-sm" />}
				</PopoverTrigger>
				<PopoverContent align="start" className="nvca-revmenu is-t6" initialFocus={false} side="top" sideOffset={8}>
					<div className="nvca-revmenu-label">以图搜图</div>
					<Item
						aria-disabled={busy || !selected || undefined}
						className="nvca-revmenu-item"
						onClick={runSelected}
						render={<button role="menuitem" type="button" />}
						size="sm"
					>
						<ItemMedia className="nvca-revmenu-thumb" variant="image">
							{selected ? <img alt="" src={selected.url} /> : <ImageOffIcon className="nvca-i-xs" />}
						</ItemMedia>
						<ItemContent>
							<ItemTitle className="nvca-revmenu-title">用画布选中的图</ItemTitle>
							<ItemDescription className="nvca-revmenu-desc">{selected ? selected.title : "先在画布上选中一张图"}</ItemDescription>
						</ItemContent>
					</Item>
					<Item
						aria-disabled={busy || undefined}
						className="nvca-revmenu-item"
						onClick={() => fileRef.current?.click()}
						render={<button role="menuitem" type="button" />}
						size="sm"
					>
						<ItemMedia className="nvca-revmenu-icon">
							<UploadIcon className="nvca-i-sm" />
						</ItemMedia>
						<ItemContent>
							<ItemTitle className="nvca-revmenu-title">上传一张图</ItemTitle>
							<ItemDescription className="nvca-revmenu-desc">从本地选一张，反查相似参考图</ItemDescription>
						</ItemContent>
					</Item>
					{busy ? <div className="nvca-revmenu-hint">正在读图并搜索相似参考图…</div> : null}
					{error ? <div className="nvca-revmenu-error">{error}</div> : null}
					<input accept="image/*" hidden onChange={(event) => void onFile(event)} ref={fileRef} type="file" />
				</PopoverContent>
			</Popover>
		</div>
	)
}
