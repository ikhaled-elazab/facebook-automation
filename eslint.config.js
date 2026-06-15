'use strict';

/**
 * ESLint flat config (ESLint 9+). Pragmatic ruleset for a CommonJS Node project.
 * Intentionally light: catch real bugs (unused vars, undefined refs), not style
 * (Prettier owns formatting).
 */

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'logs/**',
      'sessions/**',
      'state/**',
      'db/*.db',
      'db/*.db-*',
      '*.example.json',
      'debug_dom*.html',
      // The frontend is a self-contained TypeScript subpackage with its OWN flat
      // config (web/eslint.config.js) + lint script (`npm run ui:lint`). The root
      // CommonJS/Node config must not lint web/ source, its ESM config, or its
      // minified build output. Lint the UI via `npm run ui:lint`.
      'web/**',
    ],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        // Node globals
        process: 'readonly',
        console: 'readonly',
        require: 'readonly',
        module: 'writable',
        __dirname: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly',
        // Browser globals — used inside Playwright page.evaluate() callbacks,
        // which run in the browser context, not Node.
        document: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-var': 'error',
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'smart'],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
];
