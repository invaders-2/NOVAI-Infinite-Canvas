"use client"

import { cn } from "@/lib/utils"
import type { ReactNode } from "react"
import { Fragment, memo } from "react"

// 轻量 Markdown：只覆盖对话里真实出现的语法（段落/标题/列表/引用/围栏代码/行内样式/链接/图片）。
// 不引入 streamdown + shiki（会吃掉整个 gzip 预算）；所有文本都由 React 转义，不写 innerHTML。
type InlineToken =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "strong"; value: string }
  | { kind: "em"; value: string }
  | { kind: "strike"; value: string }
  | { kind: "link"; value: string; href: string }
  | { kind: "image"; value: string; src: string }

const INLINE_PATTERN =
  /(!\[[^\]]*\]\([^)\s]+\))|(\[[^\]]+\]\([^)\s]+\))|(`[^`]+?`)|(\*\*[^*]+?\*\*)|(~~[^~]+?~~)|(\*[^*\n]+?\*)/g

const safeHref = (raw: string): string => {
  const href = raw.trim()
  if (/^(https?:|mailto:|tel:|data:image\/|data:video\/)/i.test(href)) return href
  if (href.startsWith("/") || href.startsWith("#") || href.startsWith("./") || href.startsWith("../")) return href
  return "#"
}

const parseInline = (text: string): InlineToken[] => {
  const tokens: InlineToken[] = []
  let lastIndex = 0
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0
    if (index > lastIndex) tokens.push({ kind: "text", value: text.slice(lastIndex, index) })
    const raw = match[0]
    if (raw.startsWith("![")) {
      const split = raw.indexOf("](")
      tokens.push({ kind: "image", value: raw.slice(2, split), src: safeHref(raw.slice(split + 2, -1)) })
    } else if (raw.startsWith("[")) {
      const split = raw.indexOf("](")
      tokens.push({ kind: "link", value: raw.slice(1, split), href: safeHref(raw.slice(split + 2, -1)) })
    } else if (raw.startsWith("`")) {
      tokens.push({ kind: "code", value: raw.slice(1, -1) })
    } else if (raw.startsWith("**")) {
      tokens.push({ kind: "strong", value: raw.slice(2, -2) })
    } else if (raw.startsWith("~~")) {
      tokens.push({ kind: "strike", value: raw.slice(2, -2) })
    } else {
      tokens.push({ kind: "em", value: raw.slice(1, -1) })
    }
    lastIndex = index + raw.length
  }
  if (lastIndex < text.length) tokens.push({ kind: "text", value: text.slice(lastIndex) })
  return tokens
}

const renderInline = (text: string): ReactNode[] =>
  parseInline(text).map((token, index) => {
    switch (token.kind) {
      case "code":
        return <code key={index} className="nvca-md-code">{token.value}</code>
      case "strong":
        return <strong key={index}>{token.value}</strong>
      case "em":
        return <em key={index}>{token.value}</em>
      case "strike":
        return <del key={index}>{token.value}</del>
      case "link":
        return (
          <a key={index} href={token.href} target="_blank" rel="noreferrer noopener">
            {token.value}
          </a>
        )
      case "image":
        return <img key={index} src={token.src} alt={token.value} loading="lazy" className="nvca-md-image" />
      default:
        return <Fragment key={index}>{token.value}</Fragment>
    }
  })

const isFence = (line: string) => /^\s*```/.test(line)

export type MarkdownProps = {
  children?: string
  className?: string
  animated?: boolean
  trailing?: ReactNode
}

const MarkdownComponent = ({ children, className, trailing }: MarkdownProps) => {
  const source = String(children ?? "")
  if (!source.trim()) return null
  const lines = source.replace(/\r\n/g, "\n").split("\n")
  const blocks: ReactNode[] = []
  let i = 0
  let key = 0
  while (i < lines.length) {
    const line = lines[i] ?? ""
    if (!line.trim()) {
      i += 1
      continue
    }
    if (isFence(line)) {
      const language = line.replace(/^\s*```/, "").trim()
      const code: string[] = []
      i += 1
      while (i < lines.length && !isFence(lines[i] ?? "")) {
        code.push(lines[i] ?? "")
        i += 1
      }
      i += 1
      blocks.push(
        <pre key={key++} className="nvca-md-pre" data-language={language || undefined}>
          <code>{code.join("\n")}</code>
        </pre>,
      )
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      const HeadingTag = (level === 1 ? "h1" : level === 2 ? "h2" : level === 3 ? "h3" : "h4") as "h1"
      blocks.push(
        <HeadingTag key={key++} className={"nvca-md-h nvca-md-h" + level}>
          {renderInline(heading[2] ?? "")}
        </HeadingTag>,
      )
      i += 1
      continue
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*([-*+]|\d+\.)\s+/, ""))
        i += 1
      }
      const ListTag = ordered ? "ol" : "ul"
      blocks.push(
        <ListTag key={key++} className="nvca-md-list">
          {items.map((item, index) => (
            <li key={index}>{renderInline(item)}</li>
          ))}
        </ListTag>,
      )
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? "")) {
        quoted.push((lines[i] ?? "").replace(/^\s*>\s?/, ""))
        i += 1
      }
      blocks.push(
        <blockquote key={key++} className="nvca-md-quote">
          {renderInline(quoted.join("\n"))}
        </blockquote>,
      )
      continue
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="nvca-md-hr" />)
      i += 1
      continue
    }
    const paragraph: string[] = []
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() &&
      !isFence(lines[i] ?? "") &&
      !/^(#{1,4})\s+/.test(lines[i] ?? "") &&
      !/^\s*([-*+]|\d+\.)\s+/.test(lines[i] ?? "") &&
      !/^\s*>\s?/.test(lines[i] ?? "")
    ) {
      paragraph.push(lines[i] ?? "")
      i += 1
    }
    blocks.push(
      <p key={key++} className="nvca-md-p">
        {paragraph.map((textLine, index) => (
          <Fragment key={index}>
            {index > 0 ? <br /> : null}
            {renderInline(textLine)}
          </Fragment>
        ))}
        {trailing && lines.slice(i).every((line) => !line.trim()) ? trailing : null}
      </p>,
    )
  }
  return <div className={cn("nvca-md", className)}>{blocks}</div>
}

export const Markdown = memo(MarkdownComponent)
export const MarkdownResponse = Markdown
