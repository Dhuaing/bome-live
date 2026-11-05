module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    ecmaFeatures: { jsx: true }
  },
  plugins: ['@typescript-eslint', 'react', 'react-hooks', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended'
  ],
  settings: {
    react: { version: 'detect' }
  },
  env: {
    browser: true,
    node: true,
    es2020: true
  },
  globals: {
    // Taro 编译期注入
    defineAppConfig: 'readonly',
    definePageConfig: 'readonly',
    wx: 'readonly'
  },
  rules: {
    // 项目里大量使用 any 处理 catch 与第三方返回，先不阻断
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    // 允许以 _ 开头的未使用参数
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
    ],
    // 小程序端没有 window/document，误用要能发现
    'no-restricted-globals': [
      'error',
      { name: 'window', message: '小程序端没有 window，请用 Taro API' },
      { name: 'document', message: '小程序端没有 document，请用 Taro API' }
    ],
    'react/react-in-jsx-scope': 'off',
    'react/prop-types': 'off'
  },
  overrides: [
    {
      // Node 脚本运行在完整 Node 环境，不受小程序限制
      files: ['scripts/**/*.js', 'cloudfunctions/**/*.js', 'config/**/*.ts'],
      rules: {
        'no-restricted-globals': 'off',
        '@typescript-eslint/no-var-requires': 'off'
      }
    }
  ],
  ignorePatterns: ['node_modules/', 'dist/', 'dist-h5/', 'dist-weapp/', '.swc/', '*.js']
};
