// 本地结构类型：只保留 ai-elements 组件实际用到的字段，避免把整个 AI SDK 打进微应用。
export type UIMessageRole = "user" | "assistant" | "system" | "data" | "tool"

export interface UIMessage {
  id?: string
  role: UIMessageRole
}

export interface FileUIPart {
  type: "file"
  mediaType: string
  filename?: string
  url: string
}

export interface SourceDocumentUIPart {
  type: "source-document"
  mediaType?: string
  filename?: string
  title?: string
  url?: string
}

export type ChatStatus = "submitted" | "streaming" | "ready" | "error"

export type ToolUIPartState =
  | "approval-requested"
  | "approval-responded"
  | "input-available"
  | "input-streaming"
  | "output-available"
  | "output-denied"
  | "output-error"

export interface ToolUIPart {
  type: string
  state: ToolUIPartState
  input?: unknown
  output?: unknown
  errorText?: string
}

export interface DynamicToolUIPart {
  type: "dynamic-tool"
  state: ToolUIPartState
  input?: unknown
  output?: unknown
  errorText?: string
  toolName: string
}

export interface LanguageModelUsage {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cachedInputTokens?: number
}
