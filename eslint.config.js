import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // contract/schemas is a verbatim mirror of hermes-lens/src/schemas —
    // never reformatted or linted here so diffs against the source of truth
    // stay clean.
    ignores: ['dist/', 'contract/schemas/', 'node_modules/', 'fixtures/'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
)
