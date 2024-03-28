import _ from 'lodash'
import * as pluginImport from 'eslint-plugin-import'
import globals from 'globals'
import pluginN from 'eslint-plugin-n'
import pluginPromise from 'eslint-plugin-promise'
import standardjs from 'eslint-config-standard'

export default [
  // copy from https://github.com/standard/eslint-config-standard/blob/master/src/index.ts
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',

      parserOptions: {
        ecmaFeatures: { jsx: true },
      },

      globals: {
        ...globals.es2021,
        ...globals.node,
        // @ts-expect-error @types/eslint seems to be incomplete
        document: 'readonly',
        // @ts-expect-error @types/eslint seems to be incomplete
        navigator: 'readonly',
        // @ts-expect-error @types/eslint seems to be incomplete
        window: 'readonly',
      },
    },

    plugins: {
      n: pluginN,
      promise: pluginPromise,
      import: pluginImport,
    },
  },

  _.pick(standardjs, ['rules']), // rules from eslint-config-standard

  // custom rules
  {
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
    rules: {
      'multiline-ternary': 0,
      'no-return-await': 0,
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
