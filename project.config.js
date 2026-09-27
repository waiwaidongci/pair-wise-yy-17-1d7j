module.exports = {
  port: 3912,
  title: '钟乳石洞穴微环境巡测',
  lede: '基准版本按生效时刻归档；巡测按当天所处版本判定温度、湿度、CO2 三项范围。基准补录或修订后，受影响巡测与复查记录自动重算，人工结论不能覆盖新判定。',
  tones: {
    '常规观察': 'ok',
    '正常': 'ok',
    '已复查': 'ok',
    '重点保护': 'warn',
    '异常待复查': 'bad',
    '暂停开放': 'bad'
  },
  collections: {
    sites: { label: '样点档案' },
    baselines: { label: '基准版本' },
    surveys: { label: '巡测记录' }
  },
  baselineFields: {
    temp: { label: '基准温度' },
    tempTolerance: { label: '温度允许波动' },
    humidity: { label: '基准湿度' },
    humidityTolerance: { label: '湿度允许波动' },
    co2: { label: '基准CO2' },
    co2Tolerance: { label: 'CO2允许波动' }
  },
  surveyMetricLabels: {
    temperature: '温度',
    humidity: '湿度',
    co2: 'CO2',
    dripRate: '滴水频率'
  },
  stats: [
    { label: '样点', collection: 'sites' },
    { label: '基准版本', collection: 'baselines' },
    { label: '巡测记录', collection: 'surveys' },
    { label: '待复查', collection: 'surveys', filter: { field: 'status', value: '异常待复查' } }
  ],
  views: [
    {
      id: 'dashboard',
      label: '趋势看板',
      type: 'dashboard',
      focusTitle: '异常与复查',
      focus: { collection: 'surveys', field: 'status', values: ['异常待复查'], limit: 8 }
    },
    {
      id: 'sites',
      label: '样点档案',
      collection: 'sites',
      formTitle: '新增样点',
      listTitle: '样点列表',
      submitLabel: '保存样点',
      searchPlaceholder: '搜索洞穴、分区、样点、路线',
      searchFields: ['cave', 'zone', 'pointCode', 'route'],
      statusField: 'protectedStatus',
      statusOptions: ['常规观察', '重点保护', '暂停开放'],
      titleFields: ['pointCode', 'zone'],
      summaryFields: ['note'],
      detailFields: [
        { label: '洞穴', name: 'cave' },
        { label: '巡测路线', name: 'route' },
        { label: '敏感等级', name: 'sensitivity' }
      ],
      fields: [
        { label: '洞穴', name: 'cave', required: true },
        { label: '分区', name: 'zone', required: true },
        { label: '样点编号', name: 'pointCode', required: true },
        { label: '巡测路线', name: 'route', required: true },
        { label: '敏感等级', name: 'sensitivity', type: 'select', options: ['低', '中', '高'] },
        { label: '保护状态', name: 'protectedStatus', type: 'select', options: ['常规观察', '重点保护', '暂停开放'] },
        { label: '备注', name: 'note', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'baselines',
      label: '基准版本',
      collection: 'baselines',
      formTitle: '补录基准版本',
      listTitle: '版本台账',
      submitLabel: '保存基准版本',
      searchPlaceholder: '搜索备注、版本',
      searchFields: ['note'],
      titleField: 'versionTitle',
      titlePrefix: '基准',
      revision: true,
      relation: { collection: 'sites', localKey: 'siteId', labelFields: ['cave', 'zone', 'pointCode'] },
      detailFields: [
        { label: '生效时刻', name: 'effectiveAt', type: 'datetime' },
        { label: '温度基准/波动', name: 'tempRange', type: 'baselineMetric', baseline: 'temp' },
        { label: '湿度基准/波动', name: 'humidityRange', type: 'baselineMetric', baseline: 'humidity' },
        { label: 'CO2基准/波动', name: 'co2Range', type: 'baselineMetric', baseline: 'co2' }
      ],
      fields: [
        { label: '样点', name: 'siteId', type: 'relation', collection: 'sites', labelFields: ['cave', 'zone', 'pointCode'], required: true, wide: true },
        { label: '版本生效时刻', name: 'effectiveAt', type: 'datetime-local', required: true, hint: '历史基准可按发生时刻补录，保存后自动重算受影响巡测' },
        { label: '基准温度（℃）', name: 'temp', type: 'number', step: '0.1', required: true },
        { label: '温度允许波动（℃）', name: 'tempTolerance', type: 'number', step: '0.1', required: true },
        { label: '基准湿度（%RH）', name: 'humidity', type: 'number', step: '0.1', required: true },
        { label: '湿度允许波动（%RH）', name: 'humidityTolerance', type: 'number', step: '0.1', required: true },
        { label: '基准CO2（ppm）', name: 'co2', type: 'number', step: '1', required: true },
        { label: 'CO2允许波动（ppm）', name: 'co2Tolerance', type: 'number', step: '1', required: true },
        { label: '修订/补录说明', name: 'note', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'surveys',
      label: '巡测台账',
      collection: 'surveys',
      formTitle: '登记巡测',
      listTitle: '巡测历史',
      submitLabel: '保存巡测',
      searchPlaceholder: '搜索人员、干扰痕迹、照片',
      searchFields: ['surveyor', 'disturbance', 'photoUrl'],
      statusField: 'status',
      statusOptions: ['正常', '异常待复查', '已复查'],
      titleFields: ['surveyor', 'date'],
      relation: { collection: 'sites', localKey: 'siteId', labelFields: ['cave', 'zone', 'pointCode'] },
      summaryFields: ['disturbance'],
      showJudgment: true,
      actionStatusFilter: '异常待复查',
      detailFields: [
        { label: '滴水频率', name: 'dripRate' }
      ],
      fields: [
        { label: '样点', name: 'siteId', type: 'relation', collection: 'sites', labelFields: ['cave', 'zone', 'pointCode'], required: true, wide: true },
        { label: '巡测人员', name: 'surveyor', required: true },
        { label: '日期', name: 'date', type: 'date', required: true },
        { label: '温度（℃）', name: 'temperature', type: 'number', step: '0.1', required: true },
        { label: '湿度（%RH）', name: 'humidity', type: 'number', step: '0.1', required: true },
        { label: 'CO2（ppm）', name: 'co2', type: 'number', step: '1', required: true },
        { label: '滴水频率', name: 'dripRate', type: 'number', step: '1', required: true },
        { label: '照片链接', name: 'photoUrl' },
        { label: '游客干扰痕迹', name: 'disturbance', type: 'textarea', wide: true }
      ]
    }
  ],
  actions: [
    { id: 'site-normal', label: '常规观察', collection: 'sites', patches: [{ field: 'protectedStatus', value: '常规观察' }] },
    { id: 'site-focus', label: '重点保护', collection: 'sites', patches: [{ field: 'protectedStatus', value: '重点保护' }] },
    { id: 'site-close', label: '暂停开放', collection: 'sites', danger: true, patches: [{ field: 'protectedStatus', value: '暂停开放' }] }
  ],
  reviewAction: { id: 'survey-review', label: '完成复查', collection: 'surveys' }
};
