/**
 * 矿山智工 - ESLint 配置（扁平配置，ESLint 10）
 *
 * 定位：**只拦真错，不管风格**。
 * 项目此前没有任何静态检查，所以这里刻意不用 vue/recommended（那套有一半是排版规则，
 * 接入当天会刷出上千条格式告警，真正的 bug 会被淹没）。选 vue/essential
 * ——它只包含"会导致运行时报错"的规则——再补上三条本项目吃过大亏的规则：
 *
 *   vue/no-undef-properties  ← 就是它没拦住 Equipment.vue 模板里调用未导入的
 *                               equipmentPhoto()，导致整页白屏而自检全绿
 *   no-unused-vars           ← 删代码留下的死引用
 *   vue/no-unused-components ← 模板里 import 了却没用上的组件
 *
 * 运行：npm run lint        （只报错不改）
 *      npm run lint:fix    （自动修可修项）
 */
import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'

export default [
  {
    ignores: [
      'dist/**',
      'release/**',
      'node_modules/**',
      '.tmp-selfcheck/**',
      'src/renderer/public/**',
      // 临时/一次性脚本（截图工具、数据探针）。它们在 .gitignore 里已被 .tmp-*/ 忽略，
      // 但 eslint 看的是工作区、git 看的是版本控制，两件事 —— 不在这里再忽略一次的话，
      // 一个随手写的探针就能让 npm run verify 在第一步 lint 挂掉，而原因与项目代码无关。
      '.tmp-*/**',
      '.audit-probe*.mjs'
    ]
  },

  js.configs.recommended,
  ...pluginVue.configs['flat/essential'],

  {
    files: ['**/*.{js,mjs,cjs,vue}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        // vite.config.mjs 里 define 注入的构建期常量（database.js 用它定位 sql-wasm）
        __SQLJS_WASM_URL__: 'readonly'
      }
    },
    rules: {
      // ---- 拦截"会让界面炸掉但自检发现不了"的错误 ----
      'vue/no-undef-properties': 'error',
      'vue/no-unused-components': 'error',
      'vue/no-unused-vars': 'error',
      'vue/no-side-effects-in-computed-properties': 'error',
      'vue/no-mutating-props': 'error',
      'vue/require-v-for-key': 'error',
      'vue/no-parsing-error': 'error',
      'vue/valid-v-model': 'error',
      'vue/no-dupe-keys': 'error',
      'vue/no-reserved-component-names': 'error',

      // ---- 通用 JS 正确性 ----
      'no-unused-vars': ['error', {
        args: 'none',            // 回调签名常按接口预留参数，不强制删
        caughtErrors: 'none',
        varsIgnorePattern: '^_'
      }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],  // 有意留空的 catch 有注释说明
      'no-constant-binary-expression': 'error',
      'no-self-assign': 'error',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-func-assign': 'error',
      'no-unsafe-negation': 'error',
      'no-useless-escape': 'warn',
      'no-prototype-builtins': 'off',   // 本项目对象均来自本地 JSON，无原型污染面
      'no-control-regex': 'off'         // 中文标点类正则需要控制字符

      // 刻意不启用任何排版/命名类规则：风格问题由人工评审把关，
      // 静态检查只负责"这行会不会在运行时炸"。
    }
  },

  // 验收脚本跑在 Node 下，允许用 process/console 等（globals.node 已覆盖）
  {
    files: ['scripts/**/*.mjs', 'vite.config.mjs', 'eslint.config.mjs'],
    languageOptions: { sourceType: 'module' }
  },

  // 路由级视图刻意用单词名（Dashboard/Equipment/Landing…）：
  // 它们是页面而不是可复用组件，名字与菜单/路由路径一一对应，改成双词反而更难对照。
  {
    files: ['src/renderer/src/views/**/*.vue'],
    rules: { 'vue/multi-word-component-names': 'off' }
  }
]
