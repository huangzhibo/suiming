import { plugin as shadcn } from "@shadcn/lint";
import tsParser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";

/**
 * `@shadcn/lint` 的接线，只覆盖 `apps/workbench`——全仓只有它用 Tailwind v4 与 shadcn/ui。
 *
 * 通用 lint 与格式仍然全部归 biome（根 `biome.json`，覆盖 `apps/*​/src` 与 `packages/*​/src`）。
 * 这里的 ESLint **只跑设计系统规则**，不接管 biome 的任何一条：两者的规则面没有重叠，
 * 不要往这里加 `@typescript-eslint` 或 `react` 的 preset，那才会变成第二套通用 linter。
 *
 * 已开 `no-raw-colors`；其余五条（`no-restyle`、`no-arbitrary-values`、
 * `no-inline-styles`、`no-unknown-classes`、`require-static-classes`）尚未开，选项见 https://github.com/shadcn-ui/lint/blob/main/docs/rules.md，
 * 开哪几条、允许什么，由作者定。加规则就写进下面的 `rules`。
 *
 * 组件与主题由插件自己从 `apps/workbench/components.json` 发现（`@/components/ui` 与 `src/style.css`），
 * 所以这里没有 `settings.shadcn`；只有在组件搬出默认位置、或要认别的 merge / variant 函数时才需要加。
 */
export default defineConfig([
	{
		files: ["src/**/*.ts", "src/**/*.tsx"],
		languageOptions: {
			parser: tsParser,
			parserOptions: { ecmaFeatures: { jsx: true } },
		},
		plugins: { shadcn },
		rules: {
			// 2026-09-16 开的第一条：写死的颜色不跟主题走。SVG 图元的 fill 用 var(--token)，
			// 与 axis 里既有的 var(--amber) / var(--primary) 一致；className 里用 Tailwind 的颜色类。
			"shadcn/no-raw-colors": "error",
		},
	},
]);
