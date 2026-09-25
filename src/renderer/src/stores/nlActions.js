/**
 * 矿山智工 - 口述录入所需的 store 扩展动作
 *
 * 为什么单独一个模块而不继续塞进 appStore：
 *   1) appStore 已近千行，再堆会让"数据层"职责失焦；
 *   2) 这些动作只服务口述录入的**撤销**与**状态直改**，属于低频且边界清晰的能力；
 *   3) 集中在一处，便于用自检断言把"撤销必须真的还原"这件事钉死。
 *
 * 用法：在 appStore 里 createNlActions({ ... }) 后并入返回对象，
 * 这样 store 的方法仍然可以互相调用，且对外仍是同一个 store。
 */

/*
 * 逆操作描述的执行要用到 nlCommand 里两件东西：
 *   · restoreEquipment       —— 还原设备字段 + 病历 + 健康快照（撤销那条路上的原实现）
 *   · pickFields / digestEquipmentState —— CAS 比对（当前值 vs 写入时的值）
 * 都复用同一份实现，不在这里照抄一遍：两个实现最怕的就是悄悄漂移。
 * nlCommand 是纯函数模块（无 import、不碰 store），所以这个方向没有循环依赖。
 */
import { restoreEquipment, digestEquipmentState, pickFields } from '../utils/nlCommand'

export function createNlActions(ctx) {
  // 注意：这里不再需要 recentLogs —— 日志窗口统一由 appStore.addLog 按 LOG_WINDOW 管理，
  // 本模块曾自行 slice(0, 50) 把已落库的历史永久删掉一段（详见 logVoiceAction 内的说明）。
  const {
    equipmentList,
    maintenanceRecords,
    healthSnapshots,
    workOrders,
    persistAll,
    addLog,
    now,
    /*
     * 逆操作要按名字调 store 的公开方法（removeWorkOrder / updateWorkOrder /
     * removeKnowledgeItemsByIds / revertConsumption …），而 createNlActions 是在
     * store 对象成型**之前**执行的 —— 拿不到那个对象。
     * 因此 appStore 传进来一个可变的持有者：它先是个空壳，返回前填上成型后的接口。
     * 填之前不可能有撤销发生（store 都还没交出去）。
     *
     * ⚠️ 持有者里装的必须是**解包过**的数据字段（普通数组），不能是 Pinia 的 ref：
     * 本模块把 `storeApi.current` 当 store 用，会直接写 `api.equipmentList.find(...)`。
     * 为什么这一点容易错：自动解包只发生在 store 实例上，而 Pinia 的包装是在
     * appStore 的 setup **返回之后**才发生的 —— 想在 setup 里把"成型后的 store 实例"
     * 存下来是做不到的（那等于在 setup 里引用自己），所以 appStore 那边专门做了一个
     * 与 store 实例同形的解包视图。见 appStore.js 里 storeApiView 的说明。
     */
    storeApi
  } = ctx

  /**
   * 删除工单（口述建单的撤销用，也是工单页「删除」按钮的落点）
   *
   * 已归档的工单拒绝删除：完成的那一刻已经写回维保记录、健康快照、复诊任务、
   * 故障案例卡和日志，这些记的是真实发生过的事。删掉工单并不能让它们消失，
   * 只会让病历指向一个不存在的单号。这条规则放在 store 里而不是只写在按钮的
   * v-if 上——否则"删不掉"只是界面的约定，任何别的调用方都能绕过去。
   */
  function removeWorkOrder(id) {
    const index = workOrders.value.findIndex(o => String(o.id) === String(id))
    if (index < 0) return false
    if (workOrders.value[index].archived_at) return false
    workOrders.value.splice(index, 1)
    persistAll()
    return true
  }

  /**
   * updateEquipment 的字段名 → 日志里给人看的说法
   *
   * 只让日志读起来像人话，不追求覆盖全字段：查不到的一律原样回退成字段名。
   * 与 `stores/appStore.js` 的 `WORK_ORDER_FIELD_TEXT` 同一写法。
   */
  const EQUIPMENT_FIELD_TEXT = {
    name: '名称',
    model: '型号',
    category: '类别',
    location: '位置',
    purchase_date: '购置日期',
    status: '状态',
    aliases: '别名',
    notes: '备注',
    maintenance_cycle_days: '维保周期'
  }

  /**
   * 直接改设备字段（低层原语）
   *
   * ⚠️ 默认**不写操作日志**。三类调用方语义完全不同：
   *   · 台账页「编辑设备」保存 —— 用户的一次独立操作，该留痕（调用方传 log: true）
   *   · 口述改状态（nlCommand 的 SET_STATUS）—— 已有 `logVoiceAction` 那条
   *     "口述录入「…」→ …"，在这里再记一条就是同一件事记两遍
   *   · **撤销**（闭包路径在 nlCommand、描述路径在 performUndo，两条都走它）——
   *     `performUndo` 已记"撤销口述录入…（回滚 N 项变更）"；在这里记，
   *     日志里就会把一次撤销记成一次不存在的用户编辑
   *
   * 默认静默 + 调用方显式 opt-in：反过来（默认记、让撤销去 suppress）只要有一处
   * 忘了传参，日志里就会凭空多出一条没发生过的操作 —— 而日志页正是"可审计 AI"的证据链。
   * 同一个理由见 `stores/appStore.js` 的 `updateWorkOrder`。
   */
  function updateEquipment(id, patch, { log = false } = {}) {
    const eq = equipmentList.value.find(e => String(e.id) === String(id))
    if (!eq) return null
    const changed = Object.keys(patch || {}).filter(k => JSON.stringify(eq[k]) !== JSON.stringify(patch[k]))
    Object.assign(eq, patch)
    // 没真改动就不记（重复点一次保存不该留下一条"更新"）
    if (log && changed.length) {
      addLog({
        content: `编辑设备「${eq.name}」：${changed.map(k => EQUIPMENT_FIELD_TEXT[k] || k).join('、')}`,
        source: '设备',
        type: 'primary',
        tagType: 'primary'
      }, { silent: true })
    }
    persistAll()
    return eq
  }

  /** 整体替换某台设备的维保记录（撤销用：把记录恢复成写入前的样子） */
  function replaceMaintenanceRecords(equipmentId, records) {
    const key = String(equipmentId)
    if (!Array.isArray(records)) return false
    if (records.length === 0) delete maintenanceRecords.value[key]
    else maintenanceRecords.value[key] = JSON.parse(JSON.stringify(records))
    persistAll()
    return true
  }

  /** 整体替换某台设备的健康快照（撤销用） */
  function replaceHealthSnapshots(equipmentId, snapshots) {
    if (!Array.isArray(snapshots)) return false
    const others = healthSnapshots.value.filter(s => String(s.equipment_id) !== String(equipmentId))
    const restored = snapshots.map(s => JSON.parse(JSON.stringify(s)))
    healthSnapshots.value = [...others, ...restored]
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    persistAll()
    return true
  }

  /**
   * 口述录入的撤销栈（全局能力，不是聊天消息的一部分）
   *
   * ⚠️ 两个关键点：
   *   1) 为什么不挂在聊天消息上：消息组件一离开页面就被卸载，撤销入口随之消失——
   *      用户说完话跳到工单页发现问题，回来就没法撤了。所以撤销落在 store 上，界面有常驻入口。
   *   2) **必须由外部传入响应式 ref**：store 的方法是普通函数，Pinia 不会追踪其内部状态，
   *      若这里用普通数组，peekUndo() 的结果永远不会触发界面更新（侧边栏按钮不出现）。
   *
   * 只在内存中保留（刷新即失效）：刷新后数据可能已被其它操作改变，跨会话撤销是危险的，宁可不提供。
   */
  const undoStack = ctx.undoStack

  const MAX_UNDO = 20

  /** 撤销条目的自增 id：界面上的"撤销这次写入"要能精确撤到对应的那一条，
   *  而不是盲取栈顶（否则先写 A 再写 B，点 A 的撤销会撤掉 B）。 */
  let undoSeq = 0

  /**
   * 撤销栈的持久化
   *
   * 栈原来是**纯内存**的：刷新即清空，"撤销"只在当次页面加载内可用（第一批把这件事
   * 做成了如实置灰 + 提示，但能力本身仍然没有）。条目现在带上了可序列化的 `inverse`
   * 描述（见 utils/nlCommand.js 的 executePlanItem），于是能存下来、跨刷新继续用。
   *
   * 预算：栈上限 20 条，但一条 COMPLETE_ORDER 的设备快照（设备整行 + 全部病历 +
   * 全部健康快照）能到十几 KB，而 localStorage 常见上限是 5MB。超预算就**从栈底
   * （最早的）淘汰**，淘汰条数记进操作日志 —— 删除要在日志里留痕，不静默丢。
   */
  const UNDO_KEY = 'ks:undo-stack'
  const UNDO_BUDGET = 512 * 1024

  /** 只留"描述得下来"的字段：undos 是闭包，JSON 化会变成一串 null，必须排除 */
  function serializeEntry(entry) {
    return {
      id: entry.id,
      rawText: entry.rawText,
      summary: entry.summary,
      changes: entry.changes,
      inverse: entry.inverse,
      at: entry.at
    }
  }

  /**
   * 落盘撤销栈，返回因超预算被淘汰的条数
   *
   * 写不进去（隐私模式 / 配额用尽）不影响内存态撤销，但要在控制台留一句：
   * 那意味着这一回的"跨刷新仍可撤销"承诺没有兑现，而用户不会知道。
   */
  function saveUndoStack() {
    if (typeof localStorage === 'undefined') return 0
    try {
      // 没有 inverse 的条目存下来也执行不了（闭包存不下来），不进持久化副本 ——
      // 恢复出来只会得到一个"点了没反应"的按钮。
      const entries = undoStack.value
        .filter(e => Array.isArray(e.inverse) && e.inverse.length)
        .map(serializeEntry)
      let keep = entries.length
      while (keep > 0 && JSON.stringify({ seq: undoSeq, entries: entries.slice(0, keep) }).length > UNDO_BUDGET) {
        keep--
      }
      localStorage.setItem(UNDO_KEY, JSON.stringify({ seq: undoSeq, entries: entries.slice(0, keep) }))
      return entries.length - keep
    } catch (error) {
      console.warn('[口述录入] 撤销栈写入本机存储失败（跨刷新撤销会不可用）', error)
      return 0
    }
  }

  function loadUndoStack() {
    if (typeof localStorage === 'undefined') return
    try {
      const raw = localStorage.getItem(UNDO_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw)
      const entries = Array.isArray(parsed && parsed.entries) ? parsed.entries : []
      undoStack.value = entries
        .filter(e => e && e.id && Array.isArray(e.inverse) && e.inverse.length)
        .slice(0, MAX_UNDO)
      // seq 取"存档值"与"现存 id 最大值"的较大者：只认存档值的话，一旦存档被外部
      // 改过或截断，新条目的 id 就会和恢复出来的旧条目撞上（"撤销这次写入"会撤错一条）。
      const maxId = undoStack.value.reduce(
        (m, e) => Math.max(m, Number(String(e.id).replace(/^undo-/, '')) || 0),
        0
      )
      undoSeq = Math.max(Number(parsed && parsed.seq) || 0, maxId)
    } catch {
      undoStack.value = []
    }
  }

  function pushUndo(entry) {
    const record = { ...entry, id: `undo-${++undoSeq}` }
    undoStack.value.unshift(record)
    if (undoStack.value.length > MAX_UNDO) undoStack.value.pop()
    const dropped = saveUndoStack()
    if (dropped > 0) {
      addLog({
        content: `撤销栈超出本机存储预算，最早的 ${dropped} 条不再支持跨刷新撤销（当前页面内仍可撤）`,
        source: '口述',
        type: 'warning',
        tagType: 'warning'
      }, { silent: true })
    }
    return record
  }

  function getUndoStack() {
    return undoStack.value.slice()
  }

  function canUndo() {
    return undoStack.value.length > 0
  }

  function peekUndo() {
    return undoStack.value[0] || null
  }

  /**
   * 这条撤销记录还在不在栈里
   *
   * 界面用它决定"撤销这次写入"能不能按（appStore 派生出 hasUndo 给卡片用）。
   * 它取代了原来的 `session === CHAT_SESSION_ID` 判据 —— 那个判据问的是
   * "这次写入是不是发生在当前这次页面加载里"，而真正该问的是"这条记录还能不能撤"：
   * 栈现在跨刷新还在，旧卡片就该继续能撤；被撤过、被顶出栈、被导入备份清掉的，
   * 就该置灰。判据跟着**能力**走，而不是跟着页面加载次数走。
   */
  function hasUndo(entryId) {
    return !!entryId && undoStack.value.some(e => e.id === entryId)
  }

  /** 按表名取一行（CAS 与"真的删掉了吗"的校验都要用） */
  function findRow(api, table, id) {
    const list = table === 'work_orders' ? api.workOrders
      : table === 'equipment' ? api.equipmentList
      : table === 'knowledge_items' ? api.knowledgeItems
      : table === 'fault_cases' ? api.faultCases
      : null
    return (list || []).find(r => String(r.id) === String(id)) || null
  }

  /**
   * 值的"同一个"判断
   *
   * 行数据从库里读回来常常是字符串化的数字（sql.js 的 INTEGER 落到 JSON 里就是数字，
   * 但经过备份导入 / 手工改库可能变成字符串），严格 === 会产生**假阳性**拒绝 ——
   * 而假阳性比漏报更糟：用户看到"被改过"却什么都没改，就会开始不信这个提示。
   */
  function sameValue(a, b) {
    if (a === b) return true
    if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null)
    return String(a) === String(b)
  }

  /**
   * 执行一条逆操作描述
   *
   * 每条 op 都先做前置检查（记录还在不在 / 值还是不是写入时那个值），不满足就**拒绝**
   * 并把原因带回去。原来的实现是 `catch { console.warn }`：子步骤失败被吞掉，
   * 函数照样返回 `{ok:true, reverted:N}`，部分失败在界面上完全看不见 ——
   * 用户以为数据回去了，其实只回去了一半。
   *
   * @returns {{ok:boolean, why:string}}
   */
  function applyInverse(api, inv) {
    if (!inv || !inv.op) return { ok: false, why: '逆操作描述为空' }

    if (inv.op === 'remove') {
      if (inv.table === 'work_orders') {
        const done = removeWorkOrder(inv.id)
        // removeWorkOrder 内部有两道拒绝：找不到、以及"已归档的工单不允许删除"
        // （归档那一刻写回的病历/快照/案例卡记的是真实发生过的事，删工单并不能让它们消失）。
        if (!done) return { ok: false, why: `工单 #${inv.id} 没能删除（可能已被删除，或已完成归档而拒绝删除）` }
        return { ok: true, why: `已撤销新建的工单 #${inv.id}` }
      }
      if (inv.table === 'knowledge_items') {
        const done = api.removeKnowledgeItem(inv.id)
        if (!done) return { ok: false, why: `知识条目 #${inv.id} 没能删除（可能已被删除）` }
        return { ok: true, why: `已撤销新增的知识条目 #${inv.id}` }
      }
      return { ok: false, why: `不认识的表：${inv.table}` }
    }

    if (inv.op === 'remove_many') {
      const ids = Array.isArray(inv.ids) ? inv.ids : []
      if (!ids.length) return { ok: true, why: '本次没有连带产生的记录需要收回' }
      if (inv.table === 'fault_cases' && api.removeFaultCasesByIds) api.removeFaultCasesByIds(ids)
      else if (inv.table === 'knowledge_items' && api.removeKnowledgeItemsByIds) api.removeKnowledgeItemsByIds(ids)
      else return { ok: false, why: `不认识的表：${inv.table}` }
      // 这两个批量接口对"id 不存在"是静默跳过的（返回删掉的条数，不报错），
      // 所以这里自己数一遍还剩几条，否则"部分没删掉"会被当成成功。
      const left = ids.filter(id => findRow(api, inv.table, id))
      if (left.length) return { ok: false, why: `还有 ${left.length} 条连带记录没删掉（${left.slice(0, 3).join('、')}）` }
      return { ok: true, why: `已收回 ${ids.length} 条连带产生的记录` }
    }

    if (inv.op === 'update') {
      const row = findRow(api, inv.table, inv.id)
      if (!row) return { ok: false, why: `${inv.table} #${inv.id} 已不存在，无法回退` }
      const drifted = inv.after
        ? Object.keys(inv.after).filter(k => !sameValue(pickFields(row, [k])[k], inv.after[k]))
        : []
      if (drifted.length) {
        return {
          ok: false,
          why: `${inv.table} #${inv.id} 在这之后被改过（${drifted.join('、')}），不自动回退以免盖掉后来的修改`
        }
      }
      if (inv.table === 'work_orders') api.updateWorkOrder(inv.id, inv.before)
      else if (inv.table === 'equipment') api.updateEquipment(inv.id, inv.before)
      else return { ok: false, why: `不认识的表：${inv.table}` }
      return { ok: true, why: `已还原 ${inv.table} #${inv.id} 的 ${Object.keys(inv.before).join('、')}` }
    }

    if (inv.op === 'restore_equipment') {
      const snap = inv.snapshot
      if (!snap) return { ok: false, why: '设备快照缺失' }
      const row = (api.equipmentList || []).find(e => String(e.id) === String(snap.equipmentId))
      if (!row) return { ok: false, why: `设备 #${snap.equipmentId} 已不存在，无法还原` }
      const drifted = inv.after
        ? Object.keys(inv.after).filter(k => !sameValue(pickFields(row, [k])[k], inv.after[k]))
        : []
      if (drifted.length) {
        return {
          ok: false,
          why: `设备 #${snap.equipmentId} 在这之后被改过（${drifted.join('、')}），不自动回退`
        }
      }
      if (inv.afterDigest && inv.afterDigest !== digestEquipmentState(api, snap.equipmentId)) {
        return {
          ok: false,
          why: `设备 #${snap.equipmentId} 的病历或健康快照在这之后被改过，不自动回退`
        }
      }
      restoreEquipment(api, snap)
      return { ok: true, why: `已还原设备 #${snap.equipmentId} 的字段、病历与健康快照` }
    }

    if (inv.op === 'revert_consumption') {
      const applied = Array.isArray(inv.applied) ? inv.applied : []
      if (!applied.length) return { ok: true, why: '本次没有备件扣减需要回滚' }
      if (!api.revertConsumption) return { ok: false, why: 'store 未提供 revertConsumption' }
      // revertConsumption 是"把库存加回去 + 抹掉当初那条出库流水"，它对流水**不存在**
      // 的情况照样会把库存 +1 —— 所以先筛一遍：哪些流水还在台账里。
      // 否则一次重复回滚（例如同一条撤销被触发两次）会凭空多出库存，越撤越乱。
      const txs = api.partTransactions || []
      const live = applied.filter(item =>
        item.txId === null || item.txId === undefined || txs.some(t => t.id === item.txId))
      const gone = applied.length - live.length
      if (!live.length) {
        return {
          ok: false,
          why: `${applied.length} 笔备件出库流水都已不在台账里（可能已被别的操作回滚过），为避免重复加库存，本次不回滚`
        }
      }
      api.revertConsumption(live)
      return {
        ok: true,
        why: gone
          ? `已回滚 ${live.length} 笔备件扣减（另有 ${gone} 笔流水已不在，跳过）`
          : `已回滚 ${live.length} 笔备件扣减`
      }
    }

    return { ok: false, why: `不认识的逆操作：${inv.op}` }
  }

  /**
   * 撤销一次口述写入
   *
   * 优先走可序列化的 `inverse` 描述（跨刷新也用同一条路）；只有在条目没有描述时
   * 才退回闭包 —— 那是历史遗留/未写 inverse 的意图，属于兜底而非主路径。
   *
   * 部分失败**不再被吞掉**：每个子步骤的结果都收进 steps，任一失败都会让本次
   * 返回 `ok:false` 并把原因带给界面。原来失败只 console.warn 后照样返回
   * `ok:true, reverted:N`，用户以为数据回去了，实际只回去了一半。
   *
   * @param {string} [entryId] 指定要撤销的条目 id（走界面上的"撤销这次写入"）；
   *                           不传则撤销最近一次（走侧边栏的常驻入口）。
   */
  function performUndo(entryId) {
    let entry
    if (entryId) {
      const idx = undoStack.value.findIndex(e => e.id === entryId)
      if (idx < 0) {
        return { ok: false, error: '这次写入已经撤销过了' }
      }
      entry = undoStack.value.splice(idx, 1)[0]
    } else {
      entry = undoStack.value.shift()
    }
    if (!entry) return { ok: false, error: '没有可撤销的操作' }

    const api = storeApi && storeApi.current
    const steps = []
    let reverted = 0

    if (Array.isArray(entry.inverse) && entry.inverse.length) {
      if (!api) {
        // store 已经拆掉/尚未装配好：把条目放回栈顶，别把"撤不了"变成"撤销记录没了"
        undoStack.value.unshift(entry)
        return { ok: false, error: '数据层尚未就绪，暂时不能撤销' }
      }
      // 逆序执行：撤销永远按写入的逆序走（与闭包路径的 reverse 一致）
      for (const inv of [...entry.inverse].reverse()) {
        let result
        try {
          result = applyInverse(api, inv)
        } catch (error) {
          result = { ok: false, why: (error && error.message) || String(error) }
        }
        steps.push({ op: inv.op, ok: !!result.ok, why: result.why || '' })
        if (result.ok) reverted++
      }
    } else if (Array.isArray(entry.undos) && entry.undos.length) {
      for (const undo of [...entry.undos].reverse()) {
        try {
          if (typeof undo === 'function') {
            undo()
            reverted++
            steps.push({ op: 'closure', ok: true, why: '' })
          }
        } catch (error) {
          steps.push({ op: 'closure', ok: false, why: (error && error.message) || String(error) })
        }
      }
    } else {
      // 这里**故意不把条目放回栈里**（与上面"数据层未就绪"那条相反）：这种条目
      // 永远撤不动，放回去只会让侧边栏的"撤销最近一次"每次都取到它、每次都失败。
      // 丢掉它，栈会自愈。注意它同时也没有 inverse，saveUndoStack 本来就不会持久化它。
      return { ok: false, error: '这条撤销记录没有可执行的逆操作（可能是更早版本写入的）' }
    }

    const failed = steps.filter(s => !s.ok)
    const reasons = failed.map(f => f.why).filter(Boolean)
    addLog({
      content: failed.length
        ? `撤销口述录入「${entry.rawText}」未完成：${reverted} 项已回滚，${failed.length} 项没退回（${reasons.slice(0, 2).join('；')}）`
        : `撤销口述录入「${entry.rawText}」（回滚 ${reverted} 项变更）`,
      source: '口述',
      type: failed.length ? 'danger' : 'warning',
      tagType: failed.length ? 'danger' : 'warning'
    }, { silent: true })
    saveUndoStack()
    persistAll()
    return { ok: !failed.length, reverted, failed: reasons, steps, entry }
  }

  function clearUndoStack() {
    undoStack.value = []
    // 持久化副本必须一起清：导入备份 / 恢复演示数据都会整库重建、id 全部重排，
    // 留着的旧条目会拿去改重排后的同名记录（沉默改错数据）。清内存不清存档等于没清。
    saveUndoStack()
  }

  // 启动时把上次留下的撤销栈读回来（见文件末尾的 loadUndoStack() 调用）
  /**
   * 记录一次口述操作（溯源：原话 + 解析结果 + 实际变更）
   * @returns {Object|null} 压入撤销栈的条目（含 id），调用方据此做"只撤这一次"
   */
  function logVoiceAction({ rawText, summary, changes, intentLabel, undos, inverse }) {
    const detail = Array.isArray(changes) && changes.length
      ? '：' + changes.map(c => c.label).join('、')
      : ''
    addLog({
      content: `口述录入「${rawText}」→ ${intentLabel || summary}${detail}`,
      source: '口述',
      type: 'success',
      tagType: 'success'
    }, { silent: true })
    // ⚠️ 这里曾经有一行 `recentLogs.value = recentLogs.value.slice(0, 50)`。
    // 它是日志窗口的**第三个**定义（另两处是 appStore.addLog 与 persistence.logsToRows 的
    // LOG_WINDOW=500），后果不是"少显示几条"而是**永久删除**：紧接着的 persistAll()
    // 会 DELETE 整张 operation_logs 再按内存重写，第 51 条以前的真实历史就此消失。
    // 日志窗口统一由 addLog 按 LOG_WINDOW 管理，这里不再自行截断。
    let entry = null
    // 压栈的判据跟着**可执行的撤销**走：只要有一条路能退回去就该进栈。
    // 描述（inverse）是主路径（刷新后还在），闭包（undos）是兜底，
    // 两者都拿不到就没什么可撤的，不进栈 —— 进了只会得到一个点了没反应的按钮。
    if ((Array.isArray(inverse) && inverse.length) || (Array.isArray(undos) && undos.length)) {
      entry = pushUndo({ rawText, summary, changes, undos, inverse, at: now() })
    }
    persistAll()
    return entry
  }

  /**
   * 把上次留下的撤销栈读回来
   *
   * 放在最后执行：此刻上面所有函数都已就绪，也没有任何写入会发生
   * （store 的方法要等 appStore 把接口交出去才可能被调用）。
   */
  loadUndoStack()

  return {
    removeWorkOrder,
    updateEquipment,
    replaceMaintenanceRecords,
    replaceHealthSnapshots,
    logVoiceAction,
    pushUndo,
    getUndoStack,
    canUndo,
    peekUndo,
    performUndo,
    hasUndo,
    clearUndoStack
  }
}

export { }
