/**
 * 矿山智工 - 演示参数设置 / 本地 meta / 告警处置记录
 *
 * 为什么单独成模块：
 *   这一块的共同点是"存在库的 meta 表里、不属于任何业务实体"。
 *   演示参数（日产出损失、风险系数、健康分档）改了要立刻对全库重算，
 *   告警处置记录则决定了告警中心哪些行显示"已处理"。两者都写得零散，
 *   散落时最容易被漏掉的是"改完要落盘"和"清库时要一并清"——
 *   告警处置记录就曾因为存在 localStorage 而躲过了重置，重置后仍是已处理。
 *
 * 依赖注入而不是第二份状态：settings 还是 appStore 里那个 ref。
 */
import * as db from '../utils/database'
import { DAILY_OUTPUT_LOSS, configureHealth, resetHealthConfig } from '../utils/health'

/**
 * 告警处置记录的 meta key
 *
 * 为什么从 localStorage 搬到本地库 meta：
 *   1) 备份包（.mbak）只带数据库字节 + 聊天记录，放 localStorage 的处置记录换机就丢了，
 *      新电脑上已处理的告警会"复活"，与"数据全带走"的说法不一致；
 *   2) 「重置演示数据」清库时无法一并清除，导致重置后告警仍是已处理状态。
 */
const ALERT_DONE_META_KEY = 'alert_done'

export function createSettingsDomain(ctx) {
  const { settings, alertDispositions, dbReady, scheduleSave, addLog } = ctx

  /**
   * 写 meta：数据库不可用（纯内存演示）时静默跳过，不打断用户操作
   */
  function setMetaSafe(key, value) {
    if (!dbReady.value) return
    db.setMeta(key, value)
  }

  const defaultSettings = () => ({
    dailyOutputLoss: { ...DAILY_OUTPUT_LOSS },
    riskFactor: { A: 0.1, B: 0.3, C: 0.5, D: 0.7 },
    bounds: { A: 85, B: 70, C: 55 },
    llmEnabled: true
  })

  function applySettings(cfg) {
    if (!cfg) return
    configureHealth({
      dailyOutputLoss: cfg.dailyOutputLoss,
      riskFactor: cfg.riskFactor,
      bounds: cfg.bounds
    })
  }

  /** 从本地库 meta 恢复设置（启动时调用） */
  function loadSettings() {
    try {
      const raw = db.getMeta('app_settings')
      if (raw) {
        const parsed = JSON.parse(raw)
        settings.value = { ...defaultSettings(), ...parsed, dailyOutputLoss: { ...DAILY_OUTPUT_LOSS, ...(parsed.dailyOutputLoss || {}) } }
        applySettings(settings.value)
        return
      }
    } catch (error) {
      console.warn('[设置] 读取失败，使用默认参数：', error)
    }
    settings.value = defaultSettings()
  }

  /** 更新设置并立即生效（健康分/停机损失/等级分档全部实时重算） */
  function updateSettings(patch) {
    if (!settings.value) settings.value = defaultSettings()
    settings.value = {
      ...settings.value,
      ...(patch.dailyOutputLoss ? { dailyOutputLoss: { ...settings.value.dailyOutputLoss, ...patch.dailyOutputLoss } } : {}),
      ...(patch.riskFactor ? { riskFactor: { ...settings.value.riskFactor, ...patch.riskFactor } } : {}),
      ...(patch.bounds ? { bounds: { ...settings.value.bounds, ...patch.bounds } } : {})
    }
    applySettings(settings.value)
    setMetaSafe('app_settings', JSON.stringify(settings.value))
    scheduleSave()
    addLog({ content: '更新演示参数设置（日产出/风险系数/健康分档）', source: '设置', type: 'info', tagType: 'info' })
  }

  /** 恢复默认演示参数 */
  function resetSettings() {
    resetHealthConfig()
    settings.value = defaultSettings()
    setMetaSafe('app_settings', JSON.stringify(settings.value))
    scheduleSave()
    addLog({ content: '恢复默认演示参数', source: '设置', type: 'info', tagType: 'info' })
  }

  /**
   * 读取告警处置记录（响应式）。
   *
   * ⚠️ 这里必须返回**注入进来的那个 ref**，不能每次都去读 meta。
   * 原来 `getAlertDispositions()` 是"每次 db.getMeta 再 JSON.parse"，而告警中心把它
   * 存成了本地快照 `ref(store.getAlertDispositions())` —— 于是形成两个真相源：
   * 侧边栏的「重置演示数据」调 clearAlertDispositions() 把 meta 清成 {}，
   * 而**已挂载的告警中心页**手里那份快照还是重置前的 key 集合，界面继续按旧 key
   * 过滤（已处置的告警不显示、已处置率也按旧数算），只有重新挂载页面才自愈。
   * 现在状态只有一份（这个 ref），meta 只负责持久化，任何一侧改动都会同步到界面。
   */
  function loadAlertDispositions() {
    if (!alertDispositions) return
    try {
      const raw = db.getMeta(ALERT_DONE_META_KEY)
      const parsed = raw ? JSON.parse(raw) : null
      alertDispositions.value = parsed && typeof parsed === 'object' ? parsed : {}
    } catch (error) {
      console.warn('[告警] 处置记录读取失败，按未处理处理：', error)
      alertDispositions.value = {}
    }
  }

  function getAlertDispositions() {
    return alertDispositions ? alertDispositions.value : {}
  }

  function setAlertDispositions(map) {
    if (alertDispositions) alertDispositions.value = { ...(map || {}) }
    setMetaSafe(ALERT_DONE_META_KEY, JSON.stringify(map || {}))
    scheduleSave()
  }

  function clearAlertDispositions() {
    if (alertDispositions) alertDispositions.value = {}
    setMetaSafe(ALERT_DONE_META_KEY, '{}')
    scheduleSave()
  }

  return {
    defaultSettings,
    loadSettings,
    updateSettings,
    resetSettings,
    setMetaSafe,
    loadAlertDispositions,
    getAlertDispositions,
    setAlertDispositions,
    clearAlertDispositions
  }
}
