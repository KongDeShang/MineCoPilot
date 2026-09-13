<template>
  <div :class="['message', msg ? msg.role : 'assistant']">
    <div class="message-avatar">
      <el-icon v-if="msg && msg.role === 'user'" :size="20"><User /></el-icon>
      <el-icon v-else :size="20"><Monitor /></el-icon>
    </div>
    <div class="message-content">
      <!-- 等待应答的占位气泡：与真实消息共用同一套气泡外观 -->
      <div v-if="typing" class="message-text typing">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>

      <template v-else>
        <!-- AI 思考过程可视化（默认展开，可点击收起） -->
        <div v-if="msg.thinkingSteps && msg.thinkingSteps.length" class="ai-thinking">
          <div class="ai-thinking-title" @click="$emit('toggle-thinking')">
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
                @click="$emit('pick-candidate', cand)"
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
              @click="$emit('confirm-plan')"
            >{{ msg.executing ? '写入中…' : '确认写入' }}</el-button>
            <el-button size="small" @click="$emit('cancel-plan')">取消</el-button>
            <span v-if="msg.plan.blocked" class="cmd-hint">存在歧义或预检未通过，请先处理上方提示</span>
          </div>
        </div>

        <!-- 执行结果 + 撤销 -->
        <div v-if="msg.execResult" class="cmd-result" :class="{ undone: msg.execResult.undone }">
          <div v-for="(r, ri) in msg.execResult.results" :key="ri" class="cmd-result-line">
            <el-icon v-if="r.ok" color="var(--emerald)"><CircleCheckFilled /></el-icon>
            <el-icon v-else color="var(--danger)"><CircleCloseFilled /></el-icon>
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
              @click="$emit('undo-plan')"
            >撤销这次写入</el-button>
            <span class="cmd-hint">撤销会恢复写入前的数据（含自动生成的复诊任务与健康快照）</span>
          </div>
        </div>

        <div v-if="msg.refs && msg.refs.length" class="message-refs">
          <span class="refs-label">依据</span>
          <span v-for="(ref, ri) in msg.refs" :key="ri" class="ref-item">{{ ref }}</span>
        </div>
        <div class="message-time">{{ msg.time }}</div>
      </template>
    </div>
  </div>
</template>

<script setup>
/**
 * 单条对话气泡
 *
 * 为什么单独成组件：
 *   一条消息要渲染的东西比想象中多 —— 思考过程、正文、口述理解卡（歧义候选、
 *   预检错误、连带影响、确认/取消）、执行结果与撤销、回答依据、时间。这一整块
 *   原本压在 AIAssistant.vue 的模板里，占了聊天页签一半篇幅，而它需要的
 *   只有"一条消息对象"，跟父组件的解析逻辑毫无关系。
 *
 * 一条消息的两种状态放在同一个组件里（typing）：
 *   "正在输入"的占位气泡与真实气泡共用同一套外观（头像、气泡圆角、配色）。
 *   拆成两个组件就得把这几条样式抄两遍，抄完就会各自漂移。
 *
 * 只读不写：msg 是父组件的响应式对象，这里只读。所有会改数据的动作
 *   （点选候选、确认写入、撤销、展开思考过程）一律 emit 出去由父组件执行。
 */
defineProps({
  /** 消息对象：{ role, content, time, thinkingSteps, plan, execResult, refs } */
  msg: { type: Object, default: null },
  /** 是否渲染"正在输入"占位气泡（此时不需要 msg） */
  typing: { type: Boolean, default: false }
})

defineEmits(['pick-candidate', 'confirm-plan', 'cancel-plan', 'undo-plan', 'toggle-thinking'])
</script>

<style scoped>
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
  background: var(--accent);
  color: white;
}

.message.assistant .message-avatar {
  background: var(--emerald);
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
  background: var(--accent);
  color: white;
  border-top-right-radius: 4px;
}

.message.assistant .message-text {
  background: white;
  color: var(--text-1);
  border-top-left-radius: 4px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.08);
}

.message-time {
  font-size: 11px;
  color: var(--text-mute);
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
  background: var(--line-strong);
  animation: bounce 1.4s infinite ease-in-out;
}

.typing .dot:nth-child(1) { animation-delay: -0.32s; }
.typing .dot:nth-child(2) { animation-delay: -0.16s; }

@keyframes bounce {
  0%, 80%, 100% { transform: scale(0); }
  40% { transform: scale(1); }
}

/* ===== 口述录入：理解卡与执行结果 ===== */
.cmd-card {
  margin-top: 10px;
  border: 1px solid var(--accent-line);
  border-radius: 10px;
  background: var(--accent-soft);
  padding: 12px 14px;
}

.cmd-card.blocked {
  border-color: var(--danger-line);
  background: var(--danger-soft);
}

.cmd-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 700;
  color: var(--accent);
  margin-bottom: 10px;
}

.cmd-card.blocked .cmd-head { color: var(--danger-ink); }

.cmd-ambiguous {
  padding: 10px;
  background: var(--amber-soft);
  border: 1px solid var(--amber-line);
  border-radius: 8px;
  margin-bottom: 10px;
}

.cmd-ambiguous-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--warn-ink);
  margin-bottom: 8px;
}

.cmd-ambiguous-more {
  margin-left: auto;
  font-size: 11px;
  color: var(--warn-ink);
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
  color: var(--danger);
  padding: 8px 10px;
  background: var(--danger-soft);
  border-radius: 8px;
  margin-bottom: 10px;
}

.cmd-item {
  padding: 10px 12px;
  background: #fff;
  border: 1px solid var(--line);
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
  color: var(--text-1);
}

.cmd-detail > div {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: var(--text-1);
  padding: 3px 0;
  line-height: 1.6;
}

.cmd-detail > div > span:first-child {
  flex-shrink: 0;
  width: 68px;
  color: var(--text-3);
}

.cmd-raw {
  color: var(--text-3) !important;
}

.cmd-error { color: var(--danger-ink); font-style: normal; }

.cmd-impact {
  padding: 10px 12px;
  background: var(--emerald-soft);
  border: 1px solid var(--emerald-line);
  border-radius: 8px;
  font-size: 12px;
  color: var(--text-2);
  margin-bottom: 10px;
}

.cmd-impact-title { font-weight: 700; color: var(--success-ink); margin-bottom: 4px; }

.cmd-impact ul { margin: 0; padding-left: 18px; }
.cmd-impact li { line-height: 1.7; }

.cmd-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.cmd-hint { font-size: 11px; color: var(--text-3); }

.cmd-result {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--emerald-soft);
  border-left: 3px solid var(--emerald);
}

.cmd-result.undone {
  background: var(--line-2);
  border-left-color: #909399;
}

.cmd-result-line {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-1);
  margin-bottom: 4px;
}

.cmd-changes {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}

.cmd-changes-title { font-size: 12px; color: var(--text-3); }

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
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  border-radius: 10px;
  font-size: 13px;
}

.ai-thinking-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: var(--accent);
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
  color: var(--text-3);
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
  color: var(--text-3);
  font-size: 12px;
  transition: all 0.3s ease;
}

.ai-thinking-step.done {
  color: var(--text-1);
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
  color: var(--text-3);
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
  background: var(--emerald-soft);
  border-radius: 6px;
  border-left: 3px solid var(--emerald);
}

.refs-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--emerald);
}

.ref-item {
  font-size: 11px;
  color: var(--text-2);
}
</style>
