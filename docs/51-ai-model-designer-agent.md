# TY Studio Model Designer Agent（内部提示词 v1.0）

> **定位**：把自然语言业务需求转成**可编辑、可校验、可增量修改**的数据模型草案。
> **边界**：本 Agent 只出草案，不写 Schema、不生成代码、不执行迁移；代码审查由 Code Review Agent 负责（见 `fw review`），两者提示词与职责不复用。
> **状态**：提示词与契约 v1.0 定稿（2026-10-22）；**只读闭环已接入**（`POST /api/model-draft` + Studio「AI 建模」页，生成即校验、不写 schema）；增量 revise 界面与 Schema 写回未做。后端必须按本文第 6 节的 JSON Schema 语义校验，不得依赖模型自证格式。

---

## 1. 三个角色，不要混用

| 角色 | 输入 | 输出 | 权限 |
|---|---|---|---|
| **Model Designer**（本文） | 业务描述 + 项目上下文 + 当前草案 | 结构化 JSON 草案 / 增量操作 | 只读项目，只产出草案 |
| **Code Generator** | 已确认的模型定义 | 代码、接线、迁移 | 经 `fw gen crud` 确定性执行 |
| **Code Review Agent** | 生成物或 git 变更集 | 缺陷清单 | 只读，不修代码 |

模型设计阶段**禁止**出现代码、SQL、迁移语句；代码审查阶段**禁止**改模型。职责一旦混用，模型会倾向于「顺手把代码也写了」，破坏后续可校验的确定性链路。

---

## 2. 调用契约：输入也是 JSON

调用方按下面的信封发起请求。**缺少 `context` 时模型不得声称已读取项目**，只能在 `assumptions` 里写明「未提供 schema，按通用约定设计」。

```json
{
  "protocol_version": "1.0",
  "mode": "create",
  "base_revision": 0,
  "requirement": "我要做一个商品管理模块，商品要有名称、唯一 SKU、价格、库存、商品详情和上下架状态。商品属于一个分类，需要支持按名称、分类和状态搜索。",
  "locale": "zh-CN",
  "context": {
    "database": "postgresql",
    "prisma_version": "6.16.2",
    "schema_excerpt": "model Category {\n  id   String @id @default(uuid())\n  name String @unique\n}",
    "existing_models": [
      { "name": "Category", "fields": ["id", "name", "createdAt", "updatedAt"] }
    ],
    "conventions": {
      "primary_key": "id String @id @default(uuid())",
      "tenant_field": "tenantId String",
      "audit_fields": ["createdAt", "updatedAt", "createdBy", "updatedBy"],
      "soft_delete": "deletedAt DateTime?"
    },
    "generator": {
      "supports": ["single_primary_key", "relation_many_to_one", "enum", "index", "unique"],
      "unsupported": ["composite_primary_key", "many_to_many"]
    },
    "ui": {
      "controls": ["input", "textarea", "select", "decimal", "integer", "switch", "date"],
      "list_features": ["search", "filter", "sort", "paginate"]
    },
    "draft": null
  }
}
```

| 输入字段 | 类型 | 必填 | 说明与异常处理 |
|---|---|---|---|
| `protocol_version` | string | 是 | 固定 `"1.0"`；不匹配直接拒绝（`E_PROTOCOL`），不尝试兼容 |
| `mode` | `"create" \| "revise" \| "clarify"` | 是 | `revise` 表示基于 `context.draft` 增量修改；缺失按 `create` 处理，但要在 `warnings` 说明 |
| `base_revision` | integer | `revise` 必填 | 必须等于 `context.draft.revision`；不等则返回 `E_REVISION_CONFLICT`，**不得**猜测用户想改哪一版 |
| `requirement` | string | 是 | 1~4000 字；空串或纯符号 → `status: "needs_clarification"`，不硬编模型 |
| `locale` | string | 否 | 默认 `zh-CN`；影响 `display_name` 与 `questions` 语言，不影响字段名（字段名一律英文） |
| `context.database` | string | 否 | 缺省视为 `postgresql` 并在 `assumptions` 注明；不支持的库 → `unsupported_features` |
| `context.existing_models` | array | 否 | 用于查重与复用；缺失时**不得**假设「项目里没有 Category」 |
| `context.conventions` | object | 否 | 缺失时按通用约定设计，并在 `assumptions` 逐条列出 |
| `context.generator` | object | 否 | 决定 `unsupported_features`；与实际生成能力冲突时以调用方为准 |
| `context.draft` | object | `revise` 必填 | 当前草案；缺失 → `E_REVISION_CONFLICT` |

输出只允许**一个 JSON 对象**：无 Markdown 围栏、无前后说明文字、无注释。调用方必须设置 `response_format: { "type": "json_object" }`，并在收到后按第 6 节 Schema 校验。

### 2.1 输出示例（商品模块，create 模式）

下面的 JSON 是**合法示例**（可直接作为 Schema 校验的样本，也可作为 few-shot 示例）：

```json
{
  "protocol_version": "1.0",
  "status": "draft",
  "revision": 1,
  "base_revision": 0,
  "requirement_summary": "商品管理：名称、唯一 SKU、价格、库存、详情、上下架状态；归属一个分类，支持按名称/分类/状态搜索。",
  "models": [
    {
      "name": "Product",
      "display_name": "商品",
      "action": "create",
      "description": "商品基本信息与上下架状态",
      "fields": [
        {
          "name": "name", "display_name": "商品名称", "type": "String",
          "nullable": false, "default": null, "unique": false, "indexed": true,
          "relation": null, "source": "explicit", "reason": "需求明确要求名称",
          "destructive": false,
          "ui": { "visible_in_list": true, "searchable": true, "control": "input", "required": true }
        },
        {
          "name": "sku", "display_name": "商品编码", "type": "String",
          "nullable": false, "default": null, "unique": true, "indexed": false,
          "relation": null, "source": "explicit", "reason": "需求要求唯一 SKU",
          "destructive": false,
          "ui": { "visible_in_list": true, "searchable": true, "control": "input", "required": true }
        },
        {
          "name": "price", "display_name": "价格", "type": "Decimal",
          "precision": 18, "scale": 2, "nullable": false, "default": null,
          "unique": false, "indexed": false, "relation": null,
          "source": "inferred", "reason": "金额类字段按项目金额约定使用 Decimal(18,2)",
          "destructive": false,
          "ui": { "visible_in_list": true, "searchable": false, "control": "decimal", "required": true }
        },
        {
          "name": "stock", "display_name": "库存", "type": "Int",
          "nullable": false, "default": 0, "unique": false, "indexed": false,
          "relation": null, "source": "explicit", "reason": "需求要求库存，默认 0 便于新建即上架",
          "destructive": false,
          "ui": { "visible_in_list": true, "searchable": false, "control": "integer", "required": true }
        },
        {
          "name": "description", "display_name": "商品详情", "type": "String",
          "nullable": true, "default": null, "unique": false, "indexed": false,
          "relation": null, "source": "explicit", "reason": "需求明确要求商品详情且可空",
          "destructive": false,
          "ui": { "visible_in_list": false, "searchable": false, "control": "textarea", "required": false }
        },
        {
          "name": "status", "display_name": "上下架状态", "type": "ProductStatus",
          "enum_values": ["ON_SALE", "OFF_SALE"],
          "nullable": false, "default": "OFF_SALE", "unique": false, "indexed": true,
          "relation": null, "source": "inferred",
          "reason": "上下架为有限取值，用枚举；新建默认下架避免误上架",
          "destructive": false,
          "ui": { "visible_in_list": true, "searchable": true, "control": "select", "required": true }
        },
        {
          "name": "categoryId", "display_name": "所属分类", "type": "String",
          "nullable": false, "default": null, "unique": false, "indexed": true,
          "relation": { "target": "Category", "cardinality": "many_to_one", "field": "products", "on_delete": "Restrict" },
          "source": "explicit", "reason": "需求明确要求商品属于一个分类",
          "destructive": false,
          "ui": { "visible_in_list": true, "searchable": true, "control": "select", "required": true }
        }
      ],
      "indexes": [
        { "fields": ["categoryId", "status"], "unique": false, "reason": "按分类+状态筛选是最常见查询" }
      ],
      "relations": [
        { "from": "categoryId", "target": "Category", "cardinality": "many_to_one", "field": "products", "on_delete": "Restrict" }
      ]
    }
  ],
  "assumptions": [
    "分类复用项目已有 Category 模型，不新建",
    "上下架状态使用枚举 ProductStatus（ON_SALE / OFF_SALE）",
    "金额按项目约定使用 Decimal(18,2)"
  ],
  "questions": [
    { "id": "Q1", "question": "SKU 在商品软删除后是否允许复用？", "options": ["允许", "不允许"], "blocking": false, "default_assumption": "不允许" },
    { "id": "Q2", "question": "库存是否允许为负（如预售）？", "options": ["允许", "不允许"], "blocking": false, "default_assumption": "不允许" }
  ],
  "warnings": [
    "sku 唯一约束在软删除模式下会阻止复用，若业务允许复用需改为「deletedAt + sku」复合唯一（当前生成器不支持复合唯一）"
  ],
  "unsupported_features": [
    "composite_unique：软删除模式下「sku + deletedAt」复合唯一，当前生成器不支持"
  ],
  "migration_risks": [],
  "recommended_call_params": {
    "temperature": 0.2,
    "max_output_tokens": 4000,
    "reason": "结构化建模需稳定输出，模型数量少，4k 足够",
    "response_format": "json_object"
  },
  "generation_profile": {
    "list_page_size": 20,
    "default_sort": "createdAt desc",
    "permissions": ["product:create", "product:read", "product:update", "product:delete"],
    "seed_count": 10,
    "control_map": { "status": "select", "price": "decimal" }
  }
}
```

注意示例里的 `warnings` 与 `questions` 是刻意保留的：SKU 唯一性与软删除的冲突、库存是否可为负，都属于「业务含义需要人确认」的事，不能由 AI 替业务拍板。

---

## 3. 系统提示词（可直接复制使用）

```text
你是 TY Studio 的 AI 数据建模助手（Model Designer Agent）。

【任务】
把开发人员描述的业务需求转换为 TY Studio 可视化编辑器可承载的数据模型草案。你输出的是候选设计，不是最终数据库结构；开发人员必须能查看、修改、确认后才会应用。

【输入】
你会收到一个 JSON 对象：protocol_version / mode / base_revision / requirement / locale / context。
context 可能包含：数据库类型、Prisma 版本、schema 片段、已有模型、框架约定（主键/租户/审计/软删除）、生成器支持能力、前端控件能力、当前草案。
只允许依据实际提供的内容断言项目能力。context 缺失时必须在 assumptions 中写明「未提供」，不得假装已读取项目文件。

【硬性规则】
R1 只输出一个合法 JSON 对象，不带 Markdown 围栏、不带解释文字、不带注释。
R2 不输出代码、SQL、迁移语句、Prisma 片段；只描述模型结构。
R3 不写文件、不改 schema、不执行任何命令；你只产出草案。
R4 字段名用英文 lowerCamelCase，模型名用 PascalCase；display_name 可用中文。
R5 不重复创建 context.existing_models 中已有的语义模型；能复用就复用，并在 reason 中说明。
R6 不得把普通字符串字段擅自认定为外键；只有需求明确且目标模型明确时才建关系。
R7 金额用 Decimal（并给 precision/scale 建议），计数用 Int，时间用 DateTime，开关用 Boolean，有限取值用枚举（枚举值必须列全）。
R8 框架自动维护的字段（id / tenantId / createdAt / updatedAt / createdBy / updatedBy / deletedAt）按 context.conventions 决定是否出现在 fields 中；已声明为自动维护的不要重复设计，在 assumptions 里说明即可。
R9 数据库字段与 UI 设置必须分开：搜索、列表列、控件、前端校验写入 ui，不得混入字段类型或约束。
R10 需求没提到的东西不要擅自加：不加状态机、审批流、额外业务模型；确有必要时放入 questions 或 suggestions，不直接进 models。
R11 破坏性变更（删模型/删字段/改类型/收窄可空/去唯一）必须标记 destructive=true，写入 migration_risks，并要求确认；绝不静默删除。
R12 生成器不支持的设计（如复合主键、多对多）写入 unsupported_features，不要假设能生成。
R13 每个字段必须给 source：explicit（需求明说）/ convention（项目约定）/ inferred（你的推断），inferred 必须在 reason 说明依据；关键歧义进 questions。
R14 mode=revise 时只输出 operations（增量），不重发完整模型；不得改动用户未要求修改的字段。
R15 base_revision 必须与 context.draft.revision 相等；不相等时输出 status="rejected"、error_code="E_REVISION_CONFLICT"，不要猜测。
R16 不得输出任何密钥、令牌、连接串；不得建议修改 base_url、api_key、供应商。
R17 不确定就说不确定：status 用 needs_clarification，questions 里给可选项，而不是编一个看起来合理的结构。

【建模顺序】
1 识别业务实体与业务规则（谁、做什么、受什么约束）。
2 决定模型数量：既不把所有字段塞进一个模型，也不为复杂而拆。
3 逐个字段定类型、可空、默认值、唯一、索引。
4 再定关系与基数（many_to_one / one_to_many / one_to_one），两端命名互相呼应。
5 最后给 UI 与查询建议（搜索字段、列表列、控件、分页）。
6 输出前执行第 7 节自检。

【输出字段】
严格按调用方 JSON Schema。顶层必须含：
protocol_version, status, revision, base_revision, requirement_summary,
models（create 模式）或 operations（revise 模式）,
assumptions, questions, warnings, unsupported_features, migration_risks,
recommended_call_params, generation_profile。
status 只能是 draft | needs_clarification | rejected。
rejected 时必须给 error_code 与 message；needs_clarification 时 models 可为空数组，但 questions 至少 1 条。

【recommended_call_params 与 generation_profile】
前者只给「调用建议」（temperature / max_output_tokens / reason），不得包含供应商、地址、密钥；编排层有最终裁决权与硬上限。
后者是「业务生成参数」（列表分页、默认排序、权限码、种子条数、控件映射），属于草案的一部分，开发人员可编辑。
```

---

## 4. 输出字段字典

### 4.1 顶层

| 字段 | 类型 | 必填 | 含义 | 约束 / 异常处理 |
|---|---|---|---|---|
| `protocol_version` | string | 是 | 协议版本 | 必须 `"1.0"`；不符 → `E_PROTOCOL`，整份丢弃 |
| `status` | enum | 是 | `draft` / `needs_clarification` / `rejected` | 其它值 → `E_SCHEMA`；`rejected` 必须带 `error_code` |
| `error_code` | string | `rejected` 必填 | 机器可读原因 | 取值见第 8 节；`draft` 出现该字段 → 忽略并 `warnings` |
| `message` | string | `rejected` 必填 | 面向人的一句话 | 不得含栈、密钥、内部路径 |
| `revision` | integer | 是 | 本草案版本号 | 必须等于 `base_revision + 1`；否则 `E_REVISION` |
| `base_revision` | integer | 是 | 本次基于的版本 | 与请求不一致 → `E_REVISION_CONFLICT` |
| `requirement_summary` | string | 是 | 需求摘要（≤200 字） | 空串 → `E_SCHEMA`；只复述需求，不夹带设计结论 |
| `models` | array | `create` 必填 | 完整草案模型列表 | 空数组仅允许在 `needs_clarification`；重复 `name` → `E_DUP_MODEL` |
| `operations` | array | `revise` 必填 | 增量操作列表 | 空数组视为「无需修改」，合法；操作类型见 4.5 |
| `assumptions` | array\<string\> | 是 | 设计假设 | 可为空数组；每条必须能追溯到缺失上下文或推断 |
| `questions` | array\<Question\> | 是 | 待确认问题 | 见 4.6；`needs_clarification` 时至少 1 条 |
| `warnings` | array\<string\> | 是 | 非阻断提示 | 如「sku 唯一但软删除后不可复用需业务确认」 |
| `unsupported_features` | array\<string\> | 是 | 当前生成器不支持的设计 | 不得为空数组却留下相关字段（自检 D8） |
| `migration_risks` | array\<Risk\> | 是 | 迁移风险 | 见 4.7；`destructive=true` 的字段必须在此出现 |
| `recommended_call_params` | object | 是（缺失由后端补默认） | 调用参数建议 | 见 4.8；缺失按 0.2 / 4000 补齐并记 warning，只建议，编排层可覆盖 |
| `generation_profile` | object | 是（缺失由后端补默认） | 业务生成参数 | 见 4.9；缺失的分页/排序/权限码按默认补齐并记 warning，开发人员可编辑 |

### 4.2 `models[]`

| 字段 | 类型 | 必填 | 含义 | 约束 / 异常处理 |
|---|---|---|---|---|
| `name` | string | 是 | 模型名 PascalCase | `^[A-Z][A-Za-z0-9]{1,63}$`；与已有模型同名且 `action=create` → `E_DUP_MODEL` |
| `display_name` | string | 是 | 中文名 | ≤32 字 |
| `action` | enum | 是 | `create` / `update` / `delete` | `delete` 必须 `destructive=true` 并进 `migration_risks` |
| `description` | string | 否 | 一句话说明 | ≤200 字 |
| `fields` | array | 是 | 字段列表 | 至少 1 个；字段名重复 → `E_SCHEMA` |
| `indexes` | array\<Index\> | 是 | 索引建议 | 与 `fields[].indexed` 重复 → `warnings`，不重复建 |
| `relations` | array\<Relation\> | 是 | 关系 | 目标模型必须存在于本草案或 `existing_models`，否则 `E_UNKNOWN_REF` |

#### 4.2.1 `indexes[]`

| 字段 | 类型 | 必填 | 含义 | 约束 / 异常处理 |
|---|---|---|---|---|
| `fields` | array\<string\> | 是 | 索引列（按顺序） | 每列必须是本模型字段；空数组 → `E_SCHEMA` |
| `unique` | boolean | 是 | 是否唯一索引 | 唯一索引与 `fields[].unique` 重复 → 合并并 `warnings` |
| `reason` | string | 是 | 为什么建这个索引 | ≤100 字；不得写「提升性能」这类空话 |

### 4.3 `fields[]`

| 字段 | 类型 | 必填 | 含义 | 约束 / 异常处理 |
|---|---|---|---|---|
| `name` | string | 是 | 字段名 lowerCamelCase | `^[a-z][A-Za-z0-9]{0,63}$`；保留字（`model`/`enum` 等）→ `E_SCHEMA` |
| `display_name` | string | 是 | 中文名 | ≤32 字 |
| `type` | string | 是 | 数据库类型 | 必须在生成器类型映射内（String / Int / BigInt / Decimal / Boolean / DateTime / Json / 枚举名）；不支持 → 进 `unsupported_features` 且不得出现在 fields |
| `nullable` | boolean | 是 | 是否可空 | 与 `default` 冲突（`nullable=false` 且 `default=null` 且无外部填充）→ `E_DEFAULT_CONFLICT` |
| `default` | any \| null | 是 | 默认值 | 类型必须与 `type` 兼容；`null` 表示无默认值，不是「默认 null」 |
| `unique` | boolean | 是 | 唯一约束 | `true` 时 `nullable` 应为 `false`；软删除下唯一性需在 `warnings` 说明冲突风险 |
| `indexed` | boolean | 是 | 单列索引 | 与 `indexes` 重复 → 合并并 `warnings` |
| `relation` | object \| null | 是 | 关系描述 | 见 4.4；非空时 `type` 必须是外键标量类型 |
| `precision` / `scale` | integer | Decimal 必填 | 精度与小数位 | 金额建议 `18,2`；缺失 → `E_SCHEMA` |
| `enum_values` | array\<string\> | 枚举必填 | 枚举取值 | 至少 1 个且不重复；空 → `E_SCHEMA`；枚举值用 `SCREAMING_SNAKE_CASE` |
| `source` | enum | 是 | `explicit` / `convention` / `inferred` | `inferred` 时 `reason` 必填 |
| `reason` | string | `inferred` 必填 | 推断依据 | ≤200 字；不得写「通用最佳实践」这类空话 |
| `destructive` | boolean | 是 | 是否为破坏性变更 | 仅 `update`/`delete` 场景可为 `true`；`true` 必须进 `migration_risks` |
| `ui` | object | 是 | UI 设置 | 见 4.3.1；不得反向影响类型与约束 |

#### 4.3.1 `fields[].ui`

| 字段 | 类型 | 必填 | 含义 | 约束 |
|---|---|---|---|---|
| `visible_in_list` | boolean | 是 | 是否进列表 | 大文本字段建议 `false` |
| `searchable` | boolean | 是 | 是否可搜索 | `true` 时应有索引建议，否则 `warnings` |
| `control` | string | 是 | 控件类型 | 必须来自 `context.ui.controls`；不在其中 → `warnings` 并回退 `input` |
| `required` | boolean | 是 | 前端必填 | 与 `nullable` 不矛盾即可（前端必填 ⊆ 数据库非空） |
| `placeholder` / `help` | string | 否 | 提示文案 | ≤100 字 |

### 4.4 relation（`fields[].relation` 与 `relations[]` 共用）

| 字段 | 类型 | 必填 | 含义 | 约束 / 异常处理 |
|---|---|---|---|---|
| `from` | string | `relations[]` 必填 | 本端外键字段名 | 必须是本模型已声明字段；`fields[].relation` 内省略（即该字段本身） |
| `target` | string | 是 | 目标模型名 | 必须在 `models` 或 `existing_models`；否则 `E_UNKNOWN_REF` |
| `cardinality` | enum | 是 | `many_to_one` / `one_to_one` | 多对多 → `unsupported_features`，不得生成中间表 |
| `field` | string | 是 | 目标端反向字段名 | 与目标模型已有字段冲突 → `warnings` 并给替换建议 |
| `on_delete` | enum | 否 | `Restrict` / `Cascade` / `SetNull` | `SetNull` 要求外键 `nullable=true`，否则 `E_SCHEMA` |

### 4.5 `operations[]`（revise 模式）

| `op` | 必填参数 | 含义 | 破坏性 |
|---|---|---|---|
| `add_model` | `model` | 新增模型 | 否 |
| `update_model_meta` | `name`, `changes` | 改 display_name/description | 否 |
| `remove_model` | `name`, `reason` | 删模型 | 是 |
| `add_field` | `model`, `field` | 加字段 | 否 |
| `update_field` | `model`, `field`, `changes` | 改字段指定键（只允许 `changes` 里出现的键） | 视 changes 而定 |
| `remove_field` | `model`, `field`, `reason` | 删字段 | 是 |
| `add_index` | `model`, `index` | 加索引 | 否 |
| `remove_index` | `model`, `fields` | 删索引 | 是 |
| `set_enum` | `model`, `field`, `values` | 设定枚举取值 | 删值视为破坏性 |

每个操作必须带 `reason` 与 `source`；`destructive` 由**后端**根据操作类型与 changes 推导，不采信模型自报（防止模型把删字段标成非破坏）。

### 4.6 `questions[]`

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `id` | string | 是 | 稳定标识（`Q1`、`Q2`），便于回填答案 |
| `question` | string | 是 | 一句话问题 |
| `options` | array\<string\> | 否 | 可选项；有选项时开发人员可直接点选 |
| `blocking` | boolean | 是 | 是否阻断进入编辑器（`true` 时 `status` 应为 `needs_clarification`） |
| `default_assumption` | string | 否 | 若不回答，按什么假设继续 |

### 4.7 `migration_risks[]`

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `model` / `field` | string | 是 | 影响对象 |
| `kind` | enum | 是 | `drop_column` / `type_change` / `narrow_nullable` / `drop_unique` / `add_required_without_default` |
| `impact` | string | 是 | 对存量数据的影响（一句话，具体到会失败还是丢数据） |
| `requires_confirmation` | boolean | 是 | 必须为 `true`（高风险迁移无「默认放行」） |

### 4.8 `recommended_call_params`

| 字段 | 类型 | 必填 | 含义 | 边界 |
|---|---|---|---|---|
| `temperature` | number | 是 | 建议温度 | 0~0.3；越界由编排层截断并记 `warnings` |
| `max_output_tokens` | integer | 是 | 建议输出上限 | 1024~16000；编排层按模型数量估算后取 `min` |
| `reason` | string | 是 | 为什么这么建议 | ≤100 字 |
| `response_format` | string | 否 | 固定 `json_object` | 只读展示，模型不得改成别的值 |

模型**不得**输出 `model`、`base_url`、`api_key`、`provider`；出现即 `E_POLICY` 整份拒绝。

### 4.9 `generation_profile`

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `list_page_size` | integer | 是 | 列表默认分页（建议 10~50） |
| `default_sort` | string | 是 | 如 `createdAt desc` |
| `permissions` | array\<string\> | 是 | 权限码建议（`<kebab>:<action>`） |
| `seed_count` | integer | 是 | 示例数据条数建议（0~50） |
| `control_map` | object | 否 | 字段 → 控件覆盖（与 `fields[].ui.control` 冲突时以此为准并 `warnings`） |

---

## 5. 增量修改（revise）：不重发整个模型

1. 请求带 `mode: "revise"`、`base_revision` 与 `context.draft`；
2. 模型只输出 `operations`，不输出 `models`；
3. 后端按 `base_revision` 做 CAS：不匹配返回 409，前端刷新后由开发人员重新确认意图（**不重放旧的 AI 输出**）；
4. 每条操作应用到当前草案，生成结构化 diff（字段级），编辑器展示「变更前 / 变更后」；
5. `destructive` 操作在界面上必须二次确认，确认后才进入 Schema diff 阶段。

这条规则解决的是最常见的事故：用户已经在表格里改了 5 个字段，再说一句「加多图」，AI 若整份重发，前 5 处修改会被悄悄覆盖。

---

## 6. 后端校验顺序（模型不负责保证格式）

```text
AI JSON → ① JSON.parse（失败不重试同一请求）
        → ② JSON Schema 校验（ajv/zod，字段类型、必填、枚举）
        → ③ 语义校验（D1~D10 可机器断言部分 + 引用完整性 + 类型兼容）
        → ④ 修订 CAS（base_revision）
        → ⑤ 写入内部模型定义（不直接拼 Prisma 文本）
        → ⑥ 生成 Schema diff → prisma validate
        → ⑦ 迁移风险评估 → 人工确认 → 应用
```

任何一步失败都**不得**部分落库；错误码见第 8 节。

---

## 7. 自检（输出前，模型自查；后端可机器复核前 8 条）

| 编号 | 检查项 | 机器可复核方式 |
|---|---|---|
| D1 | 模型名与字段名合法 | 正则校验 |
| D2 | 类型受当前库与生成器支持 | 类型白名单比对 |
| D3 | 关系两端一致（目标存在、反向字段不冲突） | 引用完整性检查 |
| D4 | 默认值与可空规则不冲突 | `nullable=false` 且 `default=null` 且非自增 → 报错 |
| D5 | 唯一约束与索引不重复、不矛盾 | 约束集合去重 |
| D6 | 未重复创建已有模型 | 与 `existing_models` 比对 |
| D7 | UI 设置未混入数据库定义 | `ui` 中不得出现 `type`/`unique` 等键 |
| D8 | `unsupported_features` 非空时，对应设计不得出现在 models | 交叉比对 |
| D9 | 推断项有 `source=inferred` 与 `reason` | 字段级检查 |
| D10 | 破坏性变更已标记并进 `migration_risks` | 操作类型 × changes 推导比对 |

---

## 8. 异常与降级矩阵

| 错误码 | 触发条件 | 处理 | 是否重试 |
|---|---|---|---|
| `E_PROTOCOL` | `protocol_version` 不符 | 整份拒绝，提示升级 Studio | 否 |
| `E_JSON_PARSE` | 返回不是合法 JSON | 带解析错误位置重试 **1 次**；仍失败 → 展示原文前 500 字供排查 | 1 次 |
| `E_SCHEMA` | 缺必填 / 类型错 / 枚举越界 | 把 `字段路径 + 期望` 回灌重试 **1 次** | 1 次 |
| `E_UNKNOWN_REF` | 关系目标不存在 | 不重试；标为 `questions`，请用户确认目标模型 | 否 |
| `E_DUP_MODEL` | 与已有模型同名且 `create` | 改为 `update` 建议，交用户确认 | 否 |
| `E_DEFAULT_CONFLICT` | 非空且无默认且无填充来源 | 要求补默认值或改可空 | 1 次 |
| `E_TYPE_UNSUPPORTED` | 类型不在生成器能力内 | 写入 `unsupported_features`，该字段不落地 | 否 |
| `E_REVISION_CONFLICT` | `base_revision` 与草案不符 | 409，前端刷新后重述需求 | 否 |
| `E_DESTRUCTIVE_UNAUTHORIZED` | 破坏性操作未带确认 | 阻断并展示影响，等确认令牌 | 否 |
| `E_EMPTY_REQUIREMENT` | 需求为空或不可解析 | `needs_clarification` + 至少 1 个 `questions` | 否 |
| `E_CONTEXT_MISSING` | 未提供 schema/约定 | 继续设计，但 `assumptions` 逐条声明「未提供」 | 否 |
| `E_POLICY` | 输出含密钥/供应商/地址 | 整份拒绝并告警（疑似提示注入） | 否 |
| `E_MODEL_UNAVAILABLE` | 供应商 401/403 | 提示检查 `FW_AI_API_KEY` 与模型权限 | 否 |
| `E_RATE_LIMIT` | 429 | 指数退避重试 **1 次**（2s） | 1 次 |
| `E_TIMEOUT` | 超过 `timeoutMs` | 提示已等待时长与目标地址；不落任何草案 | 1 次（同参数） |
| `E_EMPTY_OUTPUT` | 返回空内容 | 视为失败，不写空草案 | 1 次 |

原则：**重试只针对「格式/网络」类错误；语义错误不重试**——同一段需求重问一遍，只会得到另一个看起来合理的错结构。

---

## 9. 模型参数由 AI 生成：两层，别混

| 层 | 谁决定 | 内容 | 落地方式 |
|---|---|---|---|
| **业务生成参数** `generation_profile` | AI 建议，开发人员可改 | 分页、默认排序、权限码、种子条数、控件映射 | 属于草案，进编辑器可编辑，确认后写进模型定义 |
| **模型调用参数** `recommended_call_params` | AI 只建议，编排层裁决 | `temperature`、`max_output_tokens`、`reason` | 编排层夹取范围（温度 ≤0.3、输出上限封顶），不采信越界值 |

调用侧默认值（接入时按此实现，模型建议只能收窄不能突破）：

| 参数 | 默认 | 硬边界 | 理由 |
|---|---|---|---|
| `temperature` | 0.2 | 0~0.3 | 建模要稳定可复现，不允许发散 |
| `top_p` | 1.0 | 0.8~1.0 | 与低温配合，避免随机截断术语 |
| `max_output_tokens` | 4000 | 1024~16000 | 按模型数量估算，超限截断会产出半个 JSON |
| `response_format` | `json_object` | 固定 | 不允许模型改成文本 |
| `timeoutMs` | 60000 | 15000~120000 | 超时与 `fw review` 同口径 |

### 9.1 用途如何影响参数建议（AI 必须解释理由）

开发人员描述「要什么模型、干什么用」时，AI 应据此调整参数，并在 `recommended_call_params.reason` 与 `generation_profile` 里给出可核对的依据：

| 用户表述 | 应调整的建议 | 不该做的事 |
|---|---|---|
| 「后台列表天天用、数据量大」 | `list_page_size` 50；给 `searchable` 字段配索引；`default_sort` 用时间倒序 | 不要把所有字段都设 `searchable` |
| 「移动端录入，字段很多」 | `visible_in_list` 只留 4~6 列；`control` 用 `select`/`switch` 降低手输 | 不要为了少列就删数据库字段 |
| 「订单 + 多条明细」 | 拆成 `Order` / `OrderItem` 两个模型；`max_output_tokens` 上调到 6000 | 不要把明细塞成 JSON 字符串 |
| 「财务/合规，金额敏感」 | `Decimal(18,2)` 起步；`migration_risks` 对类型收窄零容忍；`temperature` 0.1 | 不要用 Float，不要自动放行破坏性变更 |
| 「先做个最小可用版本」 | `seed_count` 小、少建索引；`questions` 只保留阻断项 | 不要因此省略唯一约束等硬约束 |

参数不是越多越好：开发人员说「简单点」时，正确响应是减少模型与字段，而不是把 `temperature` 调高让它自由发挥。

---

## 10. 与现有代码的接入点

**当前进度**：只读闭环已实现（2026-10-22）——`GET /api/model-draft` 回上下文摘要；`POST /api/model-draft` 生成并校验草案，Studio「AI 建模」页展示；**不写 Schema、不生成代码、revise 增量与编辑器未做**。

| 环节 | 复用 | 状态 |
|---|---|---|
| 供应商调用 | `review/provider.ts`（新增 `response_format: json_object` 与 `temperature` 参数） | ✅ 已接入 |
| 密钥配置 | `ai/ai-config-store.ts` + `review/config.ts`（页面配置 > 环境变量；存 `~/.fw/studio-ai.json`，不回显） | ✅ 已接入（FR-17-25） |
| 上下文采集 | 新增 `model-designer/context.ts`（datasource / 已有模型 / 约定出现率 / 生成器能力） | ✅ 已实现 |
| 结构与语义校验 | 新增 `model-designer/draft-schema.ts`（D1~D10 可机器部分 + 策略扫描 + 参数校准） | ✅ 已实现（手写校验器，未引 ajv） |
| 重试 | 新增 `model-designer/draft.ts`（最多 2 次，回灌路径化问题） | ✅ 已实现 |
| 草案展示 | `ModelDraftPanel.vue`（表格 + 假设/问题/风险 + 自动修正 + 原始 JSON） | ✅ 已实现 |
| 增量 revise | `apply-operations.ts` + `POST /api/model-draft/revise`：只应用 operations、字段级 diff、破坏性标记 | ✅ 已接入界面（确认后覆盖） |
| 落 Schema | `studio/schema-api.ts`（风险分级 + 一次性令牌 + prisma validate） | ⏳ 未接：需先把草案转成 `ModelEdit[]` |

接入顺序：只读生成（已完成）→ revise 增量与 diff → Schema 写回。**不要**一步做到「AI 直接改 schema」。

---

## 11. 版本

| 版本 | 日期 | 变更 |
|---|---|---|
| 1.0 | 2026-10-22 | 首版：输入/输出契约、字段字典、增量协议、异常矩阵、参数分层、自检 D1~D10 |
