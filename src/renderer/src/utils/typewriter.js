/**
 * 逐字打字引擎
 *
 * 将 HTML 字符串逐字注入到 reactive 对象的 content 属性。
 * 纯文本部分逐字出现，HTML 标签整体注入（保证 <span class="health-a">A</span> 不会被拆散）。
 *
 * 长文保护：超过 maxTypedChars 个字符后，剩余内容一次性填入——
 * 打字动画只覆盖开头一小段（兼顾"正在输出"的体感），长回答不会让用户干等十几秒。
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
 * @param {number} [opts.maxTypedChars=200] - 逐字打字的字符数上限，超出部分一次性填入
 * @param {function} [opts.scrollToBottom] - 每次内容更新后调用
 * @param {AbortSignal} [opts.signal] - 可选的取消信号
 * @returns {Promise<void>}
 */
export function typewriterHTML(msg, html, opts = {}) {
  const {
    charDelay = 18,
    maxTypedChars = 200,
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
    let typedChars = 0
    let cancelled = false

    if (signal) {
      signal.addEventListener('abort', () => { cancelled = true }, { once: true })
    }

    /** 把剩余 token 全部拼进 buffer（长文快进 / 取消时用） */
    function flushRest() {
      for (let i = tokenIdx; i < tokens.length; i++) {
        buffer += tokens[i].content
      }
      msg.content = buffer
      scrollToBottom?.()
    }

    function tick() {
      if (cancelled) {
        // 取消时直接填入剩余内容
        flushRest()
        resolve()
        return
      }

      if (tokenIdx >= tokens.length) {
        resolve()
        return
      }

      const token = tokens[tokenIdx]

      if (token.type === 'tag') {
        // 标签整体注入，不延迟、不计入打字字数
        buffer += token.content
        tokenIdx++
        msg.content = buffer
        tick()
      } else if (typedChars >= maxTypedChars) {
        // 超过打字上限：剩余全部直接填入，避免长回答让用户干等
        flushRest()
        resolve()
      } else {
        // 纯文本逐字注入
        buffer += token.content[charIdx]
        charIdx++
        typedChars++
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

/*
 * 这里原有 createTypewriter(msg, html, opts)：把 typewriterHTML 包成
 * { promise, cancel } 的"可取消控制器"。
 * 已于 2026-09-25 删除 —— 零调用方（全仓 grep 只有定义本身）。
 * 取消能力并没有丢：typewriterHTML 本身就接受 opts.signal，
 * 调用方（views/AIAssistant.vue）直接传 AbortSignal 即可，
 * 中间那层包装只是把同一个 signal 包了一遍，没有增加任何能力。
 */
