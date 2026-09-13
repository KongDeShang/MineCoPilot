/**
 * 随包示例手册（"装完就能看到"的那几份）
 *
 * 为什么要有它：手册库是空的，第一印象就是"这个模块还没做"。
 * 演示数据能造设备台账、能造工单，唯独造不出真手册——手册必须是真的 PDF。
 * 所以挑几份真手册随包发，首次启动就像示例数据一样出现在手册库里。
 *
 * 挑选口径（按优先级，三条都要满足）：
 *   1) 中文可读——演示与 AI 问答都是中文语境，纯英文手册检索出来没法看；
 *   2) 有文字层——扫描件只能"仅查看"，做不了带页码出处的问答；
 *   3) 是车队在管机型——手册能挂到对应设备的档案上。
 *
 * 资料库里三条同时满足的只有起重机/随车吊这几份。主力机型挖掘机的完整手册
 * （XE210C 英文 / XE215C 俄文 / XE230_XE250C 英文）都不是中文，
 * 因此没有随包——它们的内容已按机型提炼进维保项目库与故障现象库
 * （见 equipmentCatalog.js 里 MAINTENANCE_LIBRARY / FAULT_LIBRARY 的出处注释）。
 *
 * 文件本身由 scripts/build-manual-assets.mjs 从《资料/》抽取生成：
 *   src/renderer/public/manuals/<slug>.pdf   ← 原件（打开原文用）
 *   src/renderer/public/manuals/<slug>.json  ← 逐页文字层（问答检索用，带页码出处）
 * 换成别的手册时，改这里 + 重跑那个脚本即可。
 */
export const BUNDLED_DOCS = [
  {
    id: 'doc-bundled-sq10sk3q',
    slug: 'sq10sk3q-manual',
    src: 'SQ10SK3Q_随车起重机_操作维护手册.pdf',
    title: 'SQ10SK3Q 随车起重机 操作维护手册',
    docType: '操作维护手册',
    model: '徐工 SQ10SK3Q',
    category: '起重机'
  },
  {
    id: 'doc-bundled-xca60e',
    slug: 'xca60e-spec',
    src: 'XCA60E_全地面起重机_规格书.pdf',
    title: 'XCA60E 全地面起重机 技术规格书',
    docType: '技术规格书',
    model: '徐工 XCA60E',
    category: '起重机'
  },
  {
    id: 'doc-bundled-qy25k5d',
    slug: 'qy25k5d-spec',
    src: 'QY25K5D_汽车起重机_技术规格书.pdf',
    title: 'QY25K5D 汽车起重机 技术规格书',
    docType: '技术规格书',
    model: '徐工 QY25K5D',
    category: '起重机'
  }
]

/** 随包文件的静态目录（相对站点根，base: './' 下两种环境都可用） */
export const MANUALS_DIR = 'manuals'
