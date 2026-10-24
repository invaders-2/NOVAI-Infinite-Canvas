"use client"

import { cn } from "@/lib/utils"
import { memo } from "react"

export interface TextShimmerProps {
  children: string
  as?: "p" | "span" | "div"
  className?: string
  duration?: number
  spread?: number
}

// 用 CSS 动画复刻 motion 版 shimmer：背景裁切 + 一道高光扫过，不再引入 motion。
const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => (
  <Component
    className={cn("nvca-shimmer relative inline-block bg-clip-text text-transparent", className)}
    style={
      {
        "--nvca-shimmer-duration": duration + "s",
        "--nvca-shimmer-spread": Math.max(1, children.length * spread) + "px",
      } as React.CSSProperties
    }
  >
    {children}
  </Component>
)

export const Shimmer = memo(ShimmerComponent)
