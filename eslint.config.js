import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // The codebase uses a leading underscore for intentionally unused
      // params (store action signatures, test seams) — honor it.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // React Compiler advisory rules (new in react-hooks v6). They flag
      // this app's deliberate R3F performance patterns — reading the store
      // inside useFrame, imperative material swaps — that are documented in
      // CLAUDE.md and must not be "fixed". Kept visible as warnings; do not
      // silence entirely, and revisit if the React Compiler is ever adopted.
      'react-hooks/refs': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      // Dev-only fast-refresh hygiene. Flags deliberate co-located exports
      // (e.g. LidarViewer's getCameraPose); splitting files for HMR alone
      // isn't worth the churn.
      'react-refresh/only-export-components': 'warn',
    },
  },
])
