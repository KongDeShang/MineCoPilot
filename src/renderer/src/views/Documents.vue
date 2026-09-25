<template>
  <div class="documents-page">
    <!-- 顶部统计 -->
    <StatCards :items="statItems" />

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span><el-icon><FolderOpened /></el-icon> 手册资料库 · 随时查看 + 随时提问</span>
          <el-button type="primary" @click="showAdd = true">
            <el-icon style="margin-right: 4px"><Upload /></el-icon>添加手册（PDF）
          </el-button>
        </div>
      </template>

      <el-table :data="store.documents" stripe>
        <el-table-column label="标题" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="doc-title">{{ row.title }}</span>
            <el-tag size="small" effect="plain" type="info" style="margin-left: 6px">{{ row.docType }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="model" label="机型" width="130">
          <template #default="{ row }">{{ row.model || '—' }}</template>
        </el-table-column>
        <el-table-column label="可问答" width="140">
          <template #default="{ row }">
            <!--
              报的是**可被 AI 检索的页数**，不是 PDF 总页数。
              原来用 row.pages（PDF 总页数），而被 CHUNK_LIMIT 截断时两者并不相等 ——
              界面于是把"前 300 页可问答"显示成"可问答（420 页）"，用户问到第 350 页
              没有结果，还以为是 AI 的问题。截断时另给一条明确的副标。
            -->
            <el-tooltip
              v-if="row.status === 'ready' && isTruncated(row)"
              :content="row.note || '文字层超出单份上限，仅前若干页可被 AI 检索'"
              placement="top"
            >
              <el-tag size="small" type="warning" effect="plain">
                可问答（{{ indexedPages(row) }}/{{ totalChunks(row) }} 页）
              </el-tag>
            </el-tooltip>
            <el-tag v-else size="small" :type="row.status === 'ready' ? 'success' : 'warning'" effect="plain">
              {{ row.status === 'ready' ? `可问答（${indexedPages(row)} 页）` : '仅查看' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="大小" width="90">
          <template #default="{ row }">{{ fmtSize(row.fileSize) }}</template>
        </el-table-column>
        <el-table-column prop="addedAt" label="添加时间" width="130">
          <template #default="{ row }">{{ (row.addedAt || '').slice(0, 10) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" link @click="openDoc(row)">
              <el-icon style="margin-right: 3px"><View /></el-icon>查看原文
            </el-button>
            <el-popconfirm title="删除后文件与文字层一并清除，确认？" @confirm="removeDoc(row)">
              <template #reference>
                <el-button size="small" type="danger" link>删除</el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="还没有手册。添加一份徐工机型使用/维修手册 PDF，即可随时查看原文、随时向 AI 提问（回答带页码出处）" />
        </template>
      </el-table>

      <div class="docs-note">
        文件只存本机（Electron 写入 userData/documents，网页版存 IndexedDB），全程离线。
        有文字层的 PDF 可问答——AI 引用时注明《手册名》第 N 页，可审计；扫描件自动降级为"仅查看"，不硬撑。
        单份手册的文字层最多入库 300 页，超出部分只在原文中可查、不进 AI 检索——"可问答"列报的是
        <strong>实际可检索的页数</strong>，被截断时标黄并写明上限，不拿 PDF 总页数冒充。
      </div>
    </el-card>

    <!-- 添加对话框 -->
    <el-dialog v-model="showAdd" title="添加手册（PDF）" width="520px" :close-on-click-modal="false">
      <el-form label-width="80px">
        <el-form-item label="选择文件" required>
          <el-upload
            drag
            :auto-upload="false"
            :limit="1"
            accept=".pdf,application/pdf"
            :on-change="onFileChange"
            :on-remove="() => (selectedFile = null)"
          >
            <el-icon size="36" color="var(--accent)"><Document /></el-icon>
            <div style="margin-top: 8px">拖拽或点击选择 PDF 手册</div>
            <div class="upload-hint">仅支持 PDF · 文件只在本机处理</div>
          </el-upload>
        </el-form-item>
        <el-form-item label="手册标题">
          <el-input v-model="form.title" placeholder="如：徐工 XDA45 矿用自卸车使用手册" />
        </el-form-item>
        <el-form-item label="机型">
          <el-input v-model="form.model" placeholder="如：XDA45（用于检索匹配）" />
        </el-form-item>
        <el-form-item label="手册类型">
          <el-select v-model="form.docType" style="width: 100%">
            <el-option label="使用手册" value="使用手册" />
            <el-option label="维修手册" value="维修手册" />
            <el-option label="操作维护手册" value="操作维护手册" />
            <el-option label="保养规范" value="保养规范" />
            <el-option label="技术规格书" value="技术规格书" />
            <el-option label="其他资料" value="其他资料" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAdd = false">取消</el-button>
        <el-button type="primary" :loading="adding" :disabled="!selectedFile" @click="doAdd">
          添加并解析
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { useAppStore } from '../stores/appStore'
import StatCards from '../components/StatCards.vue'

const store = useAppStore()
const showAdd = ref(false)
const adding = ref(false)
const selectedFile = ref(null)
const form = reactive({ title: '', model: '', docType: '使用手册' })

// 包一层 computed：Pinia 会把 setup store 的 computed 解包成取值那一刻的普通对象，
// 直接别名等于拍快照——新增手册后页面上的份数/页数不会跟着变。
const stats = computed(() => store.documentStats)

const statItems = computed(() => {
  const s = stats.value
  return [
    { label: '手册资料', value: s.total, unit: '份' },
    { label: '可问答（已提取文字层）', value: s.ready, unit: '份', color: 'var(--emerald)' },
    { label: '累计页数', value: s.pages, unit: '页', color: 'var(--accent)' }
  ]
})

function fmtSize(bytes) {
  if (!bytes) return '—'
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  return Math.max(1, Math.round(bytes / 1024)) + ' KB'
}

/*
 * 「可问答」列的口径。
 *
 * 这三个函数的共同前提是：**PDF 总页数（pages）不等于可检索页数**。
 * 文字层按页切片入库，上限 CHUNK_LIMIT（现 300 片，见 documentDomain.readinessOf），
 * 超限的部分进不了检索池；而一页若无文字层也不会产生切片。
 * 所以界面必须报切片数，不能报 pages —— 后者会把"只有前 300 页能问"
 * 显示成"可问答（420 页）"。
 *
 * 老库没有 chunkTotal 列（迁移是一列一列补的），此时回落到已存切片数，
 * 等价于"没被截断"，与旧版行为一致。
 */
function totalChunks(row) {
  const n = Number(row && row.chunkTotal)
  return Number.isFinite(n) && n > 0 ? n : (row && row.chunks ? row.chunks.length : 0)
}
function indexedPages(row) {
  return row && row.chunks ? row.chunks.length : 0
}
function isTruncated(row) {
  return totalChunks(row) > indexedPages(row)
}

function onFileChange(uploadFile) {
  selectedFile.value = uploadFile.raw || null
}

async function doAdd() {
  if (!selectedFile.value) return
  adding.value = true
  const res = await store.addDocument({
    file: selectedFile.value,
    title: form.title.trim() || undefined,
    docType: form.docType,
    model: form.model.trim()
  })
  adding.value = false
  if (res && res.ok) {
    ElMessage.success(res.doc.status === 'ready'
      ? `已添加「${res.doc.title}」（${res.doc.pages} 页，可直接问答）`
      : `已添加「${res.doc.title}」，扫描件仅可查看原文`)
    showAdd.value = false
    form.title = ''
    form.model = ''
    selectedFile.value = null
  } else {
    ElMessage.error((res && res.error) || '添加失败')
  }
}

async function openDoc(row) {
  const ok = await store.openDocument(row)
  if (!ok) ElMessage.warning('无法打开文件（可能已被移动），请重新添加')
}

async function removeDoc(row) {
  await store.removeDocument(row.id)
  ElMessage.success('已删除')
}
</script>

<style scoped>
.documents-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.doc-title {
  font-weight: 600;
  color: var(--text-1);
}

.docs-note {
  margin-top: 14px;
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.8;
  background: var(--line-2);
  border-radius: 10px;
  padding: 12px 14px;
}

.upload-hint {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 4px;
}
</style>
