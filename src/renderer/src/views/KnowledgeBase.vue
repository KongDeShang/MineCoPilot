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
      <el-table :data="filteredItems" stripe style="width: 100%" height="520">
        <el-table-column prop="title" label="条目标题" min-width="240" show-overflow-tooltip>
          <template #default="{ row }">
            <div style="display:flex;align-items:center;gap:8px">
              <span class="kb-item-title">{{ row.title }}</span>
              <el-tag v-if="row.status === 'ai_draft'" type="primary" size="small" effect="dark"><el-icon><MagicStick /></el-icon> AI 草稿</el-tag>
              <el-tag v-else type="success" size="small" effect="plain"><el-icon><Check /></el-icon> 已确认</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="category" label="分类" width="110">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.category }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="关键词" min-width="160" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="kb-keywords">{{ (row.keywords || []).join('、') }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="source" label="来源" min-width="180" show-overflow-tooltip />
        <el-table-column label="频次" width="80" align="center">
          <template #default="{ row }">
            <span v-if="row.frequency > 0" style="color:var(--warn-ink);font-weight:600">{{ row.frequency }}次</span>
            <span v-else style="color:var(--text-mute)">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <template v-if="row.status === 'ai_draft'">
              <el-button size="small" link type="success" @click="confirmDraft(row)">确认采纳</el-button>
              <el-button size="small" link type="danger" @click="remove(row)">删除</el-button>
            </template>
            <template v-else>
              <el-button size="small" link type="primary" @click="openEdit(row)">编辑</el-button>
              <el-button size="small" link type="danger" @click="remove(row)">删除</el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

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

const store = useAppStore()

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

function remove(item) {
  ElMessageBox.confirm(
    `确定删除「${item.title}」吗？删除后 AI 助手将无法检索到该条目。`,
    '删除确认',
    { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
  ).then(() => {
    store.removeKnowledgeItem(item.id)
    ElMessage.success('已删除')
  }).catch(() => {})
}

/** 确认采纳 AI 草稿：状态从 ai_draft 变为 confirmed */
function confirmDraft(item) {
  store.updateKnowledgeItem(item.id, { status: 'confirmed' })
  ElMessage.success(`已采纳「${item.title}」，正式纳入知识库`)
}

function resetKnowledge() {
  ElMessageBox.confirm(
    '将知识库重置为默认 30 条规程？所有自定义条目会被清除（建议先到「备份」导出）。',
    '重置确认',
    { type: 'warning', confirmButtonText: '重置', cancelButtonText: '取消' }
  ).then(() => {
    store.resetKnowledgeBase()
    ElMessage.success('已重置为默认知识库')
  }).catch(() => {})
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
</style>
