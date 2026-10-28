/*
 * @file 生成计划组装单测（FR-02/03/04 的内容正确性）
 * @description 以真实仓库 schema 为夹具：验证后端六文件路径与关键片段、DTO 排除审计字段、
 *   前端 CrudTable 配置推导（列 / 查询 / 表单 / 外键 TODO）、seed 权限点与菜单、
 *   范围过滤（--only）与模型匹配（Order / order / order-item 三种写法）。
 * @author donttemo
 * @created 2026-10-13
 * @module cli
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPlan, matchModels, resolveLayout } from '../render.js';
import { parsePrismaSchema } from '../schema-parser.js';
import type { RenderOptions } from '../render.js';

/** 含枚举 / 外键 / 时间 / 金额的夹具 schema（与仓库模型风格一致） */
const SCHEMA = `
/// 订单（生成器集成用例）
model Order {
  id        String   @id @default(uuid())
  /// 订单编号
  code      String   @unique @db.VarChar(32)
  amount    Decimal  @db.Decimal(10, 2)
  status    OrderStatus @default(PENDING)
  remark    String?  @db.Text
  authorId  String
  /// 合同附件
  contractFileId String
  expiresAt DateTime?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  createdBy String   @default("system")
  updatedBy String   @default("system")
  deletedAt DateTime?
}

/// 关联表（复合主键，应被 --all 排除）
model OrderTag {
  orderId String
  tagId   String
  @@id([orderId, tagId])
}

enum OrderStatus {
  PENDING
  PAID
}
`;

let tmpDir: string;
let schemaFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-cli-gen-render-'));
  fs.mkdirSync(path.join(tmpDir, 'prisma'), { recursive: true });
  schemaFile = path.join(tmpDir, 'prisma', 'schema.prisma');
  fs.writeFileSync(schemaFile, SCHEMA, 'utf8');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 构造渲染选项（作者 / 日期固定，断言稳定） */
function makeOptions(overrides: Partial<RenderOptions> = {}): RenderOptions {
  return {
    models: ['Order'],
    projectRoot: tmpDir,
    author: 'donttemo',
    created: '2026-10-13',
    since: 'v0.1.0',
    schema: 'prisma/schema.prisma',
    ...overrides,
  };
}

/** 取计划中某路径的文件内容 */
function contentOf(plan: { path: string; content: string }[], suffix: string): string {
  const file = plan.find((f) => f.path.endsWith(suffix));
  if (!file) throw new Error(`计划中不存在 ${suffix}（实际：${plan.map((f) => f.path).join(', ')}）`);
  return file.content;
}

/** 计划工厂（在 it 内调用，保证 tmpDir 已由 beforeEach 建好） */
const planOf = (overrides?: Partial<RenderOptions>): ReturnType<typeof buildPlan>['plan'] =>
  buildPlan(makeOptions(overrides)).plan;

describe('buildPlan 后端产物', () => {
  it('生成后端六文件（路径约定 apps/<app>/src/modules/<model>/）', () => {
    const backend = planOf()
      .filter((f) => f.kind === 'backend')
      .map((f) => f.path);
    expect(backend).toEqual([
      'src/modules/order/order.entity.ts',
      'src/modules/order/order.repository.ts',
      'src/modules/order/order.dto.ts',
      'src/modules/order/order.service.ts',
      'src/modules/order/order.controller.ts',
      'src/modules/order/order.module.ts',
    ]);
  });

  it('实体含联合字面量枚举与可选字段，且继承 BaseEntity', () => {
    const entity = contentOf(planOf(), 'order.entity.ts');
    expect(entity).toContain("import type { BaseEntity } from '@fw/db';");
    expect(entity).toContain('export interface Order extends BaseEntity');
    expect(entity).toContain("status: 'PENDING' | 'PAID';");
    expect(entity).toContain('remark?: string;');
    expect(entity).toContain('amount: string;'); // decimal → string
  });

  it('DTO 排除审计字段，create/update/query 三类齐全', () => {
    const dto = contentOf(planOf(), 'order.dto.ts');
    expect(dto).toContain('export interface CreateOrderInput');
    expect(dto).toContain('export type UpdateOrderInput = Partial<CreateOrderInput>;');
    expect(dto).toContain('export interface OrderQuery');
    expect(dto).toContain('code?: string;');
    expect(dto).toContain('keyword?: string;');
    expect(dto).not.toContain('createdBy?:');
    expect(dto).not.toContain('deletedAt?:');
  });

  it('Repository 基于 PrismaRepository 且生成唯一键便捷方法', () => {
    const repository = contentOf(planOf(), 'order.repository.ts');
    expect(repository).toContain("extends PrismaRepository<Order>");
    expect(repository).toContain("super(client, 'order');");
    expect(repository).toContain('async findByCode(value: string): Promise<Order | null>');
  });

  it('Service 查询条件下推且不存在抛 404', () => {
    const service = contentOf(planOf(), 'order.service.ts');
    expect(service).toContain("where.code = { op: 'like', value: `%${keyword}%` };");
    expect(service).toContain('throw new BizError(ErrorCode.NOT_FOUND');
  });

  it('Controller 路由为 /api/v1/orders 且 REST 五端点齐全', () => {
    const controller = contentOf(planOf(), 'order.controller.ts');
    expect(controller).toContain("@Controller('/api/v1/orders')");
    for (const method of ['@Get()', '@Get(\':id\')', '@Post()', '@Put(\':id\')', '@Delete(\':id\')']) {
      expect(controller).toContain(method);
    }
  });
});

describe('buildPlan 前端产物', () => {
  it('生成 api 封装与两个视图文件', () => {
    const frontend = planOf().filter((f) => f.kind === 'frontend').map((f) => f.path);
    expect(frontend).toEqual(['src/api/order.ts', 'src/views/order/index.vue', 'src/views/order/form.vue']);
  });

  it('api 封装五方法且金额字段为 string', () => {
    const api = contentOf(planOf(), 'src/api/order.ts');
    expect(api).toContain('export function fetchOrders(');
    expect(api).toContain('export function createOrder(');
    expect(api).toContain('export function updateOrder(');
    expect(api).toContain('export function deleteOrder(');
    expect(api).toContain('amount: string;');
  });

  it('index.vue 基于 CrudTable：列 / 查询 / 表单配置由字段推导', () => {
    const view = contentOf(planOf(), 'src/views/order/index.vue');
    expect(view).toContain("import CrudTable from '@/components/CrudTable/index.vue';");
    expect(view).toContain('api="/orders"');
    expect(view).toContain("permission=\"order\"");
    // 枚举列带 slot、时间列宽度 180、创建时间列追加（夹具无注释，label 回落字段名）
    expect(view).toContain("{ prop: 'status', label: 'status', width: 110, align: 'center', slot: 'status' },");
    expect(view).toContain("{ prop: 'expiresAt', label: 'expiresAt', width: 180, slot: 'expiresAt' },");
    expect(view).toContain("{ prop: 'createdAt', label: '创建时间', width: 180, slot: 'createdAt' },");
    // 查询区：输入框 + 字典下拉
    expect(view).toContain("{ prop: 'code', label: '订单编号', type: 'input', placeholder: '订单编号' },");
    expect(view).toContain("type: 'dict-select', dictCode: 'order_status'");
    // 表单：外键 TODO 带责任人与日期、text 域、decimal 输入框
    expect(view).toContain('// TODO(donttemo, 2026-10-13): 绑定「authorId」关联数据源');
    expect(view).toContain("{ prop: 'remark', label: 'remark', type: 'textarea', span: 24 },");
    expect(view).toContain('max: 32');
    // CrudTable 标题占位符与 Vue 字面量
    expect(view).toContain('edit-title="编辑 Order #{id}"');
  });

  it('form.vue 为独立弹窗组件且字段配置同源', () => {
    const form = contentOf(planOf(), 'src/views/order/form.vue');
    expect(form).toContain('defineProps<{');
    expect(form).toContain("import * as orderApi from '@/api/order';");
    // 断言 double assertion：表单响应式对象与严格 DTO 结构不兼容，需经 unknown 中转（vue-tsc 实测要求）
    expect(form).toContain('orderApi.createOrder(form as unknown as CreateOrderInput)');
    expect(form).toContain('orderApi.updateOrder(props.orderId, form as unknown as UpdateOrderInput)');
    expect(form).toContain('const formFields: FormField[] = [');
  });

  it('M10 E-09 附件字段生成 upload 控件与 el-upload 分支（值存 /api/v1/files 的文件 id）', () => {
    const form = contentOf(planOf(), 'src/views/order/form.vue');
    // 字段配置：upload 控件（必填规则保留；无长度校验）、不做外键下拉
    expect(form).toContain("prop: 'contractFileId', label: '合同附件', type: 'upload'");
    expect(form).not.toMatch(/contractFileId'[^]*?type: 'select'/);
    // 模板分支：FileUpload 组件接线
    expect(form).toContain("import FileUpload from '@/components/FileUpload/index.vue';");
    expect(form).toContain(`v-else-if="field.type === 'upload'"`);
  });

  it('Vue 模板字面量 {{ }} 正确输出（转义不被引擎吞掉）', () => {
    const view = contentOf(planOf(), 'src/views/order/index.vue');
    expect(view).toContain('{{ formatTime(row.createdAt) }}');
  });
});

describe('buildPlan seed 产物', () => {
  it('生成幂等 seed：4 个权限点 + 菜单', () => {
    const seed = contentOf(planOf(), 'prisma/seed/order.seed.ts');
    for (const action of ['create', 'read', 'update', 'delete']) {
      expect(seed).toContain(`code: 'order:${action}'`);
    }
    expect(seed).toContain('prisma.permission.upsert');
    expect(seed).toContain('prisma.menu.findFirst');
    expect(seed).toContain("path: '/orders'");
    expect(seed).toContain("component: 'views/order/index'");
  });

  it('定向种子把自己建的权限授给 admin 角色（否则登录后菜单被权限过滤掉）', () => {
    const seed = contentOf(planOf(), 'prisma/seed/order.seed.ts');
    // 只建权限不授权时，/auth/menus 会按用户权限码过滤，新模块在后台完全不出现
    expect(seed).toContain("const ADMIN_ROLE_CODE = 'admin'");
    // role.code 不是唯一键：用 findUnique 会在运行期直接抛错
    expect(seed).toContain('prisma.role.findFirst({');
    expect(seed).toContain('roleId_permissionId');
    expect(seed).toContain('await grantToAdminRole()');
  });
});

describe('范围与匹配', () => {
  it('--only=backend 只生成后端六文件', () => {
    const { plan } = buildPlan(makeOptions({ scope: 'backend' }));
    expect(plan.every((f) => f.kind === 'backend')).toBe(true);
    expect(plan).toHaveLength(6);
  });

  it('--only=frontend 只生成前端三文件', () => {
    const { plan } = buildPlan(makeOptions({ scope: 'frontend' }));
    expect(plan).toHaveLength(3);
    expect(plan.every((f) => f.kind === 'frontend')).toBe(true);
  });

  it('模型名支持 Order / order / order-item 三种写法', () => {
    const schema = parsePrismaSchema(SCHEMA);
    expect(matchModels(schema, ['Order'])[0].name).toBe('Order');
    expect(matchModels(schema, ['order'])[0].name).toBe('Order');
    expect(matchModels(schema, ['order-tag'])[0].name).toBe('OrderTag');
  });

  it('模型不存在时报错并列出可用模型', () => {
    const schema = parsePrismaSchema(SCHEMA);
    expect(() => matchModels(schema, ['Nope'])).toThrow('不存在模型');
  });

  it('默认布局探测：无 apps 目录时项目根即后端应用', () => {
    const layout = resolveLayout(makeOptions());
    expect(layout.backendRoot).toBe(tmpDir);
    expect(layout.schemaFile).toBe(schemaFile);
  });
});

describe('resolveLayout 布局探测', () => {
  it('fw new --template=admin 的 server/admin-web 兄弟目录：前端根识别为 ../admin-web', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-cli-layout-'));
    const server = path.join(project, 'server');
    const web = path.join(project, 'admin-web');
    fs.mkdirSync(path.join(server, 'prisma'), { recursive: true });
    fs.mkdirSync(path.join(server, 'src'), { recursive: true });
    fs.mkdirSync(path.join(web, 'src', 'components', 'CrudTable'), { recursive: true });
    fs.writeFileSync(path.join(web, 'src', 'components', 'CrudTable', 'index.vue'), '<template />', 'utf8');
    fs.writeFileSync(path.join(server, 'prisma', 'schema.prisma'), 'model A { id String @id }', 'utf8');

    const layout = resolveLayout({ models: [], projectRoot: server, author: '', created: '', since: '' });
    expect(layout.backendRoot).toBe(server);
    expect(layout.webRoot).toBe(web);
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('单项目形态（无 apps、无兄弟前端）：前端根回落为项目根', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-cli-layout2-'));
    fs.mkdirSync(path.join(project, 'prisma'), { recursive: true });
    fs.writeFileSync(path.join(project, 'prisma', 'schema.prisma'), 'model A { id String @id }', 'utf8');
    const layout = resolveLayout({ models: [], projectRoot: project, author: '', created: '', since: '' });
    expect(layout.webRoot).toBe(project);
    fs.rmSync(project, { recursive: true, force: true });
  });
});
