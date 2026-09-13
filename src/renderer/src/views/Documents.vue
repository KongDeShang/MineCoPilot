<template>
  <div class="documents-page">
    <!-- 顶部统计 -->
    <el-row :gutter="16" class="doc-stats">
      <el-col :xs="12" :sm="8">
        <div class="stat-card">
          <div class="stat-label">手册资料</div>
          <div class="stat-value">{{ stats.total }} <span class="stat-unit">份</span></div>
        </div>
      </el-col>
      <el-col :xs="12" :sm="8">
        <div class="stat-card">
          <div class="stat-label">可问答（已提取文字层）</div>
          <div class="stat-value" style="color: #12a06b">{{ stats.ready }} <span class="stat-unit">份</span></div>
        </div>
      </el-col>
      <el-col :xs="12" :sm="8">
        <div class="stat-card">
          <div class="stat-label">累计页数</div>
          <div class="stat-value" style="color: #0b3a82">{{ stats.pages }} <span class="stat-unit">页</span></div>
        </div>
      </el-col>
    </el-row>

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
        <el-table-column label="可问答" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === 'ready' ? 'success' : 'warning'" effect="plain">
              {{ row.status === 'ready' ? `可问答（${row.pages} 页）` : '仅查看' }}
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
            <el-icon size="36" color="#0b3a82"><Document /></el-icon>
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
            <el-option label="保养规范" value="保养规范" />
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
import { ref, reactive } from 'vue'
import { ElMessage } from 'element-plus'
import { useAppStore } from '../stores/appStore'

const store = useAppStore()
const showAdd = ref(false)
const adding = ref(false)
const selectedFile = ref(null)
const form = reactive({ title: '', model: '', docType: '使用手册' })

const stats = store.documentStats

function fmtSize(bytes) {
  if (!bytes) return '—'
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  return Math.max(1, Math.round(bytes / 1024)) + ' KB'
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

.doc-stats {
  margin-bottom: 0;
}

.stat-card {
  background: #fff;
  border: 1px solid #dde4ef;
  border-radius: 13px;
  padding: 14px 16px;
  box-shadow: 0 1px 2px rgba(16, 24, 40, .04);
  margin-bottom: 4px;
}

.stat-label {
  font-size: 12px;
  color: #8a95a7;
}

.stat-value {
  font-size: 24px;
  font-weight: 700;
  color: #0a1326;
  margin-top: 4px;
}

.stat-unit {
  font-size: 12px;
  color: #8a95a7;
  font-weight: 400;
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
  color: #0a1326;
}

.docs-note {
  margin-top: 14px;
  font-size: 12px;
  color: #8a95a7;
  line-height: 1.8;
  background: #f4f7fb;
  border-radius: 10px;
  padding: 12px 14px;
}

.upload-hint {
  font-size: 12px;
  color: #8a95a7;
  margin-top: 4px;
}
</style>
