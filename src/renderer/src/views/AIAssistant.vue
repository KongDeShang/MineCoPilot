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
                <div v-for="(msg, index) in messages" :key="index" :class="['message', msg.role]">
                  <div class="message-avatar">
                    <el-icon v-if="msg.role === 'user'" :size="20"><User /></el-icon>
                    <el-icon v-else :size="20"><Monitor /></el-icon>
                  </div>
                  <div class="message-content">
                    <!-- AI 思考过程可视化（默认展开，可点击收起） -->
                    <div v-if="msg.thinkingSteps && msg.thinkingSteps.length" class="ai-thinking">
                      <div class="ai-thinking-title" @click="toggleThinking(msg)">
                        <span class="ai-thinking-icon">🤔</span> 智工分析过程
                        <span class="thinking-toggle">{{ msg.thinkingCollapsed ? '展开 ▾' : '收起 ▴' }}</span>
                      </div>
                      <div v-if="!msg.thinkingCollapsed" class="ai-thinking-body">
                        <div v-for="(step, si) in msg.thinkingSteps" :key="si" class="ai-thinking-step" :class="{ done: step.status === 'done' }">
                          <span class="step-icon">{{ step.status === 'done' ? '✅' : '⏳' }}</span>
                          <span class="step-label">{{ step.label }}</span>
                          <span v-if="step.detail" class="step-detail"> → {{ step.detail }}</span>
                        </div>
                      </div>
                    </div>
                    <div class="message-text" v-html="msg.content"></div>

                    <!-- 口述录入：理解卡（确认前不写库） -->
                    <div v-if="msg.plan" class="cmd-card" :class="{ blocked: msg.plan.blocked }">
                      <div class="cmd-head">
                        <el-icon><EditPen /></el-icon>
                        <span>我理解你要做这些操作</span>
                        <el-tag v-if="msg.plan.blocked" type="warning" size="small" effect="dark">需先确认设备</el-tag>
                        <el-tag v-else type="success" size="small" effect="dark">待确认</el-tag>
                      </div>

                      <!-- 歧义：让用户点选，绝不替你决定 -->
                      <div v-if="msg.plan.ambiguous.length" class="cmd-ambiguous">
                        <div class="cmd-ambiguous-title">
                          <el-icon><WarningFilled /></el-icon>
                          「{{ msg.plan.ambiguous[0].clause }}」匹配到多台设备，请确认是哪一台：
                          <span v-if="msg.plan.ambiguous.length > 1" class="cmd-ambiguous-more">
                            还剩 {{ msg.plan.ambiguous.length }} 处待确认
                          </span>
                        </div>
                        <div class="cmd-candidates">
                          <el-button
                            v-for="cand in msg.plan.ambiguous[0].candidates.slice(0, 8)"
                            :key="cand.id"
                            size="small"
                            @click="pickCandidate(msg, cand)"
                          >{{ cand.name }}</el-button>
                        </div>
                      </div>

                      <div v-if="msg.plan.notFound.length" class="cmd-notfound">
                        <el-icon><WarningFilled /></el-icon>
                        {{ msg.plan.notFound[0].reason }}：{{ msg.plan.notFound[0].clause }}
                      </div>

                      <div v-for="(item, ii) in msg.plan.items" :key="ii" class="cmd-item">
                        <div class="cmd-item-head">
                          <el-tag size="small" :type="item.intent === 'report_fault' ? 'danger' : 'primary'" effect="plain">
                            {{ item.intentLabel }}
                          </el-tag>
                          <span class="cmd-eq">{{ item.equipment ? item.equipment.name : '（未确定设备）' }}</span>
                          <el-tag v-if="item.priority === 'urgent'" type="danger" size="small" effect="dark">紧急</el-tag>
                          <el-tag v-else-if="item.priority === 'high'" type="warning" size="small" effect="plain">高优先级</el-tag>
                        </div>
                        <div class="cmd-detail">
                          <div v-if="item.intent === 'report_fault'"><span>故障现象</span>{{ item.title }}</div>
                          <div v-else-if="item.intent === 'add_maintenance'"><span>维保内容</span>{{ item.description }}（{{ item.date }}）</div>
                          <div v-else-if="item.intent === 'complete_order'">
                            <span>目标工单</span>
                            <template v-if="item.order">#{{ item.order.id }} {{ item.order.title }}</template>
                            <template v-else><em class="cmd-error">{{ item.preflightError }}</em></template>
                          </div>
                          <div v-else-if="item.intent === 'set_status'"><span>状态改为</span>{{ item.targetStatusLabel || item.preflightError }}</div>
                          <div v-else-if="item.intent === 'add_knowledge'"><span>写入知识库</span>{{ item.title }}（来源：现场录入）</div>
                          <div v-if="item.date && item.intent !== 'add_maintenance'"><span>日期</span>{{ item.date }}（{{ item.datePhrase }}）</div>
                          <div><span>识别依据</span>{{ item.matchedKeyword || '关键词' }} · 设备匹配方式：{{ item.equipmentRef.method }}</div>
                          <div class="cmd-raw"><span>原话</span>{{ item.rawText }}</div>
                        </div>
                      </div>

                      <!-- 连带影响：写库前必须让用户看到 -->
                      <div v-if="msg.plan.impact && msg.plan.impact.length" class="cmd-impact">
                        <div class="cmd-impact-title">确认后将同时发生：</div>
                        <ul>
                          <li v-for="(line, li) in msg.plan.impact" :key="li">{{ line }}</li>
                        </ul>
                      </div>

                      <div class="cmd-actions">
                        <el-button
                          type="primary"
                          size="small"
                          :disabled="msg.plan.blocked || msg.executing"
                          :loading="msg.executing"
                          @click="confirmPlan(msg)"
                        >{{ msg.executing ? '写入中…' : '确认写入' }}</el-button>
                        <el-button size="small" @click="cancelPlan(msg)">取消</el-button>
                        <span v-if="msg.plan.blocked" class="cmd-hint">存在歧义或预检未通过，请先处理上方提示</span>
                      </div>
                    </div>

                    <!-- 执行结果 + 撤销 -->
                    <div v-if="msg.execResult" class="cmd-result" :class="{ undone: msg.execResult.undone }">
                      <div v-for="(r, ri) in msg.execResult.results" :key="ri" class="cmd-result-line">
                        <el-icon v-if="r.ok" color="#67c23a"><CircleCheckFilled /></el-icon>
                        <el-icon v-else color="#f56c6c"><CircleCloseFilled /></el-icon>
                        <span>{{ r.ok ? r.summary : ('未能写入：' + r.error) }}</span>
                      </div>
                      <div v-if="msg.execResult.changes.length" class="cmd-changes">
                        <span class="cmd-changes-title">实际变更：</span>
                        <el-tag v-for="(c, ci) in msg.execResult.changes" :key="ci" size="small" type="info" effect="plain">
                          {{ c.label }} · {{ c.detail }}
                        </el-tag>
                      </div>
                      <div class="cmd-result-actions">
                        <el-tag v-if="msg.execResult.undone" type="info" size="small">已撤销</el-tag>
                        <el-button
                          v-else
                          type="danger"
                          size="small"
                          link
                          @click="undoPlan(msg)"
                        >撤销这次写入</el-button>
                        <span class="cmd-hint">撤销会恢复写入前的数据（含自动生成的复诊任务与健康快照）</span>
                      </div>
                    </div>

                    <div v-if="msg.refs && msg.refs.length" class="message-refs">
                      <span class="refs-label">依据</span>
                      <span v-for="(ref, ri) in msg.refs" :key="ri" class="ref-item">{{ ref }}</span>
                    </div>
                    <div class="message-time">{{ msg.time }}</div>
                  </div>
                </div>
                <div v-if="isLoading" class="message assistant">
                  <div class="message-avatar">
                    <el-icon :size="20"><Monitor /></el-icon>
                  </div>
                  <div class="message-content">
                    <div class="message-text typing">
                      <span class="dot"></span><span class="dot"></span><span class="dot"></span>
                    </div>
                  </div>
                </div>
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
                  <div class="quick-questions quick-main">
                    <span class="quick-label">快捷提问：</span>
                    <el-tag
                      v-for="q in quickPicks"
                      :key="q"
                      class="quick-tag"
                      :type="quickPickType(q)"
                      effect="plain"
                      @click="askQuick(q)"
                    >{{ q }}</el-tag>
                    <el-button link type="primary" size="small" class="quick-more" @click="showQuickMore = !showQuickMore">
                      {{ showQuickMore ? '收起 ▴' : '更多问题 ▾' }}
                    </el-button>
                  </div>

                  <template v-if="showQuickMore">
                  <div class="quick-questions">
                    <span class="quick-label">台账查询：</span>
                    <el-tag
                      v-for="q in ledgerQuestions"
                      :key="q"
                      class="quick-tag"
                      @click="askQuick(q)"
                    >{{ q }}</el-tag>
                  </div>
                  <div class="quick-questions">
                    <span class="quick-label">健康体检：</span>
                    <el-tag
                      v-for="q in healthQuestions"
                      :key="q"
                      type="danger"
                      effect="plain"
                      class="quick-tag"
                      @click="askQuick(q)"
                    >{{ q }}</el-tag>
                  </div>
                  <div class="quick-questions">
                    <span class="quick-label">数据分析：</span>
                    <el-tag
                      v-for="q in analysisQuestions"
                      :key="q"
                      type="warning"
                      effect="dark"
                      class="quick-tag"
                      @click="askQuick(q)"
                    >{{ q }}</el-tag>
                  </div>
                  <div class="quick-questions">
                    <span class="quick-label">知识库检索：</span>
                    <el-tag
                      v-for="q in knowledgeQuestions"
                      :key="q"
                      type="success"
                      class="quick-tag"
                      @click="askQuick(q)"
                    >{{ q }}</el-tag>
                  </div>

                  <!-- 口述录入示例：点一下就走完整流程（不写库，先出理解卡） -->
                  <div class="quick-questions">
                    <span class="quick-label">口述录入：</span>
                    <el-tag
                      v-for="q in commandExamples"
                      :key="q"
                      type="warning"
                      effect="plain"
                      class="quick-tag"
                      @click="askQuick(q)"
                    >{{ q }}</el-tag>
                  </div>
                  <div class="cmd-tip">
                    说一句就能录入：报故障、报完工、记保养、改状态、留经验。系统先出「理解卡」，确认后才写入，写错可撤销。
                    用「<strong>几号 + 类别名</strong>」（如 1号挖掘机），例如先说「1号挖掘机液压油压力偏低」，再说「1号挖掘机已经检修完了」。
                  </div>
                  </template>
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
import { ref, computed, nextTick, watch, onMounted, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import ExcelImportPanel from '../components/ExcelImportPanel.vue'
import { answerQuestion } from '../utils/knowledgeBase'
import { parseCommand, executePlanItem, hasWriteActions, INTENTS } from '../utils/nlCommand'
import { generateReport } from '../utils/reportGenerator'
import { useAppStore } from '../stores/appStore'
import { now } from '../utils/dates'
import { llmAvailable, llmLoad } from '../utils/llmClient'
import { htmlToText, narrateConclusionStream } from '../utils/narrate'
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
// 快捷提问：默认只显示精简行，展开后显示全部分类
const showQuickMore = ref(false)

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
  if (critical.length) alerts.push(`<span style="color:#f56c6c">🔴 ${critical.length} 台 D 级设备需要立即关注</span>`)
  if (overdue.length) alerts.push(`<span style="color:#e6a23c">⚠️ ${overdue.length} 台维保已超期${overdue.filter(e => e.overdueDays > 45).length > 0 ? `（其中 ${overdue.filter(e => e.overdueDays > 45).length} 台超期超过 45 天）` : ''}</span>`)
  if (worsening.length) alerts.push(`<span style="color:#e6a23c">📉 ${worsening.length} 台健康分持续下降，正在恶化中</span>`)

  const alertBlock = alerts.length
    ? `<div style="margin:10px 0;padding:10px 12px;background:#fef7f7;border:1px solid #fde2e2;border-radius:8px;line-height:2">${alerts.join('<br>')}</div>`
    : `<div style="margin:10px 0;padding:10px 12px;background:#f0f9eb;border:1px solid #d7efc1;border-radius:8px;color:#529b2e">✅ 所有设备状态正常，暂无紧急事项</div>`

  return [
    `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><span style="font-size:24px">👷</span><strong style="font-size:16px">智工</strong><span style="color:#909399;font-size:13px">· 你的设备健康顾问</span></div>`,
    `<div style="margin:6px 0">我帮你盯了 <strong>${stats.equipmentCount}</strong> 台设备，今天发现：</div>`,
    alertBlock,
    `<div style="margin-top:8px;color:#909399;font-size:12px">有事直接说，或者选下面的问题先看看。所有数字均由本地规则引擎实时计算，全程不联网。</div>`
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

// 三类快捷提问：台账查询 + 知识库检索 + AI 推荐（动态生成）
const ledgerQuestions = [
  '哪些设备维保已超期？',
  '台账里现在有多少台设备？',
  '最近有哪些紧急工单？',
  '哪些设备健康分最低？'
]

const knowledgeQuestions = [
  '液压油压力偏低可能是什么原因？',
  '发动机过热怎么排查？',
  '矿卡制动系统多久检查一次？',
  '装载机轮胎异常磨损的原因？',
  '保养周期是多少小时？'
]

// 健康类提问需要设备名，动态取台账里健康分最低的两台，保证"一键就有答案"
const healthQuestions = computed(() => {
  const worst = store.criticalList.slice(0, 2).map(item => `${item.name}健康怎么样？`)
  return worst.length ? worst : ['哪台设备需要体检？']
})

// 精简快捷提问行：每类取一个代表，随台账动态变化
const quickPicks = computed(() => {
  const picks = []
  if (ledgerQuestions[0]) picks.push(ledgerQuestions[0])
  if (healthQuestions.value[0]) picks.push(healthQuestions.value[0])
  if (analysisQuestions[0]) picks.push(analysisQuestions[0])
  if (knowledgeQuestions[0]) picks.push(knowledgeQuestions[0])
  return picks
})
const QUICK_TYPE_MAP = { 0: '', 1: 'danger', 2: 'warning', 3: 'success' }
function quickPickType(q) {
  return QUICK_TYPE_MAP[quickPicks.value.indexOf(q)] || ''
}

// 数据分析类问题
const analysisQuestions = [
  '各设备类别表现对比',
  '哪台设备维修次数最多？',
  '哪些设备正在恶化？',
  '生成车队周报'
]

/**
 * 口述录入示例（点一下走完整流程：先出理解卡，确认后才写库）
 *
 * 这几句都逐条验证过：解析成功 + 设备唯一确定 + 预检通过。
 * 演示数据设备名是「型号 类别-编号」且按类别连号，"序号 + 标准类别名"是 100% 命中的说法，
 * 所以示例统一用这个句式（俗称"挖机/铲车/卡车"会要求先选设备）。
 * 注意：不把"已经检修完了"放进标签——它需要该设备先有未完成工单，直接点会命中预检保护。
 */
const commandExamples = [
  '1号挖掘机液压油压力偏低',
  '1号挖掘机今天做了保养，换了液压油',
  '1号挖掘机先停机',
  '记一条：1号挖掘机回转马达异响，先查油位再拆泵',
  '1号装载机轮胎漏气了',
  '1号矿卡换了机油和机滤'
]

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

    const msg = {
      role: 'assistant',
      content: '',
      thinkingSteps,
      reportContent: reportHTML,
      time: nowTime()
    }
    messages.value.push(msg)
    isLoading.value = false

    // 动画：思考步骤逐帧展示，完成后显示报告
    if (thinkingSteps) {
      await animateThinking(thinkingSteps)
    }
    msg.content = reportHTML
    store.addLog({ content: `AI 生成${period === 'week' ? '周' : '月'}报`, source: 'AI', type: 'primary', tagType: 'primary' })
    nextTick(() => scrollToBottom(true))
    return
  }

  // ---- 普通查询：带思考过程 ----
  const thinkingSteps = buildThinkingSteps(rawQuestion)

  // 先插入一条带思考步骤的空消息
  const msg = {
    role: 'assistant',
    content: '',
    thinkingSteps: thinkingSteps || null,
    refs: [],
    time: nowTime()
  }
  messages.value.push(msg)
  await nextTick()

  // 动画：思考步骤逐帧执行
  if (thinkingSteps) {
    await animateThinking(thinkingSteps)
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
    msg.content += `<div style="margin-top:8px;color:#e6a23c">ℹ️ 顺带提示：${plan.notFound[0].reason}（原话："${plan.notFound[0].clause}"）</div>`
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
    '<div style="font-size:12px;font-weight:600;color:#0b3a82;margin-bottom:4px;">🤖 本地模型解读</div>',
    `<div id="${boxId}" style="font-size:13px;line-height:1.7;color:#1f2937;white-space:pre-wrap;">${bodyHtml || ''}</div>`,
    '<div style="margin-top:6px;font-size:11px;color:#8a95a7;">本地模型生成 · 数据未出本机</div>',
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
    `<span style="font-size:12px;color:#8a95a7;">ℹ️ ${detail} · 数据未出本机</span>`,
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
      return `<div style="margin-top:10px;padding:8px 12px;background:#ecf5ff;border-radius:6px;font-size:12px;color:#1d4ed8">💡 <strong>智工提示：</strong>如需详细分析，可在设备台账页一键生成《设备体检报告》，含完整溯源。</div>`
    }
  }
  if (/超期|到期/.test(q) && store.overdueList.length > 0) {
    return `<div style="margin-top:10px;padding:8px 12px;background:#fef0f0;border-radius:6px;font-size:12px;color:#c45656">💡 <strong>智工提示：</strong>超期设备建议优先安排保养，可在维保日历中一键创建工单。</div>`
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
      lines.push(`新建 1 张维修工单（状态：待处理，优先级：${item.priority === 'urgent' ? '紧急' : item.priority === 'high' ? '高' : '普通'}）`)
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
  color: #303133;
  margin-bottom: 8px;
}

.section-desc {
  font-size: 13px;
  color: #909399;
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
  color: #f56c6c;
  font-size: 14px;
}

.recording-indicator .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #f56c6c;
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
  background: #f5f7fa;
  border-radius: 8px;
}

.message {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}

.message.user {
  flex-direction: row-reverse;
}

.message-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.message.user .message-avatar {
  background: #409eff;
  color: white;
}

.message.assistant .message-avatar {
  background: #67c23a;
  color: white;
}

.message-content {
  max-width: 70%;
}

.message.user .message-content {
  text-align: right;
}

.message-text {
  padding: 12px 16px;
  border-radius: 12px;
  font-size: 14px;
  line-height: 1.6;
  word-break: break-word;
}

.message.user .message-text {
  background: #409eff;
  color: white;
  border-top-right-radius: 4px;
}

.message.assistant .message-text {
  background: white;
  color: #303133;
  border-top-left-radius: 4px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.08);
}

.message-time {
  font-size: 11px;
  color: #c0c4cc;
  margin-top: 4px;
}

.typing {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 16px 20px;
}

.typing .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #c0c4cc;
  animation: bounce 1.4s infinite ease-in-out;
}

.typing .dot:nth-child(1) { animation-delay: -0.32s; }
.typing .dot:nth-child(2) { animation-delay: -0.16s; }

.chat-input {
  padding-top: 12px;
  border-top: 1px solid #e4e7ed;
  background: linear-gradient(180deg, rgba(255,255,255,0) 0%, #fff 18px);
}

/* 输入框：圆角 + 聚焦高亮 */
.chat-input :deep(.el-input__wrapper) {
  border-radius: 10px;
  box-shadow: 0 0 0 1px #dcdfe6 inset;
  transition: box-shadow 0.2s;
}
.chat-input :deep(.el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 1.5px #0b3a82 inset, 0 0 0 4px rgba(11, 58, 130, 0.08);
}
.chat-input :deep(.el-input-group__append) {
  border-radius: 0 10px 10px 0;
  overflow: hidden;
}
.chat-input :deep(.el-input-group__append .el-button) {
  background: linear-gradient(120deg, #0b3a82, #1c6bd4);
  border-color: #0b3a82;
  color: #fff;
  font-weight: 600;
}
.chat-input :deep(.el-input-group__append .el-button:hover) {
  background: linear-gradient(120deg, #123f8f, #2b7de0);
}

.quick-questions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}

.quick-main {
  padding: 8px 10px;
  margin-top: 10px;
  background: rgba(11, 58, 130, 0.04);
  border: 1px dashed rgba(11, 58, 130, 0.22);
  border-radius: 8px;
}
.quick-more {
  margin-left: 4px;
  font-size: 12px;
}

.quick-label {
  font-size: 12px;
  color: #909399;
}

/* 口述录入的用法提示（紧跟在示例标签下方，一句话说清怎么用） */
.cmd-tip {
  margin-top: 10px;
  padding: 8px 12px;
  background: #fffbf0;
  border: 1px solid #ffe0a3;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.7;
  color: #8a6d3b;
}

.cmd-tip strong {
  color: #b45309;
}

.quick-tag {
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s;
}

.quick-tag:hover {
  background: #ecf5ff;
  border-color: #409eff;
  color: #409eff;
}

/* ===== 口述录入：理解卡与执行结果 ===== */
.cmd-card {
  margin-top: 10px;
  border: 1px solid #c6e2ff;
  border-radius: 10px;
  background: #f4f9ff;
  padding: 12px 14px;
}

.cmd-card.blocked {
  border-color: #fde2e2;
  background: #fef7f7;
}

.cmd-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 700;
  color: #1d4ed8;
  margin-bottom: 10px;
}

.cmd-card.blocked .cmd-head { color: #f56c6c; }

.cmd-ambiguous {
  padding: 10px;
  background: #fff7e6;
  border: 1px solid #ffe0a3;
  border-radius: 8px;
  margin-bottom: 10px;
}

.cmd-ambiguous-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #b45309;
  margin-bottom: 8px;
}

.cmd-ambiguous-more {
  margin-left: auto;
  font-size: 11px;
  color: #d46b08;
}

.cmd-candidates {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.cmd-notfound {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #f56c6c;
  padding: 8px 10px;
  background: #fef0f0;
  border-radius: 8px;
  margin-bottom: 10px;
}

.cmd-item {
  padding: 10px 12px;
  background: #fff;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  margin-bottom: 8px;
}

.cmd-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.cmd-eq {
  font-size: 13px;
  font-weight: 700;
  color: #303133;
}

.cmd-detail > div {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: #303133;
  padding: 3px 0;
  line-height: 1.6;
}

.cmd-detail > div > span:first-child {
  flex-shrink: 0;
  width: 68px;
  color: #909399;
}

.cmd-raw {
  color: #909399 !important;
}

.cmd-error { color: #f56c6c; font-style: normal; }

.cmd-impact {
  padding: 10px 12px;
  background: #f0f9eb;
  border: 1px solid #d7efc1;
  border-radius: 8px;
  font-size: 12px;
  color: #4b5563;
  margin-bottom: 10px;
}

.cmd-impact-title { font-weight: 700; color: #529b2e; margin-bottom: 4px; }

.cmd-impact ul { margin: 0; padding-left: 18px; }
.cmd-impact li { line-height: 1.7; }

.cmd-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.cmd-hint { font-size: 11px; color: #909399; }

.cmd-result {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #f0f9eb;
  border-left: 3px solid #67c23a;
}

.cmd-result.undone {
  background: #f4f4f5;
  border-left-color: #909399;
}

.cmd-result-line {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #303133;
  margin-bottom: 4px;
}

.cmd-changes {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}

.cmd-changes-title { font-size: 12px; color: #909399; }

.cmd-result-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}

/* ===== AI 思考过程可视化 ===== */
.ai-thinking {
  margin-bottom: 8px;
  padding: 10px 14px;
  background: #f0f5ff;
  border: 1px solid #d6e4ff;
  border-radius: 10px;
  font-size: 13px;
}

.ai-thinking-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: #1d4ed8;
  cursor: pointer;
  user-select: none;
  transition: opacity 0.2s;
}
.ai-thinking-title:hover {
  opacity: 0.75;
}
.thinking-toggle {
  margin-left: auto;
  font-size: 11px;
  color: #909399;
  font-weight: 400;
}
.ai-thinking-body {
  transition: all 0.2s;
}

.ai-thinking-icon {
  font-size: 16px;
  animation: thinkingPulse 1.5s ease-in-out infinite;
}

@keyframes thinkingPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.6; transform: scale(1.1); }
}

.ai-thinking-step {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
  color: #909399;
  font-size: 12px;
  transition: all 0.3s ease;
}

.ai-thinking-step.done {
  color: #303133;
}

.step-icon {
  font-size: 12px;
  width: 16px;
  text-align: center;
}

.step-label {
  font-weight: 500;
}

.step-detail {
  color: #909399;
  font-size: 11px;
}

/* 回答依据（可溯源） */
.message-refs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding: 6px 10px;
  background: #f0f9eb;
  border-radius: 6px;
  border-left: 3px solid #67c23a;
}

.refs-label {
  font-size: 11px;
  font-weight: 700;
  color: #67c23a;
}

.ref-item {
  font-size: 11px;
  color: #606266;
}

/* 动画关键帧：录音红点 与 正在输入三点 */
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

@keyframes bounce {
  0%, 80%, 100% { transform: scale(0); }
  40% { transform: scale(1); }
}

</style>
