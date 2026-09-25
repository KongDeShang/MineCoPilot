/**
 * 矿山智工 - 全局错误边界
 *
 * 为什么需要它：
 *   README 自己写着"模板里调用一个没导入的函数会导致整页白屏"，而防线只有
 *   `vue/no-undef-properties` 一条**静态**规则。它管得住"写错的函数名"，
 *   管不住运行期异常 —— 脏数据、越界取值、某个组件里一个 undefined 的 .map()，
 *   都会让 Vue 卸载出错的那棵子树。
 *
 *   现场用户看到的于是是一块白屏：没有提示、没有日志、没有恢复入口。
 *   分不清是"软件坏了"还是"我点错了"，唯一能做的是关掉重开。
 *   对一台离线设备来说，日志是事后唯一能问"刚才到底怎么了"的地方 ——
 *   所以这里不仅弹提示，还要把错误写进操作日志（本地，不出机器）。
 *
 * 三个必须守住的约束：
 *  1) **处理器自身不得抛错**。它在异常路径上被调用，自己再抛就是死循环
 *     （handler 抛错 → 触发 handler → 抛错…），比原来的白屏更难查。
 *     所以下面所有入口都包了 try/catch，且 catch 里只做最保守的事。
 *  2) **不得刷屏**。渲染期异常是**按组件实例**触发的：一个 v-for 里的取值错误
 *     可以一帧内抛出几十次。不去重的话，日志窗口（LOG_WINDOW=500）会被同一句话
 *     瞬间冲干净，恰好把"出错前发生了什么"这段最该留的证据挤掉。
 *  3) **不递归**。写日志本身若失败（落盘层出问题），不能再走回错误上报。
 *
 * 注意：此文件会被 store-check 镜像到 Node 下执行，
 * 所以不得在模块顶层碰 window / document（与 utils/bootSplash.js 同规矩）。
 */
import { ref } from 'vue'

/**
 * 当前待展示的错误（界面据此渲染可恢复提示）
 * @type {import('vue').Ref<{message:string, where:string, at:string, count:number}|null>}
 */
export const appError = ref(null)

/** 同一条错误在本进程内只记一次日志、只弹一次（见文件头约束 2） */
const seen = new Set()

/** 递归守卫：处理器正在跑时，任何再次进入的调用都直接返回（见文件头约束 3） */
let handling = false

/** 同一错误最多在提示条上累计多少次就不再增加计数（计数只用于展示） */
function normalize(error) {
  if (error == null) return '未知错误（错误对象为空）'
  if (typeof error === 'string') return error
  try {
    // 优先取 message：Vue 传进来的可能是 Error、也可能是个被 throw 出来的字符串/对象。
    // ⚠️ 读取必须包在 try 里，**`typeof error.message` 挡不住这个**——
    // typeof 只是不求值属性名，属性访问照样会跑 getter。getter 抛错时
    // （被改写过的错误对象、或代理对象）整段会跳到下面的 catch。
    const message = error.message
    if (typeof message === 'string' && message) return message
    const text = String(error)
    return text === '[object Object]' ? '未知错误（错误对象无法转成文字）' : text
  } catch {
    // 取值/toString 被改写等极端情况。这里必须给出一个**字符串**而不是继续上抛：
    // 提示条但凡拿不到消息就什么都不显示 —— 那又变回"点了没反应"，
    // 而这一层存在的全部理由就是"任何异常都要留下可见痕迹"。
    return '未知错误（错误对象无法转成文字）'
  }
}

function stamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 上报一条运行期错误：更新提示条 + 写操作日志。
 *
 * @param {unknown} error 抛出来的东西（Error / string / 任意值）
 * @param {string} [where] 出错位置的人类可读描述（如"渲染看板"），用于定位
 * @param {(entry:object, options:object)=>void} [log] 写操作日志的函数（注入，见 installErrorBoundaries）
 */
export function reportError(error, where = '未知位置', log) {
  if (handling) return
  handling = true
  try {
    const message = normalize(error)
    const key = `${where}|${message}`

    // 提示条：同一条错误只累加计数，不重复弹
    if (appError.value && `${appError.value.where}|${appError.value.message}` === key) {
      appError.value = { ...appError.value, count: appError.value.count + 1 }
    } else {
      appError.value = { message, where, at: stamp(), count: 1 }
    }

    // 日志：去重（约束 2）。重复的错误只留第一条 —— 第一条才带着"出错前"的上下文。
    if (!seen.has(key)) {
      seen.add(key)
      if (typeof log === 'function') {
        try {
          log({
            content: `运行期错误（${where}）：${message}`,
            source: '错误边界',
            type: 'warning',
            tagType: 'warning'
          }, { silent: true })
        } catch {
          // 写日志失败（落盘层本身出问题）不能再上报，否则递归。
          // 控制台留一份，至少开发时看得见。
          console.error('[错误边界] 写操作日志失败：', message)
        }
      }
    }
  } catch (fatal) {
    // 走到这里说明 normalize / 赋值本身出了问题。仍然不能抛。
    try {
      console.error('[错误边界] 处理器自身异常：', fatal)
    } catch { /* 连 console 都不给用就算了，静默 */ }
  } finally {
    handling = false
  }
}

/** 用户点掉提示条 / 成功恢复后清空 */
export function clearError() {
  appError.value = null
}

/**
 * 安装全部错误入口。
 *
 * 覆盖四类漏网：
 *   · Vue 组件内（render / setup / 生命周期 / watcher）→ app.config.errorHandler
 *   · 路由懒加载 chunk 拉取失败 → router.onError（这类**不会**走 errorHandler）
 *   · 组件外的同步异常（定时器、事件回调解引用）→ window 'error'
 *   · 未处理的 Promise（async 函数里忘了 catch）→ 'unhandledrejection'
 *
 * @param {object} app   Vue 应用实例
 * @param {{router?:object, log?:Function}} deps
 */
export function installErrorBoundaries(app, { router, log } = {}) {
  const report = (error, where) => reportError(error, where, log)

  // 1) Vue 组件内异常
  try {
    if (app && app.config) {
      app.config.errorHandler = (error, instance, info) => {
        // info 是 Vue 给的位置串（'render function' / 'setup function' / 钩子名），
        // 比单看 message 有用得多：同一个 undefined 在不同钩子里含义完全不同。
        report(error, info ? `组件 ${info}` : '组件')
      }
    }
  } catch (error) {
    console.error('[错误边界] 挂载 app.config.errorHandler 失败：', error)
  }

  // 2) 路由级异常（懒加载 chunk 失败是典型：断网重试、部署后旧 chunk 404）
  try {
    if (router && typeof router.onError === 'function') {
      router.onError((error, to) => {
        const target = to && (to.fullPath || to.path)
        report(error, target ? `路由跳转 → ${target}` : '路由跳转')
      })
    }
  } catch (error) {
    console.error('[错误边界] 挂载 router.onError 失败：', error)
  }

  // 3) 组件外的同步异常
  try {
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('error', (event) => {
        // 资源加载失败（<img>/<script> 404）也会触发 'error'，但它在**捕获**阶段
        // 从元素冒泡上来，event.error 为空 —— 那不是"程序出错"，报在提示条上只会误导。
        if (event && event.error) report(event.error, '窗口运行时')
      })
      // 4) 未处理的 Promise
      window.addEventListener('unhandledrejection', (event) => {
        // reason 可能是任何值，normalize 会兜住
        report(event && 'reason' in event ? event.reason : event, '未处理的异步操作')
      })
    }
  } catch (error) {
    console.error('[错误边界] 挂载 window 错误监听失败：', error)
  }
}
