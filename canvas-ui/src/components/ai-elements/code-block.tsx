"use client"

import { cn } from "@/lib/utils"
import type { ComponentProps } from "react"

export type CodeBlockProps = ComponentProps<"pre"> & {
  code: string
  language?: string
}

// 轻量版代码块：微应用里不需要 shiki 级高亮（gzip 预算优先），保留等宽排版与横向滚动。
export const CodeBlock = ({ code, language, className, ...props }: CodeBlockProps) => (
  <pre
    className={cn(
      "nvca-code overflow-x-auto rounded-[10px] bg-[var(--nvca-fill-1)] p-3 font-mono text-[11.5px] leading-[1.6] text-[var(--nvca-ink)]",
      className,
    )}
    data-language={language}
    {...props}
  >
    <code>{code}</code>
  </pre>
)
