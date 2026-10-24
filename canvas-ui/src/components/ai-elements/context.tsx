"use client"

import { Button } from "@/components/ui/button"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"
import type { LanguageModelUsage } from "@/types/ai"
import type { ComponentProps } from "react"
import { createContext, useContext, useMemo } from "react"

const PERCENT_MAX = 100
const ICON_RADIUS = 10
const ICON_VIEWBOX = 24
const ICON_CENTER = 12
const ICON_STROKE_WIDTH = 2

type ModelId = string

interface ContextSchema {
	usedTokens: number
	maxTokens: number
	usage?: LanguageModelUsage
	modelId?: ModelId
}

const ContextContext = createContext<ContextSchema | null>(null)

const useContextValue = () => {
	const context = useContext(ContextContext)

	if (!context) {
		throw new Error("Context components must be used within Context")
	}

	return context
}

export type ContextProps = ComponentProps<typeof HoverCard> & ContextSchema

export const Context = ({ usedTokens, maxTokens, usage, modelId, ...props }: ContextProps) => {
	const contextValue = useMemo(
		() => ({ maxTokens, modelId, usage, usedTokens }),
		[maxTokens, modelId, usage, usedTokens],
	)

	return (
		<ContextContext.Provider value={contextValue}>
			<HoverCard {...props} />
		</ContextContext.Provider>
	)
}

const ContextIcon = () => {
	const { usedTokens, maxTokens } = useContextValue()
	const circumference = 2 * Math.PI * ICON_RADIUS
	const usedPercent = maxTokens > 0 ? usedTokens / maxTokens : 0
	const dashOffset = circumference * (1 - usedPercent)

	return (
		<svg
			aria-label="Model context usage"
			height="20"
			role="img"
			style={{ color: "currentcolor" }}
			viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
			width="20"
		>
			<circle
				cx={ICON_CENTER}
				cy={ICON_CENTER}
				fill="none"
				opacity="0.25"
				r={ICON_RADIUS}
				stroke="currentColor"
				strokeWidth={ICON_STROKE_WIDTH}
			/>
			<circle
				cx={ICON_CENTER}
				cy={ICON_CENTER}
				fill="none"
				opacity="0.7"
				r={ICON_RADIUS}
				stroke="currentColor"
				strokeDasharray={`${circumference} ${circumference}`}
				strokeDashoffset={dashOffset}
				strokeLinecap="round"
				strokeWidth={ICON_STROKE_WIDTH}
				style={{ transform: "rotate(-90deg)", transformOrigin: "center" }}
			/>
		</svg>
	)
}

export type ContextTriggerProps = ComponentProps<typeof Button>

export const ContextTrigger = ({ children, ...props }: ContextTriggerProps) => {
	const { usedTokens, maxTokens } = useContextValue()
	const usedPercent = maxTokens > 0 ? usedTokens / maxTokens : 0
	const renderedPercent = new Intl.NumberFormat("zh-CN", {
		maximumFractionDigits: 1,
		style: "percent",
	}).format(usedPercent)

	const defaultButton = (
		<Button type="button" variant="ghost" {...props}>
			<span className="font-medium text-muted-foreground">{renderedPercent}</span>
			<ContextIcon />
		</Button>
	)

	return (
		<HoverCardTrigger delay={0} closeDelay={0} render={defaultButton}>
			{children}
		</HoverCardTrigger>
	)
}

export type ContextContentProps = ComponentProps<typeof HoverCardContent>

export const ContextContent = ({ className, ...props }: ContextContentProps) => (
	<HoverCardContent className={cn("min-w-60 divide-y overflow-hidden p-0", className)} {...props} />
)

export type ContextContentHeaderProps = ComponentProps<"div">

export const ContextContentHeader = ({
	children,
	className,
	...props
}: ContextContentHeaderProps) => {
	const { usedTokens, maxTokens } = useContextValue()
	const usedPercent = maxTokens > 0 ? usedTokens / maxTokens : 0
	const displayPct = new Intl.NumberFormat("zh-CN", {
		maximumFractionDigits: 1,
		style: "percent",
	}).format(usedPercent)
	const used = new Intl.NumberFormat("zh-CN", { notation: "compact" }).format(usedTokens)
	const total = new Intl.NumberFormat("zh-CN", { notation: "compact" }).format(maxTokens)

	return (
		<div className={cn("w-full space-y-2 p-3", className)} {...props}>
			{children ?? (
				<>
					<div className="flex items-center justify-between gap-3 text-xs">
						<p>{displayPct}</p>
						<p className="font-mono text-muted-foreground">
							{used} / {total}
						</p>
					</div>
					<div className="space-y-2">
						<Progress className="bg-muted" value={usedPercent * PERCENT_MAX} />
					</div>
				</>
			)}
		</div>
	)
}

export type ContextContentBodyProps = ComponentProps<"div">

export const ContextContentBody = ({ children, className, ...props }: ContextContentBodyProps) => (
	<div className={cn("w-full p-3", className)} {...props}>
		{children}
	</div>
)

export type ContextContentFooterProps = ComponentProps<"div">

// 成本估算依赖 tokenlens 的模型价目表；微应用里不引入，footer 只保留容器（children 可自定义）。
export const ContextContentFooter = ({
	children,
	className,
	...props
}: ContextContentFooterProps) => (
	<div
		className={cn(
			"flex w-full items-center justify-between gap-3 bg-secondary p-3 text-xs",
			className,
		)}
		{...props}
	>
		{children}
	</div>
)

export type ContextInputUsageProps = ComponentProps<"div">

export const ContextInputUsage = ({ className, children, ...props }: ContextInputUsageProps) => {
	const { usage } = useContextValue()
	const inputTokens = usage?.inputTokens ?? 0

	if (children) {
		return children
	}

	if (!inputTokens) {
		return null
	}

	return (
		<div className={cn("flex items-center justify-between text-xs", className)} {...props}>
			<span className="text-muted-foreground">输入</span>
			<TokensWithCost tokens={inputTokens} />
		</div>
	)
}

export type ContextOutputUsageProps = ComponentProps<"div">

export const ContextOutputUsage = ({ className, children, ...props }: ContextOutputUsageProps) => {
	const { usage } = useContextValue()
	const outputTokens = usage?.outputTokens ?? 0

	if (children) {
		return children
	}

	if (!outputTokens) {
		return null
	}

	return (
		<div className={cn("flex items-center justify-between text-xs", className)} {...props}>
			<span className="text-muted-foreground">输出</span>
			<TokensWithCost tokens={outputTokens} />
		</div>
	)
}

export type ContextReasoningUsageProps = ComponentProps<"div">

export const ContextReasoningUsage = ({
	className,
	children,
	...props
}: ContextReasoningUsageProps) => {
	const { usage } = useContextValue()
	const reasoningTokens = usage?.reasoningTokens ?? 0

	if (children) {
		return children
	}

	if (!reasoningTokens) {
		return null
	}

	return (
		<div className={cn("flex items-center justify-between text-xs", className)} {...props}>
			<span className="text-muted-foreground">推理</span>
			<TokensWithCost tokens={reasoningTokens} />
		</div>
	)
}

export type ContextCacheUsageProps = ComponentProps<"div">

export const ContextCacheUsage = ({ className, children, ...props }: ContextCacheUsageProps) => {
	const { usage } = useContextValue()
	const cacheTokens = usage?.cachedInputTokens ?? 0

	if (children) {
		return children
	}

	if (!cacheTokens) {
		return null
	}

	return (
		<div className={cn("flex items-center justify-between text-xs", className)} {...props}>
			<span className="text-muted-foreground">缓存</span>
			<TokensWithCost tokens={cacheTokens} />
		</div>
	)
}

const TokensWithCost = ({ tokens }: { tokens?: number }) => (
	<span>
		{tokens === undefined
			? "—"
			: new Intl.NumberFormat("zh-CN", { notation: "compact" }).format(tokens)}
	</span>
)
