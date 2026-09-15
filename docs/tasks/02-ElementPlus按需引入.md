# 任务 02：Element Plus 按需引入（缩小 vendor-element chunk）

## 背景

- 项目渲染入口 `src/renderer/src/main.js` 当前是 **Element Plus 全量引入**：
  - `import ElementPlus from 'element-plus'` + `app.use(ElementPlus, { locale: zhCn })`
  - `import 'element-plus/dist/index.css'`（全量样式）
- 实测生产构建（`npm run build`）输出：**`vendor-element-Dd4fJDzf.js 974.34 kB（gzip 311.77 kB）`**，超过 `vite.config.mjs` 中 `chunkSizeWarningLimit: 700`，构建时明确告警："Some chunks are larger than 700 kB after minification"。
- `vite.config.mjs` 的 `manualChunks` 把 element-plus 拆成 `vendor-element` 独立 chunk（这是有意设计，让"谁撑大包"可见），但全量引入导致该 chunk 超标。
- 图标是特例：模板以字符串形式引用图标（`<component :is="section.icon" />`、`icon="ArrowLeft"`），`main.js` 里已用白名单 `APP_ICONS`（`utils/appIcons.js`，69 个）循环 `app.component` 全局注册——**这层保留，不能删**（全量 `import * as ElementPlusIconsVue` 会让 293 个图标整包打进主 chunk）。
- 组件按需引入后，`vendor-element` chunk 预计可降到 200-350KB 量级。安全网：88 条 e2e + `vue/no-undef-properties` 静态检查（模板调用未导入函数会白屏，可被静态检查拦住）。

## 目标

将 Element Plus 组件/样式改为**按需自动引入**，消除 700KB 阈值告警，同时保证 15 个页面全部功能不回归。

## 改动清单

| 文件 | 动作 | 说明 |
|------|------|------|
| `package.json` | 新增 devDependencies | `unplugin-vue-components`、`unplugin-auto-import` |
| `vite.config.mjs` | plugins 增加两个插件 | `Components({ resolvers: [ElementPlusResolver()] })` + `AutoImport({ resolvers: [ElementPlusResolver()] })` |
| `src/renderer/src/main.js` | 移除全量引入 | 删 `app.use(ElementPlus)`、删 `import 'element-plus/dist/index.css'`；保留 locale 处理（`zh-cn` 按需方案：`import zhCn from 'element-plus/es/locale/lang/zh-cn'` 并在入口手动 `app.config.globalProperties.$ELEMENT = { locale: zhCn }` 或按 resolver 文档处理）；**保留 APP_ICONS 白名单循环注册** |
| `vite.config.mjs` | manualChunks 检查 | 确认 element-plus 仍独立成 `vendor-element` chunk（观察体积变化） |

## 实现要点

- 按 `unplugin-vue-components` 官方文档配置 `ElementPlusResolver`；注意 `directives`（如 `v-loading`）需要 resolver 的 directives 支持，模板里用到的指令要覆盖（可全局搜 `v-loading`/`v-infinite-scroll` 等）。
- `el-message` / `ElMessageBox` / `ElNotification` 这类**命令式组件**（非模板标签）按需方案需要手动引入样式：在用到处 `import { ElMessage } from 'element-plus'` + `import 'element-plus/es/components/message/style/css'`，或统一在入口按白名单注册。检查所有视图里 `ElMessage`/`ElMessageBox`/`ElNotification` 的调用方式（项目里多为 `import { ElMessage } from 'element-plus'`，确认这些模块的样式也被引入，否则弹窗无样式）。
- 构建后核对产物：`vendor-element` 应显著缩小；同时确认**没有新增其他超阈值 chunk**。
- 跑 `npm run lint`：`vue/no-undef-properties` 若报模板中未导入组件，说明按需引入漏了组件——补注册或改插件配置。

## 验收标准

1. `npm run build` 成功且**无 700KB 阈值告警**；
2. `dist/assets/` 中 `vendor-element*.js` 显著小于 700KB（记录前后体积）；
3. `npm run e2e` 88 条全部通过（真实点击 15 个页面，验证组件渲染不白屏）；
4. 手动抽查：弹窗（消息提示）、表格分页、对话框、图标均正常显示，样式不缺失；
5. `npm run lint` 0 错。

## 注意

- 不引入任何新 UI 库；不改变任何页面结构；`APP_ICONS` 白名单机制原样保留。
- 若 e2e 环境起不来（需 dev server），如实报告并给出无法验证的部分。
