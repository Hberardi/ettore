// Flat ESLint config (ESLint 9+).
// Goal: catch real bugs, NOT enforce style. We don't want noisy lint output —
// only rules where a violation reliably indicates a problem.
import globals from 'globals';

export default [
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2024,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'warn',
    },
    rules: {
      // Real bugs
      'no-undef': 'error',
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_|^e$|^err$|^error$',
        destructuredArrayIgnorePattern: '^_',
      }],
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-cond-assign': ['error', 'except-parens'],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-ex-assign': 'error',
      'no-fallthrough': 'error',
      'no-self-compare': 'error',
      'no-sparse-arrays': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-negation': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'require-atomic-updates': 'off', // too many false positives in async loops
      'no-async-promise-executor': 'error',
      'no-misleading-character-class': 'error',
      'no-promise-executor-return': 'error',
      'no-unused-private-class-members': 'warn',
    },
  },
  // Test files use a global `test` from node:test — but it's imported, so no
  // special globals are actually needed. Keep a placeholder block in case
  // we later add jest/mocha globals here.
  {
    files: ['tests/**/*.js'],
    rules: {
      'no-unused-vars': 'off',
    },
  },
  {
    ignores: [
      'node_modules/',
      // Legacy Ink renderer. The active CLI uses src/app/native-ui.js and
      // src/app/tui-native.js; see AGENTS.md.
      'src/app/index.js',
      'agents/',
      'team/',
      '.ettore/',
      '.serena/',
      '.claude/',
      'test_display.py',
    ],
  },
];
