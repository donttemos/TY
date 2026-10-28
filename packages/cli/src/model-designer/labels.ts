/*
 * @file 模型/字段中文标注（PRD-017 FR-17-04 补充）
 * @description 两个来源，优先真实注释：
 *   ① schema 里的 `/// 用户` 文档注释（labelSource='comment'）；
 *   ② 没有注释时按命名推断（'suggested'），如 `UserProfile` → 用户资料、`createdAt` → 创建时间。
 *   推断**只用于展示**，不会写回 schema——避免把「猜的中文」当成项目事实。
 *   认不出的名字返回空串，宁可不显示也不乱译。
 * @author donttemo
 * @created 2026-10-28
 * @module cli/model-designer
 * @since v0.8.0
 */

/** 词表：模型与字段共用，按 token 精确匹配（大小写不敏感） */
const WORDS: Record<string, string> = {
  user: '用户',
  account: '账号',
  profile: '资料',
  member: '会员',
  customer: '客户',
  tenant: '租户',
  role: '角色',
  permission: '权限',
  menu: '菜单',
  dict: '字典',
  config: '配置',
  setting: '设置',
  option: '选项',
  order: '订单',
  item: '条目',
  product: '商品',
  goods: '商品',
  sku: 'SKU',
  category: '分类',
  tag: '标签',
  brand: '品牌',
  cart: '购物车',
  coupon: '优惠券',
  payment: '支付',
  refund: '退款',
  invoice: '发票',
  stock: '库存',
  warehouse: '仓库',
  supplier: '供应商',
  address: '地址',
  logistics: '物流',
  notice: '通知',
  message: '消息',
  comment: '评论',
  article: '文章',
  content: '内容',
  file: '文件',
  image: '图片',
  attachment: '附件',
  log: '日志',
  audit: '审计',
  archive: '归档',
  job: '任务',
  task: '任务',
  schedule: '调度',
  stat: '统计',
  statistic: '统计',
  report: '报表',
  dashboard: '看板',
  session: '会话',
  token: '令牌',
  verifier: '验证器',
  code: '编码',
  record: '记录',
  detail: '明细',
  group: '分组',
  type: '类型',
  status: '状态',
  level: '等级',
  demo: '演示',
  example: '示例',
  sample: '示例',
  test: '测试',
  admin: '管理',
  system: '系统',
  app: '应用',
  application: '应用',
  module: '模块',
  page: '页面',
  form: '表单',
  field: '字段',
  schema: '结构',
  project: '项目',
  workspace: '空间',
  organization: '组织',
  department: '部门',
  position: '职位',
  employee: '员工',
  store: '门店',
  shop: '店铺',
  plan: '套餐',
  subscription: '订阅',
  quota: '配额',
  usage: '用量',
  event: '事件',
  history: '历史',
  template: '模板',
  workflow: '流程',
  approval: '审批',
  ticket: '工单',
  // 字段常用词
  id: 'ID',
  name: '名称',
  title: '标题',
  display: '展示',
  label: '标签',
  value: '值',
  key: '键',
  sort: '排序',
  orderno: '排序',
  enabled: '启用',
  disabled: '禁用',
  active: '激活',
  visible: '可见',
  required: '必填',
  remark: '备注',
  description: '描述',
  summary: '摘要',
  note: '备注',
  count: '数量',
  amount: '金额',
  total: '合计',
  price: '价格',
  quantity: '数量',
  qty: '数量',
  number: '编号',
  serial: '序列号',
  email: '邮箱',
  phone: '手机号',
  mobile: '手机号',
  avatar: '头像',
  icon: '图标',
  color: '颜色',
  url: '链接',
  link: '链接',
  path: '路径',
  size: '大小',
  version: '版本',
  extra: '扩展',
  metadata: '元数据',
  parent: '父级',
  child: '子级',
  start: '开始',
  end: '结束',
  expire: '过期',
  expired: '过期',
  publish: '发布',
  published: '发布',
  created: '创建',
  updated: '更新',
  deleted: '删除',
  creator: '创建人',
  updater: '更新人',
  operator: '操作人',
  owner: '负责人',
  actor: '操作者',
  target: '目标',
  source: '来源',
  result: '结果',
  reason: '原因',
  action: '动作',
  categoryid: '分类 ID',
  tenantid: '租户 ID',
  userid: '用户 ID',
  username: '用户名',
  nickname: '昵称',
  password: '密码',
  salt: '盐值',
  done: '完成',
  weight: '重量',
  banner: '横幅',
  slug: '别名',
  ip: 'IP',
  useragent: '浏览器',
  traceid: '追踪 ID',
  requestid: '请求 ID',
  actorlabel: '操作者',
  targetlabel: '目标',
  beforevalue: '变更前',
  aftervalue: '变更后',
  sortorder: '排序',
  sortno: '排序',
  createdat: '创建时间',
  updatedat: '更新时间',
  deletedat: '删除时间',
  createdby: '创建人',
  updatedby: '更新人',
  list: '列表',
  list_page_size: '分页大小',
};

/** 后缀补充：token 以这些结尾时再拼一层 */
const SUFFIXES: { suffix: string; text: string }[] = [
  { suffix: 'Count', text: '数量' },
  { suffix: 'Amount', text: '金额' },
  { suffix: 'Time', text: '时间' },
  { suffix: 'Date', text: '日期' },
  { suffix: 'List', text: '列表' },
  { suffix: 'Type', text: '类型' },
  { suffix: 'Status', text: '状态' },
  { suffix: 'Id', text: 'ID' },
  { suffix: 'Ids', text: 'ID 列表' },
  { suffix: 'Url', text: '链接' },
  { suffix: 'At', text: '时间' },
  { suffix: 'By', text: '人' },
];

/**
 * 拆分驼峰/下划线/中划线
 * @param name 标识符
 */
export function splitTokens(name: string): string[] {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

/**
 * 按命名推断中文标注
 * @description 全部 token 都能翻译才返回；有一个认不出就返回空串（宁可不显示也不乱译）。
 * @param name 模型名/字段名
 * @returns 中文标注或空串
 */
export function suggestLabel(name: string): string {
  const cleaned = name.trim();
  if (cleaned === '') return '';

  // 已知整词优先（如 createdAt 作为一个整体更准确）
  const whole = WORDS[cleaned.toLowerCase()];
  if (whole !== undefined) return whole;

  const tokens = splitTokens(cleaned);
  if (tokens.length === 0) return '';

  const parts: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (WORDS[lower] !== undefined) {
      parts.push(WORDS[lower]);
      continue;
    }
    // 后缀补充：如 stockCount → 库存 + 数量
    const suffix = SUFFIXES.find((item) => token.endsWith(item.suffix) && token.length > item.suffix.length);
    if (suffix) {
      const head = token.slice(0, -suffix.suffix.length);
      const headText = WORDS[head.toLowerCase()] ?? '';
      if (headText !== '') {
        parts.push(`${headText}${suffix.text === 'ID' ? ' ID' : suffix.text}`);
        continue;
      }
    }
    // 有一个 token 认不出：整条不猜
    return '';
  }
  return parts.join('');
}

/**
 * 读取 `///` 文档注释
 * @param line schema 原始行
 * @returns 注释正文（去掉 `///` 与前导空格）或 null
 */
export function docCommentOf(line: string): string | null {
  const matched = line.match(/^\s*\/\/\/\s*(.+?)\s*$/);
  if (!matched) return null;
  // 常见写法 `/// 用户` 或 `///用户：系统账号`
  return matched[1].trim();
}
