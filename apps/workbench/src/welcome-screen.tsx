import { Button } from "@/components/ui/button";

/** 读作品时的安静加载态。 */
export function LoadingScreen() {
	return (
		<main className="grid h-screen place-items-center bg-background">
			<div className="drag absolute inset-x-0 top-0 h-12" />
			<div className="flex flex-col items-center gap-4">
				<div className="grid size-[54px] place-items-center rounded-xl bg-muted font-serif text-[29px] text-foreground">
					燧
				</div>
				<span className="text-xs text-muted-foreground">正在打开作品…</span>
			</div>
		</main>
	);
}

/** 确实没有作品时：打开已有作品或开始新作。 */
export function WelcomeScreen({
	error,
	onChoose,
}: {
	error: string | undefined;
	/** `create` 为真是开始新作。 */
	onChoose: (create: boolean) => void;
}) {
	return (
		<main className="relative h-screen bg-background px-[12vw] py-[14vh]">
			<div className="drag absolute inset-x-0 top-0 h-12" />
			<div className="mb-11 grid size-[54px] place-items-center rounded-xl bg-muted font-serif text-[29px] text-foreground">
				燧
			</div>
			<span className="text-[10px] font-semibold tracking-[2px] text-muted-foreground">
				SUIMING / 长篇创作工作台
			</span>
			<h1 className="my-[22px] font-serif text-[51px] leading-[1.6] font-medium tracking-[3px]">
				让你的故事，
				<br />
				从火种成为世界。
			</h1>
			<p className="text-sm leading-[2] text-muted-foreground">
				阅读、写作、推敲人物与因果。
				<br />
				与专属 Agent 一起，让每一次修改都有来处。
			</p>
			<div className="mt-8 mb-6 flex gap-3">
				<Button size="lg" onClick={() => onChoose(false)}>
					打开作品 ↗
				</Button>
				<Button size="lg" variant="outline" onClick={() => onChoose(true)}>
					开始新作
				</Button>
			</div>
			<p className="text-[11px] text-muted-foreground">作品保存在你的电脑上，不需要云端账号。</p>
			{error && <p className="mt-2 text-[11.5px] leading-[1.7] whitespace-pre-wrap text-[#a06443]">{error}</p>}
		</main>
	);
}
