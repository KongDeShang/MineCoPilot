/**
 * 演示路线 · 主线（原 12 步 1:1 迁移为 JSON 配置）
 *
 * ⚠️ 文案与顺序与旧版完全一致（评委可能看过旧版，保持一致更稳）。
 * ⚠️ 改这里时记得同步更新 docs/演示脚本.md 的口径。
 *
 * 字段说明：
 *   route   —— 该步所在路由（空 = 沿用当前页；整屏说明卡）
 *   target  —— 高亮元素 CSS 选择器（空 = 不指向具体元素）
 *   waitFor —— 路由切换后等待渲染的毫秒数（页面异步数据加载完再高亮）
 *   autoAdvanceMs —— 自动演示时该步停留毫秒数（缺省用路线级默认 3000）
 */
export default {
  id: 'main',
  name: '主线',
  desc: '看板 → 台账 → 病历 → 工单 → AI → 规程 → 复诊 → 本地模型',
  autoAdvanceMs: 3200,
  steps: [
    {
      title: '欢迎：矿山智工 · 设备健康智能体',
      content:
        '一台离线运行的设备健康工作台。下面按顺序过一遍主线：' +
        '看清今天的账 → 找到最该管的那台设备 → 一路做到复诊闭环。',
      waitFor: 0
    },
    {
      route: '/dashboard',
      target: '.status-strip',
      title: '一屏看清今天的账',
      content:
        '预计停机损失、需立即处置台数、数据是否出本机 —— 三个数都在本机算出来，' +
        '鼠标不用点任何地方。',
      waitFor: 1200
    },
    {
      route: '/dashboard',
      target: '.focus-card',
      title: '最该管的那几台，自动浮上来',
      content:
        '按健康分升序、只留 D 级与超期 45 天以上的设备，并写明"为什么是它"。' +
        '点任意一张卡片直接进设备画像。',
      waitFor: 600
    },
    {
      route: '/dashboard',
      target: '.pie-chart',
      title: '设备状态分布',
      content:
        '运行 / 维保 / 故障 / 闲置四态实时统计。把鼠标停在图上，看每一段的准确台数。',
      waitFor: 600
    },
    {
      route: '/equipment',
      target: '.equip-grid',
      title: '设备台账：每台一条健康条',
      content:
        '60 台设备的健康分、状态、上次维保时间一眼扫完。健康条按分数长短不同，' +
        '不用逐台点开。',
      waitFor: 1000
    },
    {
      route: '/medical-records',
      target: '.record-profile',
      title: '设备病历：分数是怎么算出来的',
      content:
        '四因子（维保及时率、故障频次、机龄、工况）分别打分并给出算式与来源，' +
        '右侧是健康分趋势。结论可追溯到算法，不是一句"AI 认为"。',
      waitFor: 1100
    },
    {
      route: '/workorder',
      target: '.workorder .el-radio-group',
      title: '工单状态机',
      content:
        '待派单 → 已派单 → 处理中 → 已完成。非法流转会被拒绝，' +
        '每次流转都留痕，可在操作日志里回放。',
      waitFor: 900
    },
    {
      route: '/ai-assistant',
      target: '.chat-card',
      title: '一句话建单，也能问到手册原文',
      content:
        '用大白话说"3 号挖掘机履带松了"，会给出一张待确认的理解卡，' +
        '确认后才写库 —— 不替用户猜设备。',
      waitFor: 900
    },
    {
      route: '/knowledge-base',
      target: '.kb-table-card',
      title: '回答带页码，可回原文核对',
      content:
        '随包 3 份手册（共 86 页）已提取文字层，检索结果标出命中页码，' +
        '点"查看原文"跳过去对。这是全场唯一不靠"信 AI"的功能。',
      waitFor: 1100
    },
    {
      route: '/recheck',
      target: '.stat-cards',
      title: '复诊闭环：处方之后真的复查了吗',
      content:
        '工单完成会自动生成复诊任务（维修 7 天 / 保养 30 天），' +
        '闭环率是本机实算的。多数设备管理软件做到"派单"就结束了。',
      waitFor: 900
    },
    {
      route: '/model-hub',
      target: '.hero',
      title: '断网可用，数据不出本机',
      content:
        '内置 Qwen2.5-0.5B 量化模型在本机推理，全过程零联网、零上传。' +
        '这也是它能进矿区的技术前提。',
      waitFor: 1000
    },
    {
      title: '演示结束',
      content:
        '全部数据、算法、模型都在这一台机器上。需要我再走一遍某个环节，' +
        '或者换一条数据推演都可以。',
      waitFor: 0
    }
  ]
}
