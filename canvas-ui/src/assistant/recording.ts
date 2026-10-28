export interface ScreenSource {
	id: string
	name: string
	thumbnail?: string
}

export interface DisplayRecording {
	stop(): Promise<Blob | null>
	cancel(): Promise<void>
}

export const recordingSupported = (): boolean =>
	typeof navigator !== "undefined" &&
	Boolean(navigator.mediaDevices?.getDisplayMedia) &&
	typeof MediaRecorder !== "undefined"

export const getDesktopScreenSources = async (): Promise<ScreenSource[] | null> => {
	const api = (window as unknown as {
		pywebview?: { api?: { get_screen_sources?: () => Promise<ScreenSource[] | { error?: string } | null> } }
	}).pywebview?.api
	if (typeof api?.get_screen_sources !== "function") return null
	const result = await api.get_screen_sources()
	if (Array.isArray(result)) return result
	throw new Error((result as { error?: string } | null)?.error || "无法读取屏幕来源")
}

const mimeType = (): string => {
	for (const candidate of ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]) {
		if (MediaRecorder.isTypeSupported(candidate)) return candidate
	}
	return ""
}

export const startDisplayRecording = async (sourceId = ""): Promise<DisplayRecording> => {
	if (!recordingSupported()) throw new Error("当前环境不支持录屏")
	if (sourceId) {
		const api = (window as unknown as {
			pywebview?: { api?: { select_screen_source?: (id: string) => Promise<boolean> } }
		}).pywebview?.api
		if (typeof api?.select_screen_source !== "function") throw new Error("当前桌面版本不支持选择录屏来源")
		if (!await api.select_screen_source(sourceId)) throw new Error("录屏来源已失效，请重新选择")
	}
	const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
	const type = mimeType()
	const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
	const chunks: Blob[] = []
	let cancelled = false
	let settled = false
	let resolveStopped: ((blob: Blob | null) => void) | null = null
	let rejectStopped: ((error: Error) => void) | null = null
	const stopped = new Promise<Blob | null>((resolve, reject) => {
		resolveStopped = resolve
		rejectStopped = reject
	})
	const stopTracks = () => stream.getTracks().forEach((track) => track.stop())

	recorder.ondataavailable = (event) => {
		if (event.data?.size) chunks.push(event.data)
	}
	recorder.onerror = () => {
		settled = true
		stopTracks()
		rejectStopped?.(new Error("录屏失败，请重试"))
	}
	recorder.onstop = () => {
		settled = true
		stopTracks()
		resolveStopped?.(cancelled ? null : new Blob(chunks, { type: recorder.mimeType || "video/webm" }))
	}
	stream.getVideoTracks().forEach((track) => {
		track.addEventListener("ended", () => {
			if (!settled && recorder.state !== "inactive") recorder.stop()
		})
	})
	recorder.start(1000)

	return {
		stop() {
			if (!settled && recorder.state !== "inactive") recorder.stop()
			return stopped
		},
		async cancel() {
			cancelled = true
			if (!settled && recorder.state !== "inactive") recorder.stop()
			else stopTracks()
			await stopped
		},
	}
}
