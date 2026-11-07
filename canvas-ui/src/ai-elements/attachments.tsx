"use client"

import {
	Attachment as HexAttachment,
	AttachmentAction,
	AttachmentActions,
	AttachmentContent,
	AttachmentMedia,
	AttachmentTitle,
} from "@/components/hexta/attachment"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/ui/hover-card"
import { cn } from "@/ui/lib/utils"
import type { FileUIPart, SourceDocumentUIPart } from "@/ai-elements/types"
import {
	FileTextIcon,
	GlobeIcon,
	ImageIcon,
	Music2Icon,
	PaperclipIcon,
	VideoIcon,
	XIcon,
} from "lucide-react"
import type { ComponentProps, HTMLAttributes, ReactNode } from "react"
import { createContext, useCallback, useContext, useMemo } from "react"

// 导出契约不变（Attachments / Attachment / AttachmentPreview / AttachmentInfo / AttachmentRemove），
// 内部渲染换成 HextaUI 的 attachment 原件：卡片态、媒体位、动作位都由它给。

export type AttachmentData = (FileUIPart & { id: string }) | (SourceDocumentUIPart & { id: string })

export type AttachmentMediaCategory =
	| "image"
	| "video"
	| "audio"
	| "document"
	| "source"
	| "unknown"

export type AttachmentVariant = "grid" | "inline" | "list"

const mediaCategoryIcons: Record<AttachmentMediaCategory, typeof ImageIcon> = {
	audio: Music2Icon,
	document: FileTextIcon,
	image: ImageIcon,
	source: GlobeIcon,
	unknown: PaperclipIcon,
	video: VideoIcon,
}

export const getMediaCategory = (data: AttachmentData): AttachmentMediaCategory => {
	if (data.type === "source-document") {
		return "source"
	}

	const mediaType = data.mediaType ?? ""

	if (mediaType.startsWith("image/")) {
		return "image"
	}
	if (mediaType.startsWith("video/")) {
		return "video"
	}
	if (mediaType.startsWith("audio/")) {
		return "audio"
	}
	if (mediaType.startsWith("application/") || mediaType.startsWith("text/")) {
		return "document"
	}

	return "unknown"
}

export const getAttachmentLabel = (data: AttachmentData): string => {
	if (data.type === "source-document") {
		return data.title || data.filename || "Source"
	}

	const category = getMediaCategory(data)
	return data.filename || (category === "image" ? "Image" : "Attachment")
}

interface AttachmentsContextValue {
	variant: AttachmentVariant
}

const AttachmentsContext = createContext<AttachmentsContextValue | null>(null)

interface AttachmentContextValue {
	data: AttachmentData
	mediaCategory: AttachmentMediaCategory
	onRemove?: () => void
	variant: AttachmentVariant
}

const AttachmentContext = createContext<AttachmentContextValue | null>(null)

export const useAttachmentsContext = () =>
	useContext(AttachmentsContext) ?? { variant: "grid" as const }

export const useAttachmentContext = () => {
	const ctx = useContext(AttachmentContext)
	if (!ctx) {
		throw new Error("Attachment components must be used within <Attachment>")
	}
	return ctx
}

export type AttachmentsProps = HTMLAttributes<HTMLDivElement> & {
	variant?: AttachmentVariant
}

export const Attachments = ({
	variant = "grid",
	className,
	children,
	...props
}: AttachmentsProps) => {
	const contextValue = useMemo(() => ({ variant }), [variant])

	return (
		<AttachmentsContext.Provider value={contextValue}>
			<div
				className={cn(
					"flex items-start",
					variant === "list" ? "flex-col gap-2" : "flex-wrap gap-2",
					variant === "grid" && "ml-auto w-fit",
					className,
				)}
				data-slot="attachments"
				{...props}
			>
				{children}
			</div>
		</AttachmentsContext.Provider>
	)
}

export type AttachmentProps = HTMLAttributes<HTMLDivElement> & {
	data: AttachmentData
	onRemove?: () => void
}

export const Attachment = ({ data, onRemove, className, children, ...props }: AttachmentProps) => {
	const { variant } = useAttachmentsContext()
	const mediaCategory = getMediaCategory(data)

	const contextValue = useMemo<AttachmentContextValue>(
		() => ({ data, mediaCategory, onRemove, variant }),
		[data, mediaCategory, onRemove, variant],
	)

	return (
		<AttachmentContext.Provider value={contextValue}>
			<HexAttachment
				className={cn("nvca-thread-attach-card", className)}
				size={variant === "grid" ? "default" : "sm"}
				{...props}
			>
				{children}
			</HexAttachment>
		</AttachmentContext.Provider>
	)
}

export type AttachmentPreviewProps = HTMLAttributes<HTMLDivElement> & {
	fallbackIcon?: ReactNode
}

export const AttachmentPreview = ({
	fallbackIcon,
	className,
	...props
}: AttachmentPreviewProps) => {
	const { data, mediaCategory } = useAttachmentContext()
	const Icon = mediaCategoryIcons[mediaCategory]

	return (
		<AttachmentMedia className={className} {...props}>
			{mediaCategory === "image" && data.type === "file" && data.url ? (
				<img alt={data.filename || "Image"} className="size-full object-cover" src={data.url} />
			) : mediaCategory === "video" && data.type === "file" && data.url ? (
				<video className="size-full object-cover" muted src={data.url} />
			) : (
				fallbackIcon ?? <Icon />
			)}
		</AttachmentMedia>
	)
}

export type AttachmentInfoProps = HTMLAttributes<HTMLDivElement> & {
	showMediaType?: boolean
}

export const AttachmentInfo = ({
	showMediaType = false,
	className,
	...props
}: AttachmentInfoProps) => {
	const { data, variant } = useAttachmentContext()
	const label = getAttachmentLabel(data)

	if (variant === "grid") {
		return null
	}

	return (
		<AttachmentContent className={className} {...props}>
			<AttachmentTitle>{label}</AttachmentTitle>
			{showMediaType && data.mediaType ? (
				<span className="block truncate text-muted-foreground text-xs">{data.mediaType}</span>
			) : null}
		</AttachmentContent>
	)
}

export type AttachmentRemoveProps = ComponentProps<"button"> & {
	label?: string
}

export const AttachmentRemove = ({
	label = "Remove",
	className,
	children,
	...props
}: AttachmentRemoveProps) => {
	const { onRemove } = useAttachmentContext()

	const handleClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation()
			onRemove?.()
		},
		[onRemove],
	)

	if (!onRemove) {
		return null
	}

	return (
		<AttachmentActions>
			<AttachmentAction aria-label={label} className={className} onClick={handleClick} type="button" {...props}>
				{children ?? <XIcon />}
				<span className="sr-only">{label}</span>
			</AttachmentAction>
		</AttachmentActions>
	)
}

export type AttachmentHoverCardProps = ComponentProps<typeof HoverCard>

export const AttachmentHoverCard = ({ ...props }: AttachmentHoverCardProps) => (
	<HoverCard {...props} />
)

export type AttachmentHoverCardTriggerProps = ComponentProps<typeof HoverCardTrigger>

export const AttachmentHoverCardTrigger = ({
	delay = 0,
	closeDelay = 0,
	...props
}: AttachmentHoverCardTriggerProps) => (
	<HoverCardTrigger delay={delay} closeDelay={closeDelay} {...props} />
)

export type AttachmentHoverCardContentProps = ComponentProps<typeof HoverCardContent>

export const AttachmentHoverCardContent = ({
	align = "start",
	className,
	...props
}: AttachmentHoverCardContentProps) => (
	<HoverCardContent align={align} className={cn("w-auto p-2", className)} {...props} />
)

export type AttachmentEmptyProps = HTMLAttributes<HTMLDivElement>

export const AttachmentEmpty = ({ className, children, ...props }: AttachmentEmptyProps) => (
	<div
		className={cn("flex items-center justify-center p-4 text-muted-foreground text-sm", className)}
		{...props}
	>
		{children ?? "No attachments"}
	</div>
)
