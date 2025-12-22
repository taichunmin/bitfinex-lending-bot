import _ from 'lodash'
import * as pluginImport from 'eslint-plugin-import'
import globals from 'globals'
import pluginN from 'eslint-plugin-n'
import pluginPromise from 'eslint-plugin-promise'
import love from 'eslint-config-love'

export default [
  // https://github.com/mightyiam/eslint-config-love
  {
    ...love,
    files: ['**/*.js', '**/*.ts'],
    ignores: ['**/*.config.js'],
  },

  // custom rules
  {
    files: ['**/*.js', '**/*.ts'],
    ignores: ['**/*.config.js'],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 0,
      '@typescript-eslint/naming-convention': 0,
      '@typescript-eslint/no-explicit-any': 0,
      '@typescript-eslint/no-magic-numbers': 0,
      '@typescript-eslint/no-unnecessary-type-parameters': 0,
      '@typescript-eslint/no-unsafe-argument': 0,
      '@typescript-eslint/no-unsafe-assignment': 0,
      '@typescript-eslint/no-unsafe-call': 0,
      '@typescript-eslint/no-unsafe-member-access': 0,
      '@typescript-eslint/no-unsafe-return': 0,
      '@typescript-eslint/no-unsafe-type-assertion': 0,
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 0,
      '@typescript-eslint/only-throw-error': 0,
      '@typescript-eslint/prefer-destructuring': 0,
      '@typescript-eslint/unbound-method': 0,
      'complexity': 0,
      'multiline-ternary': 0,
      'no-await-in-loop': 0,
      'no-console': 0,
      'no-multi-assign': 0,
      'no-param-reassign': 0,
      'no-plusplus': 0,
      'no-return-await': 0,
      'prefer-named-capture-group': 0,
      'comma-dangle': [
        'error',
        {
          arrays: 'always-multiline',
          objects: 'always-multiline',
          imports: 'always-multiline',
          exports: 'always-multiline',
          functions: 'only-multiline',
        },
      ],
    },
  },
]
