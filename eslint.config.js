import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';

export default defineConfig([
  globalIgnores(['dist/', 'node_modules/']),
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error'
    }
  },
  {
    files: ['src/**/*.ts'],
    extends: [eslint.configs.recommended, tseslint.configs['flat/recommended']]
  },
  {
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    extends: [eslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node
    }
  }
]);
