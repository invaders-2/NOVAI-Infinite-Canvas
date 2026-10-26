import { useEffect, useRef, useState } from "react"
import type { PointerEvent as ReactPointerEvent } from "react"
import { createPortal } from "react-dom"
import { CheckIcon, RotateCcwIcon, XIcon } from "lucide-react"
import type { AssistantStore } from "./store"

type Rect = { x: number; y: number; w: number; h: number }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export const ScreenshotPicker = ({ open, onClose, store }: { open: boolean; onClose: () => void; store: AssistantStore }) => {
	const [phase, setPhase] = useState<"select" | "confirm">("select")
	const [selecting, setSelecting] = useState(false)
	const [rect, setRect] = useState<Rect | null>(null)
	const [preview, setPreview] = useState<{ url: string; width: number; height: number } | null>(null)
	const [busy, setBusy] = useState(false)
	const startRef = useRef<{ x: number; y: number } | null>(null)
	const overlayRef = useRef<HTMLDivElement | null>(null)

	useEffect(() => {
		if (!open) return
		setPhase("select")
		setRect(null)
		setPreview(null)
		setBusy(false)
		startRef.current = null
		try {
			const panel = document.getElementById("canvasAssistantPanel")
			document.documentElement.style.setProperty("--nvca-panel-width", (panel ? panel.getBoundingClientRect().width : 440) + "px")
		} catch {}
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return
			event.preventDefault()
			onClose()
		}
		document.addEventListener("keydown", onKey, true)
		return () => document.removeEventListener("keydown", onKey, true)
	}, [open, onClose])

	if (!open) return null

	const point = (event: ReactPointerEvent) => {
		const overlay = overlayRef.current
		const host = overlay ? overlay.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
		return { x: clamp(event.clientX - host.left, 0, host.width), y: clamp(event.clientY - host.top, 0, host.height) }
	}

	const finish = async (next: Rect) => {
		if (next.w < 8 || next.h < 8) {
			setRect(null)
			setSelecting(false)
			return
		}
		setSelecting(false)
		setBusy(true)
		const result = await store.captureRegionPreview(next)
		setBusy(false)
		if (!result) {
			store.notify("截图没有生成，可重新框选")
			setRect(null)
			return
		}
		setPreview(result)
		setPhase("confirm")
	}

	return createPortal(
		<div
			className={"nvca-shot-overlay is-" + phase}
			onPointerDown={(event) => {
				if (phase !== "select" || event.button !== 0) return
				event.preventDefault()
				const p = point(event)
				startRef.current = p
				setRect({ x: p.x, y: p.y, w: 0, h: 0 })
				setSelecting(true)
			}}
			onPointerMove={(event) => {
				if (!selecting || !startRef.current) return
				const p = point(event)
				const start = startRef.current
				setRect({
					x: Math.min(start.x, p.x),
					y: Math.min(start.y, p.y),
					w: Math.abs(p.x - start.x),
					h: Math.abs(p.y - start.y),
				})
			}}
			onPointerCancel={() => {
				setSelecting(false)
				setRect(null)
			}}
			onPointerUp={() => {
				if (!selecting) return
				const current = rect
				setSelecting(false)
				if (current) void finish(current)
			}}
			ref={overlayRef}
		>
			<div className="nvca-shot-label">拖拽框选截图区域 · Esc 取消</div>
			{rect && rect.w > 2 && rect.h > 2 ? (
				<div
					className="nvca-shot-select"
					style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
				>
					<span className="nvca-shot-size">{Math.round(rect.w)} × {Math.round(rect.h)}</span>
				</div>
			) : null}
			{phase === "confirm" && preview ? (
				<div className="nvca-shot-confirm" onPointerDown={(event) => event.stopPropagation()}>
					<img alt="截图预览" src={preview.url} />
					<div className="nvca-shot-confirm-text">
						<strong>使用这张截图？</strong>
						<span>{preview.width} × {preview.height}</span>
					</div>
					<button className="nvca-shot-btn" onClick={() => { setPhase("select"); setPreview(null); setRect(null) }} type="button">
						<RotateCcwIcon className="nvca-i-xs" />
						重选
					</button>
					<button className="nvca-shot-btn" onClick={onClose} type="button">
						<XIcon className="nvca-i-xs" />
						取消
					</button>
					<button
						className="nvca-shot-btn is-primary"
						disabled={busy}
						onClick={() => {
							if (!preview) return
							const ok = store.addCaptureRef(preview.url, preview.width, preview.height)
							store.notify(ok ? "已加入截图引用" : "截图引用添加失败")
							if (ok) onClose()
						}}
						type="button"
					>
						<CheckIcon className="nvca-i-xs" />
						使用这张
					</button>
				</div>
			) : null}
		</div>,
		document.body,
	)
}
