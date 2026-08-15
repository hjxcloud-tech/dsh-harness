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
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'obsidianmd/no-unsupported-api': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
    },
    // 文件级 no-unsafe-* 豁免面向审核环境（非 type-aware，Node API 判 any）；本地 type-aware 下呈 unused，忽略该检查
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },
  {
    ignores: ['node_modules/**', 'main.js', '*.mjs', 'tests/**'],
  },
)
