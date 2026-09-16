/**
 * 逐字打字引擎
 *
 * 将 HTML 字符串逐字注入到 reactive 对象的 content 属性。
 * 纯文本部分逐字出现，HTML 标签整体注入（保证 <span class="health-a">A</span> 不会被拆散）。
 *
 * 用法：
 *   const msg = reactive({ content: '' })
 *   await typewriterHTML(msg, '<p>设备健康</p>', { charDelay: 18, scrollToBottom })
 */

/**
 * 将 HTML 拆为 token 序列：标签（整体注入）和纯文本（逐字注入）
 * @param {string} html
 * @returns {Array<{type: 'tag'|'text', content: string}>}
 */
export function tokenizeHTML(html) {
  const tokens = []
  const tagRe = /<[^>]+>/g
  let lastIdx = 0
  let match

  while ((match = tagRe.exec(html)) !== null) {
    // 标签前的纯文本
    if (match.index > lastIdx) {
      tokens.push({ type: 'text', content: html.slice(lastIdx, match.index) })
    }
    // 标签本身
    tokens.push({ type: 'tag', content: match[0] })
    lastIdx = match.index + match[0].length
  }

  // 尾部剩余文本
  if (lastIdx < html.length) {
    tokens.push({ type: 'text', content: html.slice(lastIdx) })
  }

  return tokens
}

/**
 * 逐字将 HTML 写入 reactive 对象的 content 属性
 *
 * @param {{ content: string }} msg - Vue reactive 对象
 * @param {string} html - 完整 HTML 字符串
 * @param {object} opts
 * @param {number} [opts.charDelay=18] - 每个字符间隔（ms），0 表示无延迟（无障碍模式）
 * @param {function} [opts.scrollToBottom] - 每次内容更新后调用
 * @param {AbortSignal} [opts.signal] - 可选的取消信号
 * @returns {Promise<void>}
 */
export function typewriterHTML(msg, html, opts = {}) {
  const {
    charDelay = 18,
    scrollToBottom,
    signal
  } = opts

  // charDelay 为 0 或 prefers-reduced-motion 时直接填入
  if (charDelay <= 0 || (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
    msg.content = html
    scrollToBottom?.()
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    const tokens = tokenizeHTML(html)
    let buffer = ''
    let tokenIdx = 0
    let charIdx = 0
    let cancelled = false

    if (signal) {
      signal.addEventListener('abort', () => { cancelled = true }, { once: true })
    }

    function tick() {
      if (cancelled) {
        // 取消时直接填入剩余内容
        msg.content = html
        resolve()
        return
      }

      if (tokenIdx >= tokens.length) {
        resolve()
        return
      }

      const token = tokens[tokenIdx]

      if (token.type === 'tag') {
        // 标签整体注入，不延迟
        buffer += token.content
        tokenIdx++
        msg.content = buffer
        tick()
      } else {
        // 纯文本逐字注入
        buffer += token.content[charIdx]
        charIdx++
        msg.content = buffer
        scrollToBottom?.()

        // 当前 token 处理完毕
        if (charIdx >= token.content.length) {
          tokenIdx++
          charIdx = 0
        }

        setTimeout(tick, charDelay)
      }
    }

    tick()
  })
}

/**
 * 创建一个可取消的打字控制器
 *
 * @param {{ content: string }} msg
 * @param {string} html
 * @param {object} opts
 * @returns {{ promise: Promise<void>, cancel: () => void }}
 */
export function createTypewriter(msg, html, opts = {}) {
  const controller = new AbortController()
  const promise = typewriterHTML(msg, html, { ...opts, signal: controller.signal })
  return {
    promise,
    cancel: () => controller.abort()
  }
}
