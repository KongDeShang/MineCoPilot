# 任务 17：AI 老师傅人设 + 对话式 AI（Batch B）

> 状态：✅ 完成（2026-09-16）
> 批次：Batch B（任务 14 语音纪要域之后第二批实施；Batch A「数据备份/迁移」见任务 16）

## 背景

用户拍板方向：**AI 老师傅人设 + 对话式 AI**。核心诉求不是"再堆功能"，而是让 AI 助手像矿山老机修一样有用：

1. **人设落地**：开启"AI 老师傅模式"后，AI 说话带老机修口吻——直接、经验式引导（先查→再换→后试），但**只动语气不动事实**（数字来自本地台账、规程来自知识库，不新增任何内容）。
2. **现象级提问兜底**：一线问的是现象（"机器干活没劲还抖"），现有知识库靠关键词检索会落空。补两条通道：①**症状→原因→处理三元组**（现象文本滑窗匹配知识条目，命中即给结构化经验卡）；②**四类故障排查思路表**（液压/动力/电气/行走，未命中知识库时给"先看→再查→后动"分层思路）。
3. **对话式体验**：回答后动态生成 1~3 个"可能还想问"追问候选（点击即问）；导出对话头部自动附**会话摘要**（轮数/设备/系统/待办，供交接班）。

## 改动清单

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `src/renderer/src/utils/masterPersona.js` | 新增 | 老师傅人设：`masterEnabled/setMasterEnabled`（localStorage `ks:master-mode`）、`MASTER_NARRATE_PERSONA` 叙述人设、`masterGreeting(store)` 老师傅开场白（数字实时取 store）、`masterTip` 行动提示、`masterFollowups(question, result)` 追问候选 |
| `src/renderer/src/utils/faultTriplet.js` | 新增 | B2 症状通道：`matchFaultTriplet(question, items)` 2 字去重滑窗匹配条目 symptoms（≥2 命中才计），`buildTriplet` 抽取症状/原因/步骤/来源，`renderTripletCard` 渲染经验卡，`tripletRefs` 来源引用 |
| `src/renderer/src/utils/troubleshootMaps.js` | 新增 | B3 排查思路表：`DEFAULT_TROUBLESHOOT_MAPS` 四类（hydraulic/power/electric/running 各 4 步"先看→再看→三测→后查"），`getTroubleshootMaps`（localStorage `ks:troubleshoot-maps` 用户版合并覆盖/追加）、`saveTroubleshootMap`（null=恢复该类默认）、`resetTroubleshootMaps`、`matchTroubleshootMap`、`renderTroubleshootMap` |
| `src/renderer/src/utils/conversationSummary.js` | 新增 | B4 会话摘要：`buildConversationSummary(conversation, {overdueCount})` 规则生成 Markdown 摘要（不依赖本地模型），抽独立模块供 e2e 直调 |
| `src/renderer/src/utils/knowledgeBase.js` | 修改 | `answerQuestion` knowledge 分支返回值补 `hits: [{entry, score}]`（供追问候选使用） |
| `src/renderer/src/utils/llmClient.js` | 修改 | `buildNarratePrompt` 增加可选第二参 `persona`（人设前缀） |
| `src/renderer/src/utils/narrate.js` | 修改 | `narrateConclusionStream` 增加 `persona` 选项透传 |
| `src/renderer/src/utils/backup.js` | 修改 | `SETTINGS_KEYS` 增加 `ks:master-mode`、`ks:troubleshoot-maps`（随备份迁移） |
| `src/renderer/src/views/AIAssistant.vue` | 修改 | 欢迎语按开关切换老师傅开场白；普通查询重排：`answerQuestion` 后 source==='none' 先走 `matchFaultTriplet`（渲染经验卡+refs=tripletRefs）→ 再 `matchTroubleshootMap`（渲染排查思路表）；`msg.followups = masterFollowups(...)`；`narrateStream(..., {persona})`；行动提示按开关换 masterTip；`@ask-followup="askFollowup"` + handler；导出对话头部附摘要 |
| `src/renderer/src/components/ChatMessage.vue` | 修改 | refs 下方新增 followups 区块（el-tag 点击 emit `ask-followup`）+ emits + 样式 |
| `src/renderer/src/views/Settings.vue` | 修改 | 主题卡与演示参数卡之间新增"AI 助手 · 老师傅模式与排查经验"卡：el-switch 开关 + el-collapse 四类排查思路 textarea 编辑（每行"步骤：详情"）+ 保存/恢复默认/恢复全部 |
| `scripts/e2e.mjs` | 修改 | 7d 区块新增 6 项断言（设置页开关 UI / 开关读写 / B2 症状命中三元组 / B3 排查思路命中 / B4 追问候选 / B4 会话摘要） |

## 实现要点

- **人设与事实分离**：人设层（masterPersona.js）只提供话术包装；所有数字仍取 store（设备数/超期数），所有规程仍来自知识库条目原文。叙述层人设前缀经 `buildNarratePrompt(persona)` 传入，且**数字不变量校验**（verifyNumbersSubset）继续生效——本地模型即使开启老师傅口吻，也不能改数字。
- **B2 症状通道与现有检索互补**：不替换 `answerQuestion` 的关键词检索；只在 `source==='none'` 时启用。滑窗阈值≥2 避免泛词误报（"动作无力"匹配"动作无力还抖动"）。
- **B3 用户可维护**：排查思路表存 localStorage，设置页可编辑每类思路（textarea 每行"步骤：详情"）、可恢复默认；用户版合并规则为同 id 覆盖、新 id 追加；随备份迁移。
- **B4 追问候选**：`masterFollowups` 依赖 `result.hits`（知识命中条目）；hits 为空时给通用追问（针对设备提问/规程提问两类模板）。
- **会话摘要零模型依赖**：规则统计（轮数/设备去重/系统关键词/超期待办），0.5B 模型干不了结构化总结，1.5B 也不承诺——摘要必须稳定可交接，故用规则。

## 验收记录

| 验证项 | 结果 |
| --- | --- |
| `npm run lint` | ✅ 0 错误（faultTriplet 首版残留未用函数，已删） |
| `npm run build` | ✅ built in 1.04s，无告警 |
| `npm run self-check` | ✅ 288/288 |
| `npm run e2e` | ✅ 102/102（原 96 + B 批新增 6 项全过） |
| `npm run audit:contrast` | ✅ 全部达标（未发现低于 WCAG AA） |
| `npm run audit:contrast:dark` | ✅ 全部达标 |

e2e B 批关键断言截图：
- B2 症状通道：`matchFaultTriplet('钻杆摆动大怎么处理', KNOWLEDGE_BASE)` 命中 `《钻机钻杆振动异常》`（matchedBy: symptom），三元组 symptoms/causes/steps/source 齐全，refs=`["《钻机钻杆振动异常》","来源：潜孔钻机钻进异常排查流程"]`
- B3：`matchTroubleshootMap('液压系统压力低怎么办')` → id=hydraulic，4 步，渲染含"先看"
- B4 追问：`["钻机多久检查一次？","这一步检查连接螺纹有无磨损或咬具体怎么操作？","怎么判断是回转/冲击机构轴引起的？"]`
- B4 摘要：轮数/设备/系统/待办四项齐全

## 遗留

- 老师傅模式的**叙述层真人试听**（语音/朗读场景下口吻效果）待真机人工确认（任务 17 只保证文本层与规则正确）。
- 排查思路表用户编辑的**现场长文本体验**（超长 steps）未做压测；当前 4 类每类 ≤4 步，够用。
- 追问候选的**规则模板**未来可升级为基于本地模型生成（1.5B 或以上），当前为规则版（稳定、可离线、可测）。
