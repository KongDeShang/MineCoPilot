<template>
  <div class="quick-wrap">
    <div class="quick-questions quick-main">
      <span class="quick-label">快捷提问：</span>
      <el-tag
        v-for="q in quickPicks"
        :key="q"
        class="quick-tag"
        :type="quickPickType(q)"
        effect="plain"
        @click="$emit('ask', q)"
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
          @click="$emit('ask', q)"
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
          @click="$emit('ask', q)"
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
          @click="$emit('ask', q)"
        >{{ q }}</el-tag>
      </div>
      <div class="quick-questions">
        <span class="quick-label">知识库检索：</span>
        <el-tag
          v-for="q in knowledgeQuestions"
          :key="q"
          type="success"
          class="quick-tag"
          @click="$emit('ask', q)"
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
          @click="$emit('ask', q)"
        >{{ q }}</el-tag>
      </div>
      <div class="cmd-tip">
        说一句就能录入：报故障、报完工、记保养、改状态、留经验。系统先出「理解卡」，确认后才写入，写错可撤销。
        用「<strong>几号 + 类别名</strong>」（如 1号挖掘机），例如先说「1号挖掘机液压油压力偏低」，再说「1号挖掘机已经检修完了」。
      </div>
    </template>
  </div>
</template>

<script setup>
/**
 * 快捷提问区
 *
 * 四类问题（台账查询 / 健康体检 / 数据分析 / 知识库检索）外加口述录入示例。
 * 问题库和"展开更多"的状态都属于这一块，放在这里而不是留给父组件：
 * 父组件只需要知道"用户点了哪个问题"，其余一条都不关心。
 *
 * 只 emit 不执行：点一下要真的把问题发出去，那属于对话流程，由父组件决定。
 */
import { ref, computed } from 'vue'
import { useAppStore } from '../stores/appStore'

const store = useAppStore()

defineEmits(['ask'])

const showQuickMore = ref(false)

// 台账查询
const ledgerQuestions = [
  '哪些设备维保已超期？',
  '台账里现在有多少台设备？',
  '最近有哪些紧急工单？',
  '哪些设备健康分最低？'
]

// 知识库检索
const knowledgeQuestions = [
  '液压油压力偏低可能是什么原因？',
  '发动机过热怎么排查？',
  '矿卡制动系统多久检查一次？',
  '装载机轮胎异常磨损的原因？',
  '保养周期是多少小时？'
]

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
/* el-tag 的 type 只认 primary/success/info/warning/danger 五个值，
   传 '' 会被 prop 校验拦下并在控制台刷警告（每个未配色的标签一条）。
   没有配色就直接返回 undefined —— 缺省值不参与校验，警告消失，而外观不变：
   EP 内部是 `ns.m(type || "primary")`，'' 和 undefined 同样落到 el-tag--primary，
   改前改后渲染出的 class 完全一致。 */
const QUICK_TYPE_MAP = { 1: 'danger', 2: 'warning', 3: 'success' }
function quickPickType(q) {
  return QUICK_TYPE_MAP[quickPicks.value.indexOf(q)]
}
</script>

<style scoped>
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
  background: var(--accent-glass);
  border: 1px dashed var(--accent-glass-strong);
  border-radius: 8px;
}
.quick-more {
  margin-left: 4px;
  font-size: 12px;
}

.quick-label {
  font-size: 12px;
  color: var(--text-3);
}

.quick-tag {
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s;
}

.quick-tag:hover {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

/* 口述录入的用法提示（紧跟在示例标签下方，一句话说清怎么用） */
.cmd-tip {
  margin-top: 10px;
  padding: 8px 12px;
  background: var(--amber-soft);
  border: 1px solid var(--amber-line);
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--warn-ink);
}

.cmd-tip strong {
  color: var(--warn-ink);
}
</style>
