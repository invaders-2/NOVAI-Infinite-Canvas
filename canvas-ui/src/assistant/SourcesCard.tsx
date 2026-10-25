import { ChevronDownIcon, LinkIcon } from "lucide-react"
import { useState } from "react"
import { cn } from "@/lib/utils"
import type { Message } from "./types"

const URL_RE = /https?:\/\/[^\s<>"'\u0060）(]+/g
const MAX_SOURCES = 6

const cleanUrl = (raw: string): string => raw.replace(/[),.;:!?\]"'”’，。；：！？]+$/, "")

const collectStrings = (value: unknown, depth = 0): string[] => {
	if (depth > 4 || value == null) return []
	if (typeof value === "string") return [value]
	if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item, depth + 1))
	if (typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap((item) => collectStrings(item, depth + 1))
	return []
}

const deriveSources = (message: Message) => {
	const found: string[] = []
	for (const part of message.parts) {
		if (part.type === "text") found.push(part.text)
		else if (part.type === "tool_event") {
			found.push(part.message || "")
			if (part.output) found.push(part.output)
			if (part.result !== undefined) found.push(...collectStrings(part.result))
		}
	}
	const urls: string[] = []
	for (const text of found) {
		for (const match of text.matchAll(URL_RE)) {
			const url = cleanUrl(match[0])
			if (url && !urls.includes(url)) urls.push(url)
			if (urls.length >= MAX_SOURCES) break
		}
		if (urls.length >= MAX_SOURCES) break
	}
	const groups: { domain: string; items: { url: string; title: string }[] }[] = []
	for (const url of urls) {
		let domain = ""
		let title = url
		try {
			const parsed = new URL(url)
			domain = parsed.hostname
			const segments = parsed.pathname.split("/").filter(Boolean)
			title = segments.length ? decodeURIComponent(segments[segments.length - 1]) : domain
			if (parsed.search) title += parsed.search
		} catch {
			continue
		}
		let group = groups.find((item) => item.domain === domain)
		if (!group) {
			group = { domain, items: [] }
			groups.push(group)
		}
		group.items.push({ url, title: title.length > 48 ? title.slice(0, 45) + "…" : title })
	}
	return { count: urls.length, groups }
}

export const SourcesCard = ({ message }: { message: Message }) => {
	const sources = deriveSources(message)
	const [open, setOpen] = useState(false)
	if (sources.count === 0) return null
	return (
		<div className="nvca-sources">
			<button aria-expanded={open} className="nvca-sources-trigger" onClick={() => setOpen((value) => !value)} type="button">
				<LinkIcon className="nvca-i-xs" />
				<span>来源 · {sources.count}</span>
				<ChevronDownIcon className={cn("nvca-sources-caret", open && "is-open")} />
			</button>
			{open ? (
				<div className="nvca-sources-body">
					{sources.groups.map((group) => (
						<div className="nvca-source-group" key={group.domain}>
							<div className="nvca-source-domain">{group.domain}</div>
							{group.items.map((item) => (
								<a className="nvca-source-link" href={item.url} key={item.url} rel="noreferrer" target="_blank">
									{item.title}
								</a>
							))}
						</div>
					))}
				</div>
			) : null}
		</div>
	)
}
