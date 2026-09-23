<template>
  <div class="dashboard">
    <!-- 首屏信息条（痛点一句话呈现，不做大色块） -->
    <div class="status-strip">
      <div class="strip-item">
        <span class="strip-ico"><el-icon><Money /></el-icon></span>
        <div class="strip-txt">
          <b>预计停机损失 {{ lossLabel }}</b>
          <span>D 级设备逐台现算</span>
        </div>
      </div>
      <div class="strip-item warn">
        <span class="strip-ico"><el-icon><WarningFilled /></el-icon></span>
        <div class="strip-txt">
          <b>{{ store.criticalList.length }} 台需立即处置</b>
          <span>{{ store.overdueList.length }} 台维保超期</span>
        </div>
      </div>
      <div class="strip-item safe">
        <span class="strip-ico"><el-icon><Lock /></el-icon></span>
        <div class="strip-txt">
          <b>数据本地不出网</b>
          <span>规则引擎实时计算</span>
        </div>
      </div>
      <div class="strip-action">
        <el-button type="primary" size="small" @click="generateWeeklyReport">
          <el-icon><Document /></el-icon> AI 一键周报
        </el-button>
      </div>
    </div>

    <!-- 数据洞察卡（自动分析核心指标） -->
    <div class="insight-grid">
      <InsightCard
        v-for="(card, i) in insights"
        :key="i"
        :icon="card.icon"
        :label="card.label"
        :value="card.value"
        :level="card.level"
        :advice="card.advice"
        :detail="card.detail"
        :raw="card.raw"
      />
    </div>

    <!-- 预警摘要条（规则引擎驱动） -->
    <div v-if="alertSummary.total > 0" class="alert-summary-strip">
      <div class="alert-summary-content">
        <el-icon><WarningFilled /></el-icon>
        <span>
          <b>{{ alertSummary.critical }}</b> 条严重预警 ·
          <b>{{ alertSummary.warning }}</b> 条注意 ·
          <b>{{ alertSummary.info }}</b> 条提示
        </span>
        <span class="alert-summary-sep">|</span>
        <span class="alert-summary-tip">{{ alertSummary.topSuggestions[0] || '' }}</span>
      </div>
      <!-- 原先跳的是 /alerts，但路由表里只有 /alert-center，也没有兜底路由，
           点一下内容区就整块变白，用户只能自己猜。 -->
      <el-button size="small" type="warning" plain @click="router.push('/alert-center')">
        查看全部
      </el-button>
    </div>

    <!-- 健康等级分布（A/B/C/D，设备当病人管的第一眼） -->
    <el-card shadow="never" class="health-dist-card">
      <div class="health-dist">
        <div class="hd-head">
          <span class="hd-title"><el-icon><FirstAidKit /></el-icon> 健康等级分布</span>
          <span class="hd-sub">健康分 ≥{{ store.settings?.bounds?.A ?? 85 }} 为 A 级 · 当前 {{ store.equipmentList.length }} 台</span>
        </div>
        <div class="hd-bar">
          <div
            v-for="seg in healthSegments"
            :key="seg.level"
            class="hd-seg"
            :style="{ width: (entered ? (seg.pct || 0) : 0) + '%', background: seg.color }"
            :title="`${seg.level} 级 ${seg.count} 台`"
          ></div>
        </div>
        <div class="hd-legend">
          <span v-for="seg in healthSegments" :key="seg.level" class="hd-legend-item">
            <i class="hd-dot" :style="{ background: seg.color }"></i>
            {{ seg.level }} 级 {{ seg.count }} 台 · {{ seg.pct }}%
          </span>
        </div>
      </div>
    </el-card>

    <!-- 重点关注设备（D 级 / 超期 45 天以上，带照片） -->
    <el-card v-if="focusEquipments.length" shadow="never" class="focus-card">
      <template #header>
        <div class="card-header">
          <span><el-icon><Warning /></el-icon> 重点关注设备</span>
          <span class="focus-sub">按健康分升序 · 点击进入设备画像</span>
        </div>
      </template>
      <div class="focus-grid">
        <div v-for="eq in focusEquipments" :key="eq.id" class="focus-item" @click="goEquipment(eq.id)">
          <div class="focus-photo">
            <img :src="equipmentPhoto(eq.category)" :alt="eq.name" loading="lazy" />
            <span class="focus-level" :class="'lv-' + eq.health.level.toLowerCase()">{{ eq.health.level }} 级</span>
          </div>
          <div class="focus-body">
            <div class="focus-name">{{ eq.name }} <span class="focus-model">{{ eq.model }}</span></div>
            <div class="focus-meta">
              <span class="focus-score" :class="'lv-' + eq.health.level.toLowerCase()">健康分 {{ eq.health.score }}</span>
              <el-tag :type="eq.status === 'fault' ? 'danger' : eq.status === 'maintenance' ? 'warning' : 'info'" size="small">
                {{ eq.status === 'fault' ? '故障' : eq.status === 'maintenance' ? '维保中' : eq.status === 'idle' ? '闲置' : '运行中' }}
              </el-tag>
            </div>
            <div class="focus-reason">{{ eq.reason }}</div>
          </div>
        </div>
      </div>
    </el-card>

    <!-- 中间：统计卡片 + 饼图 -->
    <el-row :gutter="20" style="margin-top: 20px">
      <!-- 左侧：4个统计卡片 -->
      <el-col :span="14">
        <el-row :gutter="16">
          <el-col :span="12" v-for="(card, i) in statCards" :key="i" style="margin-bottom: 16px">
            <el-card shadow="hover" class="stat-card">
              <div class="stat-icon" :style="{ background: card.bg }">
                <el-icon :size="28"><component :is="card.icon" /></el-icon>
              </div>
              <div class="stat-info">
                <div class="stat-value"><AnimatedNumber :value="card.value" /></div>
                <div class="stat-label">{{ card.label }}</div>
              </div>
              <div class="stat-trend" :class="card.trendType">
                <el-icon><component :is="card.trendIcon" /></el-icon>
                {{ card.trend }}
              </div>
            </el-card>
          </el-col>
        </el-row>
      </el-col>

      <!-- 右侧：设备状态饼图 -->
      <el-col :span="10">
        <el-card class="chart-card">
          <template #header>
            <span><el-icon><PieChart /></el-icon> 设备状态分布</span>
          </template>
          <div class="pie-chart">
            <svg viewBox="0 0 200 200" class="pie-svg">
              <!-- 饼图 -->
              <circle v-for="(seg, i) in pieSegments" :key="i"
                class="pie-arc"
                cx="100" cy="100" r="80"
                fill="none"
                stroke-width="32"
                :stroke-dasharray="entered ? seg.dasharray : '0 ' + PIE_CIRCUMFERENCE"
                :stroke-dashoffset="seg.offset"
                :style="{ stroke: seg.color, transitionDelay: (i * 0.12) + 's' }"
              />
              <!-- 中心文字 -->
              <text x="100" y="92" text-anchor="middle" class="pie-center-num">{{ stats.equipmentCount }}</text>
              <text x="100" y="112" text-anchor="middle" class="pie-center-label">设备总数</text>
            </svg>
            <!-- 图例 -->
            <div class="pie-legend">
              <div v-for="(item, i) in statusLegend" :key="i" class="legend-item">
                <span class="legend-dot" :style="{ background: item.color }"></span>
                <span class="legend-name">{{ item.name }}</span>
                <span class="legend-count">{{ item.count }}台</span>
              </div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 下方：今日待办 + 维保趋势 + 维保提醒 -->
    <el-row :gutter="20" style="margin-top: 20px">
      <!-- 左侧：今日待办 -->
      <el-col :span="8">
        <el-card>
          <template #header>
            <div class="card-header">
              <span><el-icon><Calendar /></el-icon> 今日待办</span>
              <el-badge :value="todoList.length" type="danger"></el-badge>
            </div>
          </template>
          <div class="todo-list">
            <template v-if="todoList.length > 0">
              <div v-for="(item, i) in todoList" :key="i" class="todo-item" :class="item.level">
                <div class="todo-priority" :class="item.level"></div>
                <div class="todo-content">
                  <div class="todo-title">{{ item.title }}</div>
                  <div class="todo-meta">{{ item.meta }}</div>
                </div>
                <el-button size="small" type="primary" link @click="gotoEquipment(item)">处理</el-button>
              </div>
            </template>
            <div v-else class="empty-inline">
              <el-icon :size="32" color="var(--text-mute)"><CircleCheck /></el-icon>
              <p>今日无待办事项</p>
            </div>
          </div>
        </el-card>
      </el-col>

      <!-- 中间：维保趋势 -->
      <el-col :span="8">
        <el-card>
          <template #header>
            <span><el-icon><TrendCharts /></el-icon> 维保执行趋势</span>
          </template>
          <!-- 趋势图交给 ECharts（异步引入，echarts 单独成一个 chunk）。
               原来那排 div 柱子只能用眼睛比高低，悬停问不出准确数字；
               数据源没变，仍是下面这个 trendData。 -->
          <div class="trend-chart">
            <TrendChart :data="trendData" />
          </div>
        </el-card>
      </el-col>

      <!-- 右侧：维保超期提醒 -->
      <el-col :span="8">
        <el-card>
          <template #header>
            <div class="card-header">
              <span><el-icon><Bell /></el-icon> 维保超期提醒</span>
              <el-tag type="danger" effect="dark" size="small" v-if="overdueList.length">
                {{ overdueList.length }} 台超期
              </el-tag>
            </div>
          </template>
          <div class="overdue-list">
            <template v-if="overdueList.length > 0">
              <div v-for="(item, i) in overdueList" :key="i" class="overdue-item">
                <div class="overdue-status" :class="item.level"></div>
                <div class="overdue-info">
                  <div class="overdue-name">{{ item.name }}</div>
                  <div class="overdue-detail">{{ item.model }} · {{ item.location }}</div>
                </div>
                <div class="overdue-days">
                  <span class="days-num">{{ item.overdueDays }}</span>
                  <span class="days-unit">天</span>
                </div>
              </div>
            </template>
            <div v-else class="empty-inline">
              <el-icon :size="32" color="var(--emerald)"><CircleCheck /></el-icon>
              <p style="color: var(--success-ink)">所有设备维保正常</p>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 高频故障 TOP（数据沉淀 → 反哺：自动分类，可点开原文） -->
    <el-card style="margin-top: 20px" class="fault-card">
      <template #header>
        <div class="card-header">
          <span><el-icon><DataAnalysis /></el-icon> 高频故障 TOP</span>
          <el-tag size="small" type="info" effect="plain">
            自动沉淀 · 样本 {{ faultTop.total }} 条
          </el-tag>
        </div>
      </template>
      <div class="fault-bars">
        <div v-for="(item, i) in faultTop.top" :key="item.system"
          class="fault-row" :class="{ active: expandedFault && expandedFault.system === item.system }"
          @click="toggleFaultDetail(item)">
          <div class="fault-rank" :class="'rank-' + (i + 1)">{{ i + 1 }}</div>
          <div class="fault-system">{{ item.system }}</div>
          <div class="fault-bar-wrap">
            <div class="fault-bar" :style="{ width: (entered ? faultWidth(item.percent, faultTop.top[0].percent) : 0) + '%', background: faultColor(i) }"></div>
          </div>
          <div class="fault-count">{{ item.count }} 次</div>
          <div class="fault-percent">{{ item.percent }}%</div>
          <el-icon class="fault-arrow"><ArrowDown /></el-icon>
        </div>
      </div>
      <div class="fault-note">
        数据来自本地 {{ faultTop.total }} 条维修记录（工单 + 维保记录），按故障描述自动归类；
        点击任一行可展开原始记录，每条都可追溯到工单/维保原文。
      </div>
      <div v-if="expandedFault" class="fault-samples">
        <div class="fault-sample-head">
          <strong>{{ expandedFault.system }}</strong> 共 {{ expandedFault.count }} 条原文
          <el-button size="small" link type="primary" @click.stop="expandedFault = null">收起</el-button>
        </div>
        <div v-for="(sample, si) in expandedFault.samples.slice(0, 6)" :key="si" class="fault-sample">
          <el-tag size="small" :type="sample.source === '工单' ? 'warning' : 'info'" effect="plain">
            {{ sample.source }}
          </el-tag>
          <span class="fault-sample-text">{{ sample.title }}</span>
          <span class="fault-sample-meta">
            {{ sample.equipmentName }}{{ (sample.equipmentName && sample.date) ? ' · ' : '' }}{{ sample.date }}
          </span>
        </div>
        <div v-if="expandedFault.samples.length > 6" class="fault-more">
          其余 {{ expandedFault.samples.length - 6 }} 条记录可到工单页/设备病历中查看
        </div>
      </div>
    </el-card>

    <!-- 进化层：复诊闭环 + 健康恶化预警 + 品牌分布 -->
    <el-row :gutter="20" style="margin-top: 20px">
      <!-- 复诊闭环率 -->
      <el-col :span="8">
        <el-card class="closing-card">
          <template #header>
            <div class="card-header">
              <span><el-icon><Refresh /></el-icon> 复诊闭环率</span>
              <el-tag size="small" type="info" effect="plain">处方后是否真的复查</el-tag>
            </div>
          </template>
          <div class="closing-body">
            <div class="closing-ring">
              <!-- 真圆弧：原来 `border: 4px solid` 画的是整圈同色的假环，87% 和 12%
                   看起来完全一样。外径仍是 84px（r=38 + 线宽 4），尺寸和原来一致。 -->
              <svg class="closing-svg" viewBox="0 0 84 84" aria-hidden="true">
                <circle class="closing-track" cx="42" cy="42" r="38" fill="none" stroke-width="4" />
                <circle
                  class="closing-arc"
                  cx="42" cy="42" r="38"
                  fill="none"
                  stroke-width="4"
                  :stroke-dasharray="`${entered ? closingArc : 0} ${RING_CIRCUMFERENCE}`"
                  :style="{ stroke: closingColor }"
                />
              </svg>
              <span class="closing-num" :style="{ color: closingColor }">
                {{ recheck.rate === null ? '—' : recheck.rate + '%' }}
              </span>
            </div>
            <div class="closing-info">
              <div class="closing-line">应复诊 <strong>{{ recheck.due }}</strong> 项，已复诊 <strong>{{ recheck.done }}</strong> 项</div>
              <div class="closing-line warn" v-if="recheck.pending">待复诊 <strong>{{ recheck.pending }}</strong> 项</div>
              <div class="closing-note">工单完成后自动生成复诊任务（维修 7 天 / 保养 30 天）</div>
            </div>
          </div>
          <div v-if="recheckList.length" class="recheck-list">
            <div v-for="item in recheckList.slice(0, 3)" :key="item.id" class="recheck-item">
              <div class="recheck-info">
                <div class="recheck-title">{{ item.title }}</div>
                <div class="recheck-meta">{{ item.equipment_name }} · 应复诊 {{ item.recheck_date }}</div>
              </div>
              <el-button type="success" size="small" link @click="doRecheck(item)">标记复诊</el-button>
            </div>
          </div>
        </el-card>
      </el-col>

      <!-- 健康恶化预警 -->
      <el-col :span="8">
        <el-card>
          <template #header>
            <div class="card-header">
              <span><el-icon><TrendCharts /></el-icon> 健康恶化预警</span>
              <el-tag v-if="worseningList.length" type="danger" size="small" effect="dark">
                {{ worseningList.length }} 台
              </el-tag>
            </div>
          </template>
          <template v-if="worseningList.length">
            <div v-for="item in worseningList.slice(0, 4)" :key="item.id" class="worsen-item" @click="goEquipment(item)">
              <div class="worsen-score" :class="'lv-' + item.health.level.toLowerCase()">{{ item.health.score }}</div>
              <div class="worsen-info">
                <div class="worsen-name">{{ item.name }}</div>
                <div class="worsen-meta">{{ item.trend.summary }}</div>
              </div>
              <el-icon class="worsen-arrow"><ArrowRight /></el-icon>
            </div>
            <div class="worsen-note">连续下降意味着设备在"趴窝前"就已经在退化——提前介入比抢修便宜得多</div>
          </template>
          <div v-else class="empty-inline">
            <el-icon :size="32" color="var(--emerald)"><CircleCheck /></el-icon>
            <p style="color: var(--success-ink)">暂无健康分持续下降的设备</p>
          </div>
        </el-card>
      </el-col>

      <!-- 在管设备品牌分布 -->
      <el-col :span="8">
        <el-card>
          <template #header>
            <div class="card-header">
              <span><el-icon><SetUp /></el-icon> 在管设备品牌分布</span>
              <el-tag size="small" type="info" effect="plain">不挑品牌</el-tag>
            </div>
          </template>
          <div class="brand-list">
            <div v-for="item in brandStats" :key="item.brand" class="brand-item">
              <span class="brand-name">{{ item.brand }}</span>
              <div class="brand-bar">
                <div class="brand-bar-fill" :style="{ width: (entered ? brandPercent(item.count) : 0) + '%' }"></div>
              </div>
              <span class="brand-count">{{ item.count }} 台</span>
            </div>
          </div>
          <div class="worsen-note">
            系统按设备台账管理，无论品牌与型号——真实矿山的车队本来就是混编的。
          </div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 最近操作记录 -->
    <el-card style="margin-top: 20px">
      <template #header>
        <span><el-icon><Clock /></el-icon> 最近操作</span>
      </template>
      <el-timeline>
        <el-timeline-item
          v-for="(log, i) in recentLogs"
          :key="i"
          :timestamp="log.time"
          :type="log.type"
          placement="top"
        >
          <div class="log-content">
            <el-tag :type="log.tagType" size="small" effect="plain">{{ log.source }}</el-tag>
            {{ log.content }}
          </div>
        </el-timeline-item>
      </el-timeline>
    </el-card>
  </div>
</template>

<script setup>
import { computed, defineAsyncComponent, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAppStore } from '../stores/appStore'
import { estimateLoss, evaluateHealth, RISK_LEVELS } from '../utils/health'
import { equipmentPhoto } from '../utils/equipmentPhoto'
import { generateReport } from '../utils/reportGenerator'
import { now } from '../utils/dates'
import AnimatedNumber from '../components/AnimatedNumber.vue'
import InsightCard from '../components/InsightCard.vue'
import { buildInsights } from '../utils/insights'
import { getAlertSummary } from '../utils/alertRules'
import { useEnter } from '../utils/motion'

// 异步引入：echarts 体积不小，让它单独成一个 chunk 晚一拍到，
// 看板首屏的文字与卡片先画出来，图表随后自己长出来。
const TrendChart = defineAsyncComponent(() => import('../components/TrendChart.vue'))

const store = useAppStore()
const router = useRouter()

// 设备状态饼的周长。r=80（模板里的 cx/cy/r），SVG 的 stroke-dasharray 按这个值折算。
// 抽成常量是因为入场动画要拿它当"零长度"的起点：`0 <周长>` 表示整圈都藏起来。
const PIE_CIRCUMFERENCE = 2 * Math.PI * 80

// 复诊闭环圆环的周长。原来是 `border: 4px solid` 画的假圆 —— 整圈同色，
// 87% 和 12% 长得一模一样，读者只能靠里面的数字知道进度。改成真的圆弧：
// r=38、线宽 4，外径正好 84px，和原来的占位尺寸一致，不会挤动旁边那列文字。
const RING_CIRCUMFERENCE = 2 * Math.PI * 38

// 本页所有增长动画（.hd-seg / .trend-bar / .brand-bar-fill / .fault-bar）的总开关。
// 这些 class 本来就写了 transition，但数据在挂载前就绪、首帧即终值，所以从来没播过。
// 详见 utils/motion.js 的说明。
const entered = useEnter()

// 统计数据必须包一层 computed。
// Pinia 确实会把 setup store 的 computed 解包，但解包出来的是**取值那一刻的普通对象**——
// `const stats = store.stats` 等于给台账拍了张快照。页面停留期间导入/重置数据，
// 四张统计卡片的数字不会跟着变，看上去就像"操作没生效"（同类问题在工单抽屉里也踩过一次）。
const stats = computed(() => store.stats)

// 数据洞察卡（自动计算核心运营指标）
const insights = computed(() => buildInsights(store))

// 预警规则引擎结果
const alertSummary = computed(() => getAlertSummary(store))

// D 级（需立即处置）设备预计停机损失总额：逐个用 estimateLoss 现算，口径与体检报告同源
const totalLoss = computed(() => {
  let sum = 0
  for (const item of store.criticalList) {
    const loss = estimateLoss(item)
    if (loss && Number.isFinite(loss.estimatedLoss)) sum += loss.estimatedLoss
  }
  return Math.round(sum)
})

const lossLabel = computed(() =>
  totalLoss.value >= 10000
    ? `¥${(totalLoss.value / 10000).toFixed(1)} 万/日`
    : `¥${totalLoss.value.toLocaleString('zh-CN')}/日`
)

/** 重点关注设备：D 级 + 超期 45 天以上，照片墙呈现 */
const focusEquipments = computed(() => {
  const list = []
  for (const e of store.criticalList) {
    const h = evaluateHealth(e)
    const loss = estimateLoss(e)
    list.push({ ...e, health: h, reason: `D 级 · 预计停机损失 ¥${loss && Number.isFinite(loss.estimatedLoss) ? Math.round(loss.estimatedLoss).toLocaleString('zh-CN') : '—'}/日` })
  }
  store.overdueList.filter(e => e.overdueDays > 45).forEach(e => {
    if (!list.some(x => x.id === e.id)) {
      const h = evaluateHealth(e)
      list.push({ ...e, health: h, reason: `维保超期 ${e.overdueDays} 天，需尽快安排进站` })
    }
  })
  return list.slice(0, 4)
})

// AI 一键周报
function generateWeeklyReport() {
  const { data, html } = generateReport(store, 'week')
  ElMessageBox.alert(html, `${data.label} 设备运维周报`, {
    dangerouslyUseHTMLString: true,
    confirmButtonText: '关闭',
    customStyle: { maxWidth: '700px' }
  })
  store.addLog({ content: `从看板生成${data.label}周报`, source: 'AI', type: 'primary', tagType: 'primary' })
}

// 健康等级分布（A/B/C/D，语义色直接取全站唯一的 RISK_LEVELS）
const healthSegments = computed(() => {
  const levels = store.healthLevelStats
  const total = store.equipmentList.length || 1
  return ['A', 'B', 'C', 'D'].map(level => ({
    level,
    count: levels[level] || 0,
    pct: Math.round(((levels[level] || 0) / total) * 100),
    color: RISK_LEVELS[level].color
  }))
})

/** 今日已完成的维保条数（统计卡副文案用，现算而非写死） */
const todayCompletedMaintenance = computed(() => {
  const today = now().slice(0, 10)
  let count = 0
  for (const records of Object.values(store.maintenanceRecords)) {
    for (const r of records || []) if (String(r.date || '').slice(0, 10) === today) count += 1
  }
  return count
})

// 统计卡副文案全部现算：此前是硬编码字符串，其中"92% 可用率"与旁边的"运行中 N 台"直接打架
const statCards = computed(() => {
  const total = stats.value.equipmentCount || 1
  const availability = Math.round((stats.value.runningCount / total) * 100)
  const categories = new Set(store.equipmentList.map(e => e.category).filter(Boolean)).size
  const faultPct = Math.round((stats.value.faultCount / total) * 100)
  return [
    { label: '设备总数', value: stats.value.equipmentCount, icon: 'SetUp', bg: 'var(--accent)', trend: `覆盖 ${categories} 个类别`, trendType: 'flat', trendIcon: 'Right' },
    { label: '运行中', value: stats.value.runningCount, icon: 'CircleCheck', bg: 'var(--emerald)', trend: `${availability}% 可用率`, trendType: availability >= 80 ? 'up' : 'down', trendIcon: availability >= 80 ? 'Top' : 'Bottom' },
    { label: '维保中', value: stats.value.maintenanceCount, icon: 'Warning', bg: 'var(--amber)', trend: `${todayCompletedMaintenance.value} 台今日完成`, trendType: 'flat', trendIcon: 'Right' },
    { label: '故障', value: stats.value.faultCount, icon: 'CircleClose', bg: 'var(--danger)', trend: `占在管设备 ${faultPct}%`, trendType: stats.value.faultCount > 0 ? 'down' : 'flat', trendIcon: stats.value.faultCount > 0 ? 'Bottom' : 'Right' }
  ]
})

// 饼图数据 - 从台账实时计算，四种状态之和等于设备总数
const statusLegend = computed(() => [
  { name: '运行中', count: stats.value.runningCount, color: 'var(--emerald)' },
  { name: '维保中', count: stats.value.maintenanceCount, color: 'var(--amber)' },
  { name: '故障', count: stats.value.faultCount, color: 'var(--danger)' },
  { name: '闲置', count: stats.value.idleCount, color: 'var(--ink-4)' }
].filter(item => item.count > 0))

const pieSegments = computed(() => {
  const total = stats.value.equipmentCount || 1
  const circumference = PIE_CIRCUMFERENCE
  const data = statusLegend.value.map(d => ({ count: d.count, color: d.color }))

  let offset = 0
  return data.map(d => {
    const ratio = d.count / total
    const dasharray = `${ratio * circumference} ${circumference}`
    const currentOffset = -offset * circumference + circumference * 0.25
    offset += ratio
    return { dasharray, offset: currentOffset, color: d.color }
  })
})

// 今日待办 - 超期设备 + 14 天内即将到期设备，全部来自本地数据库计算
const todoList = computed(() => {
  // 带 id 是为了让右侧「处理」按钮能跳到那台设备的画像 —— 原先这里只挑出
  // title/meta/level 三个字段，设备身份被丢掉了，于是按钮没有任何可跳的目标，
  // 连 @click 都没写，是个点了不动的死按钮。
  const items = store.overdueList.map(e => ({
    id: e.id,
    title: `${e.name} 维保超期${e.overdueDays}天`,
    meta: `上次维保: ${e.last_maintenance_date}`,
    level: e.overdueDays > 30 ? 'urgent' : 'high'
  }))
  store.upcomingList.forEach(e => {
    items.push({
      id: e.id,
      title: `${e.name} ${e.daysUntil}天后到期`,
      meta: `到期日: ${e.dueDate}`,
      level: 'normal'
    })
  })
  return items.slice(0, 6)
})

/**
 * 去处理某台设备：跳台账页并直接展开它的画像。
 * 走的是 `?id=` 查询参数 —— 工单页与维保日历早就是这个约定
 * （Equipment.vue 的 openFromQuery 负责认），这里只是把同一个约定接上。
 */
function gotoEquipment(item) {
  router.push({ path: '/equipment', query: { id: item.id } })
}

/**
 * 某月"应做保养次数"：按每台设备自身的维保周期折算到该月天数之和。
 * 这是与台账参数同源的推算值，随设置页改周期实时变化——
 * 不再是一个写死的数组（旧实现把"计划"画成了"完成"，两个序列永远重合）。
 */
function plannedCountOfMonth(daysInMonth) {
  let sum = 0
  for (const eq of store.equipmentList) {
    const cycle = Number(eq.maintenance_cycle_days) || 90
    if (cycle > 0) sum += daysInMonth / cycle
  }
  return Math.round(sum)
}

// 维保执行趋势 - 近 6 个月，完成数与应做数都从真实台账/记录里算
const trendData = computed(() => {
  const months = []
  const base = new Date()
  base.setDate(1)
  for (let i = 5; i >= 0; i--) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1)
    const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
    months.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: `${d.getMonth() + 1}月`,
      plannedNum: plannedCountOfMonth(daysInMonth)
    })
  }

  const actual = {}
  for (const records of Object.values(store.maintenanceRecords)) {
    for (const record of records || []) {
      const key = String(record.date || '').slice(0, 7)
      if (!key) continue
      actual[key] = (actual[key] || 0) + 1
    }
  }

  // 两条序列共用同一个分母，任一序列不越界（旧实现只给完成数加了 100 兜底）
  const scale = Math.max(1, ...months.map(m => Math.max(m.plannedNum, actual[m.key] || 0)))

  return months.map(month => {
    const completedNum = actual[month.key] || 0
    return {
      month: month.label,
      plannedNum: month.plannedNum,
      completedNum,
      planned: Math.min(100, Math.round((month.plannedNum / scale) * 100)),
      completed: Math.min(100, Math.round((completedNum / scale) * 100))
    }
  })
})

// 维保超期 - 直接来自本地数据库计算
const overdueList = computed(() => store.overdueList.map(e => ({
  ...e,
  level: e.overdueDays > 30 ? 'critical' : 'warning'
})))

// 最近操作 - 记录在 store 里，所有导入/建单/查询都会留痕
const recentLogs = computed(() => store.recentLogs)

// ---------- 进化层：复诊闭环 / 健康恶化 / 品牌分布 ----------
const recheck = computed(() => store.recheckStats)
const recheckList = computed(() => store.recheckList)
const worseningList = computed(() => store.worseningList)
const brandStats = computed(() => store.brandStats)

// ---------- 高频故障 TOP（自动沉淀，可点开原文） ----------
const faultTop = computed(() => store.faultTopStats)
const expandedFault = ref(null)

function faultWidth(percent, maxPercent) {
  return Math.max(4, Math.round((percent / (maxPercent || 1)) * 100))
}

function faultColor(i) {
  const colors = ['var(--danger)', 'var(--amber)', 'var(--accent)', 'var(--emerald)', 'var(--ink-4)']
  return colors[i % colors.length]
}

function toggleFaultDetail(item) {
  expandedFault.value = expandedFault.value && expandedFault.value.system === item.system ? null : item
}

// 圆环描边 + 百分比文字，都取 —*-ink（面色在白底只有 2.28~3.26:1）
const closingColor = computed(() => {
  const rate = recheck.value.rate
  if (rate === null) return 'var(--text-mute)'
  if (rate >= 80) return 'var(--success-ink)'
  if (rate >= 50) return 'var(--warn-ink)'
  return 'var(--danger-ink)'
})

// 圆弧要画多长。rate 为 null（还没有应复诊项）时留空环，和原来的 '—' 一致。
// 入场同样走两阶段：先 0 长度，绘制过一帧后再长到目标值。
const closingArc = computed(() => {
  const rate = recheck.value.rate
  if (rate === null) return 0
  return (Math.min(100, Math.max(0, rate)) / 100) * RING_CIRCUMFERENCE
})

function brandPercent(count) {
  const total = stats.value.equipmentCount || 1
  return Math.round((count / total) * 100)
}

function doRecheck(item) {
  store.markRecheckDone(item.id)
  ElMessage.success(`已标记「${item.equipment_name}」复诊完成`)
}

function goEquipment(item) {
  router.push({ path: '/equipment', query: { id: String(item.id) } })
}
</script>

<style scoped>
/* ── 数据洞察卡 ── */
.insight-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin-top: 16px;
}

@media (max-width: 900px) {
  .insight-grid {
    grid-template-columns: 1fr;
  }
}

/* ── 预警摘要条 ── */
.alert-summary-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  padding: 10px 16px;
  background: var(--amber-soft);
  border: 1px solid var(--amber-line);
  border-radius: var(--r-sm);
  font-size: 13px;
  color: var(--text-1);
}

.alert-summary-content {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.alert-summary-content .el-icon {
  color: var(--warn-ink);
  font-size: 16px;
  flex-shrink: 0;
}

.alert-summary-sep {
  /* --text-mute 在 --amber-soft 底上仅 4.33:1，换 --text-3 保证 ≥4.5:1 */
  color: var(--text-3);
}

.alert-summary-tip {
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 健康等级分布条 ── */
.health-dist-card {
  margin-top: 16px;
  border-radius: 13px;
}

.health-dist {
  padding: 2px 0;
}

.hd-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}

.hd-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
  display: flex;
  align-items: center;
  gap: 6px;
}

.hd-sub {
  font-size: 12px;
  color: var(--text-3);
}

.hd-bar {
  display: flex;
  height: 14px;
  border-radius: 7px;
  overflow: hidden;
  background: var(--bg-sunken);
}

.hd-seg {
  height: 100%;
  min-width: 2px;
  transition: width .6s ease;
}

.hd-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 10px;
}

.hd-legend-item {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-3);
}

.hd-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}

/* 统计卡片 */
.stat-card :deep(.el-card__body) {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
}

.stat-icon {
  width: 48px;
  height: 48px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  flex-shrink: 0;
}

.stat-info { flex: 1; }

.stat-value {
  font-size: 26px;
  font-weight: 800;
  color: var(--text-1);
}

.stat-label {
  font-size: 13px;
  color: var(--text-3);
}

.stat-trend {
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 2px;
}

.stat-trend.up { color: var(--success-ink); }
.stat-trend.down { color: var(--danger-ink); }
.stat-trend.flat { color: var(--text-3); }

/* 饼图 */
.chart-card { height: 100%; }

.pie-chart {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 8px 0;
}

.pie-svg {
  width: 160px;
  height: 160px;
  flex-shrink: 0;
}

.pie-center-num {
  font-size: 28px;
  font-weight: 800;
  fill: var(--text-1);
}

/* 环形各段的入场：从"零长度"长到实际弧度。
   注意 transition 必须写在 stroke-dasharray 上 —— 原来只过渡了 stroke（颜色），
   而颜色从头到尾没变过，所以那行 transition 同样是死代码。
   每段的延迟由模板的 transitionDelay 给，形成依次扫出的效果。 */
.pie-arc {
  transition: stroke-dasharray 0.9s cubic-bezier(0.22, 0.61, 0.36, 1);
}

.pie-center-label {
  font-size: 12px;
  fill: var(--text-3);
}

.pie-legend { flex: 1; }

.legend-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid var(--line-2);
}

.legend-item:last-child { border-bottom: none; }

.legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.legend-name {
  flex: 1;
  font-size: 14px;
  color: var(--text-2);
}

.legend-count {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1);
}

/* 今日待办 */
.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.todo-list { display: flex; flex-direction: column; gap: 10px; }

.todo-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--card-2);
  transition: all 0.2s;
}

.todo-item:hover { background: var(--accent-soft); }

.todo-priority {
  width: 6px;
  height: 36px;
  border-radius: 3px;
  flex-shrink: 0;
}

.todo-priority.urgent { background: var(--danger); }
.todo-priority.high { background: var(--amber); }
.todo-priority.normal { background: var(--accent); }
.todo-priority.low { background: var(--line-strong); }

.todo-content { flex: 1; }

.todo-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}

.todo-meta {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
}

/* 维保趋势：柱子已由 ECharts 画（见 components/TrendChart.vue），
   原来那套 .trend-bar / .bar-value / .trend-label / .trend-legend 一并删掉。
   .legend-dot 保留 —— 饼图图例（第 832 行那条独立规则）还在用它，
   这里删掉的只是 `.trend-legend .legend-dot` 这条覆写。 */
.trend-chart { padding: 8px 0; }

/* 维保超期
   这一列会列出全部超期设备（演示数据 17 台），此前没有上限，
   于是整行被撑到 1401px，而左边"今日待办"只有 512px —— 下方近 900px
   是纯空白。封顶后三列等高，超出的部分在本列内滚动。 */
.overdue-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 400px;
  overflow-y: auto;
  padding-right: 2px;
}

.overdue-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border-radius: 8px;
  background: var(--danger-soft);
  border: 1px solid var(--danger-line);
}

.overdue-status {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  animation: pulse-dot 1.5s ease-in-out infinite;
}

.overdue-status.critical { background: var(--danger); }
.overdue-status.warning { background: var(--amber); }

@keyframes pulse-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(1.3); }
}

.overdue-info { flex: 1; }

.overdue-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
}

.overdue-detail {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
}

.overdue-days {
  text-align: center;
}

.days-num {
  font-size: 24px;
  font-weight: 800;
  color: var(--danger-ink);
}

.days-unit {
  font-size: 12px;
  color: var(--danger-ink);
  margin-left: 2px;
}

/* 最近操作 */
.log-content {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-2);
}

/* 空状态 */
.empty-inline {
  text-align: center;
  padding: 24px;
  color: var(--text-mute);
}
.empty-inline p {
  margin: 8px 0 0;
  font-size: 13px;
}

/* 复诊闭环 */
.closing-body {
  display: flex;
  align-items: center;
  gap: 16px;
}

.closing-ring {
  position: relative;
  width: 84px;
  height: 84px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

/* 圆弧摆在数字底下，占满整个环；旋转 -90° 让它从 12 点方向起画 */
.closing-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}

.closing-track { stroke: var(--line); }

.closing-arc {
  stroke-linecap: round;
  transition: stroke-dasharray 0.9s cubic-bezier(0.22, 0.61, 0.36, 1);
}

.closing-num {
  font-size: 22px;
  font-weight: 800;
}

.closing-info { flex: 1; }

.closing-line {
  font-size: 13px;
  color: var(--text-2);
  margin-bottom: 4px;
}

.closing-line.warn { color: var(--warn-ink); }

.closing-note {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 6px;
  line-height: 1.5;
}

.recheck-list {
  margin-top: 12px;
  border-top: 1px dashed var(--line);
  padding-top: 10px;
}

.recheck-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 0;
}

.recheck-title {
  font-size: 12px;
  color: var(--text-1);
  font-weight: 600;
}

.recheck-meta {
  font-size: 11px;
  color: var(--text-3);
}

/* 健康恶化 */
.worsen-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--danger-soft);
  border: 1px solid var(--danger-line);
  margin-bottom: 8px;
  cursor: pointer;
  transition: all 0.2s;
}

.worsen-item:hover { background: var(--danger-line); }

.worsen-score {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--lv);
  color: #fff;
  font-weight: 800;
  font-size: 15px;
  flex-shrink: 0;
}

.worsen-info { flex: 1; min-width: 0; }

.worsen-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
}

.worsen-meta {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.worsen-arrow { color: var(--text-mute); }

.worsen-note {
  margin-top: 10px;
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.6;
}

/* 品牌分布 */
.brand-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 0;
}

.brand-name {
  font-size: 13px;
  color: var(--text-1);
  width: 72px;
  flex-shrink: 0;
}

.brand-bar {
  flex: 1;
  height: 10px;
  background: var(--line-2);
  border-radius: 5px;
  overflow: hidden;
}

.brand-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--signal));
  border-radius: 5px;
  transition: width 0.6s ease;
}

.brand-count {
  font-size: 12px;
  color: var(--text-2);
  width: 48px;
  text-align: right;
  flex-shrink: 0;
}

/* 高频故障 TOP */
.fault-bars { display: flex; flex-direction: column; gap: 8px; }

.fault-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.2s;
  border: 1px solid transparent;
}

.fault-row:hover { background: var(--line-2); }
.fault-row.active { background: var(--accent-soft); border-color: var(--accent-line); }

.fault-rank {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
}

/* 排名底 + 白字：改用等级实色，rank-2 原本是 --amber（白字 2.28:1） */
.fault-rank.rank-1 { background: var(--level-d); }
.fault-rank.rank-2 { background: var(--level-c); }
.fault-rank.rank-3 { background: var(--level-b); }
.fault-rank.rank-4, .fault-rank.rank-5 { background: var(--text-3); }
/* 深色下 rank-4/5 灰底要压深，白字才达标（--text-3 提亮后白字只有 ~2.7:1） */
html[data-theme="dark"] .fault-rank.rank-4,
html[data-theme="dark"] .fault-rank.rank-5 { background: #4c5870; }

.fault-system {
  width: 76px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-1);
  flex-shrink: 0;
}

.fault-bar-wrap {
  flex: 1;
  height: 14px;
  background: var(--bg-sunken);
  border-radius: 7px;
  overflow: hidden;
}

.fault-bar {
  height: 100%;
  border-radius: 7px;
  transition: width 0.6s ease;
  min-width: 6px;
}

.fault-count {
  width: 52px;
  text-align: right;
  font-size: 14px;
  font-weight: 700;
  color: var(--text-1);
  flex-shrink: 0;
}

.fault-percent {
  width: 48px;
  text-align: right;
  font-size: 12px;
  color: var(--text-3);
  flex-shrink: 0;
}

.fault-arrow { color: var(--text-mute); flex-shrink: 0; transition: transform 0.2s; }

.fault-row.active .fault-arrow { transform: rotate(180deg); }

.fault-note {
  margin-top: 10px;
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.6;
}

.fault-samples {
  margin-top: 12px;
  border-top: 1px dashed var(--line);
  padding-top: 10px;
}

.fault-sample-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-1);
  margin-bottom: 8px;
}

.fault-sample {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  font-size: 12px;
}

.fault-sample-text { color: var(--text-1); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.fault-sample-meta {
  color: var(--text-3);
  margin-left: auto;
  flex-shrink: 0;
  font-size: 11px;
}

.fault-more {
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-3);
}

/* 响应式 */
@media (max-width: 1024px) {
  .status-strip {
    gap: 8px;
  }
}

/* ===== 首屏信息条 ===== */
.status-strip {
  display: flex;
  align-items: center;
  gap: 0;
  flex-wrap: wrap;
  background: var(--grad-strip);
  border-radius: 12px;
  padding: 10px 18px;
  margin-bottom: 16px;
  color: #fff;
}
.strip-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 18px;
  border-right: 1px solid rgba(255, 255, 255, 0.22);
}
.strip-item:first-child { padding-left: 0; }
.strip-ico {
  /* 原来是 emoji 💰 / ⚠️ / 🔒。换成单色图标后随 .status-strip 的 #fff，
     色值在 #1c6bd4 一端算 5.12:1 —— 注意这里**不能**用 --amber-on-dark 之类的
     "on-dark" 令牌：那套是按落地页深底（#061530 系）标定的，放到这条
     --grad-strip（#0b3a82→#1c6bd4）上实测只有 1.69~2.74:1，过不了 3:1。 */
  display: inline-flex;
  align-items: center;
  font-size: 18px;
}
.strip-txt { display: flex; flex-direction: column; }
.strip-txt b { font-size: 13.5px; font-weight: 700; line-height: 1.3; }
.strip-txt span { font-size: 11px; opacity: 0.78; line-height: 1.3; }
.strip-action { margin-left: auto; padding-left: 10px; }
@media (max-width: 900px) {
  .strip-item { border-right: none; }
  .strip-action { margin-left: 0; width: 100%; margin-top: 6px; }
}

/* ===== 重点关注设备照片墙 ===== */
.focus-card { margin-bottom: 16px; }
.focus-sub { font-size: 12px; color: var(--text-3); font-weight: 400; }
.focus-grid {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}
.focus-item {
  flex: 1 1 230px;
  min-width: 200px;
  border: 1px solid var(--line);
  border-radius: 10px;
  overflow: hidden;
  cursor: pointer;
  transition: all 0.2s;
  background: var(--card);
}
.focus-item:hover {
  box-shadow: 0 6px 18px var(--accent-shadow);
  transform: translateY(-2px);
  border-color: var(--accent);
}
.focus-photo {
  position: relative;
  height: 120px;
  background: var(--bg-sunken);
}
.focus-photo img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.focus-level {
  position: absolute;
  left: 8px;
  top: 8px;
  /* 底色走 --lv（等级色实色版），白字才压得住；--emerald/--amber 这类"面色"
     直接配白字只有 2.28~4.20:1，是这次修掉的一类。 */
  background: var(--lv);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 999px;
  box-shadow: 0 1px 4px rgba(0,0,0,0.25);
}
.focus-body { padding: 10px 12px; }
.focus-name {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--text-1);
  display: flex;
  align-items: center;
  gap: 6px;
}
.focus-model { font-size: 11px; color: var(--text-3); font-weight: 400; }
.focus-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
}
/* 白底上的等级色文字走 --lv 的"ink"取值（≥5.36:1），不是面色 */
.focus-score { font-size: 12.5px; font-weight: 700; color: var(--lv-text); }
.focus-reason {
  margin-top: 6px;
  font-size: 12px;
  color: var(--danger-ink);
  background: rgba(185, 28, 28, 0.06);
  border-radius: 6px;
  padding: 4px 8px;
}

</style>
