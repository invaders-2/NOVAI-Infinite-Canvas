import {
	AlertCircleIcon,
	ChevronDownIcon,
	FileCode2Icon,
	FileImageIcon,
	FileSpreadsheetIcon,
	FileTextIcon,
	FileIcon,
	RefreshCwIcon,
	XIcon,
} from "lucide-react"
import type { ArtifactList, ArtifactFile } from "./api"
import { ARTIFACT_GROUPS, formatBytes, formatRelative } from "./format"

export interface ArtifactPanelState {
	status: "idle" | "loading" | "ready" | "error"
	data: ArtifactList | null
	error: string
}

const KIND_ICONS: Record<string, typeof FileIcon> = {
	html: FileCode2Icon,
	xlsx: FileSpreadsheetIcon,
	csv: FileSpreadsheetIcon,
	md: FileTextIcon,
	image: FileImageIcon,
}

const GroupIcon = ({ kind }: { kind: string }) => {
	const Icon = KIND_ICONS[kind] || FileIcon
	return <Icon className="nvca-i-sm" />
}

const FileRow = ({ file }: { file: ArtifactFile }) => (
	<div className="nvca-artifact-row">
		<span className="nvca-artifact-kind">
			<GroupIcon kind={file.kind} />
		</span>
		<div className="nvca-artifact-main">
			<span className="nvca-artifact-name" title={file.name}>{file.name}</span>
			<span className="nvca-artifact-meta">
				{formatBytes(file.size)}
				{formatRelative(file.mtime) ? " · " + formatRelative(file.mtime) : ""}
			</span>
		</div>
		<a
			className="nvca-artifact-download"
			href={file.url}
			target="_blank"
			rel="noreferrer noopener"
			title={"在新标签打开 " + file.name}
			aria-label={"下载 " + file.name}
		>
			<ChevronDownIcon className="nvca-i-xs nvca-artifact-download-icon" />
		</a>
	</div>
)

export const ArtifactsSheet = ({
	state,
	onClose,
	onReload,
}: {
	state: ArtifactPanelState
	onClose: () => void
	onReload: () => void
}) => {
	const data = state.data
	const files = data?.files || []
	const known = new Set(ARTIFACT_GROUPS.map((group) => group.kind))
	const extraKinds = Array.from(new Set(files.map((file) => file.kind).filter((kind) => kind && !known.has(kind))))
	const groups = ARTIFACT_GROUPS.concat(extraKinds.map((kind) => ({ kind, label: kind })))
		.map((group) => ({ ...group, files: files.filter((file) => file.kind === group.kind) }))
		.filter((group) => group.files.length > 0)
	const loading = state.status === "loading" && !data
	const failed = state.status === "error" && !data

	return (
		<div className="nvca-artifacts-sheet" role="dialog" aria-label="助手产物">
			<div className="nvca-sheet-head">
				<div className="nvca-sheet-title">
					<span>产物</span>
					{data ? <span className="nvca-sheet-count">{files.length}</span> : null}
				</div>
				<div className="nvca-sheet-actions">
					<button className="nvca-icon-btn" onClick={onReload} title="刷新产物" aria-label="刷新产物" type="button">
						<RefreshCwIcon className="nvca-i-sm" />
					</button>
					<button className="nvca-icon-btn" onClick={onClose} title="关闭" aria-label="关闭产物面板" type="button">
						<XIcon className="nvca-i-sm" />
					</button>
				</div>
			</div>

			{loading ? (
				<div className="nvca-sheet-skeleton" aria-label="正在加载产物">
					{[0, 1, 2].map((index) => (
						<div className="nvca-skeleton-row" key={index}>
							<span className="nvca-skeleton-block nvca-skeleton-icon" />
							<span className="nvca-skeleton-lines">
								<span className="nvca-skeleton-block nvca-skeleton-line" />
								<span className="nvca-skeleton-block nvca-skeleton-line is-short" />
							</span>
						</div>
					))}
				</div>
			) : failed ? (
				<div className="nvca-sheet-state is-error">
					<AlertCircleIcon className="nvca-i-lg" />
					<p>产物加载失败</p>
					<span>{state.error || "网络错误"}</span>
					<button className="nvca-btn ghost" onClick={onReload} type="button">重试</button>
				</div>
			) : files.length === 0 ? (
				<div className="nvca-sheet-state">
					<p>还没有产物</p>
					<span>让助手写报告、表格或导出图片后，文件会出现在这里。</span>
				</div>
			) : (
				<div className="nvca-sheet-body">
					{groups.map((group) => (
						<section className="nvca-artifact-group" key={group.kind}>
							<div className="nvca-artifact-group-head">
								<GroupIcon kind={group.kind} />
								<span>{group.label}</span>
								<span className="nvca-artifact-group-count">{group.files.length}</span>
							</div>
							{group.files.map((file) => <FileRow file={file} key={file.kind + ":" + file.name} />)}
						</section>
					))}
					{data?.truncated ? (
						<div className="nvca-sheet-note">只列出最近 {files.length} 个产物，更早的文件没有显示。</div>
					) : null}
				</div>
			)}
			{state.status === "error" && data ? (
				<div className="nvca-sheet-note is-warn">刷新失败（{state.error}），下面是上一次的结果。</div>
			) : null}
		</div>
	)
}
