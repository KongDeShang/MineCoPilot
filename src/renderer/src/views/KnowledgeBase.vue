<template>
  <div class="knowledge-page">
    <!-- 顶部：统计 + 操作 -->
    <el-card shadow="never" class="kb-head-card">
      <div class="kb-head">
        <div class="kb-head-info">
          <div class="kb-title">本地维保规程库</div>
          <div class="kb-sub">
            共 <strong>{{ store.knowledgeItems.length }}</strong> 条可溯源规程 ·
            <strong>{{ categoryCount }}</strong> 个分类 ·
            全部存储在本机
            <template v-if="aiDraftCount > 0">
              · <el-tag type="primary" size="small" effect="dark"><el-icon><MagicStick /></el-icon> AI 已自动提炼 {{ aiDraftCount }} 条</el-tag>
            </template>
          </div>
        </div>
        <div class="kb-actions">
          <el-radio-group v-model="statusFilter" size="small">
            <el-radio-button value="all">全部</el-radio-button>
            <el-radio-button value="confirmed">已确认</el-radio-button>
            <el-radio-button value="ai_draft">AI 草稿</el-radio-button>
          </el-radio-group>
          <el-button @click="resetKnowledge" plain>重置为默认</el-button>
          <el-button type="primary" @click="openCreate">
            <el-icon style="margin-right: 4px"><Plus /></el-icon>新增条目
          </el-button>
        </div>
      </div>
    </el-card>

    <!-- 演示爆点提示 -->
    <el-alert type="success" :closable="false" show-icon class="kb-demo-tip">
      <template #title>
        <strong>现场演示动作：</strong>新增一条案例后，切到「AI 助手」问同样的问题——立刻命中并带出处。这就是"经验传承"的实锤。
      </template>
    </el-alert>

    <!-- 条目表格 -->
    <el-card shadow="never" class="kb-table-card">
      <!-- 整行可点开详情：光有行内「查看」还不够 —— 一线是习惯性点行的，
           点不动就会被当成"这页坏了"。按钮的 .stop 与 openDetail 里的按钮判断两级保险。 -->
      <el-table :data="filteredItems" stripe style="width: 100%" height="520" @row-click="openDetail">
        <el-table-column prop="title" label="条目标题" min-width="240" show-overflow-tooltip>
          <template #default="{ row }">
            <div style="display:flex;align-items:center;gap:8px">
              <span class="kb-item-title">{{ row.title }}</span>
              <el-tag v-if="row.status === 'ai_draft'" type="primary" size="small" effect="dark"><el-icon><MagicStick /></el-icon> AI 草稿</el-tag>
              <el-tag v-else type="success" size="small" effect="plain"><el-icon><Check /></el-icon> 已确认</el-tag>
            </div>
          </template>
        </el-table-column>
        <!-- 窄屏摘「分类」「来源」，留标题 / 关键词 / 频次 / 操作。
             「来源」是可追溯性信息，但详情抽屉里一字不差地还在；
             而「关键词」是现场判断"这条跟我这台机器对不对得上"最直接的线索，留下 -->
        <el-table-column v-if="!isNarrow" prop="category" label="分类" width="110">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.category }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="关键词" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="kb-keywords">{{ (row.keywords || []).join('、') }}</span>
          </template>
        </el-table-column>
        <el-table-column v-if="!isNarrow" prop="source" label="来源" min-width="180" show-overflow-tooltip />
        <el-table-column label="频次" width="80" align="center">
          <template #default="{ row }">
            <span v-if="row.frequency > 0" style="color:var(--warn-ink);font-weight:600">{{ row.frequency }}次</span>
            <span v-else style="color:var(--text-mute)">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="240" fixed="right">
          <template #default="{ row }">
            <!-- 「查看」对 AI 草稿同样开放：草稿也要先能读，才能判断该不该采纳。
                 按钮一律 .stop —— 否则点编辑/删除会连带触发整行的"查看"。 -->
            <el-button size="small" link type="primary" @click.stop="openDetail(row)">查看</el-button>
            <template v-if="row.status === 'ai_draft'">
              <el-button size="small" link type="success" @click.stop="confirmDraft(row)">确认采纳</el-button>
              <el-button size="small" link type="danger" @click.stop="remove(row)">删除</el-button>
            </template>
            <template v-else>
              <el-button size="small" link type="primary" @click.stop="openEdit(row)">编辑</el-button>
              <el-button size="small" link type="danger" @click.stop="remove(row)">删除</el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 规程详情（只读）：症状 → 原因 → 步骤，与 AI 检索用的字段一致 -->
    <el-drawer v-model="detailVisible" size="520px" destroy-on-close>
      <template #header>
        <span style="font-weight:600">{{ detail?.title || '规程详情' }}</span>
      </template>
      <div v-if="detail" class="kb-detail">
        <div class="kb-detail-meta">
          <el-tag size="small" effect="plain">{{ detail.category || '其他' }}</el-tag>
          <el-tag v-if="detail.status === 'ai_draft'" type="primary" size="small" effect="dark">AI 草稿（未采纳）</el-tag>
          <el-tag v-else type="success" size="small" effect="plain">已确认</el-tag>
          <span class="kb-detail-freq">被命中 {{ detail.frequency || 0 }} 次</span>
        </div>
        <div class="kb-detail-block">
          <div class="kb-detail-label">关键词</div>
          <div class="kb-detail-text">{{ (detail.keywords || []).join('、') || '（未设置，AI 只能按标题/正文命中）' }}</div>
        </div>
        <div class="kb-detail-block">
          <div class="kb-detail-label">来源</div>
          <div class="kb-detail-text">{{ detail.source || '（未填写来源）' }}</div>
        </div>
        <div class="kb-detail-block">
          <div class="kb-detail-label">典型现象</div>
          <div class="kb-detail-text">{{ detail.symptoms || '（未填写）' }}</div>
        </div>
        <div class="kb-detail-block">
          <div class="kb-detail-label">可能原因</div>
          <ol v-if="(detail.causes || []).length" class="kb-detail-list">
            <li v-for="(c, i) in detail.causes" :key="'c' + i">{{ c }}</li>
          </ol>
          <div v-else class="kb-detail-text">（未填写）</div>
        </div>
        <div class="kb-detail-block">
          <div class="kb-detail-label">处置步骤</div>
          <ol v-if="(detail.steps || []).length" class="kb-detail-list">
            <li v-for="(s, i) in detail.steps" :key="'s' + i">{{ s }}</li>
          </ol>
          <div v-else class="kb-detail-text">（未填写）</div>
        </div>
        <div class="kb-detail-note">
          本页只是把条目读出来，不改任何字段。要改请用行内的「编辑」。
        </div>
      </div>
      <template #footer>
        <el-button @click="detailVisible = false">关闭</el-button>
        <el-button v-if="detail && detail.status !== 'ai_draft'" type="primary" @click="editFromDetail">编辑</el-button>
        <el-button v-else-if="detail" type="success" @click="adoptFromDetail">确认采纳</el-button>
      </template>
    </el-drawer>

    <!-- 新增 / 编辑对话框 -->
    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑知识条目' : '新增知识条目'"
      width="640px"
      destroy-on-close
    >
      <el-form :model="form" label-width="86px">
        <el-form-item label="标题" required>
          <el-input v-model="form.title" placeholder="例：徐工 XE215C 回转马达异响排查" maxlength="60" show-word-limit />
        </el-form-item>
        <el-form-item label="分类">
          <el-select v-model="form.category" style="width: 100%">
            <el-option v-for="c in CATEGORIES" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>
        <el-form-item label="关键词">
          <el-input v-model="form.keywords" placeholder="逗号分隔，如：XE215C, 回转马达, 异响（用于 AI 检索命中）" />
        </el-form-item>
        <el-form-item label="典型现象">
          <el-input v-model="form.symptoms" placeholder="例：回转时异响、回转无力、伴有顿挫" />
        </el-form-item>
        <el-form-item label="可能原因">
          <el-input
            v-model="form.causes"
            type="textarea"
            :rows="3"
            placeholder="每行一条原因"
          />
        </el-form-item>
        <el-form-item label="处置步骤">
          <el-input
            v-model="form.steps"
            type="textarea"
            :rows="4"
            placeholder="每行一条步骤，按执行顺序"
          />
        </el-form-item>
        <el-form-item label="来源">
          <el-input v-model="form.source" placeholder="例：现场案例 - 2026-09 / 参照徐工 XX 系列公开手册" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!form.title.trim()" @click="save">
          {{ editingId ? '保存修改' : '新增并立即生效' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAppStore } from '../stores/appStore'
import { confirmAction } from '../utils/confirmAction'
import { useNarrowMode } from '../utils/responsive'

const store = useAppStore()
const { isNarrow } = useNarrowMode()

const CATEGORIES = [
  '液压系统', '动力系统', '电气系统', '制动系统', '行走机构', '保养规范',
  '安全规范', '传动系统', '工作装置', '破碎设备', '钻机系统', '压实设备', '新能源', '其他'
]

const categoryCount = computed(() => new Set(store.knowledgeItems.map(i => i.category)).size)

// AI 知识进化：筛选与统计
const statusFilter = ref('all')
const aiDraftCount = computed(() => store.knowledgeItems.filter(i => i.status === 'ai_draft').length)
const filteredItems = computed(() => {
  if (statusFilter.value === 'all') return store.knowledgeItems
  return store.knowledgeItems.filter(i => (i.status || 'confirmed') === statusFilter.value)
})

const dialogVisible = ref(false)
const editingId = ref(null)
const form = ref(blankForm())

// 只读详情（抽屉）。之前没有任何"看"的入口：症状/原因/步骤只能从编辑对话框里看，
// AI 草稿行连编辑都没有 —— 规程库因此变成"点不动"的列表。
const detailVisible = ref(false)
const detail = ref(null)

/**
 * 打开详情。
 * el-table 的 row-click 在点按钮时也会触发（按钮的点击冒泡到行），
 * 所以这里再挡一道：命中行内按钮/链接的事件一律不当成"点行"。
 * 行内按钮本身也都写了 .stop，两层保险。
 */
function openDetail(row, column, event) {
  const target = event && event.target
  if (target && typeof target.closest === 'function' && target.closest('button, a, .el-button, .el-link')) return
  detail.value = row
  detailVisible.value = true
}

/** 从详情里跳去编辑：先关抽屉，避免两层浮层叠着 */
function editFromDetail() {
  const row = detail.value
  detailVisible.value = false
  if (row) openEdit(row)
}

/** 从详情里采纳 AI 草稿 */
function adoptFromDetail() {
  const row = detail.value
  detailVisible.value = false
  if (row) confirmDraft(row)
}

function blankForm() {
  return { title: '', category: '液压系统', keywords: '', symptoms: '', causes: '', steps: '', source: '' }
}

function openCreate() {
  editingId.value = null
  form.value = blankForm()
  dialogVisible.value = true
}

function openEdit(item) {
  editingId.value = item.id
  form.value = {
    title: item.title,
    category: item.category || '其他',
    keywords: (item.keywords || []).join('，'),
    symptoms: item.symptoms || '',
    causes: (item.causes || []).join('\n'),
    steps: (item.steps || []).join('\n'),
    source: item.source || ''
  }
  dialogVisible.value = true
}

function save() {
  if (!form.value.title.trim()) {
    ElMessage.warning('请填写条目标题')
    return
  }
  const payload = {
    title: form.value.title.trim(),
    category: form.value.category,
    keywords: form.value.keywords,
    symptoms: form.value.symptoms,
    causes: form.value.causes,
    steps: form.value.steps,
    source: form.value.source
  }
  if (editingId.value) {
    store.updateKnowledgeItem(editingId.value, payload)
    ElMessage.success('已保存，AI 助手检索即时生效')
  } else {
    store.addKnowledgeItem(payload)
    ElMessage.success('已新增，去 AI 助手问同样的问题即可命中')
  }
  dialogVisible.value = false
}

async function remove(item) {
  // 写库动作（store.removeKnowledgeItem → persistAll）失败必须报出来，
  // 不能靠 `.catch(() => {})` 吞掉 —— 那会变成"点了删除什么也没发生"。
  // 取消与失败的区分统一在 utils/confirmAction.js 里，见那里的说明。
  await confirmAction(
    ElMessageBox.confirm(
      `确定删除「${item.title}」吗？删除后 AI 助手将无法检索到该条目。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    ),
    () => {
      store.removeKnowledgeItem(item.id)
      ElMessage.success('已删除')
    },
    { label: '删除规程' }
  )
}

/** 确认采纳 AI 草稿：状态从 ai_draft 变为 confirmed */
function confirmDraft(item) {
  store.updateKnowledgeItem(item.id, { status: 'confirmed' })
  ElMessage.success(`已采纳「${item.title}」，正式纳入知识库`)
}

async function resetKnowledge() {
  await confirmAction(
    ElMessageBox.confirm(
      '将知识库重置为默认 30 条规程？所有自定义条目会被清除（建议先到「备份」导出）。',
      '重置确认',
      { type: 'warning', confirmButtonText: '重置', cancelButtonText: '取消' }
    ),
    () => {
      store.resetKnowledgeBase()
      ElMessage.success('已重置为默认知识库')
    },
    { label: '重置知识库' }
  )
}
</script>

<style scoped>
.knowledge-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.kb-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}

.kb-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-1);
}

.kb-sub {
  font-size: 13px;
  color: var(--text-3);
  margin-top: 4px;
}

.kb-actions {
  display: flex;
  gap: 8px;
}

.kb-demo-tip {
  border-radius: 10px;
}

.kb-table-card :deep(.el-card__body) {
  padding: 0;
}

.kb-item-title {
  font-weight: 600;
  color: var(--text-1);
}

.kb-keywords {
  font-size: 12px;
  color: var(--text-2);
}

/* 规程详情（只读抽屉） */
.kb-detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.kb-detail-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.kb-detail-freq {
  font-size: 12px;
  color: var(--text-3);
}

.kb-detail-block {
  border-left: 3px solid var(--line);
  padding-left: 10px;
}

.kb-detail-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-3);
  margin-bottom: 4px;
}

.kb-detail-text {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-1);
  white-space: pre-wrap;
}

.kb-detail-list {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.9;
  color: var(--text-1);
}

.kb-detail-note {
  margin-top: 4px;
  padding-top: 10px;
  border-top: 1px dashed var(--line);
  font-size: 12px;
  color: var(--text-3);
}
</style>
