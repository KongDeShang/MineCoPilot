<template>
  <el-row :gutter="20">
    <!-- 左侧：上传区域 -->
    <el-col :span="10">
      <el-card>
        <template #header>
          <div class="card-header">
            <span><el-icon><Upload /></el-icon> Excel 文件导入</span>
            <el-button type="primary" size="small" @click="loadExcelDemo">
              加载演示数据
            </el-button>
          </div>
        </template>

        <div
          class="upload-area"
          :class="{ 'is-dragover': isExcelDragover }"
          @dragover.prevent="isExcelDragover = true"
          @dragleave="isExcelDragover = false"
          @drop.prevent="handleExcelDrop"
          @click="openFilePicker"
        >
          <el-icon :size="48" color="var(--text-mute)"><Upload /></el-icon>
          <p class="upload-text">拖入 Excel 文件到此处</p>
          <p class="upload-hint">支持 .xlsx / .xls / .csv 格式</p>
          <input
            ref="excelFileInput"
            type="file"
            accept=".xlsx,.xls,.csv"
            multiple
            style="display: none"
            @change="handleExcelFileSelect"
          >
        </div>

        <!-- 已导入文件列表 -->
        <div v-if="importedFiles.length > 0" class="file-list">
          <div class="file-list-title">已导入文件 ({{ importedFiles.length }})</div>
          <div v-for="(file, index) in importedFiles" :key="index" class="file-item">
            <el-icon color="var(--accent)"><Document /></el-icon>
            <span class="file-name">{{ file.filename }}</span>
            <el-tag size="small" type="info">{{ file.sheets.length }} 个工作表</el-tag>
            <el-button type="danger" size="small" link @click="removeExcelFile(index)">删除</el-button>
          </div>
        </div>

        <!-- 解析统计 -->
        <div v-if="mergedResult" class="parse-stats">
          <el-divider>解析统计</el-divider>
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="文件数">{{ mergedResult.sourceCount }}</el-descriptions-item>
            <el-descriptions-item label="工作表">{{ mergedResult.sheetCount }}</el-descriptions-item>
            <el-descriptions-item label="总行数">{{ mergedResult.totalRows }}</el-descriptions-item>
            <el-descriptions-item label="字段数">{{ mergedResult.headers.length }}</el-descriptions-item>
          </el-descriptions>
        </div>

        <!-- 导入结果 -->
        <div v-if="importReport" class="import-report">
          <el-divider>导入结果</el-divider>
          <el-alert
            :type="importReport.created + importReport.updated > 0 ? 'success' : 'warning'"
            :closable="false"
            show-icon
          >
            <template #title>
              新增 {{ importReport.created }} 台 · 更新 {{ importReport.updated }} 台 · 生成 {{ importReport.records }} 条维保记录
            </template>
            <div v-if="importReport.skipped" class="report-line">
              跳过 {{ importReport.skipped }} 行（缺少设备名称）
            </div>
          </el-alert>
          <el-button
            v-if="importReport.equipmentNames.length"
            type="primary"
            link
            style="margin-top: 8px"
            @click="$router.push('/equipment')"
          >
            去设备台账查看 {{ importReport.equipmentNames.length }} 台设备 →
          </el-button>
        </div>
      </el-card>
    </el-col>

    <!-- 右侧：解析结果 -->
    <el-col :span="14">
      <el-card>
        <template #header>
          <div class="card-header">
            <span><el-icon><List /></el-icon> 智能解析结果</span>
            <div v-if="mergedResult">
              <el-button type="success" size="small" :loading="importing" @click="importToLedger">
                <el-icon><Upload /></el-icon> 导入设备台账
              </el-button>
              <el-button type="primary" size="small" @click="exportExcelJSON">
                <el-icon><Download /></el-icon> 导出 JSON
              </el-button>
            </div>
          </div>
        </template>

        <div v-if="!mergedResult" class="empty-state">
          <el-empty description="请导入 Excel 文件查看解析结果">
            <template #image>
              <el-icon :size="80" color="var(--line-strong)"><Document /></el-icon>
            </template>
          </el-empty>
        </div>

        <div v-else>
          <!-- 数据质量报告：导入前先看清脏在哪 -->
          <div class="quality-report">
            <h4>
              <el-icon><DataAnalysis /></el-icon> 数据质量体检
              <span class="mapping-hint">（导入台账前先看这一份）</span>
            </h4>
            <div class="quality-grid">
              <div class="quality-item">
                <div class="q-value">{{ qualityReport.sourceCount }}</div>
                <div class="q-label">来源文件</div>
              </div>
              <div class="quality-item">
                <div class="q-value">{{ qualityReport.rawRows }}</div>
                <div class="q-label">原始数据行</div>
              </div>
              <div class="quality-item">
                <div class="q-value">{{ qualityReport.uniqueNames }}</div>
                <div class="q-label">去重后设备</div>
              </div>
              <div class="quality-item">
                <div class="q-value">{{ qualityReport.fieldNames }}</div>
                <div class="q-label">识别到不同字段名</div>
              </div>
              <div class="quality-item" :class="{ warn: qualityReport.mergedFields > 0 }">
                <div class="q-value">{{ qualityReport.mergedFields }}</div>
                <div class="q-label">需合并的同义字段</div>
              </div>
              <div class="quality-item" :class="{ danger: qualityReport.missingName > 0 }">
                <div class="q-value">{{ qualityReport.missingName }}</div>
                <div class="q-label">无设备名（将跳过）</div>
              </div>
            </div>
            <div class="quality-detail">
              <span class="detail-title">字段归并：</span>
              <span v-for="(item, i) in qualityReport.mergedList" :key="i" class="merge-chip">
                {{ item.originals.join(' / ') }} → <strong>{{ item.standard }}</strong>
              </span>
            </div>
          </div>

          <!-- 效率对比：系统耗时是实测值，人工耗时按"每行约 30 秒手工录入"估算 -->
          <div class="efficiency-card">
            <div class="efficiency-title">
              <el-icon><Timer /></el-icon> 这次导入的效率对比
            </div>
            <div class="efficiency-body">
              <div class="eff-item manual">
                <div class="eff-value">{{ manualEstimate }}</div>
                <div class="eff-label">人工整理录入<br><small>按每行约 30 秒估算</small></div>
              </div>
              <div class="eff-arrow">
                <el-icon :size="22"><Right /></el-icon>
              </div>
              <div class="eff-item system">
                <div class="eff-value">{{ analysisElapsed }}</div>
                <div class="eff-label">
                  {{ usingDemoData ? '系统处理耗时' : '矿山智工实测耗时' }}
                  <br><small>{{ usingDemoData ? '（演示数据在内存中，导入真实文件时计时更直观）' : '解析 + 字段归一 + 合并 + 入库' }}</small>
                </div>
              </div>
            </div>
            <div class="efficiency-note">
              本次处理 {{ qualityReport.rawRows }} 行数据、{{ qualityReport.sourceCount }} 个来源文件、
              {{ qualityReport.fieldNames }} 个不同字段名，全部在本地完成，未联网。
            </div>
          </div>

          <!-- 数据来源对比 -->
          <div class="source-comparison">
            <h4>多源数据智能合并</h4>
            <div class="source-files">
              <div v-for="(file, i) in importedFiles" :key="i" class="source-file">
                <div class="source-header">
                  <el-icon color="var(--accent)"><Document /></el-icon>
                  <span>{{ file.filename }}</span>
                </div>
                <div class="source-headers">
                  <el-tag
                    v-for="h in file.sheets[0]?.headers?.slice(0, 4)"
                    :key="h"
                    size="small"
                    type="info"
                    effect="plain"
                  >{{ h }}</el-tag>
                  <el-tag v-if="(file.sheets[0]?.headers?.length || 0) > 4" size="small" type="info" effect="plain">
                    +{{ file.sheets[0].headers.length - 4 }}
                  </el-tag>
                </div>
              </div>
            </div>
          </div>

          <!-- 字段映射展示 -->
          <div class="mapping-section">
            <h4>字段智能映射 <span class="mapping-hint">（不同部门的字段名 → 统一标准字段）</span></h4>
            <div class="mapping-tags">
              <el-tag
                v-for="(standard, original) in allExcelMappings"
                :key="original"
                :type="standard === original ? 'info' : 'success'"
                class="mapping-tag"
              >
                {{ original }}
                <el-icon><Right /></el-icon>
                {{ standard }}
              </el-tag>
            </div>
          </div>

          <!-- 数据表格 -->
          <el-table
            :data="paginatedExcelRows"
            stripe
            border
            style="width: 100%; margin-top: 16px"
            max-height="350"
          >
            <el-table-column
              v-for="header in mergedResult.headers"
              :key="header"
              :prop="header"
              :label="header"
              min-width="120"
              show-overflow-tooltip
            />
          </el-table>

          <el-pagination
            v-if="mergedResult.totalRows > excelPageSize"
            v-model:current-page="excelCurrentPage"
            :page-size="excelPageSize"
            :total="mergedResult.totalRows"
            layout="total, prev, pager, next"
            style="margin-top: 16px; justify-content: center"
          />
        </div>
      </el-card>
    </el-col>
  </el-row>
</template>

<script setup>
/**
 * Excel 智能解析面板
 *
 * 为什么从 AIAssistant.vue 里拆出来：
 *   这个页面的两个页签本来是两套完全无关的东西 —— 左边是对话，右边是数据导入。
 *   合成一个 2400 行的组件后，两边的状态、计算属性、样式全挤在一个作用域里：
 *   改 Excel 的解析逻辑时，得先在一堆聊天相关的 ref 里找到那十来个属于自己的。
 *   拆开之后，本文件就是"从文件 → 质量体检 → 导入台账"这一条链路的全部。
 *
 * 自己持有全部 Excel 状态（不再由父组件传入）：
 *   导入的文件、解析结果、导入报告、耗时都只在这里用，父组件从不读它们。
 *   若挂在父组件再往下传，等于把已经分离开的状态又缝回去。
 */
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { parseExcelFile, mergeExcelResults, generateSampleData } from '../utils/excelParser'
import { useAppStore } from '../stores/appStore'

const store = useAppStore()

const isExcelDragover = ref(false)
const importedFiles = ref([])
const mergedResult = ref(null)
const excelFileInput = ref(null)
const excelCurrentPage = ref(1)
const excelPageSize = 20
const importing = ref(false)
const importReport = ref(null)
/** 系统实测耗时（毫秒），0 表示还没跑过 */
const analysisMs = ref(0)

/**
 * 打开文件选择框
 *
 * 走函数而不是模板里的 `$refs.excelFileInput`：`<script setup>` 下的模板 ref
 * 绑定的是同名变量，是否同时出现在 `$refs` 上属于实现细节，不该依赖。
 */
function openFilePicker() {
  excelFileInput.value?.click()
}

const allExcelMappings = computed(() => {
  if (!mergedResult.value) return {}
  const mappings = {}
  for (const file of importedFiles.value) {
    for (const sheet of file.sheets) {
      Object.entries(sheet.headerMapping).forEach(([original, standard]) => {
        mappings[original] = standard
      })
    }
  }
  return mappings
})

/** 数据质量体检：把"多部门表格有多脏"量化出来 */
const qualityReport = computed(() => {
  if (!mergedResult.value) {
    return { sourceCount: 0, rawRows: 0, uniqueNames: 0, fieldNames: 0, mergedFields: 0, missingName: 0, mergedList: [] }
  }

  const mapping = allExcelMappings.value
  const originals = Object.keys(mapping)

  // 同一个标准字段被多少个不同原名指向 = 需要归并的同义字段
  const byStandard = {}
  for (const [original, standard] of Object.entries(mapping)) {
    if (original === standard) continue
    if (!byStandard[standard]) byStandard[standard] = []
    byStandard[standard].push(original)
  }

  const mergedList = Object.entries(byStandard)
    .filter(([, list]) => list.length > 0)
    .map(([standard, list]) => ({ standard, originals: list }))

  const rows = mergedResult.value.rows || []
  const names = new Set()
  let missingName = 0
  for (const row of rows) {
    const name = String(row['设备名称'] ?? '').trim()
    if (name) names.add(name)
    else missingName++
  }

  return {
    sourceCount: mergedResult.value.sourceCount,
    rawRows: rows.length,
    uniqueNames: names.size,
    fieldNames: originals.length,
    mergedFields: mergedList.length,
    missingName,
    mergedList
  }
})

/** 人工对照：按"每行 30 秒手工录入"这一保守口径估算 */
const manualEstimate = computed(() => {
  const rows = qualityReport.value.rawRows
  if (!rows) return '—'
  const minutes = Math.round((rows * 30) / 60)
  if (minutes < 60) return `约 ${minutes} 分钟`
  const hours = minutes / 60
  return `约 ${hours >= 10 ? Math.round(hours) : hours.toFixed(1)} 小时`
})

/** 系统实测耗时（解析 + 字段归一 + 合并的真实计时） */
const analysisElapsed = computed(() => {
  if (!analysisMs.value) return '—'
  if (analysisMs.value < 1) return '< 1 毫秒'
  if (analysisMs.value < 1000) return `${Math.round(analysisMs.value)} 毫秒`
  return `${(analysisMs.value / 1000).toFixed(2)} 秒`
})

/** 演示数据走内存，耗时统计意义不大，单独说明 */
const usingDemoData = computed(() =>
  importedFiles.value.length > 0 && importedFiles.value.every(f => String(f.filename).includes('部门_'))
)

const paginatedExcelRows = computed(() => {
  if (!mergedResult.value) return []
  const start = (excelCurrentPage.value - 1) * excelPageSize
  return mergedResult.value.rows.slice(start, start + excelPageSize)
})

function handleExcelFileSelect(e) {
  const files = Array.from(e.target.files)
  processExcelFiles(files)
  e.target.value = ''
}

function handleExcelDrop(e) {
  isExcelDragover.value = false
  const files = Array.from(e.dataTransfer.files).filter(f =>
    f.name.endsWith('.xlsx') || f.name.endsWith('.xls') || f.name.endsWith('.csv')
  )
  if (files.length === 0) {
    ElMessage.warning('请拖入 Excel 文件 (.xlsx/.xls/.csv)')
    return
  }
  processExcelFiles(files)
}

async function processExcelFiles(files) {
  const startedAt = performance.now()
  for (const file of files) {
    try {
      const result = await parseExcelFile(file)
      importedFiles.value.push(result)
      ElMessage.success(`"${file.name}" 解析成功`)
    } catch (error) {
      ElMessage.error(`"${file.name}" 解析失败: ${error.message}`)
    }
  }
  updateMergedResult()
  analysisMs.value = performance.now() - startedAt
}

function removeExcelFile(index) {
  importedFiles.value.splice(index, 1)
  updateMergedResult()
}

function updateMergedResult() {
  if (importedFiles.value.length === 0) {
    mergedResult.value = null
    importReport.value = null
    return
  }
  mergedResult.value = mergeExcelResults(importedFiles.value)
  excelCurrentPage.value = 1
  importReport.value = null
}

function loadExcelDemo() {
  const startedAt = performance.now()
  importedFiles.value = generateSampleData()
  updateMergedResult()
  analysisMs.value = performance.now() - startedAt
  ElMessage.success('演示数据加载成功，展示了 5 个部门的混乱 Excel 表格')
}

/** 核心闭环：把解析结果真正写进设备台账与维保记录 */
function importToLedger() {
  if (!mergedResult.value) return
  importing.value = true
  try {
    const report = store.importFromExcel(mergedResult.value.rows)
    importReport.value = report
    if (report.created + report.updated === 0) {
      ElMessage.warning('没有可导入的数据行，请检查表格中是否有「设备名称」列')
    } else {
      ElMessage.success(`已导入台账：新增 ${report.created} 台 / 更新 ${report.updated} 台 / 维保记录 ${report.records} 条`)
    }
  } catch (error) {
    ElMessage.error(`导入失败：${error.message}`)
  } finally {
    importing.value = false
  }
}

function exportExcelJSON() {
  if (!mergedResult.value) return
  const blob = new Blob([JSON.stringify(mergedResult.value.rows, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = '矿山智工_数据导入.json'
  a.click()
  URL.revokeObjectURL(url)
  ElMessage.success('JSON 导出成功')
}
</script>

<style scoped>
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* Excel 解析样式 */
.upload-area {
  border: 2px dashed var(--line-strong);
  border-radius: 12px;
  padding: 48px 24px;
  text-align: center;
  cursor: pointer;
  transition: all 0.3s;
  background: var(--card-2);
}

.upload-area:hover,
.upload-area.is-dragover {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.upload-text {
  font-size: 16px;
  color: var(--text-2);
  margin: 12px 0 4px;
}

.upload-hint {
  font-size: 13px;
  color: var(--text-mute);
}

.file-list {
  margin-top: 16px;
}

.file-list-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
  margin-bottom: 8px;
}

.file-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--line-2);
  border-radius: 6px;
  margin-bottom: 6px;
}

.file-name {
  flex: 1;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.parse-stats {
  margin-top: 16px;
}

/* 数据质量体检 */
.quality-report {
  padding: 14px 16px;
  margin-bottom: 16px;
  background: var(--card-2);
  border-radius: 10px;
  border: 1px solid var(--line);
}

.quality-report h4 {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  color: var(--text-1);
  margin-bottom: 12px;
}

.quality-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 8px;
}

.quality-item {
  text-align: center;
  padding: 10px 4px;
  background: #fff;
  border-radius: 8px;
  border: 1px solid var(--line-2);
}

.quality-item.warn {
  border-color: var(--amber-soft);
  background: var(--amber-soft);
}

.quality-item.danger {
  border-color: var(--danger-line);
  background: var(--danger-soft);
}

.q-value {
  font-size: 20px;
  font-weight: 800;
  color: var(--text-1);
}

.quality-item.warn .q-value { color: var(--warn-ink); }
.quality-item.danger .q-value { color: var(--danger-ink); }

.q-label {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
}

.quality-detail {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.quality-detail .detail-title {
  font-size: 12px;
  color: var(--text-3);
}

.merge-chip {
  font-size: 11px;
  padding: 2px 8px;
  background: var(--accent-soft);
  color: var(--accent);
  border-radius: 10px;
}

/* 导入结果 */
.import-report {
  margin-top: 16px;
}

.report-line {
  font-size: 12px;
  margin-top: 4px;
}

/* 效率对比 */
.efficiency-card {
  margin-bottom: 16px;
  padding: 14px 16px;
  border-radius: 10px;
  background: linear-gradient(135deg, var(--accent-soft), var(--emerald-soft));
  border: 1px solid var(--accent-line);
}

.efficiency-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
  margin-bottom: 12px;
}

.efficiency-body {
  display: flex;
  align-items: center;
  justify-content: space-around;
  gap: 8px;
}

.eff-item {
  text-align: center;
  flex: 1;
}

.eff-value {
  font-size: 24px;
  font-weight: 800;
  line-height: 1.2;
}

.eff-item.manual .eff-value { color: var(--danger-ink); }
.eff-item.system .eff-value { color: var(--success-ink); }

.eff-label {
  font-size: 12px;
  color: var(--text-2);
  margin-top: 4px;
  line-height: 1.5;
}

.eff-label small {
  color: var(--text-3);
  font-size: 11px;
}

.eff-arrow {
  color: var(--accent);
  flex-shrink: 0;
}

.efficiency-note {
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-3);
  text-align: center;
  line-height: 1.6;
}

.source-comparison {
  margin-bottom: 16px;
}

.source-comparison h4 {
  font-size: 14px;
  color: var(--text-1);
  margin-bottom: 10px;
}

.source-files {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.source-file {
  flex: 1;
  min-width: 180px;
  padding: 10px 12px;
  background: var(--line-2);
  border-radius: 8px;
  border: 1px solid var(--line);
}

.source-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1);
  margin-bottom: 8px;
}

.source-headers {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.mapping-section h4 {
  font-size: 14px;
  color: var(--text-1);
  margin-bottom: 8px;
}

.mapping-hint {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-3);
}

.mapping-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.mapping-tag {
  font-size: 12px;
}

.empty-state {
  padding: 40px 0;
}
</style>
