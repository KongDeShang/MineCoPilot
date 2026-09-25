<template>
  <div class="parts-page">
    <!-- 顶部仪表 -->
    <div class="parts-dash">
      <div class="dash-item">
        <div class="dash-label">库存件数</div>
        <div class="dash-value"><AnimatedNumber :value="totalStock" /> <span class="dash-unit">件</span></div>
      </div>
      <div class="dash-item">
        <div class="dash-label">备件种类</div>
        <div class="dash-value"><AnimatedNumber :value="store.partsInventory.length" /> <span class="dash-unit">种</span></div>
      </div>
      <div class="dash-item dash-warn">
        <div class="dash-label">缺料预警（≤安全库存）</div>
        <div class="dash-value"><AnimatedNumber :value="store.lowStockParts.length" /> <span class="dash-unit">种</span></div>
      </div>
      <div class="dash-item dash-action">
        <el-button type="primary" size="small" plain @click="openAdd">
          <el-icon><Plus /></el-icon> 新增备件
        </el-button>
        <el-button type="warning" size="small" plain @click="openPurchase">
          <el-icon><ShoppingCart /></el-icon> 采购建议单
        </el-button>
      </div>
    </div>

    <!-- 缺料预警 -->
    <el-card v-if="store.lowStockParts.length" shadow="never" class="warn-card">
      <template #header>
        <div class="card-header">
          <span class="warn-title"><el-icon><WarningFilled /></el-icon> 缺料预警（已联动告警中心）</span>
          <el-tag size="small" type="warning" effect="plain">库存 ≤ 安全库存，请及时补货</el-tag>
        </div>
      </template>
      <div class="warn-grid">
        <div v-for="p in store.lowStockParts" :key="p.id" class="warn-item">
          <div class="warn-name">{{ p.name }}</div>
          <div class="warn-nums">库存 <b class="warn-low">{{ p.stock }}</b> / 安全 {{ p.safety_stock }} {{ p.unit }}</div>
          <div class="warn-bar">
            <div class="warn-fill" :style="{ width: Math.min(100, Math.round((p.stock / Math.max(1, p.safety_stock * 2)) * 100)) + '%' }"></div>
          </div>
          <el-button size="small" type="warning" plain @click="openRestock(p)">立即入库</el-button>
        </div>
      </div>
    </el-card>

    <!-- 备件台账 -->
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span><el-icon><Box /></el-icon> 备件台账（维保/维修领用自动扣减）</span>
          <el-input v-model="partQuery" placeholder="搜索备件名 / 类别" clearable size="small" style="width: 200px">
            <template #prefix><el-icon><Search /></el-icon></template>
          </el-input>
        </div>
      </template>

      <el-table :data="filteredParts" size="small" stripe>
        <el-table-column prop="name" label="备件名称" min-width="140">
          <template #default="{ row }">
            <span class="part-name">{{ row.name }}</span>
          </template>
        </el-table-column>
        <el-table-column v-if="!isNarrow" prop="category" label="类别" width="110">
          <template #default="{ row }"><el-tag size="small" effect="plain">{{ row.category }}</el-tag></template>
        </el-table-column>
        <el-table-column label="库存" width="130">
          <template #default="{ row }">
            <span :class="row.stock <= row.safety_stock ? 'stock-low' : 'stock-ok'">{{ row.stock }}</span>
            <span class="stock-unit"> / {{ row.safety_stock }} {{ row.unit }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="row.stock <= row.safety_stock ? 'warning' : 'success'">
              {{ row.stock <= row.safety_stock ? '缺料' : '充足' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column v-if="!isNarrow" prop="unit_price" label="单价" width="90">
          <template #default="{ row }">¥{{ row.unit_price }}</template>
        </el-table-column>
        <el-table-column label="操作" width="210" fixed="right">
          <template #default="{ row }">
            <el-button size="small" link type="success" @click="openRestock(row)">入库</el-button>
            <el-button size="small" link type="warning" @click="openIssue(row)">出库</el-button>
            <el-button size="small" link type="primary" @click="openHistory(row)">流水</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 最近流水 -->
    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span><el-icon><Tickets /></el-icon> 最近出入库流水</span>
          <el-tag size="small" type="info" effect="plain">来源：手动出入库 / 维保记录自动扣减</el-tag>
        </div>
      </template>
      <el-table :data="store.partTransactions.slice(0, 12)" size="small">
        <el-table-column label="时间" width="110">
          <template #default="{ row }">{{ (row.createdAt || '').slice(5, 16) }}</template>
        </el-table-column>
        <el-table-column label="备件" min-width="120">
          <template #default="{ row }">{{ partName(row.part_id) }}</template>
        </el-table-column>
        <el-table-column label="方向" width="80">
          <template #default="{ row }">
            <el-tag size="small" :type="row.type === 'in' ? 'success' : 'warning'">
              {{ row.type === 'in' ? '入库' : '出库' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="quantity" label="数量" width="70" />
        <!-- 窄屏（<1200px）时来源列让位：时间/备件/方向/数量始终可见 -->
        <el-table-column v-if="!isNarrow" label="来源" min-width="160">
          <template #default="{ row }">
            {{ row.note || (row.ref_type ? `${row.ref_type} #${row.ref_id}` : '—') }}
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 入库 / 出库对话框 -->
    <el-dialog v-model="showStock" :title="stockMode === 'in' ? '入库' : '出库'" width="400">
      <div v-if="stockTarget" class="stock-target">
        <b>{{ stockTarget.name }}</b>
        <span>当前库存 {{ stockTarget.stock }} {{ stockTarget.unit }} · 安全库存 {{ stockTarget.safety_stock }}</span>
      </div>
      <el-form label-width="70px" style="margin-top: 12px">
        <el-form-item label="数量">
          <el-input-number v-model="stockQty" :min="1" :max="999" style="width: 100%" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="stockNote" placeholder="如：月度补货 / 检修领用" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showStock = false">取消</el-button>
        <el-button :type="stockMode === 'in' ? 'success' : 'warning'" @click="confirmStock">确认{{ stockMode === 'in' ? '入库' : '出库' }}</el-button>
      </template>
    </el-dialog>

    <!-- 新增备件对话框 -->
    <el-dialog v-model="showAdd" title="新增备件" width="440">
      <el-form label-width="80px">
        <el-form-item label="名称"><el-input v-model="newPart.name" placeholder="如：液压油滤芯" /></el-form-item>
        <el-form-item label="类别">
          <el-select v-model="newPart.category" style="width: 100%">
            <el-option v-for="c in partCategories" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>
        <el-form-item label="初始库存"><el-input-number v-model="newPart.stock" :min="0" style="width: 100%" /></el-form-item>
        <el-form-item label="安全库存"><el-input-number v-model="newPart.safety_stock" :min="0" style="width: 100%" /></el-form-item>
        <el-form-item label="单价"><el-input-number v-model="newPart.unit_price" :min="0" :precision="2" style="width: 100%" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAdd = false">取消</el-button>
        <el-button type="primary" :disabled="!newPart.name" @click="confirmAdd">保存</el-button>
      </template>
    </el-dialog>

    <!-- 采购建议单 -->
    <el-dialog v-model="showPurchase" title="采购建议单" width="520">
      <div v-if="store.lowStockParts.length === 0" class="purchase-empty">
        <el-icon><CircleCheck /></el-icon> 暂无缺料备件，库存健康。
      </div>
      <el-table v-else :data="purchasePlan" size="small">
        <el-table-column prop="name" label="备件" min-width="110" />
        <el-table-column prop="stock" label="现有库存" width="80" />
        <el-table-column prop="safety_stock" label="安全库存" width="80" />
        <el-table-column label="建议采购量" width="90">
          <template #default="{ row }"><b class="buy-qty">{{ row.buy }}</b></template>
        </el-table-column>
        <el-table-column label="预计金额" width="100">
          <template #default="{ row }">¥{{ row.cost }}</template>
        </el-table-column>
      </el-table>
      <div v-if="purchasePlan.length" class="purchase-total">
        合计建议采购 <b>{{ purchaseTotal.qty }}</b> 件，预计 <b>¥{{ purchaseTotal.cost.toLocaleString('zh-CN') }}</b>
      </div>
      <template #footer>
        <el-button type="primary" @click="applyPurchase">按建议批量入库</el-button>
        <el-button @click="showPurchase = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 流水历史 -->
    <el-dialog v-model="showHistory" title="出入库流水" width="520">
      <el-table v-if="historyTx.length" :data="historyTx" size="small">
        <el-table-column label="时间" width="110">
          <template #default="{ row }">{{ (row.createdAt || '').slice(5, 16) }}</template>
        </el-table-column>
        <el-table-column label="方向" width="70">
          <template #default="{ row }">
            <el-tag size="small" :type="row.type === 'in' ? 'success' : 'warning'">{{ row.type === 'in' ? '入' : '出' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="quantity" label="数量" width="60" />
        <el-table-column label="来源" min-width="180">
          <template #default="{ row }">{{ row.note || '—' }}</template>
        </el-table-column>
      </el-table>
      <el-empty v-else description="暂无流水记录" :image-size="60" />
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { ElMessage } from 'element-plus'
import { Plus, ShoppingCart, WarningFilled, Box, Search, Tickets, CircleCheck } from '@element-plus/icons-vue'
import { useAppStore } from '../stores/appStore'
import AnimatedNumber from '../components/AnimatedNumber.vue'
import { useNarrowMode } from '../utils/responsive'

// 窄屏（<1200px）隐藏次要列：类别/单价/流水来源让位，名称/库存/状态保持可见
const { isNarrow } = useNarrowMode()

const store = useAppStore()

const partQuery = ref('')
const filteredParts = computed(() => {
  const q = partQuery.value.trim().toLowerCase()
  if (!q) return store.partsInventory
  return store.partsInventory.filter(p => (p.name + ' ' + p.category).toLowerCase().includes(q))
})

const totalStock = computed(() => store.partsInventory.reduce((s, p) => s + Number(p.stock), 0))

// 出入库
const showStock = ref(false)
const stockMode = ref('in')
const stockTarget = ref(null)
const stockQty = ref(1)
const stockNote = ref('')

function openRestock(p) {
  stockMode.value = 'in'
  stockTarget.value = p
  stockQty.value = 1
  stockNote.value = '手动入库'
  showStock.value = true
}
function openIssue(p) {
  stockMode.value = 'out'
  stockTarget.value = p
  stockQty.value = 1
  stockNote.value = '检修领用'
  showStock.value = true
}
function confirmStock() {
  if (!stockTarget.value || !stockQty.value) return
  if (stockMode.value === 'in') {
    store.restockPart(stockTarget.value.id, stockQty.value, stockNote.value)
    ElMessage.success(`${stockTarget.value.name} 入库 ${stockQty.value} 件`)
  } else {
    if (stockQty.value > stockTarget.value.stock) {
      ElMessage.warning(`出库数量超过当前库存（${stockTarget.value.stock}）`)
      return
    }
    store.issuePart(stockTarget.value.id, stockQty.value, stockNote.value)
    ElMessage.success(`${stockTarget.value.name} 出库 ${stockQty.value} 件`)
  }
  showStock.value = false
}

// 新增
const showAdd = ref(false)
const partCategories = ['液压系统', '动力系统', '工作装置', '行走系统', '电气系统', '润滑系统', '其他']
const newPart = ref({ name: '', category: '液压系统', stock: 10, safety_stock: 5, unit_price: 0 })
function openAdd() {
  newPart.value = { name: '', category: '液压系统', stock: 10, safety_stock: 5, unit_price: 0 }
  showAdd.value = true
}
function confirmAdd() {
  const part = store.addPart(newPart.value)
  if (!part) {
    ElMessage.warning('请填写备件名称')
    return
  }
  ElMessage.success(`已新增备件「${part.name}」`)
  showAdd.value = false
}

// 采购建议
const showPurchase = ref(false)
const purchasePlan = computed(() =>
  store.lowStockParts.map(p => {
    const buy = Math.max(0, p.safety_stock * 2 - p.stock)
    return { id: p.id, name: p.name, stock: p.stock, safety_stock: p.safety_stock, buy, cost: Math.round(buy * p.unit_price) }
  })
)
const purchaseTotal = computed(() => ({
  qty: purchasePlan.value.reduce((s, r) => s + r.buy, 0),
  cost: purchasePlan.value.reduce((s, r) => s + r.cost, 0)
}))
function openPurchase() {
  showPurchase.value = true
}
function applyPurchase() {
  // ⚠️ 必须先取快照再入库：purchasePlan 是 computed，restockPart 一改库存，
  // 建议单立刻重算（缺口被补上 → buy 变 0），循环结束再读就会得到"入库 0 件"。
  const rows = purchasePlan.value.filter(r => r.buy > 0)
  const qty = rows.reduce((s, r) => s + r.buy, 0)
  const cost = rows.reduce((s, r) => s + r.cost, 0)
  if (!qty) {
    ElMessage.warning('当前没有需要补货的备件')
    return
  }
  for (const r of rows) store.restockPart(r.id, r.buy, '采购建议单批量入库')
  ElMessage.success(`已按建议单批量入库 ${qty} 件，合计 ¥${cost.toLocaleString('zh-CN')}`)
  showPurchase.value = false
}

// 流水历史
const showHistory = ref(false)
const historyTarget = ref(null)
const historyTx = computed(() => store.partTransactions.filter(t => t.part_id === historyTarget.value?.id))
function openHistory(row) {
  historyTarget.value = row
  showHistory.value = true
}
function partName(partId) {
  const p = store.partsInventory.find(x => x.id === partId)
  return p ? p.name : `#${partId}`
}
</script>

<style scoped>
.parts-page { display: flex; flex-direction: column; gap: 16px; }

.parts-dash { display: flex; gap: 12px; flex-wrap: wrap; }
.dash-item {
  flex: 1 1 150px;
  min-width: 130px;
  border-radius: 12px;
  padding: 14px 18px;
  background: var(--grad-strip);
  color: #fff;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
/* 同 AlertCenter 的 .dash-rate：白字带 0.85/0.88 透明度，而 #d97706 太亮，
   纯白压上去也只有 4.0~4.5:1。叠一层压暗层把底色降下来，保住"警示橙"的色相。
   压深后标签 5.2:1、单位 4.9:1、数字 6.1:1。 */
.dash-item.dash-warn { background: linear-gradient(rgba(0, 0, 0, 0.3), rgba(0, 0, 0, 0.3)), linear-gradient(120deg, #b45309, #d97706); }
.dash-item.dash-action {
  background: var(--card);
  border: 1px solid var(--line-2);
  color: var(--text-1);
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.dash-label { font-size: 12px; opacity: 0.88; }
.dash-value { font-size: 26px; font-weight: 800; line-height: 1; }
.dash-unit { font-size: 12px; font-weight: 400; opacity: 0.85; }

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

/* 缺料预警 */
.warn-card { border-color: rgba(217, 119, 6, 0.35); }
.warn-title { display: flex; align-items: center; gap: 6px; color: var(--warn-ink); font-weight: 700; }
.warn-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}
.warn-item {
  border: 1px solid var(--amber-soft);
  background: var(--amber-soft);
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.warn-name { font-size: 13.5px; font-weight: 700; color: var(--warn-ink); }
.warn-nums { font-size: 12px; color: var(--warn-ink); }
.warn-low { font-size: 18px; color: var(--danger-ink); }
.warn-bar { height: 6px; border-radius: 3px; background: var(--amber-line); overflow: hidden; }
.warn-fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg, #e0a020, #d97706); }

.part-name { font-weight: 600; color: var(--text-1); }
.stock-low { color: var(--danger-ink); font-weight: 700; font-size: 15px; }
.stock-ok { color: var(--success-ink); font-weight: 700; font-size: 15px; }
.stock-unit { color: var(--text-3); font-size: 12px; }

.stock-target {
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--line-2);
  border-radius: 8px;
  padding: 10px 12px;
}
.stock-target span { font-size: 12px; color: var(--text-3); }

.purchase-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 30px 0;
  color: var(--success-ink);
}
.buy-qty { color: var(--warn-ink); font-size: 15px; }
.purchase-total {
  margin-top: 12px;
  text-align: right;
  font-size: 13px;
  color: var(--text-2);
}
.purchase-total b { color: var(--warn-ink); }
</style>
