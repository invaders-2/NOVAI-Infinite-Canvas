import { createRoot, type Root } from "react-dom/client"
import { AssistantApp } from "./assistant/AssistantApp"
import { createAssistant } from "./assistant/store"
import type { CanvasAssistantHandle, CanvasAssistantHostApi } from "./assistant/types"
import "./styles/index.css"

export interface MountedAssistant extends CanvasAssistantHandle {
	root: Root
	element: HTMLElement
	store: ReturnType<typeof createAssistant>["store"]
}

// window.NovaiCanvasAssistant.mount(el, api) —— 桥接层唯一入口。
// 微应用不直接触网、不读 localStorage；会话/动作全部经 api 回到 NOVAI 现有函数。
export const mount = (element: HTMLElement, api: CanvasAssistantHostApi): MountedAssistant | null => {
	if (!element) return null
	const { store, handle } = createAssistant(api)
	const root = createRoot(element)
	root.render(<AssistantApp store={store} />)
	return {
		...handle,
		element,
		root,
		store,
		destroy() {
			handle.destroy()
			try {
				root.unmount()
			} catch {
				/* unmount after host already detached */
			}
		},
	}
}

export const version = "0.1.0"
