<template>
  <div class="ai-assistant">
    <!-- 顶部 Tab 切换 -->
    <el-tabs v-model="activeTab" class="ai-tabs">
      <!-- Tab 1: AI 智能问答 -->
      <el-tab-pane label="AI 智能问答" name="chat">
        <el-row :gutter="20">
          <!-- 左侧：输入方式（默认收起，聊天区占满；可从聊天头部展开） -->
          <el-col :span="inputPanelCollapsed ? 0 : 8" class="input-panel-col">
            <div v-show="!inputPanelCollapsed" class="input-panel-inner">
              <el-card>
                <template #header>
                  <span><el-icon><MagicStick /></el-icon> AI 输入
                    <el-button link size="small" type="primary" @click="inputPanelCollapsed = true">
                      <el-icon><Fold /></el-icon>收起
                    </el-button>
                  </span>
                </template>

                <!-- 语音录入 -->
                <div class="input-section">
                  <h4><el-icon><Microphone /></el-icon> 语音录入工单</h4>
                  <p class="section-desc">点击按钮，说出设备问题，自动转为工单</p>
                  <div class="voice-controls">
                    <el-button
                      :type="isRecording ? 'danger' : 'primary'"
                      size="large"
                      round
                      @click="toggleRecording"
                    >
                      <el-icon><Microphone v-if="!isRecording" /><VideoPause v-else /></el-icon>
                      {{ isRecording ? '停止录音' : '开始录音' }}
                    </el-button>
                    <div v-if="isRecording" class="recording-indicator">
                      <span class="dot"></span> 录音中...
                    </div>
                  </div>
                  <el-input
                    v-if="voiceText"
                    v-model="voiceText"
                    type="textarea"
                    :rows="3"
                    readonly
                    style="margin-top: 12px"
                  />
                </div>

                <el-divider />

                <!-- 拍照 OCR -->
                <div class="input-section">
                  <h4><el-icon><Camera /></el-icon> 拍照识别巡检单</h4>
                  <p class="section-desc">拍摄手写巡检表，自动识别文字</p>
                  <el-upload
                    action="#"
                    :auto-upload="false"
                    :show-file-list="false"
                    accept="image/*"
                    :on-change="handleImageSelect"
                  >
                    <el-button type="success" size="large">
                      <el-icon><Camera /></el-icon>
                      选择图片
                    </el-button>
                  </el-upload>
                  <div v-if="ocrText" class="ocr-result">
                    <el-divider>识别结果</el-divider>
                    <el-input v-model="ocrText" type="textarea" :rows="4" readonly />
                  </div>
                </div>
              </el-card>
            </div>
          </el-col>

          <!-- 右侧：AI 对话 -->
          <el-col :span="inputPanelCollapsed ? 24 : 16">
            <el-card class="chat-card">
              <template #header>
                <div class="card-header">
                  <span><el-icon><ChatDotRound /></el-icon> AI 智能问答</span>
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                    <el-button size="small" :type="inputPanelCollapsed ? 'default' : 'primary'" plain @click="inputPanelCollapsed = !inputPanelCollapsed">
                      <el-icon><Microphone /></el-icon> {{ inputPanelCollapsed ? 'AI 输入' : '收起输入' }}
                    </el-button>
                    <el-button type="primary" size="small" plain @click="exportConversation" :disabled="messages.length <= 1">
                      <el-icon><Download /></el-icon> 导出对话
                    </el-button>
                    <el-button type="danger" size="small" plain @click="clearChat" :disabled="messages.length <= 1">
                      <el-icon><Delete /></el-icon> 清空对话
                    </el-button>
                    <el-tooltip
                      content="数字由本地规则引擎实时计算，规程来自本地知识库，全程不联网；未命中时明确告知查不到。"
                      placement="bottom"
                    >
                      <el-tag type="success" effect="plain" size="small">
                        <el-icon><Lock /></el-icon> 纯离线模式
                      </el-tag>
                    </el-tooltip>
                  </div>
                </div>
              </template>

              <!-- 聊天消息区域 -->
              <div class="chat-messages" ref="chatContainer">
                <ChatMessage
                  v-for="(msg, index) in messages"
                  :key="index"
                  :msg="msg"
                  @pick-candidate="(cand) => pickCandidate(msg, cand)"
                  @confirm-plan="confirmPlan(msg)"
                  @cancel-plan="cancelPlan(msg)"
                  @undo-plan="undoPlan(msg)"
                  @toggle-thinking="toggleThinking(msg)"
                />
                <ChatMessage v-if="isLoading" typing />
              </div>

                <div class="chat-input">
                  <el-input
                    v-model="inputText"
                    placeholder="试试问：6号钻机上次保养是什么时候？/ 哪些设备维保已超期？"
                    @keyup.enter="onEnterKey"
                    :disabled="isLoading"
                  >
                    <template #append>
                      <el-button type="primary" @click="sendMessage" :disabled="isLoading">
                        <el-icon><Promotion /></el-icon> 提问
                      </el-button>
                    </template>
                  </el-input>
                  <QuickQuestions @ask="askQuick" />
                </div>
            </el-card>
          </el-col>
        </el-row>
      </el-tab-pane>

      <!-- Tab 2: Excel 智能解析（整块拆到 components/ExcelImportPanel.vue） -->
      <el-tab-pane label="Excel 智能解析" name="excel">
        <ExcelImportPanel />
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup>
import { ref, reactive, nextTick, watch, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import ExcelImportPanel from '../components/ExcelImportPanel.vue'
import ChatMessage from '../components/ChatMessage.vue'
import QuickQuestions from '../components/QuickQuestions.vue'
import { answerQuestion } from '../utils/knowledgeBase'
import { parseCommand, executePlanItem, hasWriteActions, INTENTS } from '../utils/nlCommand'
import { generateReport } from '../utils/reportGenerator'
import { useAppStore } from '../stores/appStore'
import { now } from '../utils/dates'
import { llmAvailable, llmLoad } from '../utils/llmClient'
import { htmlToText, narrateConclusionStream } from '../utils/narrate'
import { statusLabel, priorityLabel } from '../utils/dictionaries'
import { escapeHtml } from '../utils/html'

const store = useAppStore()

const activeTab = ref('chat')
const isRecording = ref(false)
const voiceText = ref('')
const ocrText = ref('')
const inputText = ref('')
const isLoading = ref(false)
const chatContainer = ref(null)

// 左侧"AI 输入"面板：默认收起，聊天区占满（可从聊天头部展开）
const inputPanelCollapsed = ref(true)

/** 聊天记录持久化键名（localStorage，数据不出本机） */
const CHAT_STORAGE_KEY = 'ai_chat_messages'

// ============================================================
// AI 对话能力升级：多轮上下文 & 追问
// ============================================================
const conversation = ref([]) // { role, text, equipmentName?, timestamp }

/** 追问检测：用户说"那台设备" / "上次"时，关联上文提到的设备 */
const FOLLOWUP_PATTERN = /那(台|个)|上次|之前|它|这台|接着|同样的/
function resolveFollowup(question) {
  if (!FOLLOWUP_PATTERN.test(question)) return question
  const lastMention = conversation.value.slice().reverse().find(c => c.equipmentName)
  if (lastMention) return question + ' ' + lastMention.equipmentName
  return question
}

// ============================================================
// AI 人格："智工" + 主动播报式欢迎语
// ============================================================
function buildWelcomeMessage() {
  const stats = store.stats
  const critical = store.criticalList
  const overdue = store.overdueList
  const worsening = store.worseningList

  const alerts = []
  if (critical.length) alerts.push(`<span style="color:var(--danger-ink)">🔴 ${critical.length} 台 D 级设备需要立即关注</span>`)
  if (overdue.length) alerts.push(`<span style="color:var(--warn-ink)">⚠️ ${overdue.length} 台维保已超期${overdue.filter(e => e.overdueDays > 45).length > 0 ? `（其中 ${overdue.filter(e => e.overdueDays > 45).length} 台超期超过 45 天）` : ''}</span>`)
  if (worsening.length) alerts.push(`<span style="color:var(--warn-ink)">📉 ${worsening.length} 台健康分持续下降，正在恶化中</span>`)

  const alertBlock = alerts.length
    ? `<div style="margin:10px 0;padding:10px 12px;background:var(--danger-soft);border:1px solid var(--danger-line);border-radius:8px;line-height:2">${alerts.join('<br>')}</div>`
    : `<div style="margin:10px 0;padding:10px 12px;background:var(--emerald-soft);border:1px solid var(--emerald-line);border-radius:8px;color:var(--success-ink)">✅ 所有设备状态正常，暂无紧急事项</div>`

  return [
    `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><span style="font-size:24px">👷</span><strong style="font-size:16px">智工</strong><span style="color:var(--text-3);font-size:13px">· 你的设备健康顾问</span></div>`,
    `<div style="margin:6px 0">我帮你盯了 <strong>${stats.equipmentCount}</strong> 台设备，今天发现：</div>`,
    alertBlock,
    `<div style="margin-top:8px;color:var(--text-3);font-size:12px">有事直接说，或者选下面的问题先看看。所有数字均由本地规则引擎实时计算，全程不联网。</div>`
  ].join('')
}

const messages = ref([])

/** 历史对话的保鲜期：超过它、或台账规模变了，就不再沿用旧对话 */
const CHAT_MAX_AGE_MS = 30 * 60 * 1000

function welcomeMessage() {
  return {
    role: 'assistant',
    content: buildWelcomeMessage(),
    time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
}

/**
 * 恢复聊天记录（本地保留，需要时可调出；没有可用历史则显示欢迎语）
 *
 * 为什么要设保鲜期：欢迎语是"我帮你盯了 N 台设备，今天发现…"的主动播报，
 * 是首屏的爆点。若无条件沿用存档，第二次演示看到的会是上一场的旧对话，
 * 且旧对话里的数字与当前台账可能已经对不上（中途导过 Excel），被追问时对不上号。
 */
function restoreChatHistory() {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY)
    if (raw) {
      const saved = JSON.parse(raw)
      // 兼容两种格式：旧版是消息数组，新版是 { savedAt, equipmentCount, messages }
      const list = Array.isArray(saved) ? saved : saved?.messages
      const savedAt = Array.isArray(saved) ? 0 : Number(saved?.savedAt || 0)
      const eqCount = Array.isArray(saved) ? null : saved?.equipmentCount
      const fresh = Date.now() - savedAt < CHAT_MAX_AGE_MS
      const sameFleet = eqCount == null || eqCount === store.stats.equipmentCount
      if (Array.isArray(list) && list.length && fresh && sameFleet) {
        messages.value = list
        return
      }
    }
  } catch {
    /* 记录损坏则回退欢迎语 */
  }
  messages.value = [welcomeMessage()]
}

/** 防抖保存聊天记录（最多 40 条，单条超长截断，控制 localStorage 体积） */
let chatSaveTimer = null
let recordTimer = null
function scheduleChatSave() {
  if (chatSaveTimer) clearTimeout(chatSaveTimer)
  chatSaveTimer = setTimeout(() => {
    try {
      const trimmed = messages.value.slice(-40).map(m => ({
        role: m.role,
        content: String(m.content || '').slice(0, 12000),
        time: m.time,
        thinkingSteps: m.thinkingSteps || null,
        thinkingCollapsed: !!m.thinkingCollapsed,
        refs: m.refs || []
      }))
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify({
        savedAt: Date.now(),
        equipmentCount: store.stats.equipmentCount,
        messages: trimmed
      }))
    } catch { /* 存储失败不打断对话 */ }
  }, 500)
}

watch(messages, scheduleChatSave, { deep: true })

/** 清空对话（恢复欢迎语，清掉本地记录） */
async function clearChat() {
  try {
    await ElMessageBox.confirm('确定清空当前对话记录吗？清除后不可恢复。', '清空对话', {
      confirmButtonText: '清空',
      cancelButtonText: '取消',
      type: 'warning'
    })
  } catch {
    return
  }
  localStorage.removeItem(CHAT_STORAGE_KEY)
  messages.value = [welcomeMessage()]
  conversation.value = []
  ElMessage.success('对话记录已清空')
}

// 无输入时也能回答的默认问题
const fallbackQuestion = '设备维保知识库能回答什么？'

// ============================================================
// AI 思考过程可视化
// ============================================================

/** 根据查询类型生成思考步骤 */
function buildThinkingSteps(question) {
  const q = question.toLowerCase()
  // 口述录入不出思考链（已有理解卡）
  const plan = parseCommand(store, question)
  if (plan.ok && (hasWriteActions(plan) || plan.blocked)) return null

  // 周报生成
  if (/周报|月报|报告/.test(q)) {
    return [
      { label: '扫描全部设备台账', status: 'pending', detail: `${store.equipmentList.length} 台设备` },
      { label: '统计工单与维保数据', status: 'pending', detail: '' },
      { label: '分析健康分分布与趋势', status: 'pending', detail: '' },
      { label: '识别重点关注与亮点', status: 'pending', detail: '' },
      { label: '生成结构化报告', status: 'pending', detail: '' }
    ]
  }

  // 健康/体检类
  if (/健康|体检|风险|怎么样|状态/.test(q)) {
    const matched = store.equipmentList.find(eq => q.includes(eq.name.toLowerCase()))
    return [
      { label: '查询台账', status: 'pending', detail: matched ? `找到 ${matched.name}` : '匹配设备信息' },
      { label: '计算四因子健康评分', status: 'pending', detail: '维保及时性 / 机龄 / 故障状态 / 数据完整度' },
      { label: '分析健康趋势', status: 'pending', detail: '' },
      { label: '检索知识库', status: 'pending', detail: `${store.knowledgeItems.length} 条可溯源规程` },
      { label: '生成诊断结论', status: 'pending', detail: '' }
    ]
  }

  // 超期/到期类
  if (/超期|到期|哪些设备/.test(q)) {
    return [
      { label: '扫描全部设备', status: 'pending', detail: `${store.equipmentList.length} 台` },
      { label: '计算超期天数', status: 'pending', detail: '' },
      { label: '排序生成清单', status: 'pending', detail: '' }
    ]
  }

  // 对比类
  if (/对比|比较/.test(q)) {
    return [
      { label: '匹配目标设备', status: 'pending', detail: '' },
      { label: '计算各设备健康数据', status: 'pending', detail: '' },
      { label: '统计工单与维保记录', status: 'pending', detail: '' },
      { label: '生成对比分析', status: 'pending', detail: '' }
    ]
  }

  // 统计/排名类
  if (/最多|最高|统计|排名|类别/.test(q)) {
    return [
      { label: '聚合全量数据', status: 'pending', detail: `${store.workOrders.length} 张工单` },
      { label: '按维度分组统计', status: 'pending', detail: '' },
      { label: '排序生成排行', status: 'pending', detail: '' }
    ]
  }

  // 知识库检索（默认）
  return [
    { label: '解析问题关键词', status: 'pending', detail: '' },
    { label: '同义词扩展匹配', status: 'pending', detail: '' },
    { label: '知识库相关度排序', status: 'pending', detail: `${store.knowledgeItems.length} 条` },
    { label: '渲染结果', status: 'pending', detail: '' }
  ]
}

/** 逐帧执行思考步骤动画（节奏紧凑，不拖沓） */
async function animateThinking(thinkingSteps) {
  if (!thinkingSteps || !thinkingSteps.length) return
  for (let i = 0; i < thinkingSteps.length; i++) {
    thinkingSteps[i].status = 'done'
    await new Promise(r => setTimeout(r, 35 + Math.random() * 45))
  }
}

/** 折叠/展开某条消息的思考过程 */
function toggleThinking(msg) {
  msg.thinkingCollapsed = !msg.thinkingCollapsed
}

function toggleRecording() {
  isRecording.value = !isRecording.value
  if (!isRecording.value) return
  ElMessage.info('正在录音…（演示环境使用模拟识别结果）')
  recordTimer = setTimeout(() => {
    recordTimer = null
    voiceText.value = '6号钻机钻杆振动异常，需要安排检修，建议更换轴承'
    isRecording.value = false
    inputText.value = voiceText.value
    ElMessage.success('语音已转写，可直接提问或建单')
  }, 2200)
}

/** 拍照 OCR：演示环境使用模拟识别结果，真实版本可替换为 Tesseract.js 本地识别 */
function handleImageSelect() {
  ocrText.value = '设备：5号矿卡\n日期：' + now().slice(0, 10) + '\n巡检人：赵工\n异常：刹车片磨损严重\n处理：已安排更换，预计明天到货'
  ElMessage.success('巡检单已识别，可复制文本创建工单')
}

function askQuick(question) {
  if (isLoading.value) return
  inputText.value = question
  sendMessage()
}

/**
 * 回车发送（要避开中文输入法的候选词确认）
 *
 * keyup 在输入法合成期间也会触发，而 v-model 此时还是旧值：
 * 用拼音输入时按回车选词，会把半成品发出去；输入框为空时更糟——
 * 直接发出兜底问题，屏幕上凭空出现一个没人问过的答案。
 * 所以合成中一律不发送（e.isComposing 由浏览器给出，最可靠）。
 */
function onEnterKey(e) {
  if (e && (e.isComposing || e.keyCode === 229)) return
  sendMessage()
}

async function sendMessage() {
  if (isLoading.value) return
  const rawQuestion = inputText.value.trim() || fallbackQuestion
  inputText.value = ''

  // 追问解析：把"那台设备"替换为上文设备名
  const question = resolveFollowup(rawQuestion)

  // 记录到对话上下文
  const matchedEq = store.equipmentList.find(eq => question.toLowerCase().includes(eq.name.toLowerCase()))
  conversation.value.push({
    role: 'user',
    text: rawQuestion,
    equipmentName: matchedEq?.name || null,
    timestamp: now()
  })
  // 只保留最近 10 轮
  if (conversation.value.length > 20) conversation.value = conversation.value.slice(-20)

  messages.value.push({
    role: 'user',
    content: rawQuestion,
    time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  })

  isLoading.value = true
  await nextTick()
  scrollToBottom(true)

  /**
   * 先尝试按"口述录入"解析。
   * 关键安全约定：parseCommand 是纯函数，**不写任何数据**；
   * 只有用户在理解卡上点【确认写入】才会落库。
   */
  const plan = parseCommand(store, question)

  if (plan.ok && hasWriteActions(plan)) {
    plan.impact = describeImpact(plan)
    // 口述录入不出思考链（已有理解卡），直接展示
    setTimeout(() => {
      messages.value.push({
        role: 'assistant',
        content: '我识别到你要**登记一条运维记录**。请核对下面的理解，确认无误后我再写入本机数据库。',
        plan,
        time: nowTime()
      })
      isLoading.value = false
      nextTick(() => scrollToBottom(true))
    }, 350)
    return
  }

  // 有歧义 / 找不到设备时不写库，只提示
  if (plan.ok && plan.blocked) {
    plan.impact = describeImpact(plan)
    setTimeout(() => {
      messages.value.push({
        role: 'assistant',
        content: '这条记录需要一个前提：**确认是哪台设备**。请从下面的候选里点选，我不会替你猜。',
        plan,
        time: nowTime()
      })
      isLoading.value = false
      nextTick(() => scrollToBottom(true))
    }, 350)
    return
  }

  // ---- 周报/月报生成 ----
  if (/生成.*周报|生成.*月报|周报|月报|车队报告/.test(question.toLowerCase())) {
    const period = /月/.test(question) ? 'month' : 'week'
    const { html: reportHTML } = generateReport(store, period)
    const thinkingSteps = buildThinkingSteps(question)

    // 必须 reactive 包一层。Vue 只追踪"响应式对象"的属性读写：
    // 把普通对象 push 进数组之后再改它的字段，父子组件都不会重渲染。
    // 这里恰好是"先插入空消息 → 逐帧改步骤状态 → 最后回填 content"，
    // 全靠后续赋值生效。此前没有 reactive，之所以看着正常，是因为
    // 模板整个写在本组件里：任何别的响应式变化（isLoading、store…）都会让
    // 本组件重渲染，重渲染时把最新值重新读了一遍，问题就被盖住了。
    // 拆成子组件后 props 引用没变、子组件不重渲染，这个洞立刻显形（白气泡、步骤停在 ⏳）。
    const msg = reactive({
      role: 'assistant',
      content: '',
      thinkingSteps,
      reportContent: reportHTML,
      time: nowTime()
    })
    messages.value.push(msg)
    isLoading.value = false

    // 动画：思考步骤逐帧展示，完成后显示报告
    // 走 msg.thinkingSteps 而不是裸数组：要经过代理，改动的状态才通知得出去
    if (msg.thinkingSteps) {
      await animateThinking(msg.thinkingSteps)
    }
    msg.content = reportHTML
    store.addLog({ content: `AI 生成${period === 'week' ? '周' : '月'}报`, source: 'AI', type: 'primary', tagType: 'primary' })
    nextTick(() => scrollToBottom(true))
    return
  }

  // ---- 普通查询：带思考过程 ----
  const thinkingSteps = buildThinkingSteps(rawQuestion)

  // 先插入一条带思考步骤的空消息（reactive 的理由同上：后面要反复回填字段）
  const msg = reactive({
    role: 'assistant',
    content: '',
    thinkingSteps: thinkingSteps || null,
    refs: [],
    time: nowTime()
  })
  messages.value.push(msg)
  await nextTick()

  // 动画：思考步骤逐帧执行
  if (msg.thinkingSteps) {
    await animateThinking(msg.thinkingSteps)
    await new Promise(r => setTimeout(r, 150))
  }

  // 本地检索：台账优先，其次知识库 + 手册资料库（含 PDF 原文切片，命中带页码出处）；不做任何网络请求
  const result = answerQuestion(store, question, store.answerItems)

  msg.content = result.html
  msg.refs = result.refs

  // 本地模型叙述层：把已核实的结论"说成人话"（流式；未就绪/失败自动回退，不阻塞主答案）
  narrateStream(msg, result.html)

  // 查询意图 + 提到了设备 → 给一个直达体检报告的入口
  if (plan.notFound && plan.notFound.length) {
    msg.content += `<div style="margin-top:8px;color:var(--warn-ink)">ℹ️ 顺带提示：${plan.notFound[0].reason}（原话："${plan.notFound[0].clause}"）</div>`
  }

  // 追加"智工小提示"（与问题类型相关的行动建议）
  msg.content += buildTip(question, result)

  store.addLog({
    content: `AI 助手回答：${rawQuestion}`,
    source: 'AI',
    type: 'info',
    tagType: 'info'
  })

  // 记录到对话上下文
  conversation.value.push({
    role: 'assistant',
    text: result.html.replace(/<[^>]+>/g, '').slice(0, 200),
    equipmentName: matchedEq?.name || null,
    timestamp: now()
  })

  isLoading.value = false
  nextTick(() => scrollToBottom(true))
}

/** 本地模型解读块的外壳（正文留给流式填充；tone=ok 时带上最终文本） */
function narrateBlockHtml(boxId, bodyHtml) {
  return [
    '<div class="llm-narrate" style="margin-bottom:10px;padding:10px 12px;background:rgba(11,58,130,0.06);border:1px solid rgba(11,58,130,0.18);border-radius:8px;">',
    '<div style="font-size:12px;font-weight:600;color:var(--accent);margin-bottom:4px;">🤖 本地模型解读</div>',
    `<div id="${boxId}" style="font-size:13px;line-height:1.7;color:var(--text-1);white-space:pre-wrap;">${bodyHtml || ''}</div>`,
    '<div style="margin-top:6px;font-size:11px;color:var(--text-3);">本地模型生成 · 数据未出本机</div>',
    '</div>'
  ].join('')
}

/** 明示降级块："不撒谎"原则——生成不可用时如实说明，而不是留个空盒子 */
function narrateFallbackHtml(reason) {
  const detail = reason === 'number-mismatch'
    ? '本次叙述未通过数字一致性校验，已回退'
    : '本地模型暂不可用，本次由内置规则叙述'
  return [
    '<div class="llm-narrate" style="margin-bottom:10px;padding:8px 12px;background:rgba(11,58,130,0.04);border:1px dashed rgba(11,58,130,0.25);border-radius:8px;">',
    `<span style="font-size:12px;color:var(--text-3);">ℹ️ ${detail} · 数据未出本机</span>`,
    '</div>'
  ].join('')
}

/**
 * 本地模型叙述层（流式）：在结论上方插入"本地模型解读"块。
 *
 * 铁律：
 *   1) 走 utils/narrate.js 的唯一实现——它内含数字不变量校验
 *      （verifyNumbersSubset：模型新造的数字一律作废，回退规则叙述）。
 *      此前这里是一份内联复制版，抄的时候把校验丢了，等于防幻觉是空转的。
 *   2) 任何环节不可用都明示降级，主答案照常展示。
 *   3) 最终文本写回 msg.content，刷新/导出后仍在（此前只写 DOM，刷新就是空盒子）。
 */
async function narrateStream(msg, resultHtml) {
  try {
    if (!llmAvailable()) return
    const plain = htmlToText(resultHtml).slice(0, 1200)
    if (!plain) return

    const boxId = `narrate-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const block = narrateBlockHtml(boxId, '')
    msg.content = block + msg.content
    await nextTick()
    const box = document.getElementById(boxId)
    if (!box) return
    box.textContent = '本地模型解读生成中…'

    let acc = ''
    const r = await narrateConclusionStream(resultHtml, {
      onChunk: (t) => {
        acc += t
        box.textContent = acc
        scrollToBottom()
      }
    })

    if (r.mode === 'local' && r.text) {
      // 成功：把最终文本固化进消息内容（不再只存在于 DOM）
      msg.content = msg.content.replace(block, narrateBlockHtml(boxId, escapeHtml(r.text)))
      return
    }
    msg.content = msg.content.replace(block, narrateFallbackHtml(r.reason))
  } catch {
    // 任何异常静默回退
  }
}

/** 构建"智工小提示"：根据查询类型给出行动建议 */
function buildTip(question, result) {
  const q = question.toLowerCase()
  if (/健康|体检|怎么样/.test(q) && result.source === 'ledger') {
    const worst = store.criticalList[0]
    if (worst) {
      return `<div style="margin-top:10px;padding:8px 12px;background:var(--accent-soft);border-radius:6px;font-size:12px;color:var(--accent)">💡 <strong>智工提示：</strong>如需详细分析，可在设备台账页一键生成《设备体检报告》，含完整溯源。</div>`
    }
  }
  if (/超期|到期/.test(q) && store.overdueList.length > 0) {
    return `<div style="margin-top:10px;padding:8px 12px;background:var(--danger-soft);border-radius:6px;font-size:12px;color:var(--danger-ink)">💡 <strong>智工提示：</strong>超期设备建议优先安排保养，可在维保日历中一键创建工单。</div>`
  }
  return ''
}

function nowTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/** 写库前把"连带影响"讲清楚（确认卡的核心价值） */
function describeImpact(plan) {
  const lines = []
  for (const item of plan.items) {
    if (item.intent === INTENTS.REPORT_FAULT) {
      lines.push(`新建 1 张维修工单（状态：${statusLabel('pending')}，优先级：${priorityLabel(item.priority)}）`)
    } else if (item.intent === INTENTS.COMPLETE_ORDER) {
      lines.push(`工单 #${item.order?.id} 标记为已完成`)
      lines.push('自动归档一条维保记录到该设备病历')
      lines.push('自动生成 7 天后的复诊任务（闭环率会随之变化）')
    } else if (item.intent === INTENTS.ADD_MAINTENANCE) {
      lines.push('新增 1 条维保记录')
      lines.push(`把「${item.equipment?.name}」的上次维保日期更新为 ${item.date}`)
      lines.push(`记录一次健康快照（健康分将按新日期重算：超期扣分归零）`)
    } else if (item.intent === INTENTS.SET_STATUS) {
      lines.push(`把设备状态改为「${item.targetStatusLabel}」（会同时影响看板统计与维保预警）`)
    } else if (item.intent === INTENTS.DO_RECHECK) {
      lines.push('标记复诊完成，复诊闭环率会更新')
    } else if (item.intent === INTENTS.ADD_KNOWLEDGE) {
      lines.push('在本地知识库新增 1 条条目，来源标注为"现场录入"')
    }
  }
  return [...new Set(lines)]
}

/** 用户点选歧义候选 → 只解掉界面上正在展示的这一组，其余歧义留待下一轮 */
function pickCandidate(msg, candidate) {
  const group = msg.plan.ambiguous[0]
  if (!group) return
  for (const item of msg.plan.items) {
    if (item.equipmentRef.status !== 'ambiguous') continue
    if (item.ambiguousId !== group.id) continue
    item.equipment = candidate
    item.equipmentRef = { ...item.equipmentRef, status: 'resolved', equipment: candidate, method: 'user-pick', phrase: candidate.name }
  }
  // 只移出这一组；「1号挖机报故障，2号铲车也报故障」这类两处歧义的话，
  // 选完第一台后第二组仍会显示出来，不会被静默套用同一台设备。
  msg.plan.ambiguous = msg.plan.ambiguous.filter(g => g.id !== group.id)
  // 处理完成工单/改状态这类需要按设备重新预检的动作
  recheckPreflight(msg.plan)
  msg.plan.blocked = msg.plan.ambiguous.length > 0 || msg.plan.notFound.length > 0
  msg.plan.impact = describeImpact(msg.plan)
  const rest = msg.plan.ambiguous.length
  ElMessage.success(rest ? `已选定：${candidate.name}，还有 ${rest} 处待确认` : `已选定：${candidate.name}`)
}

/** 用户改选设备后，重新做一次预检（例如"该设备是否有未完成工单"） */
function recheckPreflight(plan) {
  for (const item of plan.items) {
    if (!item.equipment) continue
    if (item.intent === INTENTS.COMPLETE_ORDER) {
      const orders = store.workOrders.filter(o =>
        o.equipment_name === item.equipment.name && (o.status === 'pending' || o.status === 'processing'))
      const latest = orders.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null
      item.order = latest
      item.preflightError = latest ? null : '该设备没有待处理或处理中的工单，无法标记完成'
    }
    if (item.intent === INTENTS.DO_RECHECK) {
      const order = store.workOrders.find(o =>
        o.recheck_status === 'pending' && o.equipment_name === item.equipment.name)
      item.order = order || null
      item.preflightError = order ? null : '该设备没有待复诊的工单'
    }
  }
}

/**
 * 确认写入
 *
 * 必须防重复执行：卡片执行完不会消失，按钮仍在原地——
 * 双击（触控板/手抖）会再跑一遍，同一张故障卡就会建出两张工单。
 */
function confirmPlan(msg) {
  if (msg.executing || msg.execResult) return
  const plan = msg.plan
  if (!plan) return
  msg.executing = true

  const results = []
  const undos = []
  const changes = []

  for (const item of plan.items) {
    if (item.preflightError) {
      results.push({ ok: false, error: item.preflightError })
      continue
    }
    // 单项失败不中断整批：此前循环里抛错会让已写入的部分不产生结果卡，看起来像"点了没反应"
    let outcome
    try {
      outcome = executePlanItem(store, item)
    } catch (error) {
      outcome = { ok: false, error: error?.message || String(error) }
    }
    results.push({ ok: outcome.ok, summary: outcome.summary, error: outcome.error })
    if (outcome.ok) {
      if (outcome.undo) undos.push(outcome.undo)
      changes.push(...(outcome.changes || []))
    }
  }

  const okCount = results.filter(r => r.ok).length
  msg.execResult = { results, changes, undos, undone: false, undoId: null }
  msg.plan = null
  msg.executing = false

  if (okCount) {
    const entry = store.logVoiceAction({
      rawText: plan.rawText,
      summary: results.filter(r => r.ok).map(r => r.summary).join('；'),
      changes,
      intentLabel: plan.items[0].intentLabel,
      // 撤销函数进 store 的撤销栈：这样离开页面/走到别的页也依然能撤销
      undos
    })
    // 记下本次写入在撤销栈里的 id：卡片上的"撤销这次写入"只撤这一条
    msg.execResult.undoId = entry ? entry.id : null
    ElMessage.success(`已写入本机数据库：${okCount} 项操作`)
  } else {
    ElMessage.error('没有写入任何数据，请看卡片上的原因')
  }
  nextTick(() => scrollToBottom(true))
}

/** 取消：什么都不做 */
function cancelPlan(msg) {
  msg.plan = null
  msg.content = '好的，已取消，没有写入任何数据。'
}

/**
 * 撤销：只撤这张卡片对应的那一次写入。
 * 走 store 的撤销栈（离开页面后也能撤），但按 id 精确定位——
 * 盲取栈顶会撤错对象（写了 A、B 两条再点 A 的撤销，撤掉的却是 B）。
 */
function undoPlan(msg) {
  const exec = msg.execResult
  if (!exec || exec.undone) return
  const outcome = store.performUndo(exec.undoId)
  if (!outcome.ok) {
    ElMessage.warning(outcome.error)
    return
  }
  exec.undone = true
  ElMessage.warning(`已撤销 ${outcome.reverted} 项变更，数据恢复到写入前`)
}

/**
 * 滚到底部
 * @param {boolean} force 用户主动发消息时强制滚到底；
 *   否则仅当用户本来就在底部附近才跟随——流式生成期间每来一个字
 *   就"写 DOM + 读布局 + 拽到底"，既掉帧，也让人没法往上翻看历史。
 */
let scrollPending = false
function scrollToBottom(force = false) {
  const el = chatContainer.value
  if (!el) return
  if (!force && el.scrollHeight - el.scrollTop - el.clientHeight > 160) return
  if (scrollPending) return
  scrollPending = true
  requestAnimationFrame(() => {
    scrollPending = false
    const node = chatContainer.value
    if (node) node.scrollTop = node.scrollHeight
  })
}

/** 导出 AI 对话记录为 Markdown（供交接班使用） */
function exportConversation() {
  const lines = [
    `# 矿山智工 AI 对话记录`,
    ``,
    `导出时间：${now().slice(0, 16).replace('T', ' ')}`,
    `设备总数：${store.equipmentList.length} 台`,
    ``,
    `---`,
    ``
  ]
  for (const msg of messages.value) {
    const role = msg.role === 'user' ? '👷 用户' : '👷‍♂️ 智工'
    const time = msg.time || ''
    // Strip HTML tags for plain text export
    const text = (msg.content || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    if (!text && !msg.plan && !msg.execResult) continue
    lines.push(`**${role}** ${time}`)
    lines.push(``)
    if (text) lines.push(text)
    if (msg.refs && msg.refs.length) {
      lines.push(`> 依据：${msg.refs.join('；')}`)
    }
    lines.push(``)
    lines.push(`---`)
    lines.push(``)
  }
  lines.push(`> 本记录由矿山智工 AI 助手自动生成，所有数字均来自本地台账实时计算。`)

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `矿山智工_AI对话记录_${now().slice(0, 10)}.md`
  a.click()
  URL.revokeObjectURL(url)
  ElMessage.success('对话记录已导出')
}

// 挂载时恢复本地聊天记录，并预热本地模型（幂等）
// 预热的意义：直接进 AI 助手页提问时，"本地模型解读"不会因为引擎还没加载而缺席
onMounted(() => {
  restoreChatHistory()
  if (llmAvailable()) llmLoad().catch(() => { /* 预热失败不打扰，叙述层会明示降级 */ })
})

// 离开页面时清掉挂起的定时器（否则卸载后仍会写一次 localStorage / 改一次输入框）
onBeforeUnmount(() => {
  if (chatSaveTimer) { clearTimeout(chatSaveTimer); chatSaveTimer = null }
  if (recordTimer) { clearTimeout(recordTimer); recordTimer = null }
})

</script>

<style scoped>
.ai-tabs :deep(.el-tabs__header) {
  margin-bottom: 20px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.input-section {
  margin-bottom: 16px;
}

/* 左侧输入面板收起过渡 */
.input-panel-col {
  transition: all 0.25s ease;
}
.input-panel-inner {
  transition: opacity 0.2s;
}

.input-section h4 {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 15px;
  color: var(--text-1);
  margin-bottom: 8px;
}

.section-desc {
  font-size: 13px;
  color: var(--text-3);
  margin-bottom: 12px;
}

.voice-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.recording-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--danger);
  font-size: 14px;
}

.recording-indicator .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--danger);
  animation: pulse 1s infinite;
}

.ocr-result {
  margin-top: 12px;
}

.chat-card {
  height: calc(100vh - 180px);
  display: flex;
  flex-direction: column;
}

.chat-card :deep(.el-card__body) {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  background: var(--line-2);
  border-radius: 8px;
}

.chat-input {
  padding-top: 12px;
  border-top: 1px solid var(--line);
  background: linear-gradient(180deg, rgba(255,255,255,0) 0%, #fff 18px);
}

/* 输入框：圆角 + 聚焦高亮 */
.chat-input :deep(.el-input__wrapper) {
  border-radius: 10px;
  box-shadow: 0 0 0 1px var(--line-strong) inset;
  transition: box-shadow 0.2s;
}
.chat-input :deep(.el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 1.5px var(--accent) inset, 0 0 0 4px rgba(11, 58, 130, 0.08);
}
.chat-input :deep(.el-input-group__append) {
  border-radius: 0 10px 10px 0;
  overflow: hidden;
}
.chat-input :deep(.el-input-group__append .el-button) {
  background: var(--grad-strip);
  border-color: var(--accent);
  color: #fff;
  font-weight: 600;
}
.chat-input :deep(.el-input-group__append .el-button:hover) {
  background: linear-gradient(120deg, var(--accent-dark), var(--accent-mid));
}
/* 动画关键帧：录音指示红点 */
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}


</style>
