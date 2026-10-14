import { useCommandState } from "cmdk";
import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Book } from "./model.js";
import { shortId } from "./model.js";
import { rankVersion } from "./version-search.js";

/** 版本编号来自 Canon 顺序；只改变展示顺序，不改变 rN 的含义。侧栏与两处比较入口共用。 */
export function VersionPicker({
	book,
	selected,
	label,
	name,
	onSelect,
}: {
	book: Book;
	selected: string | null;
	label: string;
	name: string;
	onSelect(id: string): void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<Button size="xs" variant="outline" aria-label={name}>
						{label}
						<ChevronDown data-icon="inline-end" />
					</Button>
				}
			/>
			<PopoverContent align="start" className="w-80 max-w-[calc(100vw-32px)] gap-0 p-0" data-version-picker>
				{open && (
					<Command
						defaultValue={selected ?? ""}
						filter={(id, query, keywords) =>
							rankVersion(id, keywords?.[0] ?? "", query, book.data.revisions.length)
						}
					>
						<CommandInput aria-label="搜索版本" placeholder="搜索版本号或提交编号…" />
						<CommandList className="max-h-[min(320px,calc(var(--available-height)-80px))]">
							<CommandEmpty>没有匹配的版本</CommandEmpty>
							<CommandGroup heading={<VersionHeading total={book.data.revisions.length} />}>
								{book.data.revisions
									.map((revision, index) => ({ ...revision, label: `r${index + 1}` }))
									.reverse()
									.map((revision) => (
										<CommandItem
											key={revision.id}
											value={revision.id}
											keywords={[revision.label]}
											onSelect={() => {
												setOpen(false);
												onSelect(revision.id);
											}}
										>
											<span className="w-12 shrink-0 tabular-nums">{revision.label}</span>
											<span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
												{shortId(revision.id)}
											</span>
											<span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
												{revision.id === book.data.revisionId ? "最新" : ""}
												{revision.id === selected && <Check aria-label="当前选择" />}
											</span>
										</CommandItem>
									))}
							</CommandGroup>
						</CommandList>
					</Command>
				)}
			</PopoverContent>
		</Popover>
	);
}

function VersionHeading({ total }: { total: number }) {
	const query = useCommandState((state) => state.search);
	const count = useCommandState((state) => state.filtered.count);
	return query.trim() ? `匹配 ${count} / ${total} · 精确优先` : `${total} 个版本 · 最近在前`;
}
