const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');
const tseslint = require('typescript-eslint');
import { defineConfig } from 'eslint/config';

module.exports = defineConfig(
  {
    ignores: ['node_modules/**', 'dist/**', 'build/**', 'coverage/**', '*.log'],
  },
  {
    files: ['src/**/*.ts'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      prettier,
    ],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-console': 'warn',
      'no-unused-vars': 'off',
    },
  },
);
