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
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/hexta/empty"
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/hexta/item"
import { Skeleton } from "@/components/hexta/skeleton"
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
	<Item className="nvca-artifact-row" size="xs">
		<ItemMedia className="nvca-artifact-kind">
			<GroupIcon kind={file.kind} />
		</ItemMedia>
		<ItemContent className="nvca-artifact-main">
			<ItemTitle className="nvca-artifact-name" title={file.name}>{file.name}</ItemTitle>
			<ItemDescription className="nvca-artifact-meta">
				{formatBytes(file.size)}
				{formatRelative(file.mtime) ? " · " + formatRelative(file.mtime) : ""}
			</ItemDescription>
		</ItemContent>
		<ItemActions>
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
		</ItemActions>
	</Item>
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

	/* 侧栏贴右邻助手面板、不遮罩不抢焦点，所以外壳沿用非模态 aside；
	   HextaUI 的 sheet/dialog 会强制遮罩 + 焦点陷阱，会把侧栏变成模态。 */
	return (
		<aside className="nvca-artifacts-sheet nvca-sheet-v2" aria-label="助手产物">
			<div className="nvca-sheet-head">
				<div className="nvca-sheet-title">
					<span>文件</span>
					{files.length > 0 ? <span className="nvca-sheet-count">{files.length}</span> : null}
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
							<Skeleton className="nvca-skeleton-icon" />
							<div className="nvca-skeleton-lines">
								<Skeleton className="nvca-skeleton-line" />
								<Skeleton className="nvca-skeleton-line is-short" />
							</div>
						</div>
					))}
				</div>
			) : failed ? (
				<Empty className="nvca-sheet-state is-error" size="sm">
					<EmptyMedia>
						<AlertCircleIcon className="nvca-sheet-empty-icon" />
					</EmptyMedia>
					<EmptyHeader>
						<EmptyTitle>产物加载失败</EmptyTitle>
						<EmptyDescription>{state.error || "网络错误"}</EmptyDescription>
					</EmptyHeader>
					<EmptyContent>
						<button className="nvca-btn ghost" onClick={onReload} type="button">重试</button>
					</EmptyContent>
				</Empty>
			) : files.length === 0 ? (
				<Empty className="nvca-sheet-state" size="sm">
					<EmptyMedia>
						<FileIcon className="nvca-sheet-empty-icon" />
					</EmptyMedia>
					<EmptyHeader>
						<EmptyTitle>暂无输出</EmptyTitle>
						<EmptyDescription>助手生成的 HTML、表格、文档和图片会出现在这里</EmptyDescription>
					</EmptyHeader>
				</Empty>
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
		</aside>
	)
}
