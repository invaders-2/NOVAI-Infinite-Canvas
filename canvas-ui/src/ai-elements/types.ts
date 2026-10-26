export type ChatStatus = "ready" | "submitted" | "streaming" | "error"

export interface FileUIPart {
	type: "file"
	filename?: string
	mediaType?: string
	url: string
}

export interface SourceDocumentUIPart {
	type: "source-document"
	title?: string
	filename?: string
	mediaType?: string
	url?: string
}
