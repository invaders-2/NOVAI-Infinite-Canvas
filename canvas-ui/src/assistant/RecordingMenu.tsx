import { Loader2Icon, MonitorIcon, SquareIcon, VideoIcon, XIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { getDesktopScreenSources, startDisplayRecording } from "./recording"
import type { DisplayRecording, ScreenSource } from "./recording"
import type { AssistantStore } from "./store"

const clock = (seconds: number) =>
	String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0")

export const RecordingMenu = ({ store, onClose }: { store: AssistantStore; onClose: () => void }) => {
	const [sources, setSources] = useState<ScreenSource[] | null>(null)
	const [browserDirect, setBrowserDirect] = useState(false)
	const [sourceError, setSourceError] = useState("")
	const [phase, setPhase] = useState<"choose" | "recording" | "saving">("choose")
	const [seconds, setSeconds] = useState(0)
	const controllerRef = useRef<DisplayRecording | null>(null)
	const timerRef = useRef<number>(0)

	useEffect(() => {
		let alive = true
		getDesktopScreenSources()
			.then((items) => {
				if (!alive) return
				setBrowserDirect(items === null)
				setSources(items || [])
			})
			.catch((error) => {
				if (!alive) return
				setBrowserDirect(true)
				setSources([])
				setSourceError((error as Error)?.message || "无法读取屏幕来源，可使用系统录屏选择器")
			})
		return () => {
			alive = false
			if (timerRef.current) window.clearInterval(timerRef.current)
			if (controllerRef.current) void controllerRef.current.cancel()
		}
	}, [])

	const begin = async (sourceId = "") => {
		setSourceError("")
		try {
			const controller = await startDisplayRecording(sourceId)
			controllerRef.current = controller
			setSeconds(0)
			setPhase("recording")
			timerRef.current = window.setInterval(() => setSeconds((value) => value + 1), 1000)
		} catch (error) {
			if ((error as Error)?.name !== "NotAllowedError") setSourceError((error as Error)?.message || "无法开始录屏")
		}
	}

	const upload = async (blob: Blob) => {
		const form = new FormData()
		const filename = "画布录屏-" + new Date().toISOString().replace(/[:.]/g, "-") + ".webm"
		form.append("folder", "")
		form.append("files", new File([blob], filename, { type: blob.type || "video/webm" }))
		const response = await fetch("/api/local-assets/upload", { method: "POST", body: form })
		const data = await response.json().catch(() => ({}))
		if (!response.ok || !Array.isArray(data.files) || !data.files.length) throw new Error(data.detail || "录屏上传失败")
		const file = data.files[0]
		const added = store.addFolderFiles([{ name: String(file.name || filename), url: String(file.url || ""), kind: "video" }])
		if (!added) throw new Error("录屏已上传，但未能加入引用")
		store.notify("录屏已加入本轮引用")
	}

	const finish = async () => {
		const controller = controllerRef.current
		if (!controller || phase !== "recording") return
		if (timerRef.current) window.clearInterval(timerRef.current)
		setPhase("saving")
		try {
			const blob = await controller.stop()
			controllerRef.current = null
			if (blob?.size) await upload(blob)
			onClose()
		} catch (error) {
			setSourceError((error as Error)?.message || "保存录屏失败")
			setPhase("choose")
		}
	}

	const cancel = async () => {
		if (timerRef.current) window.clearInterval(timerRef.current)
		if (controllerRef.current) {
			const controller = controllerRef.current
			controllerRef.current = null
			await controller.cancel()
		}
		onClose()
	}

	return (
		<div className="nvca-recording" role="dialog" aria-label="屏幕录制">
			<div className="nvca-recording-head">
				<span><VideoIcon className="nvca-i-sm" />{phase === "recording" ? "正在录屏" : phase === "saving" ? "正在保存" : "屏幕录制"}</span>
				<button aria-label="关闭录屏" disabled={phase === "saving"} onClick={() => void cancel()} type="button"><XIcon className="nvca-i-sm" /></button>
			</div>
			{phase === "choose" ? (
				<div className="nvca-recording-body">
					{sources === null && !sourceError ? <div className="nvca-recording-hint">正在读取可录制的屏幕和窗口…</div> : null}
					{browserDirect ? (
						<button className="nvca-recording-source is-primary" onClick={() => void begin()} type="button"><MonitorIcon className="nvca-i-sm" />选择屏幕或窗口</button>
					) : (
						<div className="nvca-recording-sources">
							{sources?.length === 0 && !sourceError ? <div className="nvca-recording-hint">没有可用来源</div> : null}
							{sources?.map((source) => (
								<button className="nvca-recording-source" key={source.id} onClick={() => void begin(source.id)} type="button">
									{source.thumbnail ? <img alt="" src={source.thumbnail} /> : <MonitorIcon className="nvca-i-sm" />}
									<span>{source.name}</span>
								</button>
							))}
						</div>
					)}
				</div>
			) : (
				<div className="nvca-recording-active">
					{phase === "recording" ? <span className="nvca-recording-dot" /> : <Loader2Icon className="nvca-i-sm nvca-spin" />}
					<strong>{phase === "recording" ? clock(seconds) : "上传并加入引用…"}</strong>
					{phase === "recording" ? <button aria-label="停止并保存录屏" onClick={() => void finish()} title="停止并保存" type="button"><SquareIcon className="nvca-i-sm" /></button> : null}
				</div>
			)}
			{sourceError ? <div className="nvca-recording-error">{sourceError}</div> : null}
		</div>
	)
}
