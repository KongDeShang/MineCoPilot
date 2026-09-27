<template>
  <div class="logs-page">
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span><el-icon><List /></el-icon> 操作日志（全量留痕）</span>
          <div class="logs-filter">
            <el-select v-model="sourceFilter" size="small" style="width: 130px" clearable placeholder="全部来源">
              <el-option v-for="s in sources" :key="s" :label="s" :value="s" />
            </el-select>
            <el-tag size="small" type="info" effect="plain">共 {{ filteredLogs.length }} 条</el-tag>
          </div>
        </div>
      </template>

      <el-timeline v-if="filteredLogs.length">
        <el-timeline-item
          v-for="(log, i) in filteredLogs"
          :key="i"
          :timestamp="log.time"
          :type="log.type"
          placement="top"
        >
          <div class="log-row">
            <el-tag :type="log.tagType" size="small" effect="plain">{{ log.source }}</el-tag>
            <span class="log-content">{{ log.content }}</span>
            <!-- 操作人（P4-3）。空的时候显示「未署名」而不是干脆不显示：
                 两种写法看着都不刺眼，但意思完全不同 —— 不显示等于这条图省事、
                 看的人根本不知道还有"谁操作"这一栏；显示「未署名」才是如实的
                 "这条没记到人"（老库里的历史日志、以及随包演示数据都是这一种）。 -->
            <el-tooltip
              :content="log.actor
                ? `这条记录是以「${log.actor}」的身份操作产生的`
                : '这条记录产生时没有解锁身份（当时未启用应用锁，或是随包自带的演示数据）'"
              placement="top"
            >
              <span class="log-actor">
                <el-icon><User /></el-icon>{{ log.actor || '未署名' }}
              </span>
            </el-tooltip>
          </div>
        </el-timeline-item>
      </el-timeline>
      <el-empty v-else description="暂无操作记录" />

      <div class="logs-note">
        每一次体检、工单、复诊、导入、知识库变更都会在这里留痕——这是"可审计 AI"的证据链，演示时可直接点开给评委看。
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useAppStore } from '../stores/appStore'

const store = useAppStore()
const sourceFilter = ref('')

// 来源下拉的选项：日志来源是开放的（静态的有「体检/工单/知识库」等十几种，
// 动态的还有「本地手册 · xxx」这种按文档名生成的），不能截断——
// 原来这里有个 .slice(0, 12)，一旦来源超过 12 种就会有来源在下拉里查不到，
// 而「共 N 条」仍把它们算进去，用户看到数字对不上、又筛不出来。
const sources = computed(() => [...new Set(store.recentLogs.map(l => l.source))])

const filteredLogs = computed(() => {
  const list = store.recentLogs
  return sourceFilter.value ? list.filter(l => l.source === sourceFilter.value) : list
})
</script>

<style scoped>
.logs-page {
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

.logs-filter {
  display: flex;
  align-items: center;
  gap: 8px;
}

.log-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.log-content {
  font-size: 13px;
  color: var(--text-2);
}

/* 操作人靠右，和左边"来源标签 + 内容"分开：一条时间线上扫下来，
   左边看"发生了什么"、右边看"谁干的"，不用从左往右读到底。
   margin-left:auto 在 .log-row 的 flex 里生效，内容长时会被挤到右边换行。 */
.log-actor {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  flex: none;
  font-size: 11.5px;
  color: var(--text-3);
  white-space: nowrap;
}

/* 「未署名」刻意**不再调暗**：本项目没有 --text-4 这档令牌，靠 opacity 压暗会让
   对比度掉到 4.5:1 边缘（白底上是变浅，不是变深），为一句"没有值"的文案冒这个险不值。
   「未署名」三个字本身已经说清了，不靠颜色区分。 */

.logs-note {
  margin-top: 14px;
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.7;
}
</style>
