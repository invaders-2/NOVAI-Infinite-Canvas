import {
	BrainIcon,
	CheckCircle2Icon,
	CheckIcon,
	ChevronDownIcon,
	ClapperboardIcon,
	ImageIcon,
	LayersIcon,
	LayoutGridIcon,
	LinkIcon,
	ListChecksIcon,
	Loader2Icon,
	PencilIcon,
	PlusIcon,
	ScanSearchIcon,
	SparklesIcon,
	Trash2Icon,
	WrenchIcon,
	XCircleIcon,
	XIcon,
} from "lucide-react"
import type { ComponentType } from "react"

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
	brain: BrainIcon,
	check: CheckCircle2Icon,
	checkPlain: CheckIcon,
	chevron: ChevronDownIcon,
	clapperboard: ClapperboardIcon,
	image: ImageIcon,
	layers: LayersIcon,
	layout: LayoutGridIcon,
	link: LinkIcon,
	list: ListChecksIcon,
	loading: Loader2Icon,
	pencil: PencilIcon,
	plus: PlusIcon,
	scan: ScanSearchIcon,
	sparkles: SparklesIcon,
	trash: Trash2Icon,
	wrench: WrenchIcon,
	fail: XCircleIcon,
	close: XIcon,
}

export const ToolIcon = ({ name, className }: { name: string; className?: string }) => {
	const Icon = ICONS[name] || WrenchIcon
	return <Icon className={className} />
}
