import { BookmarkIcon, RotateCcwIcon } from "lucide-react"
import { useState } from "react"
import type { AssistantStore } from "./store"
import type { Message } from "./types"

export const CheckpointCard = ({ message, store }: { message: Message; store: AssistantStore }) => {
	const [busy, setBusy] = useState(false)
	const [undone, setUndone] = useState(false)
	const changes = message.changes
	const nodeCount = changes
		? (Number(changes.nodes_created) || 0) + (Number(changes.nodes_modified) || 0) + (Number(changes.nodes_deleted) || 0)
		: 0
	const connections = Number(changes?.connections) || 0
	const artifacts = Number(changes?.artifacts) || 0
	const hasChangeInfo = Boolean(changes)
	if (!message.runId) return null
	if (message.status === "pending") return null
	if (hasChangeInfo && nodeCount <= 0 && connections <= 0 && artifacts <= 0) return null
	const label = !hasChangeInfo
		? "检查点"
		: nodeCount > 0
			? "检查点 · 已修改 " + nodeCount + " 个节点"
			: artifacts > 0
				? "检查点 · 产出 " + artifacts + " 个产物"
				: "检查点 · 已修改画布"
	const undo = async () => {
		if (busy || undone) return
		setBusy(true)
		try {
			const result = await store.undoRun(message.runId as string)
			if (result.ok) {
				setUndone(true)
				store.notify(result.message || "已撤销本次修改")
				window.dispatchEvent(new Event("resize"))
			} else {
				store.notify(result.message || "撤销失败")
			}
		} finally {
			setBusy(false)
		}
	}
	return (
		<div className={"nvca-checkpoint" + (undone ? " is-undone" : "")}>
			<BookmarkIcon className="nvca-i-xs" />
			{undone ? (
				<span className="nvca-checkpoint-text">检查点 · 已撤销</span>
			) : (
				<>
					<span className="nvca-checkpoint-text">{label}</span>
					<button className="nvca-checkpoint-undo" disabled={busy} onClick={() => void undo()} type="button">
						<RotateCcwIcon className="nvca-i-xs" />
						撤销
					</button>
				</>
			)}
		</div>
	)
}
