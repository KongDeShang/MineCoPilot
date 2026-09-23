/**
 * 首启播种判据（纯函数）
 *
 * 为什么单独抽出来：这段判据一旦写错，后果是**演示数据整库覆盖用户真实数据** ——
 * 而它原先藏在 stores/appStore.js 的 initStore 里，store 并不进 Node 侧自检的镜像清单，
 * 等于"最危险的一段判断"没有任何测试能直接驱动。抽成纯函数后，状态组合可以被逐一钉死。
 *
 * 判据必须**同时**满足两条才算全新安装：
 *   1) 库里一条数据都没有（hasAnyData === false）
 *   2) 从没装过（meta 里的 seed_version 不存在）
 *
 * 为什么不能只看"台账为空"：
 *   台账为空是**用户状态**（删空了设备、或导入了不含台账的备份），不是"从没装过"。
 *   只看它的话，下次启动会重新长出 60 台演示设备，并把工单/维保/日志/知识库/备件
 *   （persistence.applySeedData 覆盖九个集合）一并换成演示数据，而磁盘上用户真实的
 *   数据就在这一次启动里没了。附带后果：应用无法以"空台账"状态交付 —— 真实矿区
 *   试点要清掉演示设备，每次重启都会长回来。
 *
 * 为什么不能只看"没有 seed_version"：
 *   早于本标记的老版本装过的库没有这个 meta。只凭它判断，升级上来的真实数据会被
 *   演示数据整库覆盖。
 *
 * @param {object} state
 * @param {string|null|undefined} state.seedVersion meta 里的 seed_version
 * @param {boolean} state.hasEquipment 设备台账是否有行
 * @param {boolean} state.hasAnyData 任意一张业务表是否有数据
 * @returns {'seed'|'empty-ledger'|'hydrate'} seed=播种演示数据；empty-ledger=装载后进入空台账态；hydrate=正常恢复
 */
export function decideBootSeed({ seedVersion, hasEquipment, hasAnyData }) {
  // 台账有行就一定算"有数据"，调用方传漏了也不会误判成全新安装
  const anyData = !!(hasAnyData || hasEquipment)

  if (anyData) return hasEquipment ? 'hydrate' : 'empty-ledger'

  // 一条数据都没有：只有"从没装过"才允许播种
  return seedVersion === null || seedVersion === undefined ? 'seed' : 'empty-ledger'
}
