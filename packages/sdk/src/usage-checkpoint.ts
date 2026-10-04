/**
 * 每轮用量检查点（折算 token：未缓存输入与缓存写按一，缓存读按一成，输出按五倍）。一轮里根与子任务合计到这里，
 * 下一次请求之前停下等作者说继续；理由与 600 万的依据见 Harness 设计第 10 节。作者在设置页或 config.toml 的
 * `session.usage_checkpoint` 调；不设「关闭」：停下不丢任何进度，要整夜跑就调大。
 *
 * 单独一个模块：渲染层只要这个常量，不该为它把命令目录、AG-UI schema 与 zod-to-json-schema 一起打进包
 * （sdk 声明了 sideEffects: false，常量与 LOCAL_COMMANDS 同在一个模块时摇不掉）。
 */
export const USAGE_CHECKPOINT_TOKENS = { default: 6_000_000, min: 1_000_000, max: 1_000_000_000 } as const;
