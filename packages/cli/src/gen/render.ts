/*
 * @file 生成计划组装（渲染编排）
 * @description PRD-006 FR-02/03/04/06：把 schema 元信息 + 模板渲染为「待写入文件计划」。
 *   本层不落盘（落盘与安全策略在 writer.ts），因此 dry-run 与真实生成共用同一条渲染路径，
 *   保证 --dry 输出与真实生成完全一致（TC-GEN-004）。
 *   目录约定：后端 apps/<app>/src/modules/<model>/，前端 apps/<web>/src/{api,views}/<model>/，
 *   seed 落 apps/<app>/prisma/seed/<model>.seed.ts（PRD-006 §6）。
 * @author donttemo
 * @created 2026-10-13
 * @module cli/gen
 */

import fs from 'node:fs';
import path from 'node:path';
import { renderTemplate } from './template-engine.js';
import { resolveTemplate } from './templates.js';
import { parsePrismaSchema, type ParsedModel, type ParsedSchema } from './schema-parser.js';
import {
  kebabCase,
  pascalCase,
  pluralize,
  resolveModelFields,
  type FieldMeta,
  type TypeOverrides,
} from './type-map.js';

/** 待写入文件（相对项目根） */
export interface PlanFile {
  /** 相对项目根的路径（统一 / 分隔） */
  path: string;
  /** 渲染后的完整内容 */
  content: string;
  /** 产物类型 */
  kind: 'backend' | 'frontend' | 'seed';
  /**
   * 写入方式（PRD-016 FR-16-02）：
   *   - create（默认）：新建文件，已存在默认跳过、--force 才覆盖；
   *   - patch：重写既有文件的标记块，**不需要 --force**，文件必须已存在，内容相同则不算变更。
   */
  mode?: 'create' | 'patch';
}

/** 生成范围 */
export type GenScope = 'all' | 'backend' | 'frontend' | 'seed';

/** 生成选项（runGenCrud 归一后透传） */
export interface RenderOptions {
  /** 模型名列表（原始输入，归一化后匹配 schema） */
  models: string[];
  /** 生成范围 */
  scope?: GenScope;
  /** 后端应用目录名（apps/<app>）；缺省自动探测 */
  app?: string;
  /** 前端应用目录名（apps/<web>）；缺省自动探测 */
  web?: string;
  /** schema 相对路径；缺省 <app>/prisma/schema.prisma */
  schema?: string;
  /** 作者（FR-11：git config user.name 或回退默认署名） */
  author: string;
  /** 创建日期 YYYY-MM-DD */
  created: string;
  /** 框架版本 */
  since: string;
  /** 项目根目录 */
  projectRoot: string;
  /** 自定义模板变量（codegen.config.json → vars） */
  vars?: Record<string, string>;
  /** 项目级类型映射覆盖（codegen.config.json → typeOverrides） */
  typeOverrides?: TypeOverrides;
}

/** 模板数据中的模型元信息 */
interface ModelView {
  name: string;
  camel: string;
  kebab: string;
  pluralKebab: string;
  routePath: string;
  apiPath: string;
  comment: string;
  permissionPrefix: string;
  constName: string;
}

/** 探测到的应用布局 */
export interface AppLayout {
  /** 后端应用根（绝对路径） */
  backendRoot: string;
  /** 后端模块目录（绝对路径） */
  backendModulesDir: string;
  /** 前端应用根（绝对路径） */
  webRoot: string;
  /** schema 绝对路径 */
  schemaFile: string;
}

/**
 * 组装单个模型的生成计划
 * @param model 目标模型（已解析）
 * @param schema 全量解析结果（外键目标推导用）
 * @param options 生成选项
 * @returns 待写入文件列表（相对项目根路径）
 */
export function buildModelPlan(model: ParsedModel, schema: ParsedSchema, options: RenderOptions): PlanFile[] {
  const layout = resolveLayout(options);
  const fields = resolveModelFields(model, { enums: schema.enums, overrides: options.typeOverrides });
  const modelView = toModelView(model);
  const data = buildTemplateData(modelView, fields, options);

  const plan: PlanFile[] = [];
  const scope = options.scope ?? 'all';

  if (scope === 'all' || scope === 'backend') {
    plan.push(
      ...renderBackend(modelView, layout, data),
    );
  }
  if (scope === 'all' || scope === 'frontend') {
    plan.push(...renderFrontend(modelView, layout, data));
  }
  if (scope === 'all' || scope === 'seed') {
    plan.push(...renderSeed(modelView, layout, data));
  }
  return plan;
}

/**
 * 组装全部目标模型的生成计划
 * @param options 生成选项
 */
export function buildPlan(options: RenderOptions): { schema: ParsedSchema; models: ParsedModel[]; plan: PlanFile[] } {
  const layout = resolveLayout(options);
  if (!fs.existsSync(layout.schemaFile)) {
    throw new Error(`未找到数据模型：${layout.schemaFile}（请在项目根执行，或用 --schema=<路径> 指定）`);
  }
  const schema = parsePrismaSchema(fs.readFileSync(layout.schemaFile, 'utf8'));
  const models = matchModels(schema, options.models);
  const plan = models.flatMap((model) => buildModelPlan(model, schema, options));
  return { schema, models, plan };
}

/** 模型名归一匹配：支持 Order / order / order-item / order_item 四种写法 */
export function matchModels(schema: ParsedSchema, requested: string[]): ParsedModel[] {
  const matched: ParsedModel[] = [];
  for (const raw of requested) {
    // pascalCase 自带分隔符处理：order-item → OrderItem，勿预先剥离分隔符
    const target = pascalCase(raw);
    const model = schema.models.find((m) => m.name === target);
    if (!model) {
      throw new Error(`schema 中不存在模型：${raw}（已有模型：${schema.models.map((m) => m.name).join(' / ')}）`);
    }
    if (!matched.includes(model)) matched.push(model);
  }
  return matched;
}

/** 探测应用布局（后端 / 前端 / schema 位置） */
export function resolveLayout(options: RenderOptions): AppLayout {
  const root = options.projectRoot;
  const appsDir = path.join(root, 'apps');

  // 后端应用：显式指定 > apps 下含 prisma/schema.prisma 的应用（优先 example-api）> 项目根自身
  let backendRoot: string;
  if (options.app) {
    backendRoot = path.join(appsDir, options.app);
    if (!fs.existsSync(backendRoot)) {
      throw new Error(`后端应用不存在：${backendRoot}（--app 可选值见 apps/ 目录）`);
    }
  } else if (fs.existsSync(appsDir)) {
    const candidates = fs
      .readdirSync(appsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(appsDir, entry.name, 'prisma', 'schema.prisma')))
      .map((entry) => entry.name)
      .sort();
    const picked = candidates.includes('example-api') ? 'example-api' : candidates[0];
    backendRoot = picked ? path.join(appsDir, picked) : root;
  } else {
    backendRoot = root;
  }

  const schemaFile = options.schema
    ? path.resolve(root, options.schema)
    : path.join(backendRoot, 'prisma', 'schema.prisma');

  // 前端应用：显式指定 > apps 下含 src/components/CrudTable 的应用（优先 admin-web）> 项目根自身
  let webRoot: string;
  if (options.web) {
    webRoot = path.join(appsDir, options.web);
    if (!fs.existsSync(webRoot)) {
      throw new Error(`前端应用不存在：${webRoot}（--web 可选值见 apps/ 目录）`);
    }
  } else if (fs.existsSync(appsDir)) {
    const candidates = fs
      .readdirSync(appsDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          fs.existsSync(path.join(appsDir, entry.name, 'src', 'components', 'CrudTable', 'index.vue')),
      )
      .map((entry) => entry.name)
      .sort();
    const picked = candidates.includes('admin-web') ? 'admin-web' : candidates[0];
    webRoot = picked ? path.join(appsDir, picked) : path.join(appsDir, 'admin-web');
  } else {
    // 无 apps 目录：两种形态
    //   ① 单项目（前端源码就在 root/src 下）；
    //   ② fw new --template=admin 产出的「后端 server/ + 前端 admin-web/」兄弟目录
    //      （此时 cwd 通常是 server/，前端在 ../admin-web）——不识别会把前端产物写进后端根。
    const sibling = ['admin-web', 'web', 'frontend']
      .map((name) => path.resolve(root, '..', name))
      .find((dir) => fs.existsSync(path.join(dir, 'src', 'components', 'CrudTable', 'index.vue')));
    webRoot = sibling ?? root;
  }

  return {
    backendRoot,
    backendModulesDir: path.join(backendRoot, 'src', 'modules'),
    webRoot,
    schemaFile,
  };
}

/** 构造模板视图（模型级命名与路径） */
function toModelView(model: ParsedModel): ModelView {
  const kebab = kebabCase(model.name);
  const pluralKebab = pluralize(kebab);
  return {
    name: model.name,
    camel: kebab.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase()),
    kebab,
    pluralKebab,
    routePath: `/${pluralKebab}`,
    apiPath: `/api/v1/${pluralKebab}`,
    comment: model.comment ?? model.name,
    permissionPrefix: kebab,
    constName: model.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase(),
  };
}

/** 字段分组（模板与预渲染片段共用） */
interface FieldGroups {
  entityFields: FieldMeta[];
  createFields: FieldMeta[];
  searchFields: FieldMeta[];
  listFields: FieldMeta[];
  formFields: FieldMeta[];
  uniqueFields: FieldMeta[];
}

/** 按用途分组字段 */
function groupFields(fields: FieldMeta[]): FieldGroups {
  return {
    // 实体字段：除 BaseEntity 通用字段外全部
    entityFields: fields.filter((f) => !f.isBase),
    // 新建输入：除通用字段与主键外全部（主键由 uuid 默认值生成）
    createFields: fields.filter((f) => !f.isBase && !f.isId),
    // 查询字段：可搜索的字符串 / 枚举 / 时间字段
    searchFields: fields.filter((f) => !f.isBase && (f.prismaType === 'String' || f.isEnum || f.prismaType === 'DateTime') && f.searchable),
    // 列表列：可展示字段 + 创建时间（渲染时追加）
    listFields: fields.filter((f) => !f.isBase && f.listable),
    // 表单字段：除通用字段与主键外全部
    formFields: fields.filter((f) => !f.isBase && !f.isId),
    // 唯一键字段（Repository 便捷查询用）
    uniqueFields: fields.filter((f) => !f.isBase && f.unique),
  };
}

/** 构造模板数据（含预渲染代码片段） */
function buildTemplateData(model: ModelView, fields: FieldMeta[], options: RenderOptions): Record<string, unknown> {
  const groups = groupFields(fields);
  return {
    model,
    fields,
    ...groups,
    author: options.author,
    created: options.created,
    since: options.since,
    // 预渲染片段（前端 CrudTable 配置与 Repository 便捷方法）
    columnsCode: renderColumnsCode(groups.listFields),
    searchCode: renderSearchCode(groups.searchFields),
    formCode: renderFormCode(groups.formFields, options.author, options.created),
    listItemFieldsCode: renderListItemFieldsCode(groups.listFields),
    uniqueMethodsCode: renderUniqueMethodsCode(model, groups.uniqueFields),
    keywordField: groups.searchFields.find((f) => f.prismaType === 'String')?.name ?? '',
    searchableSummary: groups.searchFields.map((f) => f.label).join(' / ') || '无（可搜索字段为空）',
    // 模板定位上下文（项目级同名模板优先，见 templates.ts）
    projectRoot: options.projectRoot,
    ...(options.vars ?? {}),
  };
}

/** CrudColumn[] 代码片段 */
function renderColumnsCode(listFields: FieldMeta[]): string {
  const lines = listFields.map((field) => {
    switch (field.control) {
      case 'datetime':
        return `  { prop: '${field.name}', label: '${field.label}', width: 180, slot: '${field.name}' },`;
      case 'switch':
        return `  { prop: '${field.name}', label: '${field.label}', width: 90, align: 'center' },`;
      case 'select':
        return `  { prop: '${field.name}', label: '${field.label}', width: 140 },`;
      case 'number':
        return `  { prop: '${field.name}', label: '${field.label}', width: 110, align: 'right' },`;
      case 'dict-select':
        return `  { prop: '${field.name}', label: '${field.label}', width: 110, align: 'center', slot: '${field.name}' },`;
      default:
        return `  { prop: '${field.name}', label: '${field.label}', minWidth: 120, showOverflowTooltip: true },`;
    }
  });
  lines.push(`  { prop: 'createdAt', label: '创建时间', width: 180, slot: 'createdAt' },`);
  return lines.join('\n');
}

/** SearchField[] 代码片段 */
function renderSearchCode(searchFields: FieldMeta[]): string {
  return searchFields
    .map((field) => {
      if (field.isEnum) {
        return `  { prop: '${field.name}', label: '${field.label}', type: 'dict-select', dictCode: '${field.dictCode}' },`;
      }
      if (field.prismaType === 'DateTime') {
        return `  { prop: '${field.name}', label: '${field.label}', type: 'date' },`;
      }
      return `  { prop: '${field.name}', label: '${field.label}', type: 'input', placeholder: '${field.label}' },`;
    })
    .join('\n');
}

/** FormField[] 代码片段（含校验规则；外键绑定数据源的 TODO 带责任人与日期，过文件头门禁） */
function renderFormCode(formFields: FieldMeta[], author: string, created: string): string {
  return formFields
    .map((field) => {
      const rules: string[] = [];
      if (field.required && field.control !== 'switch') {
        rules.push(`{ required: true, message: '请输入${field.label}', trigger: 'blur' }`);
      }
      // 附件字段：长度校验无意义（值是文件 id），类型/大小白名单由服务端 @fw/storage 把关
      if (field.maxLength !== undefined && field.control !== 'upload') {
        rules.push(`{ max: ${field.maxLength}, message: '长度不超过 ${field.maxLength}', trigger: 'blur' }`);
      }
      const rulesText = rules.length > 0 ? `, rules: [${rules.join(', ')}]` : '';
      const span = field.control === 'textarea' ? ', span: 24' : '';
      const dict = field.isEnum ? `, dictCode: '${field.dictCode}'` : '';
      const options = field.isForeignKey ? `, options: []` : '';
      const todo = field.isForeignKey ? ` // TODO(${author}, ${created}): 绑定「${field.label}」关联数据源（如 /${kebabCase(field.fkTarget ?? '')}s 列表）` : '';
      return `  { prop: '${field.name}', label: '${field.label}', type: '${field.control}'${dict}${options}${span}${rulesText} },${todo}`;
    })
    .join('\n');
}

/** 列表项接口字段代码片段（id + 可展示字段 + 创建时间） */
function renderListItemFieldsCode(listFields: FieldMeta[]): string {
  const lines = listFields.map((field) => `  ${field.name}: ${field.tsType};`);
  lines.push('  createdAt: string;');
  return lines.join('\n');
}

/** Repository 唯一键便捷方法代码片段 */
function renderUniqueMethodsCode(model: ModelView, uniqueFields: FieldMeta[]): string {
  if (uniqueFields.length === 0) return '';
  return uniqueFields
    .map((field) => {
      const method = `findBy${pascalCase(field.name)}`;
      return [
        '',
        `  /** 按${field.label}查询（唯一键，不存在返回 null） */`,
        `  async ${method}(value: ${field.tsType}): Promise<${model.name} | null> {`,
        `    return this.findOne({ ${field.name}: value });`,
        '  }',
      ].join('\n');
    })
    .join('\n');
}

/** 渲染后端六个文件（路径相对项目根，与 writer 的 projectRoot 对齐） */
function renderBackend(model: ModelView, layout: AppLayout, data: Record<string, unknown>): PlanFile[] {
  const projectRoot = data.projectRoot as string;
  const dir = relative(projectRoot, path.join(layout.backendModulesDir, model.kebab));
  const specs: { template: string; file: string }[] = [
    { template: 'backend/entity.ts.tpl', file: `${model.kebab}.entity.ts` },
    { template: 'backend/repository.ts.tpl', file: `${model.kebab}.repository.ts` },
    { template: 'backend/dto.ts.tpl', file: `${model.kebab}.dto.ts` },
    { template: 'backend/service.ts.tpl', file: `${model.kebab}.service.ts` },
    { template: 'backend/controller.ts.tpl', file: `${model.kebab}.controller.ts` },
    { template: 'backend/module.ts.tpl', file: `${model.kebab}.module.ts` },
  ];
  return specs.map((spec) => ({
    path: `${dir}/${spec.file}`,
    content: renderOne(spec.template, data),
    kind: 'backend' as const,
  }));
}

/** 渲染前端三个文件（路径相对项目根） */
function renderFrontend(model: ModelView, layout: AppLayout, data: Record<string, unknown>): PlanFile[] {
  const projectRoot = data.projectRoot as string;
  return [
    {
      path: `${relative(projectRoot, path.join(layout.webRoot, 'src', 'api'))}/${model.kebab}.ts`,
      content: renderOne('frontend/api.ts.tpl', data),
      kind: 'frontend' as const,
    },
    {
      path: `${relative(projectRoot, path.join(layout.webRoot, 'src', 'views', model.kebab))}/index.vue`,
      content: renderOne('frontend/index.vue.tpl', data),
      kind: 'frontend' as const,
    },
    {
      path: `${relative(projectRoot, path.join(layout.webRoot, 'src', 'views', model.kebab))}/form.vue`,
      content: renderOne('frontend/form.vue.tpl', data),
      kind: 'frontend' as const,
    },
  ];
}

/** 渲染权限点与菜单 seed 文件（路径相对项目根） */
function renderSeed(model: ModelView, layout: AppLayout, data: Record<string, unknown>): PlanFile[] {
  const projectRoot = data.projectRoot as string;
  const dir = relative(projectRoot, path.join(layout.backendRoot, 'prisma', 'seed'));
  return [
    {
      path: `${dir}/${model.kebab}.seed.ts`,
      content: renderOne('seed/permissions.ts.tpl', data),
      kind: 'seed' as const,
    },
  ];
}

/** 渲染单个模板（错误信息带模型与模板上下文，便于定位） */
function renderOne(templateName: string, data: Record<string, unknown>): string {
  const model = data.model as ModelView;
  try {
    return renderTemplate(templateName, readTemplate(templateName, data), data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`生成 ${model.name} 的 ${templateName} 失败：${message}`);
  }
}

/** 读取模板文本（项目级同名模板优先） */
function readTemplate(templateName: string, data: Record<string, unknown>): string {
  const projectRoot = (data as { projectRoot?: string }).projectRoot;
  if (!projectRoot) {
    throw new Error(`模板 ${templateName} 缺少 projectRoot 上下文`);
  }
  return fs.readFileSync(resolveTemplate(templateName, projectRoot), 'utf8');
}

/** 相对路径（统一 / 分隔，保证跨平台计划稳定） */
function relative(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/');
}
