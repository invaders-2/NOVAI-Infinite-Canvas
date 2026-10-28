import { createRoot } from "react-dom/client"
import { AssistantApp } from "./assistant/AssistantApp"
import { createAssistant } from "./assistant/store"
import type { CanvasAssistantHandle, CanvasAssistantHostApi, SkillChip } from "./assistant/types"
import "./styles/index.css"

// 开发预览：不接 NOVAI，用一串脚本事件走完「空态 → 运行中 → 方案 → 产物 → 完成」。
const skills: SkillChip[] = [
	{ id: "poster", name: "海报设计", icon: "🎨", description: "按参考图生成电商海报" },
	{ id: "detail", name: "详情页", icon: "🧩", description: "拆卖点、排详情页" },
	{ id: "storyboard", name: "分镜", icon: "🎬", description: "把文案拆成分镜序列" },
]

let handle: CanvasAssistantHandle | null = null
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const scriptedRun = async () => {
	if (!handle) return
	handle.pushEvent({ type: "vision", data: { mode: "direct", labels: ["图1", "图2"], text: "已把图1、图2直接给模型看" } })
	handle.pushEvent({ type: "run_start", data: { run_id: "demo-run", max_steps: 6 } })
	await wait(260)
	handle.pushEvent({ type: "thinking", data: { text: "先看看画布上选中的图片，判断主体和风格，再决定用哪个生图平台。", duration_ms: 1200 } })
	await wait(320)
	handle.pushEvent({ type: "plan", data: {
		intent: "用选中的红色杯子做主图，出一张电商首图",
		summary: "先写提示词，再生成图片",
		requires_confirmation: true,
		impact: { generations: 1, nodes: 2 },
		steps: [
			{ tool: "create_node", args: { type: "prompt" }, description: "新建提示词节点：红色杯子，白色背景，电商主图，柔和棚拍光" },
			{ tool: "connect_nodes", args: { from: "{0}", to: "{1}" }, description: "把提示词连到图片节点" },
			{ tool: "generate_image", args: { ratio: "1:1" }, description: "生成 1 张 1:1 主图" },
		],
	} })
	await wait(500)
	handle.pushEvent({ type: "step_start", data: { index: 0, tool: "create_node", description: "新建提示词节点", args: { node_id: "demo-node-1" } } })
	await wait(700)
	handle.pushEvent({ type: "step_result", data: { index: 0, tool: "create_node", ok: true, message: "已创建提示词节点" } })
	handle.pushEvent({ type: "step_start", data: { index: 1, tool: "generate_image", description: "生成 1 张 1:1 主图" } })
	await wait(1200)
	handle.pushEvent({ type: "step_result", data: { index: 1, tool: "generate_image", ok: true, message: "已提交生成，预计 12 秒" } })
	handle.setArtifacts([
		{ id: "demo-image-1", kind: "image", url: "https://picsum.photos/seed/novai-assistant/900/900", thumb: "https://picsum.photos/seed/novai-assistant/400/400", title: "主图 1:1" },
	])
	await wait(900)
	handle.pushEvent({ type: "message", data: { text: "已完成主图生成，并关联到提示词节点。你可以继续调整风格，或从这条回复创建分支。" } })
	handle.pushEvent({ type: "usage", data: { usage: { input_tokens: 4120, output_tokens: 860 } } })
	const current = store.state.messages[store.state.messages.length - 1]
	if (current) current.planState = "applied"
	handle.pushEvent({ type: "done", data: { status: "ok", steps_executed: 2 } })
}

const api: CanvasAssistantHostApi = {
	send(text) {
		handle?.pushEvent({ type: "run_start", data: { run_id: "demo-run", max_steps: 6 } })
		setTimeout(() => { void scriptedRun() }, 120)
		return true
	},
	abort() {
		handle?.pushEvent({ type: "error", data: { message: "已手动停止" } })
	},
	steer(text) {
		handle?.notifySteer(text, "placed")
	},
	selectSkill(id) {
		handle?.setSelectedSkill(id)
	},
	clearSkill() {
		handle?.setSelectedSkill(null)
	},
	removeRef(id) {
		handle?.setRefs([{ id: "ref-2", name: "参考图 2", type: "image", kind: "image" }])
	},
	clearRefs() {
		handle?.setRefs([])
	},
	setChatModel(model, provider) {
		handle?.setComposerState({ models: [], model, provider, imageProviders: [], imageProvider: "", planConfirm: true })
	},
	setImageProvider(imageProvider) {
		handle?.setComposerState({ models: [], model: "", provider: "", imageProviders: [], imageProvider, planConfirm: true })
	},
	setPlanConfirm(on) {
		handle?.setPlanConfirm(on)
	},
	async addSelectedRefs() {
		return 1
	},
	pickUpload() {
		/* noop in preview */
	},
	planAction(action) {
		if (action === "run") {
			handle?.pushEvent({ type: "run_start", data: { run_id: "demo-run-2", max_steps: 6 } })
			setTimeout(() => { void scriptedRun() }, 120)
		}
	},
	togglePlanConfirm(on) {
		handle?.setPlanConfirm(on)
	},
	openHistory() {
		/* noop in preview */
	},
	openNode() {
		/* noop in preview */
	},
	confirmAction() {
		/* noop in preview */
	},
}

const { store, handle: created } = createAssistant(api)
handle = created
console.log('dbg keys', Object.keys(created), typeof created.setRefs)
for (const [name, fn] of Object.entries({ setSkills: () => created.setSkills(skills), setPlanConfirm: () => created.setPlanConfirm(true), setContextUsage: () => created.setContextUsage({ percentage: 18 }), setRefs: () => created.setRefs([{ id: "ref-1", name: "红色杯子.jpg", type: "image", kind: "image" }]) })) {
	console.log('dbg call', name, typeof (created as any)[name])
	try { (fn as any)() } catch (e) { console.log('dbg error in', name, e) }
}
(window as any).__nvcaStore = store
createRoot(document.getElementById("root") as HTMLElement).render(<AssistantApp store={store} />)
setTimeout(() => { void scriptedRun() }, 700)
