// Shared ESLint setup for the repo-rule checks. Parser only, no type info, so it stays light.
'use strict';
const { Linter, ESLint } = require('eslint');
const tsParser = require('@typescript-eslint/parser');
const plugin = require('./eslint-plugin');

const config = [
  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { repo: plugin },
    rules: {
      'repo/worklet-captures': 'error',
      'repo/no-union-box-blocker': 'error',
      'repo/dir-row-needs-flex-direction': 'error',
    },
  },
];

/** Lint a string in memory (used by the tests and the git-history proofs). */
function lintText(code, filename = 'x.tsx') {
  return new Linter({ configType: 'flat' }).verify(code, config, filename);
}

/** Lint real files. Returns [{file, ruleId, line, message}]. */
async function lintFiles(patterns) {
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: config, cache: false });
  const results = await eslint.lintFiles(patterns);
  return results.flatMap((r) => r.messages.filter((m) => m.ruleId && m.ruleId.startsWith('repo/')).map((m) => ({ file: r.filePath, ruleId: m.ruleId, line: m.line, message: m.message })));
}

module.exports = { lintText, lintFiles };
