module.exports = {
  root: true,
  extends: ['@adobe/helix', 'prettier'],
  env: {
    serviceworker: true,
    browser: true,
    es6: true,
  },
  parserOptions: {
    sourceType: 'module',
    ecmaVersion: 2022,
  },
  overrides: [
    {
      files: ['**/*.ts'],
      parser: '@typescript-eslint/parser',
      plugins: ['@typescript-eslint'],
      extends: [
        'plugin:@typescript-eslint/recommended',
        'prettier',
      ],
      settings: {
        'import/resolver': {
          node: {
            extensions: ['.js', '.ts'],
          },
        },
      },
      rules: {
        // TypeScript handles these
        'no-unused-vars': 'off',
        '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
        'no-undef': 'off',
        // TypeScript module resolution
        'import/no-unresolved': 'off',
        'import/extensions': 'off',
        // Allow any in specific cases
        '@typescript-eslint/no-explicit-any': 'warn',
        // Allow empty interfaces for type declarations
        '@typescript-eslint/no-empty-object-type': 'off',
        // Allow assignment to function parameters
        'no-param-reassign': 'off',
        // Allow class methods that don't use 'this'
        'class-methods-use-this': 'off',

        // collab-client uses a factory function that returns a class expression
        'max-classes-per-file': 'off',
      },
    },
  ],
  rules: {
    'import/prefer-default-export': 0,

    // console.log is the only means of logging in a cloudflare worker
    'no-console': 'off',

    // Allow assignment to function parameters
    'no-param-reassign': 'off',

    // Allow class methods that don't use 'this'
    'class-methods-use-this': 'off',

    // Disable license header requirement
    'header/header': 'off',

    'no-underscore-dangle': 'off',

    'import/no-extraneous-dependencies': [
      'error',
      {
        devDependencies: true,
      },
    ],

    // Allow functions to be used before their definition (hoisting)
    'no-use-before-define': ['error', { functions: false, classes: true, variables: true }],
  },
  globals: {
    globalThis: true,
  },
};
