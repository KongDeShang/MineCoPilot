# 任务 12：Ctrl+K 命令面板

## 背景

- 现状：`src/renderer/src/components/GlobalSearch.vue`（6.5KB）实现全局搜索（搜设备/工单/知识库），挂在 App 布局里；无键盘命令入口。
- 目标：`Ctrl+K` 唤起**全局命令面板**，四类命令：导航（15 个页面）、动作（建单/记维保/导出报告等快捷操作）、查询（融合 GlobalSearch）、AI（自然语言转 AI 助手）。
- 依赖：任务 05 域化架构的 `commands.js` 注册接口（本任务实现命令收集与执行，域注册命令的规范已在任务 05 定义；先接入现有页面的命令，未迁移域的命令由注册中心默认提供）。

## 目标

1. `components/CommandPalette.vue`：Ctrl+K 唤起、模糊搜索（含拼音首字母）、↑↓ 选择、Enter 执行、Esc 关闭；
2. 四类命令全部可用；
3. 命令注册表：各域/页面通过注册接口贡献命令，面板本体不写死命令列表；
4. GlobalSearch 改造成面板的"查询后端"（或面板内联搜索结果区）。

## 改动清单

| 文件 | 动作 | 说明 |
|------|------|------|
| `src/renderer/src/components/CommandPalette.vue`（新增） | 面板 | 快捷键/搜索/选择/执行 |
| `src/renderer/src/domains/registry.js` | 命令收集 | `getCommands()` 聚合各域 `commands.js` + 内置导航/动作命令 |
| `src/renderer/src/components/GlobalSearch.vue` | 改造/复用 | 搜索结果作为命令面板的"查询"类别（或面板内联搜索逻辑，GlobalSearch 保留原入口） |
| `src/renderer/src/App.vue` | 挂载面板 | 全局注册快捷键与面板实例 |
| 各域 `commands.js`（settings 域已有，其余现有域可先由注册中心默认生成导航命令） | 命令贡献 | 定义 `{ id, label, keywords, run }` |

## 实现要点

- **快捷键**：`keydown` 监听 `Ctrl/Cmd + K`（`preventDefault` 防浏览器默认）；输入框自动聚焦；Esc 关闭并还原焦点；打开时锁定背景滚动。
- **模糊搜索**：命令 label + keywords 子串匹配，可加拼音首字母匹配（如"kj"→"控制台/看板"；简单实现：`pinyin-pro` 或手写首字母提取，若引库注意离线与体积，或用轻量实现）。
- **命令结构**：`{ id, label, category: 'nav'|'action'|'query'|'ai', keywords, icon, run(ctx) }`；`run` 返回 Promise，执行后可关闭面板。
- **四类实现**：
  - nav：路由跳转（`router.push`），15 个页面由路由表自动生成（不手写）；
  - action：调 store 方法（新建工单→跳工单页打开新建；记录维保→跳台账；导出周报→触发报告导出——报告导出在任务 13 实现，本任务先接现有动作，未实现的占位标"开发中"或跳过）；
  - query：复用 GlobalSearch 的搜索逻辑（设备/工单/知识库），面板内显示结果列表，回车进详情页；
  - ai：回车后跳 `/ai-assistant?q=<text>`，AI 助手读取 query 参数自动发送（AIAssistant.vue 需支持读取 `route.query.q`——小改动，含在本任务）。
- **键盘导航**：↑↓ 移动高亮、Enter 执行、Tab 切换类别（可选）；鼠标点击同样可用（触控 44px 目标）。
- **空态**：无匹配时显示"没有匹配的命令"+"回车直接问 AI"（把输入当作 AI 提问）。

## 验收标准

1. Ctrl+K 唤起/关闭正常；焦点管理正确（关闭后焦点还原）；
2. 15 个页面导航可达；动作类命令执行正确；查询类返回结果并可进详情；AI 类带问句跳转并自动发送；
3. 拼音首字母匹配可用（或明确说明未做，如实记录）；
4. 命令面板在深色主题（任务 09）下可读；
5. `npm run lint` 0 错；`npm run e2e` 全过（可加 1 条：Ctrl+K → 输入"告警" → 回车跳转）。

## 注意

- 命令面板是纯前端功能，不涉及 Electron IPC 变更；不破坏 GlobalSearch 现有入口（搜索框保留）。
- 若引入拼音库，必须纯 JS 且体积小（离线铁律），否则手写首字母提取。
- 不动 health.js / nlCommand.js / llmClient.js / database.js。
