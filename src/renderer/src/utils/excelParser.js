/**
 * 矿山智工 - Excel 智能解析模块
 * 自动识别表头、智能映射字段、合并多源表格
 */
import * as XLSX from 'xlsx'

/**
 * 工程机械运维常用字段映射表
 * key: 标准字段名
 * value: 可能的表头别名
 */
const FIELD_ALIASES = {
  设备名称: ['设备名', '设备名称', '名称', '机号', '设备编号', '编号', '设备', '机器名称', '机械名称'],
  设备型号: ['型号', '规格型号', '设备型号', '机型', '规格'],
  设备类别: ['类别', '类型', '设备类型', '设备类别', '种类', '分类'],
  所在位置: ['位置', '地点', '矿区', '工区', '所在位置', '所在矿区', '作业区域', '施工地点', '使用部门', '所在部门'],
  购置日期: ['购买日期', '采购日期', '购置日期', '入库日期', '购入时间', '购置时间', '购买时间'],
  设备状态: ['状态', '运行状态', '设备状态', '当前状态'],
  // 口述别名：现场台账常写成"俗称/叫法"。导入后进设备指代解析的第二层匹配。
  口述别名: ['口述别名', '别名', '口语别名', '俗称', '常用叫法'],
  维保日期: ['保养日期', '维修日期', '维保日期', '维护日期', '上次保养', '最近维保', '巡检日期', '保养时间'],
  维保内容: ['保养内容', '维修内容', '维保内容', '维护内容', '工作内容', '处理结果'],
  维保人员: ['保养人', '维修人', '维保人员', '负责人', '维修人员', '技术员', '巡检人'],
  故障描述: ['故障', '故障描述', '故障现象', '问题描述', '异常情况', '故障原因'],
  配件名称: ['配件', '配件名称', '配件名', '备件', '备件名称', '零件', '零部件'],
  数量: ['数量', '用量', '使用数量', '库存数量'],
  单价: ['单价', '价格', '金额'],
  备注: ['备注', '说明', '注释', 'remark', 'note']
}

/**
 * 智能识别表头映射
 *
 * 两轮匹配，避免跨字段误映射（例如「配件名称」不应被「设备名称」的别名「名称」抢走）：
 *   第一轮：表头与别名完全相等
 *   第二轮：表头包含别名（要求别名长度 ≥ 2，防止单字误命中）
 *
 * @param {string[]} headers - 原始表头数组
 * @returns {Object} 映射关系 { 原始表头: 标准字段名 }
 */
export function identifyHeaders(headers) {
  const mapping = {}
  const entries = Object.entries(FIELD_ALIASES)

  // 第一轮：精确匹配，并把已占用的标准字段登记下来，避免多个表头映射到同一字段
  const usedStandard = new Set()
  const pending = []

  for (const header of headers) {
    if (!header) continue
    const cleanHeader = String(header).trim()
    const exact = entries.find(([, aliases]) => aliases.includes(cleanHeader))
    if (exact && !usedStandard.has(exact[0])) {
      mapping[cleanHeader] = exact[0]
      usedStandard.add(exact[0])
    } else {
      pending.push(cleanHeader)
    }
  }

  // 第二轮：模糊匹配
  for (const cleanHeader of pending) {
    const fuzzy = entries.find(([standard, aliases]) => {
      if (usedStandard.has(standard)) return false
      return aliases.some(alias => alias.length >= 2 &&
        (cleanHeader.includes(alias) || (cleanHeader.length >= 2 && alias.includes(cleanHeader))))
    })
    if (fuzzy) {
      mapping[cleanHeader] = fuzzy[0]
      usedStandard.add(fuzzy[0])
    } else {
      // 没匹配到就保留原名
      mapping[cleanHeader] = cleanHeader
    }
  }

  return mapping
}

/**
 * 解析 Excel 文件
 * @param {File} file - 文件对象
 * @returns {Promise<Object>} 解析结果
 */
export function parseExcelFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result)
        const workbook = XLSX.read(data, { type: 'array' })

        const result = {
          filename: file.name,
          sheets: []
        }

        for (const sheetName of workbook.SheetNames) {
          const worksheet = workbook.Sheets[sheetName]
          const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 })

          if (jsonData.length === 0) continue

          // 找到表头行（第一个非空行）
          let headerRowIndex = 0
          for (let i = 0; i < Math.min(5, jsonData.length); i++) {
            if (jsonData[i] && jsonData[i].length > 1) {
              headerRowIndex = i
              break
            }
          }

          const headers = jsonData[headerRowIndex].map(h => String(h || '').trim())
          const headerMapping = identifyHeaders(headers)

          // 提取数据行
          const rows = []
          for (let i = headerRowIndex + 1; i < jsonData.length; i++) {
            const row = jsonData[i]
            if (!row || row.every(cell => cell === null || cell === undefined || cell === '')) continue

            const rowObj = {}
            headers.forEach((header, index) => {
              if (header) {
                const standardField = headerMapping[header] || header
                rowObj[standardField] = row[index] !== undefined ? row[index] : ''
              }
            })
            rows.push(rowObj)
          }

          result.sheets.push({
            name: sheetName,
            headers: headers.filter(h => h),
            headerMapping,
            rows,
            totalRows: rows.length,
            totalCols: headers.filter(h => h).length
          })
        }

        resolve(result)
      } catch (error) {
        reject(new Error(`Excel 解析失败: ${error.message}`))
      }
    }

    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsArrayBuffer(file)
  })
}

/**
 * 合并多个 Excel 解析结果
 * 按照标准字段名对齐不同来源的表格
 */
export function mergeExcelResults(results) {
  // 收集所有标准字段
  const allFields = new Set()
  for (const result of results) {
    for (const sheet of result.sheets) {
      Object.values(sheet.headerMapping).forEach(f => allFields.add(f))
    }
  }

  const mergedHeaders = Array.from(allFields)

  // 合并所有行
  const mergedRows = []
  for (const result of results) {
    for (const sheet of result.sheets) {
      for (const row of sheet.rows) {
        const normalizedRow = {}
        for (const header of sheet.headers) {
          const standardField = sheet.headerMapping[header] || header
          normalizedRow[standardField] = row[standardField] || ''
        }
        mergedRows.push(normalizedRow)
      }
    }
  }

  return {
    headers: mergedHeaders,
    rows: mergedRows,
    totalRows: mergedRows.length,
    sourceCount: results.length,
    sheetCount: results.reduce((sum, r) => sum + r.sheets.length, 0)
  }
}

/**
 * 生成示例 Excel 数据（用于演示）
 */
export function generateSampleData() {
  return [
    {
      filename: '生产部_设备清单.xlsx',
      sheets: [{
        name: 'Sheet1',
        headers: ['设备名称', '型号', '类别', '所在矿区', '购置时间', '运行状态'],
        headerMapping: {
          '设备名称': '设备名称', '型号': '设备型号', '类别': '设备类别',
          '所在矿区': '所在位置', '购置时间': '购置日期', '运行状态': '设备状态'
        },
        // 型号一律取自 equipmentCatalog 的白名单：示例数据要是写了目录外的机型，
        // 导入进来的台账当场就成了"品类校验认不出"的脏数据，演示第一步就卡住。
        // 品牌配比也照着目录的口径来——徐工为主，留一台他牌说明系统不挑品牌。
        rows: [
          { '设备名称': '1号挖掘机', '设备型号': '徐工 XE215C', '设备类别': '挖掘机', '所在位置': 'A矿区', '购置日期': '2021-03-15', '设备状态': '运行中' },
          { '设备名称': '2号挖掘机', '设备型号': '徐工 XE370C', '设备类别': '挖掘机', '所在位置': 'A矿区', '购置日期': '2020-08-20', '设备状态': '运行中' },
          { '设备名称': '3号装载机', '设备型号': '徐工 LW300FN', '设备类别': '装载机', '所在位置': 'B矿区', '购置日期': '2022-01-10', '设备状态': '维保中' },
          { '设备名称': '4号挖掘机', '设备型号': '小松 PC200-8', '设备类别': '挖掘机', '所在位置': 'B矿区', '购置日期': '2023-05-18', '设备状态': '运行中' },
          { '设备名称': '5号矿卡', '设备型号': '徐工 XDA45', '设备类别': '矿卡', '所在位置': 'A矿区', '购置日期': '2023-06-01', '设备状态': '运行中' },
          { '设备名称': '6号钻机', '设备型号': '徐工 XQZ120', '设备类别': '钻机', '所在位置': 'C矿区', '购置日期': '2019-11-20', '设备状态': '故障' },
          { '设备名称': '7号破碎机', '设备型号': '徐工 XGY1500', '设备类别': '破碎机', '所在位置': 'C矿区', '购置日期': '2022-09-05', '设备状态': '运行中' },
          { '设备名称': '8号矿卡', '设备型号': '徐工 XDE130', '设备类别': '矿卡', '所在位置': 'A矿区', '购置日期': '2024-01-15', '设备状态': '运行中' }
        ],
        totalRows: 8,
        totalCols: 6
      }]
    },
    {
      filename: '维修部_维保记录.xlsx',
      sheets: [{
        name: '维保记录',
        headers: ['设备名', '保养日期', '保养内容', '维修人', '配件名称', '备注'],
        headerMapping: {
          '设备名': '设备名称', '保养日期': '维保日期', '保养内容': '维保内容',
          '维修人': '维保人员', '配件名称': '配件名称', '备注': '备注'
        },
        rows: [
          { '设备名称': '1号挖掘机', '维保日期': '2026-08-15', '维保内容': '更换液压油', '维保人员': '张工', '配件名称': '液压油46号', '备注': '常规保养' },
          { '设备名称': '2号挖掘机', '维保日期': '2026-07-20', '维保内容': '更换滤芯', '维保人员': '李工', '配件名称': '机油滤芯', '备注': '' },
          { '设备名称': '3号装载机', '维保日期': '2026-09-01', '维保内容': '轮胎更换', '维保人员': '王工', '配件名称': '工程轮胎', '备注': '左前轮磨损严重' },
          { '设备名称': '6号钻机', '维保日期': '2026-06-10', '维保内容': '钻头更换', '维保人员': '张工', '配件名称': '合金钻头', '备注': '已超期未保养' },
          { '设备名称': '7号破碎机', '维保日期': '2026-08-25', '维保内容': '衬板更换', '维保人员': '李工', '配件名称': '高锰钢衬板', '备注': '' },
          { '设备名称': '4号挖掘机', '维保日期': '2026-08-28', '维保内容': '发动机保养', '维保人员': '张工', '配件名称': '机油+三滤', '备注': '2000小时保养' }
        ],
        totalRows: 6,
        totalCols: 6
      }]
    },
    {
      filename: '安全部_巡检记录.xlsx',
      sheets: [{
        name: '巡检',
        headers: ['机械名称', '巡检日期', '异常情况', '负责人', '处理结果'],
        headerMapping: {
          '机械名称': '设备名称', '巡检日期': '维保日期', '异常情况': '故障描述',
          '负责人': '维保人员', '处理结果': '备注'
        },
        rows: [
          { '设备名称': '1号挖掘机', '维保日期': '2026-09-05', '故障描述': '液压油压力偏低', '维保人员': '赵工', '备注': '已安排检修' },
          { '设备名称': '5号矿卡', '维保日期': '2026-09-03', '故障描述': '刹车片磨损', '维保人员': '赵工', '备注': '已更换' },
          { '设备名称': '6号钻机', '维保日期': '2026-09-08', '故障描述': '钻杆振动异常', '维保人员': '钱工', '备注': '待检修' },
          { '设备名称': '8号矿卡', '维保日期': '2026-09-07', '故障描述': '轮胎气压不足', '维保人员': '赵工', '备注': '已补气' }
        ],
        totalRows: 4,
        totalCols: 5
      }]
    },
    {
      filename: '采购部_配件库存.xlsx',
      sheets: [{
        name: '库存',
        headers: ['配件名', '规格型号', '库存数量', '单价(元)', '最低库存', '供应商'],
        headerMapping: {
          '配件名': '配件名称', '规格型号': '设备型号', '库存数量': '数量',
          '单价(元)': '单价', '最低库存': '备注', '供应商': '负责人'
        },
        // 规格与 PARTS_CATALOG 对齐：同名的件在导入时才能按件名归并到同一行，
        // 而不是造出一个"液压油46号（200L/桶）"和"液压油46号"两条记录。
        // 合金钻头故意不在目录里——示例数据也要能演示"导入出现新件名"这条路径。
        rows: [
          { '配件名称': '液压油46号', '设备型号': '200L/桶', '数量': 12, '单价': 1850, '备注': '5', '负责人': '徐工集团' },
          { '配件名称': '机油滤芯', '设备型号': '通用', '数量': 8, '单价': 280, '备注': '10', '负责人': '徐工集团' },
          { '配件名称': '工程轮胎', '设备型号': '23.5R25', '数量': 3, '单价': 12000, '备注': '4', '负责人': '米其林' },
          { '配件名称': '合金钻头', '设备型号': 'R32-45mm', '数量': 6, '单价': 3500, '备注': '3', '负责人': '徐工集团' },
          { '配件名称': '高锰钢衬板', '设备型号': '圆锥破专用', '数量': 2, '单价': 28000, '备注': '2', '负责人': '徐工集团' },
          { '配件名称': '刹车片', '设备型号': '通用', '数量': 4, '单价': 4500, '备注': '4', '负责人': '徐工集团' }
        ],
        totalRows: 6,
        totalCols: 6
      }]
    },
    {
      filename: '财务部_设备资产表.xlsx',
      sheets: [{
        name: '资产台账',
        headers: ['资产编号', '设备名称', '原值(万元)', '已用年限', '月折旧(元)', '使用部门'],
        headerMapping: {
          '资产编号': '备注', '设备名称': '设备名称', '原值(万元)': '单价',
          '已用年限': '数量', '月折旧(元)': '维保内容', '使用部门': '所在位置'
        },
        rows: [
          { '备注': 'EQ-001', '设备名称': '1号挖掘机', '单价': 185, '数量': 5, '维保内容': '3083', '所在位置': '采矿车间' },
          { '备注': 'EQ-002', '设备名称': '2号挖掘机', '单价': 168, '数量': 6, '维保内容': '2800', '所在位置': '采矿车间' },
          { '备注': 'EQ-003', '设备名称': '3号装载机', '单价': 85, '数量': 4, '维保内容': '1771', '所在位置': '运输车间' },
          { '备注': 'EQ-005', '设备名称': '5号矿卡', '单价': 320, '数量': 3, '维保内容': '5333', '所在位置': '采矿车间' },
          { '备注': 'EQ-006', '设备名称': '6号钻机', '单价': 450, '数量': 7, '维保内容': '5357', '所在位置': '爆破车间' }
        ],
        totalRows: 5,
        totalCols: 6
      }]
    }
  ]
}
