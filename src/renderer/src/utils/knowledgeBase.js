/**
 * 矿山智工 - 本地维保知识库
 *
 * 设计原则：不做"会编造扭矩值的聊天机器人"，只做"可溯源的现场手册"。
 * 每条答案都对应一份可指认的来源（徐工/卡特/小松等机型的通用维保规程与故障案例），
 * 检索离线完成，数据不出设备。答案里出现的数字（超期天数、健康分等）
 * 由本地台账实时计算，不写死。
 */
import { daysSince, daysUntilDue, equipmentAgeYears } from './dates'
import { evaluateHealth, levelMeta, levelOf } from './health'
import { expandQuery, manualTerms } from './synonyms'
import { htmlIcon } from './htmlIcons'
// HTML 转义统一走 utils/html.js：这里原先自己实现了一份，两份行为还不一致
// （本地那份漏了单引号的转义）。共用一份既少一处漂移面，
// 也让"转义边界"只有一个实现要审。
import { escapeHtml } from './html'

export const KNOWLEDGE_BASE = [
  {
    id: 'hydraulic-low-pressure',
    title: '液压系统压力偏低',
    category: '液压系统',
    keywords: ['液压', '压力', '偏低', '液压油', '油压', '无力', '动作慢', '憋车'],
    symptoms: '动作无力、行走/回转缓慢、油缸顶不动、压力表读数低于额定值',
    causes: ['液压油位不足或油液变质', '吸油/回油滤芯堵塞', '液压泵内泄（柱塞泵配油盘磨损）', '溢流阀设定压力漂移或卡滞', '系统进空气或油管接头漏气'],
    steps: ['停机静置 10 分钟后检查液压油位与油液颜色，必要时补油至刻度中位', '更换液压油滤芯，检查吸油管是否吸扁', '读取主泵压力，与机型手册标注的额定值比对（不同机型差异较大，必须查手册）', '检查并清洗溢流阀，必要时重新标定压力', '排空气后复测，仍偏低则判定泵内泄，安排泵体检修'],
    caveat: '压力类数值随机型差异很大，本条目不给具体数值，一律以随机手册标注的额定值为准。',
    source: '工程机械液压系统通用维保规程（参照徐工/卡特同吨位机型手册）'
  },
  {
    id: 'engine-overheat',
    title: '发动机过热 / 水温偏高',
    category: '动力系统',
    keywords: ['发动机', '过热', '水温', '高温', '开锅', '冷却', '散热', '防冻液', '报警'],
    symptoms: '水温表超过 95°C、报警蜂鸣、动力下降、副水箱溢流',
    causes: ['冷却液不足或浓度不对', '散热器外部积尘堵塞（矿区高发）', '风扇皮带打滑或张紧度不足', '节温器卡死在关闭位置', '水泵密封失效'],
    steps: ['高温报警立即降载停机，切勿直接打开水箱盖', '冷却后检查液位与浓度，补充合格冷却液', '用低压水或压缩空气由内向外清理散热器（矿卡建议每班次清理）', '检查风扇皮带张紧度与磨损，必要时更换', '拆检节温器，在水中加热验证开启温度', '以上均正常仍高温，检查水泵与缸垫'],
    caveat: '水温报警阈值随机型与发动机不同，具体数值以随机手册与仪表标注为准。',
    source: '矿区恶劣工况发动机散热维护要点（湿度大、粉尘重地区缩短清理周期）'
  },
  {
    id: 'mining-truck-brake',
    title: '矿卡制动系统检查周期',
    category: '制动系统',
    keywords: ['制动', '刹车', '矿卡', '刹车片', '刹车油', '制动液', '下坡', '刹车失灵'],
    symptoms: '制动距离变长、踏板发软或行程变大、异响、制动鼓发烫',
    causes: ['制动片磨损到极限', '制动液含水或液位低', '制动缸漏气/漏油', '长时间下坡热衰减'],
    steps: ['每班次：检查制动液位、踏板自由行程、有无漏气声', '每周：检查制动片厚度与制动鼓磨损，管路有无渗漏', '每月：测量制动片厚度、检查制动盘/鼓圆度', '每季度：更换制动液、检查制动泵与加力器', '连续长坡必须挂低档配合缓速器，禁止空档滑行'],
    source: '矿用自卸车制动系统维保规程（载重大、坡道多，属安全关键系统）'
  },
  {
    id: 'tire-wear',
    title: '轮胎异常磨损',
    category: '行走机构',
    keywords: ['轮胎', '磨损', '胎压', '气压', '装载机', '吃胎', '偏磨', '爆胎'],
    symptoms: '胎面偏磨、单侧磨损、中央磨损、鼓包、异常振动',
    causes: ['气压过高（中央磨损）或过低（两侧磨损）', '长期超载', '前束/外倾角不准', '作业面碎石、尖锐物割伤', '急转急刹的驾驶习惯'],
    steps: ['用胎压表实测并按机型标准充气（装载机通常 600~650kPa，以手册为准）', '检查是否有偏磨规律，判断定位问题', '检查轮辋有无变形、螺栓扭矩是否一致', '清理作业面上的尖锐岩块', '规范操作，避免满斗急转'],
    source: '装载机行走机构维护要点（矿面作业需同步关注作业面清理）'
  },
  {
    id: 'oil-change-cycle',
    title: '保养周期与油品规格',
    category: '保养规范',
    keywords: ['保养', '周期', '多少小时', '机油', '换油', '液压油', '齿轮油', '滤芯', '多久'],
    symptoms: '用户询问某类设备的保养间隔与油品选型',
    causes: ['不同机型、不同工况的保养间隔不同，矿区粉尘工况需按"重载工况"档执行'],
    steps: ['日常班检：液位、渗漏、异响、仪表报警（每班次）', '50 小时：首次保养，更换发动机机油与机滤', '250 小时：更换机油机滤、检查空滤、润滑各铰点', '500 小时：更换液压油滤芯、柴滤、检查回转/行走马达油', '1000 小时：更换液压油、变速箱油、齿轮油', '2000 小时：整机大保养，全车油液+滤芯+关键件检查', '粉尘大的矿区建议在上述基础上缩短 20%~30%'],
    source: '工程机械定期保养分级规范（小时数按发动机工作小时计）'
  },
  {
    id: 'excavator-hydraulic-oil-temp',
    title: '液压油温过高',
    category: '液压系统',
    keywords: ['油温', '液压油温', '高温', '散热器', '液压过热', '烫', '挖掘机'],
    symptoms: '油温超过 80°C、动作变慢、油封渗油加剧、油液发黑',
    causes: ['液压油散热器外部积尘或内部堵塞', '液压油量不足', '溢流阀长时间溢流（操作习惯）', '油液老化黏度下降', '环境温度高且连续重载作业'],
    steps: ['清理液压油散热器表面与风道，检查风扇转速', '检查油位与油液状态，超标更换', '避免长时间高压溢流憋车作业', '检查回油滤芯是否堵塞导致背压高', '油温持续偏高需检测泵与阀的内泄'],
    caveat: '油温报警阈值随机型不同，具体以随机手册与仪表标注为准。',
    source: '挖掘机液压系统温度控制维护要点'
  },
  {
    id: 'engine-abnormal-noise',
    title: '发动机异响',
    category: '动力系统',
    keywords: ['异响', '响声', '敲缸', '嗒嗒', '噪音', '怠速', '发动机'],
    symptoms: '怠速或加速时出现敲击声、金属摩擦声、气门声',
    causes: ['气门间隙过大（清脆嗒嗒声）', '喷油器雾化不良/早燃（敲缸）', '曲轴连杆轴瓦磨损（沉闷敲击）', '皮带张紧轮轴承损坏', '正时齿轮或链条松动'],
    steps: ['冷机与热机分别听诊，定位声源区域', '检查气门间隙并按手册调整', '检查喷油器回油量与雾化状态', '拆检油底壳，检查机油中含金属屑情况', '若为曲轴轴承异响，立即停机避免扩大损伤'],
    source: '柴油发动机异响诊断流程（由外到内逐级排查）'
  },
  {
    id: 'coolant-check',
    title: '冷却液检查与更换',
    category: '保养规范',
    keywords: ['冷却液', '防冻液', '液位', '冰点', '更换冷却液', '水箱'],
    symptoms: '液位频繁下降、颜色发褐、有油花',
    causes: ['正常蒸发损耗', '管路或水箱渗漏', '缸垫窜气（液面冒泡、有油花）', '防冻液超期失效'],
    steps: ['冷机状态检查副水箱液位，介于 MIN~MAX 之间', '用冰点仪检测浓度，与当地历史最低气温比对确定所需冰点', '每 2 年或 4000 小时整体更换', '液面冒泡且带油花需检查缸垫', '禁止不同品牌防冻液混用'],
    caveat: '冰点要求按使用地区最低气温确定，具体浓度比例以随机手册为准。',
    source: '发动机冷却系统保养规范'
  },
  {
    id: 'crusher-liner',
    title: '破碎机衬板磨损与更换',
    category: '破碎设备',
    keywords: ['破碎机', '衬板', '磨损', '破碎腔', '圆锥破', '给料', '振动'],
    symptoms: '出料粒度变粗、产量下降、振动增大、异响',
    causes: ['衬板达到磨损极限', '给料偏析导致局部磨损', '给料粒度过大或不均匀', '破碎腔内有异物'],
    steps: ['每 500 小时测量衬板厚度并记录磨损曲线', '衬板磨损到原厚度 40% 时安排更换', '检查并调整给料分布，尽量满腔给料', '更换衬板后按规定扭矩紧固并复紧', '振动异常需检查减振器与地脚螺栓'],
    source: '圆锥破碎机衬板寿命管理要点'
  },
  {
    id: 'drill-rod-vibration',
    title: '钻机钻杆振动异常',
    category: '钻机系统',
    keywords: ['钻机', '钻杆', '振动', '异响', '钻孔', '偏斜', '轴承', '冲击'],
    symptoms: '钻进时钻杆摆动大、异响、进尺速度下降、孔位偏斜',
    causes: ['钻杆弯曲或连接螺纹磨损', '回转/冲击机构轴承损坏', '推进梁滑块间隙过大', '钻头磨损不均', '液压系统压力波动'],
    steps: ['停机检查钻杆直线度，超差需校直或更换', '检查连接螺纹有无磨损或咬伤', '检测回转机构轴承游隙与温升', '调整推进梁滑块间隙', '检查蓄能器压力与液压系统稳定性'],
    source: '潜孔钻机钻进异常排查流程'
  },
  {
    id: 'filter-replacement',
    title: '三滤更换要点',
    category: '保养规范',
    keywords: ['三滤', '滤芯', '空滤', '机滤', '柴滤', '更换滤芯', '堵塞'],
    symptoms: '进气阻力报警、动力不足、烟色变黑',
    causes: ['滤芯达到容尘极限', '安装不到位导致旁通（未过滤空气进入）', '劣质滤芯过滤精度不足'],
    steps: ['空滤每 250 小时清理，每 500~1000 小时更换（矿区取小值）', '清理时用低压压缩空气由内向外吹，压力不可过高以免击穿滤纸', '机滤随机油同步更换', '柴滤更换后必须手动泵油排气', '安装时检查密封圈位置，禁止漏装'],
    caveat: '清理气压与滤芯更换周期随机型与工况不同，具体按随机手册与现场粉尘情况调整。',
    source: '发动机进气与燃油系统三级过滤维护规范'
  },
  {
    id: 'grease-lubrication',
    title: '润滑点与润滑脂选择',
    category: '保养规范',
    keywords: ['润滑', '打黄油', '润滑脂', '黄油', '销轴', '关节', '铰点'],
    symptoms: '销轴异响、间隙变大、动作不顺',
    causes: ['润滑周期过长', '润滑脂牌号不匹配（极压/耐水要求）', '润滑点堵塞未打通'],
    steps: ['每班次对工作装置铰点、回转支承加注润滑脂', '每 250 小时对底盘、行走机构集中润滑', '矿区粉尘大、水汽重，优先选耐水极压锂基脂', '加注时观察是否有旧脂挤出，判断油道是否通畅', '长期未润滑的销轴需拆检衬套'],
    source: '工程机械集中润滑维护要点'
  },
  {
    id: 'undercarriage',
    title: '履带与行走机构检查',
    category: '行走机构',
    keywords: ['履带', '张紧', '链条', '四轮一带', '行走', '支重轮', '脱轨'],
    symptoms: '履带松弛跳动、脱轨、行走跑偏、支重轮漏油',
    causes: ['履带张紧度不当', '支重轮/托链轮磨损或漏油', '履带板螺栓松动', '行走马达内泄'],
    steps: ['测量履带下垂量（一般 20~30mm，按手册调整）', '检查支重轮、托链轮是否漏油、异响', '复紧履带板螺栓至规定扭矩', '检查行走马达与减速机渗漏', '作业中避免单边受力过大导致脱轨'],
    source: '履带式底盘四轮一带维护规范'
  },
  {
    id: 'safety-lockout',
    title: '维修作业安全与停机挂牌',
    category: '安全规范',
    keywords: ['安全', '挂牌', '上锁', '维修安全', '支撑', '泄压', '动火'],
    symptoms: '用户询问检修前的安全准备',
    causes: ['液压与电气系统未隔离是矿山维修事故的主要来源'],
    steps: ['停机、熄火、取下钥匙并挂牌上锁', '工作装置落地并加装机械支撑，禁止仅靠液压支撑', '液压系统检修前必须泄压', '断开蓄电池负极，避免误启动', '动火作业前清理周边油污并配备灭火器', '两人以上作业需明确监护人'],
    source: '矿山设备检修安全作业规程'
  },

  // ============================================================
  // 以下为徐工系列条目（只写公开系列名 + 通用维保知识，不编造具体参数）
  // ============================================================
  {
    id: 'xugong-xe-hydraulic',
    title: 'XE 系列挖掘机液压系统保养',
    category: '液压系统',
    keywords: ['XE', 'XE系列', '徐工挖掘机', '挖掘机液压', '主泵', '先导', '回转马达'],
    symptoms: '动作迟缓、油温高、油缸渗漏、先导压力异常',
    causes: ['液压油超期未更换导致黏度变化', '吸油滤芯堵塞造成吸空', '主泵调节器磨损使流量下降', '先导管路接头渗漏'],
    steps: ['按周期更换液压油与吸油/回油滤芯，矿尘大的工况取周期下限', '检查主泵调节器与先导压力，异常时先排除滤芯与油位问题', '检查动臂、斗杆、铲斗油缸活塞杆有无拉伤与渗漏', '回转马达与减速机按周期换油，关注回转支承润滑', '长期停机的设备启用前需排空气并低速预热'],
    source: '参照徐工 XE 系列挖掘机公开机型手册'
  },
  {
    id: 'xugong-xe-undercarriage',
    title: 'XE 系列挖掘机履带与行走机构维护',
    category: '行走机构',
    keywords: ['XE', '徐工挖掘机', '履带', '张紧', '支重轮', '行走马达', '四轮一带', '脱轨'],
    symptoms: '行走跑偏、履带跳齿、支重轮漏油、行走无力',
    causes: ['履带张紧度过松或过紧', '支重轮、托链轮密封失效漏油', '行走马达内泄', '履带板螺栓松动'],
    steps: ['按手册测量履带下垂量并调整张紧油缸', '检查支重轮与托链轮是否漏油、异响、卡滞', '复紧履带板螺栓至规定扭矩', '检查行走减速机与马达渗漏，测量行走压力', '避免单边受力过大导致脱轨，作业面及时清理大块岩石'],
    source: '参照徐工 XE 系列挖掘机公开机型手册'
  },
  {
    id: 'xugong-lw-loader',
    title: 'LW 系列装载机传动系统维护',
    category: '传动系统',
    keywords: ['LW', '徐工装载机', '装载机', '变速箱', '变矩器', '传动', '油温'],
    symptoms: '行走无力、变速箱油温高、换挡冲击、变矩器异响',
    causes: ['变速箱油位不足或油液变质', '变矩器与变速箱油散热器堵塞', '换挡离合器片磨损', '传动轴十字节缺油'],
    steps: ['按周期检查并按牌号更换变速箱油，注意油位需在热车状态下测量', '清理变速箱油散热器，检查油管有无压扁', '测量变矩器进出口压力，判断是否内泄', '检查传动轴十字节与花键润滑，必要时更换', '连续重载作业时避免长时间半联动铲装'],
    source: '参照徐工 LW 系列装载机公开机型手册'
  },
  {
    id: 'xugong-lw-bucket',
    title: 'LW 系列装载机工作装置与铲斗维护',
    category: '工作装置',
    keywords: ['LW', '装载机', '铲斗', '斗齿', '动臂', '摇臂', '销轴', '工作装置'],
    symptoms: '铲斗异响、斗齿脱落、动臂销轴间隙大、举升无力',
    causes: ['斗齿磨损后未及时更换', '销轴与衬套间隙过大', '动臂油缸内泄', '结构件焊缝疲劳开裂'],
    steps: ['每班次检查斗齿、副刀板磨损，成对更换保持受力均衡', '按周期对动臂、摇臂、铲斗铰点加注润滑脂', '测量销轴与衬套间隙，超差更换衬套', '检查动臂根部与车架连接焊缝，发现裂纹立即补焊', '举升无力需先排除油缸内泄与系统压力问题'],
    source: '参照徐工 LW 系列装载机公开机型手册'
  },
  {
    id: 'xugong-xde-brake',
    title: 'XDE/XDA 系列矿卡制动系统检查',
    category: '制动系统',
    keywords: ['XDE', 'XDA', '徐工矿卡', '矿卡', '制动', '刹车', '缓速器', '制动液', '下坡'],
    symptoms: '制动距离变长、踏板发软、制动鼓发烫、驻车制动失效',
    causes: ['制动片磨损至极限', '制动液含水或液位不足', '制动缸漏气/漏油', '长坡连续制动导致热衰减'],
    steps: ['每班次检查制动液位、踏板自由行程与漏气声', '每周检查制动片厚度、管路渗漏与制动鼓温度', '每月测量制动片厚度与制动盘/鼓圆度', '每季度更换制动液、检查制动泵与加力器', '长坡必须低档配合缓速器，严禁空档滑行'],
    source: '参照徐工矿用自卸车公开资料'
  },
  {
    id: 'xugong-xde-tire',
    title: 'XDE/XDA 系列矿卡轮胎与轮辋维护',
    category: '行走机构',
    keywords: ['XDE', 'XDA', '矿卡', '轮胎', '轮辋', '胎压', '轮胎磨损', '割伤'],
    symptoms: '胎面偏磨、鼓包、异常振动、轮辋螺栓松动',
    causes: ['气压不当或长期超载', '作业面尖锐岩块割伤', '轮辋变形、螺栓扭矩不均', '前后桥载荷分配不均'],
    steps: ['按机型标准用胎压表实测充气，关注温度升高后的压力变化', '每班次检查胎面有无割伤、鼓包与夹石', '按对角顺序复紧轮辋螺栓至规定扭矩', '清理运输干线撒料与尖锐岩块', '轮胎异常偏磨需检查定位与悬挂'],
    source: '参照徐工矿用自卸车公开资料'
  },
  {
    id: 'xugong-xky-drill',
    title: 'XKY 系列牙轮钻机回转与除尘维护',
    category: '钻机系统',
    keywords: ['XKY', '徐工钻机', '牙轮钻机', '钻机', '回转', '除尘', '钻杆', '钻头', '进尺'],
    symptoms: '进尺速度下降、回转抖动、孔位偏斜、粉尘大',
    causes: ['牙轮钻头磨损或轴承损坏', '回转减速机润滑不足', '除尘系统滤芯堵塞或风机失效', '钻杆连接螺纹磨损'],
    steps: ['按周期检查牙轮钻头磨损并及时更换', '检查回转减速机油位与温升，按周期换油', '清理除尘器滤芯与风道，检查风机与喷水系统', '检查钻杆直线度与连接螺纹磨损', '按矿岩硬度调整轴压与转速，避免蛮进导致偏斜'],
    source: '参照徐工露天钻机公开资料'
  },
  {
    id: 'xugong-xky-mast',
    title: 'XKY 系列钻机桅杆与推进机构检查',
    category: '钻机系统',
    keywords: ['XKY', '钻机', '桅杆', '推进', '链条', '钢丝绳', '提升', '滑块'],
    symptoms: '推进不稳、提升异响、钻具下滑、桅杆晃动',
    causes: ['推进链条或钢丝绳磨损伸长', '桅杆滑块间隙过大', '提升制动器打滑', '桅杆结构件螺栓松动'],
    steps: ['检查推进链条/钢丝绳磨损与张紧度，按手册调整或更换', '测量滑块间隙并调整', '检查提升制动器摩擦片磨损', '复紧桅杆与车架连接螺栓', '作业前检查桅杆起落限位与安全锁'],
    source: '参照徐工露天钻机公开资料'
  },
  {
    id: 'xugong-xgy-crusher',
    title: 'XGY/XPY 系列圆锥破衬板与给料管理',
    category: '破碎设备',
    keywords: ['XGY', 'XPY', '徐工破碎机', '圆锥破', '破碎机', '衬板', '破碎腔', '给料', '粒度'],
    symptoms: '出料粒度变粗、产量下降、振动增大、破碎腔异响',
    causes: ['衬板磨损至极限', '给料偏析造成局部磨损', '给料粒度过大或给料不均', '破碎腔进入异物'],
    steps: ['按运行小时测量衬板厚度并记录磨损曲线', '衬板磨损到原厚度约 40% 时安排更换', '调整给料分布，尽量实现满腔均匀给料', '更换衬板后按规定扭矩紧固并在运行后复紧', '振动异常需检查减振器、地脚螺栓与偏心套'],
    source: '参照徐工圆锥破碎机公开资料'
  },
  {
    id: 'xugong-xgy-lubrication',
    title: 'XGY 系列圆锥破润滑与油温管理',
    category: '破碎设备',
    keywords: ['XGY', '圆锥破', '破碎机', '润滑', '油温', '油压', '稀油站', '回油'],
    symptoms: '油温偏高、油压不足报警、润滑油乳化、轴承异响',
    causes: ['稀油站滤芯堵塞', '冷却器结垢或水量不足', '回油管路堵塞导致油位失衡', '粉尘进入油池造成油品劣化'],
    steps: ['每班次检查稀油站油位、油压与回油温度', '按周期更换滤芯与润滑油，检查油品有无乳化与杂质', '清理冷却器，检查冷却水流量与温度', '检查回油管路与密封，防止粉尘侵入', '油温或油压报警必须停机排查，禁止带病运行'],
    source: '参照徐工圆锥破碎机公开资料'
  },
  {
    id: 'xugong-xs-roller',
    title: 'XS 系列压路机振动系统维护',
    category: '压实设备',
    keywords: ['XS', '徐工压路机', '压路机', '振动', '钢轮', '激振', '减振块', '洒水'],
    symptoms: '振动无力、振动异响、钢轮轴承发热、洒水不畅',
    causes: ['振动轴承润滑不足或损坏', '减振块老化开裂', '振动马达或泵内泄', '洒水管路堵塞'],
    steps: ['按周期为振动轴承加注规定润滑脂', '检查减振块有无开裂、变形，成组更换', '测量振动系统压力，判断马达与泵状态', '清理洒水管路与喷头，检查水泵', '钢轮轴承温升异常立即停机检查'],
    source: '参照徐工 XS 系列压路机公开资料'
  },
  {
    id: 'xugong-gr-grader',
    title: 'GR 系列平地机刮刀与回转机构维护',
    category: '工作装置',
    keywords: ['GR', '徐工平地机', '平地机', '刮刀', '回转', '铲刀', '齿圈', '找平'],
    symptoms: '刮刀回转卡滞、找平精度下降、回转齿圈异响',
    causes: ['回转齿圈与蜗轮蜗杆润滑不足', '刮刀升降油缸内泄', '齿圈磨损或异物卡入', '铲刀磨损不均'],
    steps: ['按周期润滑回转齿圈、蜗轮蜗杆与各铰点', '清理齿圈处积料与异物', '检查刮刀升降油缸同步性与内泄', '检查铲刀刃口磨损，必要时更换或堆焊', '找平精度下降需检查回转间隙与液压系统'],
    source: '参照徐工 GR 系列平地机公开资料'
  },
  {
    id: 'xugong-sd-dozer',
    title: 'SD 系列推土机行走与铲刀维护',
    category: '行走机构',
    keywords: ['SD', '徐工推土机', '推土机', '铲刀', '履带', '行走', '松土器', '台车'],
    symptoms: '行走跑偏、铲刀升降无力、台车异响、履带脱轨',
    causes: ['履带张紧度不当', '台车架与支重轮磨损', '铲刀油缸内泄或阀卡滞', '终传动漏油'],
    steps: ['测量履带下垂量并调整张紧', '检查台车架、支重轮与引导轮磨损与漏油', '检查铲刀油缸与分配阀，排除内泄', '检查终传动（减速机）油位与渗漏', '排土场作业注意边坡，避免偏载导致脱轨'],
    source: '参照徐工 SD 系列推土机公开资料'
  },
  {
    id: 'xugong-electric-battery',
    title: 'XE 系列电动化工程机械电池与电驱维护',
    category: '新能源',
    keywords: ['新能源', '电动', '电池', '充电', '电驱', '续航', 'SOC', '绝缘'],
    symptoms: '续航下降、充电异常、SOC 跳变、绝缘报警',
    causes: ['电池组温度管理不当', '充电桩与车辆通信异常', '高压接插件松动或受潮', '电驱系统冷却不足'],
    steps: ['按手册要求的环境温度区间作业与充电，避免极端温度下快充', '每班次检查充电口与高压接插件无异物、无受潮', '按周期检查电池箱通风与加热/冷却系统工作状态', '检查电驱与电机冷却液液位与管路渗漏', '出现绝缘或高压报警立即停机并断开维修开关'],
    source: '行业通用新能源工程机械维护要点'
  },
  {
    id: 'xugong-cooling-mine',
    title: 'XE/LW/XDE 系列矿区粉尘工况下的散热系统维护',
    category: '动力系统',
    keywords: ['散热', '散热器', '粉尘', '清理', '高温', '冷却', '风道', '中冷'],
    symptoms: '水温或油温偏高、散热器表面积尘板结、风道堵塞',
    causes: ['矿区粉尘浓度高，散热器翅片快速堵塞', '清理方式不当（高压水枪直冲）导致翅片倒伏', '中冷器与液压油散热器叠加积尘', '风扇导风罩密封不严导致风量短路'],
    steps: ['按工况缩短清理周期，粉尘重的采剥区建议每班次清理一次', '清理时用低压水或压缩空气由内向外吹，禁止高压水枪近距离直冲翅片', '分别清理水散、中冷、液压油散热器之间的夹层积尘', '检查导风罩与挡风胶条密封，避免风量短路', '清理后复测水温与油温，仍偏高再排查节温器、水泵与风扇转速'],
    source: '工程机械矿区恶劣工况散热维护要点'
  },
  {
    id: 'xugong-filter-mine',
    title: 'XE/LW/XDE 系列矿区工况下的三滤与油品管理',
    category: '保养规范',
    keywords: ['矿区', '粉尘', '三滤', '滤芯', '油品', '保养周期', '缩短', '恶劣工况'],
    symptoms: '进气阻力报警、动力下降、滤芯更换频繁',
    causes: ['矿山粉尘浓度高，滤芯容尘速度远快于标准工况', '劣质滤芯过滤精度不足导致早期磨损', '油品按标准周期更换已不适用'],
    steps: ['空滤清理周期按标准工况的 50%~70% 执行，更换取周期下限', '每次清理同时检查进气管路密封，禁止漏装密封圈', '机滤随机油同步更换，柴滤更换后必须泵油排气', '液压油按油质检测结果更换，而非仅按时间', '建立单机滤芯与油品更换台账，按实际工况动态调整周期'],
    source: '工程机械矿区恶劣工况保养要点'
  }
]

/** 把一条知识库条目渲染成回答 HTML */
function renderEntry(entry) {
  const causes = entry.causes.map(c => `<li>${c}</li>`).join('')
  const steps = entry.steps.map(s => `<li>${s}</li>`).join('')
  return [
    `<strong>${entry.title}</strong>`,
    `<div style="color:var(--text-3);font-size:12px;margin:6px 0 10px">分类：${entry.category} · 来源：${entry.source}</div>`,
    `<div style="margin-bottom:6px">典型现象：${entry.symptoms}</div>`,
    `<div style="margin:8px 0 4px"><strong>可能原因</strong></div><ul style="margin:0;padding-left:18px">${causes}</ul>`,
    `<div style="margin:10px 0 4px"><strong>排查与处置步骤</strong></div><ol style="margin:0;padding-left:18px">${steps}</ol>`,
    entry.caveat
      ? `<div style="margin-top:10px;padding:6px 10px;background:var(--amber-soft);border-radius:6px;color:var(--warn-ink);font-size:12px">口径说明：${entry.caveat}</div>`
      : '',
    `<div style="margin-top:10px;color:var(--text-3);font-size:12px">※ 本条目不给出具体规格数值，扭矩、压力与油品规格一律以随机手册为准。</div>`
  ].join('')
}

export function normalize(text) {
  return String(text || '').toLowerCase().replace(/[\s，。？！,.?!、；;：:"'（）()【】[\]]/g, '')
}

/** 正文相关度的上限。刻意压得比一次标题命中（+12）低，见 scoreByContent 说明。 */
const CONTENT_SCORE_CAP = 8

/** 子串在正文里出现了几次（用来做词频倍率，见 scoreByContent） */
function countOccurrences(body, term) {
  let count = 0
  let at = body.indexOf(term)
  while (at !== -1) {
    count++
    at = body.indexOf(term, at + term.length)
  }
  return count
}

/** 正文的"分空格"形式：仅用于匹配英文词，见 countInBody */
export function normalizeSpaced(text) {
  return String(text || '').toLowerCase()
    .replace(/[，。？！,.?!、；;：:"'（）()【】[\]/\\|]/g, ' ')
    .replace(/\s+/g, ' ')
}

/**
 * 这个词在正文里出现了几次。
 *
 * **中英两套匹配规则，不能用同一个正文**：
 *
 * - 英文词按**词边界**匹配，正文要保留词间空格。normalize() 会把空格也删掉，
 *   "hydraulic oil filter" 变成 "hydraulicoilfilter" —— 既让 `\bhydraulic\b`
 *   找不到边界（后面紧跟的是 o），也让表里所有多词条目（hydraulic oil、
 *   wire rope、lubricating oil）**永远匹配不上**，是三个死条目。
 * - 中文滑窗必须用去掉空格的那份。手册页眉的「随车起重机 操作维护手册」
 *   中间有空格，留着空格「车起」就断了 —— 而页眉正是每个切片都有的。
 *
 * 词边界也不能省：正文里的 "proper installation" 含有 "rope"，
 * 按子串数，第 34 页就凭 "improper" 里的 rope 混进了「钢丝绳」提问的第二名（实测）。
 * 中文没有这个问题 —— 汉字滑窗本来就是词的一部分，"液压系统"里出现「液压」正是要的。
 *
 * 但边界**只卡前面，不卡后面**。手册里的词几乎都以变形出现，实测这份
 * 操作维护手册里只写 "intervals"（×8）、"lubricated/lubricating/lubrication"
 * （×7），从不写光秃秃的 interval / lubricat —— 两头都卡的话，表里这两条
 * 直接变成死词，检索静默地少两路信号。只卡前边界既能收下变形（intervals、
 * lubrication、checks、ropes），又能挡住"嵌在别的词里"（proper 里的 rope、
 * boiler 里的 oil，前面都不是词边界）。
 *
 * @param {string} plain normalize() 后的正文（无空格），中文滑窗用
 * @param {string} spaced normalizeSpaced() 后的正文，英文词用
 * @param {string} term 检索词
 */
export function countInBody(plain, spaced, term) {
  if (/^[a-z][a-z ]*$/.test(term)) {
    const safe = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return (spaced.match(new RegExp(`\\b${safe}`, 'g')) || []).length
  }
  return countOccurrences(plain, term)
}

/** 提问切成去重后的 2 字滑窗 */
function queryGrams(q) {
  const grams = []
  const seen = new Set()
  for (let i = 0; i + 2 <= q.length; i++) {
    const g = q.slice(i, i + 2)
    if (seen.has(g)) continue
    seen.add(g)
    grams.push(g)
  }
  return grams
}

/**
 * 手册切片的**正文相关度**。
 *
 * 为什么需要它：手册切片的元数据整本相同（同一个 title/model），光靠元数据
 * 打分，同一本手册的每个切片必然同分，排序退化成插入顺序 —— 问"液压系统
 * 怎么保养"也会返回第 1/2/3 页（封面、目录），页码与提问内容无关。
 * 只有正文能把页与页区分开。
 *
 * 三道处理，都是被实测否掉一版之后才加的：
 *
 * 1) **剔除"身份词"**。提问里的「SQ10SK3Q」「随车起重机」「操作维护手册」
 *    说明的是"问哪一本"，不是"问这一本的哪一页"，对页间排序零信息。
 *    第一版数命中滑窗，第 1/4/5/12 页全部顶到上限、并列；第二版换成 IDF
 *    加权，并列的换成第 1/4/8/10/11 页 —— 换了个数法，还是好几页同分，
 *    因为 IDF 只认"稀有"，而型号恰恰是**又稀有又没用**：它的文字层只印在
 *    少数几页的页眉上，于是 (1 - df/N) 高达 0.87~0.95，跟"液压""钢丝绳"
 *    这些真正该管的词（≈0.92）不相上下，凭空给那几页加了 3.5 分。
 *    所以身份词必须在算分前整批剔掉，不能指望权重自己压住它。
 *
 * 2) **按文档频率加权**。剔掉身份词后剩下的多是「系统」「操作」「保养」这类
 *    通篇都有的词，页页命中的对区分度没有贡献，权重取 (1 - 出现在多少页 /
 *    总页数) 后自动趋近 0；真正有区分度的（液压、钢丝绳）≈ 0.9。
 *
 * 3) **再看词频**。只按"命中/没命中"算，一页正经讲液压的跟一页只在插图
 *    标题里出现过一次"hydraulic"的同样得分。实测「液压系统怎么保养」这个
 *    提问下，有 7 页都同时命中 hydraulic + maintenance、全部同分，最后靠
 *    插入顺序选出了第 3 页（目录页，只列了章节名）—— 同分退化成下标，
 *    跟没打分一样。词频是个诚实的区分信号：讲这个的页会反复提到它。
 *    取 1+log(tf) 做倍率（次线性，避免长页靠字数取胜），并封顶 3 倍 ——
 *    它仍然是**打破并列**的信号，不该盖过词本身的稀有度。
 *
 * 已知不足：改完仍会把手册的**目录页**（如第 5 页）排进前三。目录罗列了
 * 所有章节名，天然命中多个检索词且词频高，这不是算分算错了。首位引用已经
 * 是正文页（第 30 页，保养计划表），目录页作为补充来源可接受，暂不额外处理。
 *
 * 为什么是 2 字滑窗而不是分词：中文分词要么引依赖、要么自建词典，对一个
 * 离线项目都不划算；2 字滑窗零依赖，且对"液压系统""钢丝绳"这类工程术语够用。
 *
 * 为什么封顶 8 分：它是**打破并列**的信号，不是主判据。压得比标题命中（+12）
 * 低，才能保证"指名问某本手册"时仍是那本手册优先，不会让手册原文顶掉更对症的
 * 精选知识条目。
 *
 * @returns {Map<Object, number>} 条目对象 → 正文分
 */
function scoreByContent(q, entries) {
  const result = new Map()

  // 所有候选切片的"身份文本"（手册名、型号、标题）。提问里出现这些字，
  // 只意味着指名了某本手册，对"翻到哪一页"没有信息量，见上面 1)。
  const identity = normalize(entries
    .flatMap(e => [e.docTitle, e.title, ...(e.keywords || [])])
    .filter(Boolean).join(' '))

  // 手册正文是英文原版，中文提问在正文里没有任何公共子串。所以检索词
  // 分两路：中文滑窗（命中正文里 OCR 出来的中文）+ 身份词之外的词翻译成
  // 英文手册用词（见 synonyms.manualTerms）。两路用同一套 IDF 权重。
  const grams = [
    ...queryGrams(q).filter(g => !identity.includes(g)),
    ...manualTerms(q, identity)
  ]
  if (!grams.length) return result

  const texts = entries.map(e => normalize(e.pageText))
  const spaced = entries.map(e => normalizeSpaced(e.pageText))
  const total = texts.length

  // 文档频率：每个检索词出现在多少个切片里（与词频同一套匹配规则，
  // 否则两边对不上：df 用词边界、tf 用子串，权重和计数会互相矛盾）
  const df = new Map()
  for (const g of grams) {
    let count = 0
    for (let i = 0; i < total; i++) if (countInBody(texts[i], spaced[i], g)) count++
    df.set(g, count)
  }

  entries.forEach((entry, i) => {
    const body = texts[i]
    if (!body) { result.set(entry, 0); return }
    let sum = 0
    for (const g of grams) {
      const seen = df.get(g)
      if (!seen) continue
      const tf = countInBody(body, spaced[i], g)
      if (!tf) continue
      // 稀有度 × 词频倍率（次线性、封顶 3 倍），见上面 3)
      sum += (1 - seen / total) * Math.min(1 + Math.log(tf), 3)
    }
    result.set(entry, Math.min(Math.round(sum * 2), CONTENT_SCORE_CAP))
  })
  return result
}

/**
 * 检索知识库
 * @param {string} question
 * @param {Array} items 知识条目数组（由调用方从 store 传入，便于知识库管理页增删后即时生效）
 * @param {number} limit
 * @returns {Array<{entry: Object, score: number}>} 按相关度排序
 */
export function searchKnowledge(question, items = KNOWLEDGE_BASE, limit = 3) {
  const q = normalize(question)
  const source = Array.isArray(items) ? items : KNOWLEDGE_BASE
  if (!q || !source.length) return []

  // 同义词展开：用户说"漏油"，也匹配含"渗油"的条目
  const expanded = expandQuery(question)

  // 带正文的条目（手册切片）先整批算一次正文分 —— IDF 要看到整批片段
  // 才有意义，逐条算无法判断"这个词是不是页页都有"。
  const withText = source.filter(e => e.pageText)
  const contentScores = withText.length ? scoreByContent(q, withText) : null

  const scored = source.map(entry => {
    let score = 0
    // 手册切片比标题，比的是**手册名**而不是切片标题 —— 后者的
    // 「《》· 第 N 页」装饰会让 q.includes() 永远为假，这条 +12 便形同虚设，
    // 指名问某本手册时它反而排不过别的手册。手册名对整本的所有切片一样，
    // 所以这个加分只决定"哪本手册优先"，本手册内部的页序仍由正文分决定。
    const nTitle = normalize(entry.docTitle || entry.title)
    const nCategory = normalize(entry.category)
    if (q.includes(nTitle)) score += 12
    if (q.includes(nCategory)) score += 4
    for (const keyword of entry.keywords || []) {
      const k = normalize(keyword)
      if (!k) continue
      // 直接匹配
      if (q.includes(k)) {
        score += k.length >= 2 ? 3 : 2
      }
      // 同义词扩展匹配（分值略低于直接命中）
      else if (expanded.has(k)) {
        score += k.length >= 2 ? 2 : 1
      }
    }
    // 带正文的条目额外按正文打分，把同分的页区分开
    if (contentScores) score += contentScores.get(entry) || 0
    return { entry, score }
  })

  return scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/**
 * 设备明细问答（型号、位置、上次维保、超期情况）
 */
function answerEquipmentDetail(store, matched) {
  const days = daysSince(matched.last_maintenance_date)
  const until = daysUntilDue(matched.last_maintenance_date, matched.maintenance_cycle_days)
  const age = equipmentAgeYears(matched.purchase_date)
  const records = store.getMaintenanceByEquipmentId(matched.id)

  const lines = [
    `<strong>${matched.name}</strong>（${matched.model || '型号未录入'}）`,
    `<div style="color:var(--text-3);font-size:12px;margin:6px 0 10px">位置：${matched.location || '未录入'} · 类别：${matched.category || '未录入'}</div>`,
    `<ul style="margin:0;padding-left:18px">`,
    `<li>上次维保：<strong>${matched.last_maintenance_date || '无记录'}</strong>${days !== null ? `（${days} 天前）` : ''}</li>`,
    `<li>维保周期：${matched.maintenance_cycle_days} 天</li>`,
    `<li>${until === null
      ? '暂无足够数据判断维保状态'
      : until < 0
        ? `<span style="color:var(--danger-ink)">已超期 ${-until} 天，建议立即安排</span>`
        : `距下次维保还剩 <strong>${until}</strong> 天`}</li>`,
    age !== null ? `<li>设备机龄：约 ${age.toFixed(1)} 年</li>` : '',
    `</ul>`
  ].filter(Boolean)

  if (records.length) {
    lines.push('<div style="margin:10px 0 4px"><strong>最近维保记录</strong></div>')
    lines.push('<ul style="margin:0;padding-left:18px">')
    for (const record of records.slice(0, 3)) {
      lines.push(`<li>${record.date} · ${record.type} · ${record.description}（${record.technician || '未记录'}）</li>`)
    }
    lines.push('</ul>')
  } else {
    lines.push('<div style="margin-top:8px;color:var(--warn-ink)">该设备暂无维保记录，建议先建立保养基线。</div>')
  }
  if (until !== null && until < 0) {
    lines.push(`<div style="margin-top:8px;color:var(--danger-ink)">${htmlIcon('warning')}该设备已超期，可在维保日历中一键创建工单。</div>`)
  }
  return lines.join('')
}

/**
 * 设备健康体检问答：健康分 + 四因子 + 趋势 + 行动建议
 * 所有数字由 utils/health.js 实时计算，与体检报告完全同源（不会两处口径不一致）
 */
function answerHealth(store, eq) {
  const health = evaluateHealth(eq)
  const trend = store.getTrend ? store.getTrend(eq.id) : null

  const lines = [
    `<strong>${eq.name}</strong> 健康体检`,
    `<div style="margin:6px 0 10px">` +
      `健康分：<strong style="color:${health.color};font-size:18px">${health.score}</strong> / 100 ` +
      `（${health.level} ${health.levelLabel} · ${health.levelDesc}）</div>`,
    '<ul style="margin:0;padding-left:18px">'
  ]

  for (const factor of health.factors) {
    const sign = factor.penalty > 0 ? `扣 ${factor.penalty} 分` : '不扣分'
    lines.push(`<li>${factor.name}：${factor.detail} <span style="color:var(--text-3)">（${sign}）</span></li>`)
  }
  lines.push('</ul>')

  if (health.overdueDays !== null && health.overdueDays > 0) {
    lines.push(`<div style="margin-top:8px;color:var(--danger-ink)">${htmlIcon('warning')}维保已超期 ${health.overdueDays} 天，建议立即安排保养</div>`)
  }
  if (eq.status === 'fault') {
    lines.push(`<div style="margin-top:6px;color:var(--danger-ink)">${htmlIcon('warning')}设备当前处于故障状态，建议立即安排检修</div>`)
  }
  if (health.escalateReasons.length) {
    lines.push(`<div style="margin-top:6px;color:var(--warn-ink)">等级调整依据：${health.escalateReasons.join('；')}</div>`)
  }

  if (trend) {
    lines.push(
      `<div style="margin-top:10px">健康趋势：<span style="color:${trend.color}">${trend.label}</span> — ${trend.summary}</div>`
    )
  }

  lines.push(`<div style="margin-top:8px;color:var(--text-2)">处置建议：${health.conclusion}</div>`)
  lines.push(
    `<div style="margin-top:8px;font-size:12px;color:var(--text-3)">` +
    `以上数字均由本地台账实时计算（共 ${health.factors.length} 个因子，每个因子都带计算式）；` +
    `可在设备台账中一键生成《设备体检报告》查看完整溯源。</div>`
  )

  return lines.join('')
}

/**
 * 台账实时问答：问的是"我的设备"，答案必须来自本地数据库
 */
function answerFromStore(store, question) {
  const q = normalize(question)
  const equipment = store.equipmentList

  // ---- 优先：对比查询 ----
  if (/对比|比较/.test(q)) {
    return answerComparison(store, q)
  }

  // ---- 多设备匹配（用于分类聚合、排名等） ----
  const matchedEquipment = equipment.filter(eq => q.includes(normalize(eq.name)))
  if (matchedEquipment.length >= 2) {
    return answerComparison(store, q, matchedEquipment)
  }

  // 1) 命中具体设备名的问题
  const matched = equipment.find(eq => q.includes(normalize(eq.name)))
  if (matched) {
    // 健康 / 体检类提问：走四因子评估，数字全部实时计算
    if (/健康|体检|评分|风险|怎么样|状态如何|能不能用|还能用/.test(q)) {
      return answerHealth(store, matched)
    }
    return answerEquipmentDetail(store, matched)
  }

  // 2) 超期类问题
  if (q.includes('超期') || q.includes('哪些设备') || q.includes('到期')) {
    const overdue = store.overdueList
    const upcoming = store.upcomingList
    const lines = []
    if (overdue.length) {
      lines.push(`当前有 <strong>${overdue.length} 台</strong>设备维保已超期：`)
      lines.push('<ol style="margin:6px 0 0;padding-left:20px">')
      for (const eq of overdue) {
        lines.push(`<li><strong>${eq.name}</strong>（${eq.model}）— 超期 <span style="color:var(--danger-ink)">${eq.overdueDays} 天</span>，上次维保 ${eq.last_maintenance_date}</li>`)
      }
      lines.push('</ol>')
    } else {
      lines.push('当前没有维保超期的设备。')
    }
    if (upcoming.length) {
      lines.push(`<div style="margin-top:10px">另有 <strong>${upcoming.length} 台</strong>将在 14 天内到期：</div>`)
      lines.push('<ul style="margin:6px 0 0;padding-left:20px">')
      for (const eq of upcoming) {
        lines.push(`<li>${eq.name} — ${eq.daysUntil} 天后到期（${eq.dueDate}）</li>`)
      }
      lines.push('</ul>')
    }
    return lines.join('')
  }

  // 3) 工单类问题
  if (q.includes('工单') || q.includes('待办') || q.includes('处理中')) {
    const pending = store.workOrders.filter(o => o.status === 'pending')
    const processing = store.workOrders.filter(o => o.status === 'processing')
    const lines = [
      `当前工单共 <strong>${store.workOrders.length}</strong> 张：待处理 ${pending.length} 张，处理中 ${processing.length} 张。`
    ]
    const urgent = store.workOrders.filter(o => o.priority === 'urgent' && o.status !== 'completed')
    if (urgent.length) {
      lines.push('<div style="margin-top:10px"><strong>紧急未完成工单</strong></div>')
      lines.push('<ul style="margin:6px 0 0;padding-left:20px">')
      for (const order of urgent) {
        lines.push(`<li>#${order.id} ${order.title}（${order.equipment_name}）</li>`)
      }
      lines.push('</ul>')
    }
    return lines.join('')
  }

  // 4) 统计排名查询
  if (/最多|最高|最少|最低|排名第|排前|排后|故障率|维修次数/.test(q)) {
    return answerRanking(store, q)
  }

  // 5) 分类聚合查询（挖掘机和矿卡/按类别）
  if (/类别|类型|挖掘机.*矿卡|装载机.*矿卡|挖掘机.*装载机|品牌/.test(q)) {
    return answerCategoryStats(store, q)
  }

  // 6) 保养统计查询
  if (/保养.*多少|保养.*统计|保养.*情况|维保.*统计|做了.*保养|换过.*油/.test(q)) {
    return answerMaintenanceStats(store, q)
  }

  // 7) 恶化趋势查询
  if (/恶化|下降|趋势|哪些.*下降/.test(q)) {
    return answerWorsening(store)
  }

  // 8) 台账概况
  if (q.includes('设备') || q.includes('台账') || q.includes('总体') || q.includes('多少台')) {
    const stats = store.stats
    return [
      `本地台账共 <strong>${stats.equipmentCount}</strong> 台设备：运行中 ${stats.runningCount} 台，维保中 ${stats.maintenanceCount} 台，故障 ${stats.faultCount} 台，闲置 ${stats.idleCount} 台。`,
      `<div style="margin-top:8px">维保超期 ${store.overdueList.length} 台，14 天内到期 ${store.upcomingList.length} 台。</div>`,
      `<div style="margin-top:8px;color:var(--text-3);font-size:12px">以上数字均由本地台账实时计算，未上传任何数据。</div>`
    ].join('')
  }

  return null
}

// ============================================================
// 新增查询分支：对比 / 排名 / 分类聚合 / 保养统计 / 恶化趋势
// ============================================================

/** 设备对比（"对比1号和3号挖掘机" / "挖掘机和矿卡哪个更省心"） */
function answerComparison(store, q, explicitEquipment) {
  let eqs = explicitEquipment || []
  // 尝试从问题中提取设备名
  if (!eqs.length) {
    for (const eq of store.equipmentList) {
      if (q.includes(normalize(eq.name))) eqs.push(eq)
    }
  }
  if (eqs.length >= 2) {
    return eqs.slice(0, 4).map(eq => {
      const health = evaluateHealth(eq)
      const orders = store.workOrders.filter(o => o.equipment_id === eq.id)
      const maintenance = store.getMaintenanceByEquipmentId(eq.id)
      const faultOrders = orders.filter(o => o.type === 'repair' && o.status === 'completed')
      const trend = store.getTrend ? store.getTrend(eq.id) : null
      return `<div style="flex:1;min-width:180px;padding:12px;background:var(--line-2);border-radius:8px;border:1px solid var(--line)">` +
        `<div style="font-weight:700;margin-bottom:8px">${eq.name}</div>` +
        `<div>健康分：<strong style="color:${health.color}">${health.score}</strong>（${health.level} ${health.levelLabel}）</div>` +
        `<div>工单数：${orders.length}（故障 ${faultOrders.length}）</div>` +
        `<div>维保次数：${maintenance.length}</div>` +
        `<div>状态：${eq.status === 'running' ? '运行中' : eq.status === 'fault' ? '故障' : eq.status === 'maintenance' ? '维保中' : '闲置'}</div>` +
        (trend ? `<div>趋势：<span style="color:${trend.color}">${trend.label}</span></div>` : '') +
        `</div>`
    }).join('')
      + `<div style="margin-top:12px;padding:8px 12px;background:var(--accent-soft);border-radius:6px;font-size:13px;color:var(--accent)">` +
      `<strong>${htmlIcon('chart')}AI 对比结论：</strong>` +
      (() => {
        const sorted = [...eqs].sort((a, b) => evaluateHealth(b).score - evaluateHealth(a).score)
        const best = sorted[0], worst = sorted[sorted.length - 1]
        const diff = evaluateHealth(best).score - evaluateHealth(worst).score
        return diff > 0
          ? `${best.name} 综合表现更优（健康分高 ${diff} 分）`
          : '两台设备综合表现接近'
      })() + `</div>`
  }
  return null
}

/** 统计排名（"哪台设备维修次数最多" / "故障率最高"） */
function answerRanking(store, q) {
  const sortBy = /维修|工单/.test(q) ? 'orders' : /故障/.test(q) ? 'faults' : /健康/.test(q) ? 'health' : 'orders'
  const isAscending = /最少|最低/.test(q)
  const limit = /前\d/.test(q) ? parseInt(q.match(/前(\d)/)?.[1]) || 5 : 5

  const stats = store.equipmentList.map(eq => {
    const orders = store.workOrders.filter(o => o.equipment_id === eq.id)
    const faultOrders = orders.filter(o => o.type === 'repair')
    const health = evaluateHealth(eq)
    return {
      name: eq.name,
      model: eq.model,
      orderCount: orders.length,
      faultCount: faultOrders.length,
      faultRate: orders.length > 0 ? Math.round((faultOrders.length / orders.length) * 100) : 0,
      healthScore: health.score,
      healthLevel: health.level
    }
  })

  let sorted, metricLabel
  if (sortBy === 'faults') {
    sorted = stats.sort((a, b) => isAscending ? a.faultRate - b.faultRate : b.faultRate - a.faultRate)
    metricLabel = '故障率'
  } else if (sortBy === 'health') {
    sorted = stats.sort((a, b) => isAscending ? a.healthScore - b.healthScore : b.healthScore - a.healthScore)
    metricLabel = '健康分'
  } else {
    sorted = stats.sort((a, b) => isAscending ? a.orderCount - b.orderCount : b.orderCount - a.orderCount)
    metricLabel = '工单数'
  }

  const top = sorted.slice(0, limit)
  const lines = [
    `<div style="margin-bottom:8px">按<strong>${metricLabel}</strong>${isAscending ? '从低到高' : '从高到低'}排列的 TOP${limit} 设备：</div>`,
    '<table style="width:100%;border-collapse:collapse;font-size:13px">',
    '<tr style="background:var(--line-2)"><th style="padding:6px 8px;text-align:left;border-bottom:1px solid var(--line)">排名</th>',
    '<th style="padding:6px 8px;text-align:left;border-bottom:1px solid var(--line)">设备</th>',
    '<th style="padding:6px 8px;text-align:left;border-bottom:1px solid var(--line)">型号</th>',
    '<th style="padding:6px 8px;text-align:center;border-bottom:1px solid var(--line)">工单数</th>',
    '<th style="padding:6px 8px;text-align:center;border-bottom:1px solid var(--line)">故障数</th>',
    '<th style="padding:6px 8px;text-align:center;border-bottom:1px solid var(--line)">故障率</th>',
    '<th style="padding:6px 8px;text-align:center;border-bottom:1px solid var(--line)">健康分</th></tr>'
  ]
  for (let i = 0; i < top.length; i++) {
    const s = top[i]
    const healthColor = levelMeta(s.healthLevel).color
    lines.push(
      `<tr><td style="padding:6px 8px;border-bottom:1px solid var(--line-2)">${i + 1}</td>` +
      `<td style="padding:6px 8px;border-bottom:1px solid var(--line-2);font-weight:600">${s.name}</td>` +
      `<td style="padding:6px 8px;border-bottom:1px solid var(--line-2);color:var(--text-3)">${s.model || '-'}</td>` +
      `<td style="padding:6px 8px;text-align:center;border-bottom:1px solid var(--line-2)">${s.orderCount}</td>` +
      `<td style="padding:6px 8px;text-align:center;border-bottom:1px solid var(--line-2)">${s.faultCount}</td>` +
      `<td style="padding:6px 8px;text-align:center;border-bottom:1px solid var(--line-2);color:${s.faultRate > 30 ? 'var(--danger-ink)' : 'var(--text-1)'}">${s.faultRate}%</td>` +
      `<td style="padding:6px 8px;text-align:center;border-bottom:1px solid var(--line-2);color:${healthColor};font-weight:700">${s.healthScore}</td></tr>`
    )
  }
  lines.push('</table>')
  lines.push('<div style="margin-top:8px;color:var(--text-3);font-size:12px">以上数字均来自本地工单与维保记录实时统计。</div>')
  return lines.join('')
}

/** 分类聚合（"挖掘机和矿卡哪个更省心"） */
function answerCategoryStats(store, q) {
  const categories = {}
  for (const eq of store.equipmentList) {
    const cat = eq.category || '其他'
    if (!categories[cat]) categories[cat] = { count: 0, healthSum: 0, orderCount: 0, faultCount: 0 }
    categories[cat].count++
    categories[cat].healthSum += evaluateHealth(eq).score
    const orders = store.workOrders.filter(o => o.equipment_id === eq.id)
    categories[cat].orderCount += orders.length
    categories[cat].faultCount += orders.filter(o => o.type === 'repair').length
  }

  const rows = Object.entries(categories).map(([cat, data]) => ({
    category: cat,
    count: data.count,
    avgHealth: Math.round(data.healthSum / data.count),
    totalOrders: data.orderCount,
    faultRate: data.orderCount > 0 ? Math.round((data.faultCount / data.orderCount) * 100) : 0
  })).sort((a, b) => b.avgHealth - a.avgHealth)

  const lines = [
    '<div style="margin-bottom:10px">各设备类别综合表现对比：</div>',
    '<table style="width:100%;border-collapse:collapse;font-size:13px">',
    '<tr style="background:var(--line-2)">',
    '<th style="padding:6px 8px;text-align:left;border-bottom:1px solid var(--line)">类别</th>',
    '<th style="padding:6px 8px;text-align:center;border-bottom:1px solid var(--line)">数量</th>',
    '<th style="padding:6px 8px;text-align:center;border-bottom:1px solid var(--line)">平均健康分</th>',
    '<th style="padding:6px 8px;text-align:center;border-bottom:1px solid var(--line)">总工单数</th>',
    '<th style="padding:6px 8px;text-align:center;border-bottom:1px solid var(--line)">故障率</th></tr>'
  ]
  for (const r of rows) {
    // 平均健康分同样走系统可调的阈值，不再写死 85/70/55
    const color = levelMeta(levelOf(r.avgHealth)).color
    lines.push(
      `<tr><td style="padding:6px 8px;border-bottom:1px solid var(--line-2);font-weight:600">${r.category}</td>` +
      `<td style="padding:6px 8px;text-align:center;border-bottom:1px solid var(--line-2)">${r.count} 台</td>` +
      `<td style="padding:6px 8px;text-align:center;border-bottom:1px solid var(--line-2);color:${color};font-weight:700">${r.avgHealth}</td>` +
      `<td style="padding:6px 8px;text-align:center;border-bottom:1px solid var(--line-2)">${r.totalOrders}</td>` +
      `<td style="padding:6px 8px;text-align:center;border-bottom:1px solid var(--line-2)">${r.faultRate}%</td></tr>`
    )
  }
  lines.push('</table>')
  if (rows.length > 1) {
    lines.push(`<div style="margin-top:10px;padding:8px 12px;background:var(--accent-soft);border-radius:6px;font-size:13px;color:var(--accent)">` +
      `<strong>${htmlIcon('chart')}AI 分析：</strong>${rows[0].category}类设备表现最优（平均健康分 ${rows[0].avgHealth}），` +
      `${rows[rows.length - 1].category}类最需关注（平均 ${rows[rows.length - 1].avgHealth} 分，故障率 ${rows[rows.length - 1].faultRate}%）。` +
      `</div>`)
  }
  return lines.join('')
}

/** 保养统计（"今年做了多少次保养"） */
function answerMaintenanceStats(store, q) {
  const allRecords = []
  for (const [eqId, records] of Object.entries(store.maintenanceRecords)) {
    for (const r of records || []) {
      allRecords.push({ ...r, equipment_id: eqId })
    }
  }
  const totalCount = allRecords.length
  const byType = {}
  for (const r of allRecords) {
    const type = r.type || '其他'
    byType[type] = (byType[type] || 0) + 1
  }
  const lines = [
    `本地台账共记录 <strong>${totalCount}</strong> 条维保记录：`,
    '<ul style="margin:8px 0 0;padding-left:20px">'
  ]
  for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    lines.push(`<li>${type}：${count} 条（${Math.round(count / totalCount * 100)}%）</li>`)
  }
  lines.push('</ul>')
  if (allRecords.length > 0) {
    const latest = allRecords.sort((a, b) => String(b.date).localeCompare(String(a.date)))[0]
    lines.push(`<div style="margin-top:8px">最近一次维保：${latest.date} · ${latest.type} · ${latest.description || '无描述'}</div>`)
  }
  lines.push('<div style="margin-top:8px;color:var(--text-3);font-size:12px">以上统计基于本地维保记录实时计算。</div>')
  return lines.join('')
}

/** 恶化趋势查询 */
function answerWorsening(store) {
  const worsening = store.worseningList
  if (!worsening.length) {
    return '当前没有健康分持续下降的设备，车队整体状态稳定。'
  }
  const lines = [
    `<strong>${worsening.length} 台</strong>设备健康分持续下降（恶化中）：`,
    '<ol style="margin:8px 0 0;padding-left:20px">'
  ]
  for (const item of worsening.slice(0, 8)) {
    const snapText = item.trend.snapshots ? item.trend.snapshots.slice(-3).map(s => s.score).join('→') : ''
    lines.push(`<li><strong>${item.name}</strong>（${item.model}）— 健康分 <span style="color:${item.trend.color}">${snapText}</span>，${item.trend.summary}</li>`)
  }
  lines.push('</ol>')
  lines.push('<div style="margin-top:10px;padding:8px 12px;background:var(--danger-soft);border-radius:6px;color:var(--danger-ink);font-size:13px">' +
    `<strong>${htmlIcon('warning')}建议：</strong>健康分连续下降通常意味着设备正在恶化，建议尽快安排全面检修，避免趴窝停机。</div>`)
  return lines.join('')
}

/**
 * 统一的问答入口：先查本地台账（真实数据），再查维保知识库（可溯源规程）
 * @param {object} store Pinia store
 * @param {string} question
 * @param {Array} [items] 知识条目（默认用内置条目；知识库管理页改造后由 store 传入）
 * @returns {{html: string, source: 'ledger'|'knowledge'|'none', refs: string[]}}
 */
export function answerQuestion(store, question, items = KNOWLEDGE_BASE) {
  const source = Array.isArray(items) && items.length ? items : KNOWLEDGE_BASE

  const ledger = answerFromStore(store, question)
  if (ledger) {
    return {
      html: ledger,
      source: 'ledger',
      refs: [`本地台账（${store.equipmentList.length} 台设备 / ${store.workOrders.length} 张工单）`]
    }
  }

  const hits = searchKnowledge(question, source)
  if (hits.length) {
    const html = hits.map((hit, index) => {
      const block = renderEntry(hit.entry)
      return index === 0 ? block : `<div style="margin-top:14px;padding-top:12px;border-top:1px dashed var(--line)">${block}</div>`
    }).join('')
    return {
      html,
      source: 'knowledge',
      refs: hits.map(hit => `《${hit.entry.title}》· ${hit.entry.source}`),
      hits: hits.map(hit => ({ entry: hit.entry, score: hit.score }))
    }
  }

  // 没命中时给出知识库覆盖面，而不是编造答案
  const categories = [...new Set(source.map(e => e.category))]
  return {
    html: [
      `本地知识库中没有检索到与「${escapeHtml(question)}」直接匹配的条目。`,
      `<div style="margin-top:8px">当前本地维保知识库覆盖：<strong>${categories.join('、')}</strong>，共 ${source.length} 条可溯源规程。</div>`,
      `<div style="margin-top:8px">你可以换一种说法，或直接问某台设备的型号、位置、上次维保时间、健康状况与超期情况。</div>`,
      `<div style="margin-top:10px;color:var(--text-3);font-size:12px">说明：系统不会编造答案。未命中时明确告知"查不到"，这也是矿山现场需要的可审计 AI。</div>`
    ].join(''),
    source: 'none',
    refs: []
  }
}

/**
 * 默认知识库的深拷贝（供 store 初始化 / 重置演示数据时使用）
 * 必须返回全新数组，避免 store 与常量共享引用导致误改
 */
export function buildDefaultKnowledge() {
  return KNOWLEDGE_BASE.map(entry => ({
    ...entry,
    keywords: [...(entry.keywords || [])],
    causes: [...(entry.causes || [])],
    steps: [...(entry.steps || [])]
  }))
}

// ============================================================
// AI 知识进化：从工单自动提炼 + 智能推荐
// ============================================================

/** 故障关键词 → 系统分类映射 */
const FAULT_SYSTEM_KEYWORDS = {
  '液压系统': ['液压', '油压', '压力', '油缸', '泵', '阀', '马达', '液压油', '先导'],
  '动力系统': ['发动机', '水温', '过热', '高温', '机油', '异响', '动力', '涡轮', '增压'],
  '制动系统': ['制动', '刹车', '刹车片', '制动液', '刹车油', '缓速器'],
  '行走机构': ['轮胎', '履带', '行走', '跑偏', '磨损', '支重轮', '张紧'],
  '电气系统': ['电气', '电路', '电瓶', '传感器', '线束', '保险', '继电器', '控制器'],
  '钻机系统': ['钻杆', '钻头', '振动', '冲击', '回转', '推进'],
  '破碎设备': ['破碎', '衬板', '破碎腔', '给料', '圆锥'],
  '传动系统': ['变速箱', '变矩器', '传动', '离合器', '传动轴'],
}

function detectFaultSystem(text) {
  const t = normalize(text)
  for (const [system, keywords] of Object.entries(FAULT_SYSTEM_KEYWORDS)) {
    for (const kw of keywords) {
      if (t.includes(normalize(kw))) return system
    }
  }
  return '其他'
}

/**
 * 从已完成工单中自动提炼知识条目
 *
 * 触发条件：同一设备同一故障系统出现 ≥3 次
 * 产出：标记为 'ai_draft' 的知识条目，等待人工确认
 *
 * @param {object} store appStore 实例
 * @param {number} equipmentId 触发提炼的设备 ID
 * @returns {number} 新生成的草稿条数
 */
export function extractKnowledgeFromOrders(store, equipmentId) {
  const eq = store.equipmentList.find(e => String(e.id) === String(equipmentId))
  if (!eq) return 0

  const orders = store.workOrders.filter(o =>
    String(o.equipment_id) === String(equipmentId) && o.status === 'completed')
  if (orders.length < 3) return 0

  // 按故障系统分组
  const groups = {}
  for (const order of orders) {
    const system = detectFaultSystem(order.title + ' ' + (order.description || ''))
    if (!groups[system]) groups[system] = []
    groups[system].push(order)
  }

  let generated = 0
  for (const [system, groupOrders] of Object.entries(groups)) {
    if (groupOrders.length < 3) continue
    if (system === '其他') continue // 不提炼太模糊的分类

    // 查重：同一设备同一系统是否已有草稿
    const existingDraft = store.knowledgeItems.find(k =>
      k.status === 'ai_draft' &&
      normalize(k.title).includes(normalize(eq.category)) &&
      normalize(k.title).includes(normalize(system)))
    if (existingDraft) {
      existingDraft.frequency = groupOrders.length
      continue
    }

    // 提取相关维保记录
    const records = store.getMaintenanceByEquipmentId(eq.id)
    const partsList = records
      .map(r => r.parts_used)
      .filter(Boolean)
      .flatMap(p => p.split(/[,，、]/))
      .map(p => p.trim())
      .filter(Boolean)
    const partFreq = {}
    for (const p of partsList) { partFreq[p] = (partFreq[p] || 0) + 1 }
    const commonParts = Object.entries(partFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([p, c]) => `${p}（${c}次）`)

    // 平均维修时长
    const durations = groupOrders
      .filter(o => o.completed_at && o.created_at)
      .map(o => {
        const created = new Date(o.created_at).getTime()
        const completed = new Date(o.completed_at).getTime()
        return (completed - created) / 3600000 // 小时
      })
      .filter(h => h > 0 && h < 720) // 排除异常值
    const avgHours = durations.length > 0
      ? Math.round(durations.reduce((s, h) => s + h, 0) / durations.length)
      : null

    // 生成草稿
    store.addKnowledgeItem({
      title: `${eq.category} ${system}高频故障（${eq.name}）`,
      category: system,
      keywords: [eq.category, system.replace('系统', ''), eq.model, '高频', '反复'],
      symptoms: `该设备近期反复出现${system}类故障，共 ${groupOrders.length} 次工单记录。最近一次：${groupOrders[0].title}`,
      causes: [
        `累计 ${groupOrders.length} 次同类故障，存在系统性问题可能`,
        ...commonParts.map(p => `高频更换部件：${p}`)
      ],
      steps: [
        `建议对${system}做全面排查，定位根本原因`,
        commonParts.length ? `高频更换件：${commonParts.join('、')}，建议检查其上游关联部件` : '',
        avgHours ? `历史平均维修耗时约 ${avgHours} 小时，建议提前安排人员和备件` : '',
        `如果短期无法根治，建议缩短该系统的巡检周期`
      ].filter(Boolean),
      source: `AI 自动提炼（基于 ${groupOrders.length} 条工单记录）`,
      status: 'ai_draft',
      frequency: groupOrders.length,
      avg_repair_hours: avgHours
    })
    generated++
  }
  return generated
}

/**
 * 知识库智能推荐：根据设备和故障描述推荐相关知识条目
 *
 * @param {object} equipment 设备对象
 * @param {string} faultText 故障描述文本
 * @param {Array} items 知识条目数组
 * @returns {Array<{entry, score, relevance}>} 带归一化相关度的推荐结果
 */
export function recommendKnowledge(equipment, faultText, items) {
  const parts = [equipment?.category, equipment?.model, faultText].filter(Boolean)
  if (!parts.length) return []
  const q = parts.join(' ')
  const results = searchKnowledge(q, items, 5)
  const maxScore = results.length > 0 ? results[0].score : 1
  return results
    .filter(r => r.score >= 3)
    .map(r => ({
      ...r,
      relevance: Math.min(99, Math.max(10, Math.round((r.score / Math.max(maxScore, 1)) * 100)))
    }))
}
