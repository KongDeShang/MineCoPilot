# 任务 01：提交未提交改动 + 修正 README 不一致

## 背景

- 项目 `D:\徐工` 工作区有 **12 个文件、512 行改动未提交**（`git status` 确认）：`README.md`、`docs/参赛材料.md`、`docs/测试报告.md`、`docs/演示脚本.md`、`scripts/e2e.mjs`（+44）、`scripts/self-check.mjs`（+90）、`src/renderer/src/stores/appStore.js`（+40）、`src/renderer/src/stores/persistence.js`、`src/renderer/src/utils/knowledgeBase.js`（+178）、`src/renderer/src/utils/nlCommand.js`、`src/renderer/src/utils/synonyms.js`（+95）、`src/renderer/src/views/Dashboard.vue`、`src/renderer/src/views/Equipment.vue`。
- 这些改动包含 README 中"self-check 288 通过 / e2e 88 通过"数字的更新来源，属于正在进行的增量（知识库扩充 + 同步词表 + 断言新增）。
- 当前 HEAD 为 `15357d2`（build 打包优化），工作区领先于它。
- README 仍有 **2 处与代码不一致**：
  1. 「验收」节写 `npm run e2e # 86 条`，但「当前状态」写 `e2e 88 通过`（脚本已实际为 88 条）；
  2. 「已知边界」仍写"数据看板状态条仍用 emoji 图标（💰⚠️🔒）"，但代码已在提交 `692fe62` 换成 `el-icon`（`Dashboard.vue` 第 6-24 行已用 `<el-icon><Money/></el-icon>` 等，注释也写明已换）。

## 目标

1. 把所有未提交改动提交为一个 checkpoint（消息可描述"知识库扩充 + 同步词表 + 验收数字更新"）。
2. README 两处失真修正，使文档与代码一致。

## 改动清单

| 文件 | 动作 | 说明 |
|------|------|------|
| （整个工作区） | `git add -A && git commit` | 先提交现状，保留可回退点 |
| `README.md` | 修改 2 处 | ①「e2e # 86 条」→ 与当前状态一致（88 条）；② 删除/改写 emoji 那条已知边界（说明已换 el-icon） |

## 实现要点

- 提交前先 `git diff --stat` 确认改动范围与预期一致，确认没有意外文件（如 `node_modules`、`.mbak` 备份、模型文件）被纳入。
- README 修改后全局搜索核对：`emoji`、`86`、`88` 出现处是否自洽。

## 验收标准

1. `git status` 干净（无未提交、无未跟踪）；
2. `git log -1` 显示新的 checkpoint 提交；
3. `README.md` 中"86 条"与"88 通过"口径一致；emoji 表述已更新；
4. 不引入任何代码改动（纯提交 + 文档修正）。

## 注意

- 这是所有后续任务的前置：保证后续改动都从干净基线出发。
- 不要顺手"清理"其他未点名的文档内容。
