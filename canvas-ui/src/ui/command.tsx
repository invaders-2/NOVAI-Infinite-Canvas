import { Command as CommandPrimitive } from "cmdk"
import { SearchIcon } from "lucide-react"
import type * as React from "react"
import { cn } from "@/ui/lib/utils"

const Command = ({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) => (
	<CommandPrimitive className={cn("flex size-full flex-col overflow-hidden", className)} {...props} />
)
const CommandInput = ({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) => (
	<div className="flex items-center gap-2 border-b px-2">
		<SearchIcon className="size-4 opacity-50" />
		<CommandPrimitive.Input className={cn("h-8 w-full bg-transparent text-sm outline-none", className)} {...props} />
	</div>
)
const CommandList = ({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) => (
	<CommandPrimitive.List className={cn("max-h-64 overflow-y-auto p-1", className)} {...props} />
)
const CommandEmpty = (props: React.ComponentProps<typeof CommandPrimitive.Empty>) => (
	<CommandPrimitive.Empty className="px-2 py-3 text-xs opacity-60" {...props} />
)
const CommandGroup = ({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) => (
	<CommandPrimitive.Group className={cn("p-1", className)} {...props} />
)
const CommandItem = ({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) => (
	<CommandPrimitive.Item className={cn("flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs", className)} {...props} />
)
const CommandSeparator = ({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Separator>) => (
	<CommandPrimitive.Separator className={cn("my-1 h-px bg-black/10", className)} {...props} />
)
export { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator }
