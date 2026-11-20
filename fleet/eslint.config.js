import { defineConfig } from 'eslint/config';

export default defineConfig([
  { ignores: ['dist/**', 'playwright-report/**', 'test-results/**'] },
  {
    files: ['src/**/*.js', 'test/**/*.js', 'e2e/**/*.js', 'web/**/*.jsx', '*.js'],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: {
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-debugger': 'error',
      'no-dupe-keys': 'error',
      'no-irregular-whitespace': 'error',
      'no-unreachable': 'error',
      'valid-typeof': 'error',
    },
  },
]);
