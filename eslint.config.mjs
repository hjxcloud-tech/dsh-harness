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
  },
  {
    // 审核环境为非 type-aware 扫描，Node API 会被判 any；本地的豁免注释在其环境下有用
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },
  {
    ignores: ['node_modules/**', 'main.js', '*.mjs', 'tests/**'],
  },
)
