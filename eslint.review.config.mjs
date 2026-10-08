/**
 * 商店源码审查（obsidian-releases 自动审核）本地复现器。用法：npm run lint:review
 *
 * 为什么要复现器：商店审查是 type-aware 的 ESLint，但**不加载 @types/***——
 * `node:fs` / `node:os` / `node:path` / `child_process` 以及 `process`、`Buffer` 全局在它那不落成类型，
 * 一律按 error type（等价 any）处理，于是 `@typescript-eslint/no-unsafe-*` 成批出现、
 * `no-redundant-type-constituents` 报「error 型联合」，`no-deprecated` 还会把 JSDoc 废弃的 API 全列出来。
 * `obsidian` 包自带的 d.ts 能解析，所以只有直用 Node 内置模块的文件被报——这与 2.8.8 那份审查清单逐条吻合。
 * 本地 `npm run lint`（tsconfig.json 类型齐全）看不到这些，改完没法自证，故用本配置复现同一视角。
 *
 * 本仓的两类处理手段：
 * 1. 「文件级 eslint-disable/enable 配对头」豁免 Node API 造成的 no-unsafe-*（配对由 check-review-lint.mjs 第 1 项钉死）；
 * 2. 真 API 迁移（如 window.* 定时器）。
 * 剩余不修的只有「插件功能固有项」：Node 直访/子进程/系统身份信息/剪贴板披露，以及声明式设置 API 建议。
 */
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import obsidianPlugin from 'eslint-plugin-obsidianmd'

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    plugins: {
      obsidianmd: obsidianPlugin,
    },
    languageOptions: {
      parserOptions: {
        project: './tsconfig.review.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // 审查侧会跑 no-deprecated（JSDoc @deprecated 一律报）
      '@typescript-eslint/no-deprecated': 'warn',
      // 本仓故意关掉（无歧义写法可读性更好），模拟时同样关闭以免噪声掩盖真问题
      '@typescript-eslint/no-explicit-any': 'off',
      // Obsidian 侧规则：审查 recommended 集里与本次清单相关的
      'obsidianmd/no-unsupported-api': 'error',
      'obsidianmd/prefer-window-timers': 'warn',
      'obsidianmd/settings-tab/prefer-setting-definitions': 'warn',
      'obsidianmd/settings-tab/prefer-update-over-display': 'warn',
      'obsidianmd/settings-tab/no-deprecated-display': 'warn',
    },
    linterOptions: {
      // 与 eslint.config.mjs 同口径关掉「多余指令」检查：同一份豁免在类型齐全的一侧必然显得多余；
      // 商店据此报错的是「disable 未配 enable」，那条由 check-review-lint.mjs 第 1 项把关
      reportUnusedDisableDirectives: 'off',
    },
  },
  {
    ignores: ['node_modules/**', 'main.js', '*.mjs', '**/*.mjs', 'scripts/**', 'tests/**', 'vitest.config.ts'],
  },
)
