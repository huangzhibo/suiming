import { ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { bridge } from "./bridge.js";
import { Hint, OverflowHint } from "./ui-bits.js";

/** 左栏底部的作品切换：当前作品、最近作品，打开或新建。 */
export function ProjectSwitcher({
	open,
	onOpenChange,
	workName,
	checkoutPath,
	detail,
	recent,
	busy,
	onSwitch,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workName: string;
	checkoutPath: string;
	/** 当前作品的版本与正文进度。 */
	detail: string;
	recent: { name: string; path: string }[] | undefined;
	busy: boolean;
	/** 切到另一部作品：先存好当前的工作区，再执行 `choose`；它返回真表示真的换了。 */
	onSwitch: (choose: () => Promise<boolean>) => void;
}) {
	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger
				render={
					<Hint content={checkoutPath}>
						<button
							type="button"
							aria-label="切换作品"
							className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-control-hover"
						>
							<ChevronsUpDown className="size-[14px] shrink-0 text-muted-foreground" />
							<span className="truncate text-[13px] font-semibold">{workName}</span>
						</button>
					</Hint>
				}
			/>
			<PopoverContent align="start" side="top" className="w-[270px] p-1.5">
				<div className="px-2 pt-1.5 pb-1 text-[11px] text-muted-foreground">当前作品</div>
				<div className="flex items-center justify-between rounded-md bg-hair-2 px-2 py-[7px]">
					<span className="min-w-0">
						<b className="block truncate text-[13px] font-medium">{workName}</b>
						<small className="block truncate text-[11px] text-muted-foreground">
							{checkoutPath} · {detail}
						</small>
					</span>
					<i className="shrink-0 pl-2 text-[11px] whitespace-nowrap text-primary not-italic">当前</i>
				</div>
				{recent?.some((item) => item.path !== checkoutPath) && (
					<>
						<div className="px-2 pt-2 pb-1 text-[11px] text-muted-foreground">最近作品</div>
						{recent
							.filter((item) => item.path !== checkoutPath)
							.map((item) => (
								<OverflowHint content={`${item.name}\n${item.path}`} key={item.path}>
									<button
										type="button"
										className="flex w-full cursor-pointer flex-col rounded-md px-2 py-[7px] text-left hover:bg-muted disabled:opacity-50"
										disabled={busy}
										onClick={() => onSwitch(() => bridge().openProject(item.path))}
									>
										<b className="block max-w-full truncate text-[13px] font-medium">{item.name}</b>
										<small className="block max-w-full truncate text-[11px] text-muted-foreground">
											{item.path}
										</small>
									</button>
								</OverflowHint>
							))}
					</>
				)}
				<Separator className="my-1.5" />
				<div className="flex gap-1">
					<Button
						variant="outline"
						size="sm"
						className="flex-1"
						disabled={busy}
						onClick={() => onSwitch(() => bridge().chooseProject(false))}
					>
						打开作品…
					</Button>
					<Button
						variant="outline"
						size="sm"
						className="flex-1"
						disabled={busy}
						onClick={() => onSwitch(() => bridge().chooseProject(true))}
					>
						新建作品
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}
