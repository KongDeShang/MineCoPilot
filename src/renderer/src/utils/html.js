/**
 * 矿山智工 - HTML 转义工具（公共）
 *
 * 为什么需要：项目里有若干处把数据拼成 HTML 再交给 v-html 渲染
 * （体检报告、AI 助手消息、故障案例原文）。凡是用户可编辑的字段
 * （设备名、故障描述、知识库条目、手册文本）拼进去之前都必须转义，
 * 否则 Excel 导入/口述录入的内容就是一条存储型 XSS 路径。
 */

/** HTML 特殊字符转义（& < > " '） */
export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
