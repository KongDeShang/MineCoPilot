/**
 * 演示路线 · AI 能力线
 *
 * 这条线专讲"AI 在这台机器上到底做了什么"：模型档位 → 对话叙述 → 口述/OCR 录入。
 * 全部步骤不触发真实写库（演示层约束，与主线一致）。
 */
export default {
  id: 'ai-line',
  name: 'AI 能力线',
  desc: '本地模型 → AI 助手 → 口述/OCR 录入',
  autoAdvanceMs: 3200,
  steps: [
    {
      title: 'AI 能力线：全程离线推理',
      content:
        'AI 助手的三件事：本地模型叙述、一句话建单、口述与 OCR 录入。' +
        '全程在本机推理，数据不出这台机器。',
      waitFor: 0
    },
    {
      route: '/model-hub',
      target: '.tier-card',
      title: '本地模型：三档可选',
      content:
        '轻量 / 标准 / 增强三档，按内存自动推荐。模型文件在本机，' +
        '换档不换服务 —— 同一套对话界面背后是不同的推理能力。',
      waitFor: 1100
    },
    {
      route: '/ai-assistant',
      target: '.chat-card',
      title: '对话式建单：先确认，再写库',
      content:
        '大白话说出设备问题，AI 先给一张"我理解的是这样"的确认卡，' +
        '确认后才落库 —— 不替用户猜设备，杜绝编造。',
      waitFor: 1000
    },
    {
      route: '/ai-assistant',
      target: '.input-section',
      title: '口述与 OCR：不敲键盘也能录数据',
      content:
        '按住说话自动转工单；拍一张手写巡检表，自动识别成结构化文字。' +
        '这两条录入通道是给机修现场设计的。',
      waitFor: 600
    },
    {
      title: 'AI 线结束',
      content:
        '模型、对话、录入都在本机闭环。想看规则引擎和数据的部分，切回"主线"再走一遍。',
      waitFor: 0
    }
  ]
}
