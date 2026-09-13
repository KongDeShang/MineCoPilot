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

export function createNlActions(ctx) {
  const {
    equipmentList,
    maintenanceRecords,
    healthSnapshots,
    workOrders,
    recentLogs,
    persistAll,
    addLog,
    now
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

  /** 直接改设备字段（口述改状态的撤销也需要它） */
  function updateEquipment(id, patch) {
    const eq = equipmentList.value.find(e => String(e.id) === String(id))
    if (!eq) return null
    Object.assign(eq, patch)
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

  function pushUndo(entry) {
    const record = { ...entry, id: `undo-${++undoSeq}` }
    undoStack.value.unshift(record)
    if (undoStack.value.length > MAX_UNDO) undoStack.value.pop()
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
   * 撤销一次口述写入
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
    let reverted = 0
    for (const undo of [...(entry.undos || [])].reverse()) {
      try {
        if (typeof undo === 'function') { undo(); reverted++ }
      } catch (error) {
        console.warn('[口述录入] 撤销子步骤失败', error)
      }
    }
    addLog({
      content: `撤销口述录入「${entry.rawText}」（回滚 ${reverted} 项变更）`,
      source: '口述',
      type: 'warning',
      tagType: 'warning'
    }, { silent: true })
    persistAll()
    return { ok: true, reverted, entry }
  }

  function clearUndoStack() {
    undoStack.value = []
  }

  /**
   * 记录一次口述操作（溯源：原话 + 解析结果 + 实际变更）
   * @returns {Object|null} 压入撤销栈的条目（含 id），调用方据此做"只撤这一次"
   */
  function logVoiceAction({ rawText, summary, changes, intentLabel, undos }) {
    const detail = Array.isArray(changes) && changes.length
      ? '：' + changes.map(c => c.label).join('、')
      : ''
    addLog({
      content: `口述录入「${rawText}」→ ${intentLabel || summary}${detail}`,
      source: '口述',
      type: 'success',
      tagType: 'success'
    }, { silent: true })
    recentLogs.value = recentLogs.value.slice(0, 50)
    let entry = null
    if (Array.isArray(undos) && undos.length) {
      entry = pushUndo({ rawText, summary, changes, undos, at: now() })
    }
    persistAll()
    return entry
  }

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
    clearUndoStack
  }
}

export { }
