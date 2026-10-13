# AI 多线程开工执行手册

> 版本 v0.1 ｜ 状态：草案 ｜ 更新：2026-10-12
>
> 关联：[并行工作线划分](./85-parallel-workstreams.md) ｜ [项目计划与任务板](./80-project-plan.md) ｜ [编码/Git/PR 规范](./70-engineering-standards.md) ｜ [验收标准](./10-acceptance-criteria.md)
>
> 本文回答一个问题：**用 AI（多个并行会话 / 子 agent）开工时，具体怎么分、怎么派活、怎么合并**。线的划分沿用 85 文档，本文只讲「AI 怎么跑」这部分。

## 1. 拓扑：一个编排者 + N 个执行 agent

```
主会话（编排者 = L0 + L6）
  ├─ 写契约、建骨架、建 worktree
  ├─ 分派任务给执行 agent（后台并行）
  ├─ 收 PR：评审 diff → 跑 CI → 合并 → 广播
  └─ 仲裁：契约变更、跨线冲突、阻塞升级
        │
        ├─ agent-orm   → packages/orm/**
        ├─ agent-auth  → packages/auth/**
        ├─ agent-cache → packages/cache/** + packages/queue/**
        ├─ agent-web   → apps/admin-web/**
        └─ agent-cli   → packages/cli/** + templates/**
```

**铁律**：执行 agent **只写代码**，不改契约、不改共享工程文件、不做跨线决策；这三件事全部归主会话。理由很简单——契约和 `pnpm-lock.yaml` 被两个 agent 同时改，合并成本远超并行收益。

## 2. 波次与并发上限

**并发数建议 4–5，不是越多越好。** 每个 agent 产出都要经过主会话评审 + CI，主会话的吞吐是瓶颈；超过 6 个会出现「PR 排队 + 合并冲突」反噬。

| 波次 | 时间 | 谁做 | 内容 | 说明 |
|---|---|---|---|---|
| **Wave 0** | 第 1 轮（半天） | **主会话单独做，不并行** | 写 6 份契约（C-03~C-08）、建 4 个空包骨架、建 `apps/admin-web` 骨架、建 worktree、CI 骨架 | 契约是并行的地基，并行写契约必然返工 |
| **Wave 1** | 第 2 轮起 | 5 个 agent 并行 | 见 §3 名额表「首个任务」 | 五条线互不依赖，靠契约 + stub 解耦 |
| **Wave 2** | W2–W3 | 同批 agent 继续（resume） | 各线推进到 I1 集成点 | 到达 I1 前不换 agent，保持上下文 |
| **Wave 3** | W4–W6 | 5 个 agent（L1 完成后 L5 接真实元信息） | 三驱动、方言白名单、真实 API 联调 | I2 集成点：切真实实现 |
| **Wave 4** | W7–W10 | 收敛到 3–4 个 agent | M6/M7/M8 | 线之间依赖变多，降并发保质量 |

**什么时候换 agent**：同一线同一里程碑内用 resume（保留上下文，成本低）；跨里程碑、agent 反复出错、或上下文已很长时，**新开会话 + 注入交接摘要**（见 §5.3）。

## 3. agent 名额表

下表就是「谁负责哪个」的最终答案，可直接照着开会话。

| agent 名 | 线 | worktree 目录 | 分支 | 可写目录（白名单） | 必读契约 | 首个任务（Wave 1） | 验收命令 |
|---|---|---|---|---|---|---|---|
| `agent-orm` | L1 数据访问 | `F:/WorkBuddy/TY-wt/l1-orm` | `lane/l1-orm` | `packages/orm/**`、`docs/prd/prd-002-*.md` | C-01 C-02 C-03 C-07 | ADR-0002 定稿（3 人日时间盒）+ `MemoryRepository` 内存实现 | `pnpm --filter @fw/orm test` |
| `agent-auth` | L2 鉴权权限 | `F:/WorkBuddy/TY-wt/l2-auth` | `lane/l2-auth` | `packages/auth/**`、`apps/example-api/src/modules/auth/**`、`docs/prd/prd-003-*.md` | C-01 C-03 C-04 C-05 C-06 | 五表迁移 + 密码策略（Argon2id） | `pnpm --filter @fw/auth test` |
| `agent-cache` | L3 缓存队列 | `F:/WorkBuddy/TY-wt/l3-cache` | `lane/l3-cache` | `packages/cache/**`、`packages/queue/**`、`docs/prd/prd-004-*.md`、`prd-007-*.md` | C-01 C-02 C-04 C-08 | `CacheService` 接口实现 + memory 驱动 + `NullCache` | `pnpm --filter @fw/cache test` |
| `agent-web` | L4 前端 | `F:/WorkBuddy/TY-wt/l4-web` | `lane/l4-web` | `apps/admin-web/**`、`docs/25-ui-prototype.md`、`docs/prd/prd-005-*.md` | C-06 | Vite 工程 + 布局 + request 层 + **mock server** | `pnpm --filter admin-web build` |
| `agent-cli` | L5 CLI 与生成 | `F:/WorkBuddy/TY-wt/l5-cli` | `lane/l5-cli` | `packages/cli/**`、`templates/**`、`docs/prd/prd-006-*.md` | C-03 C-05 C-07 | CLI 收尾 + `templates/` 补全 + 元信息解析（**fixture 驱动**） | `pnpm --filter @fw/cli test` |
| （主会话兼） | L6 质量交付 | 主工作区 `F:/WorkBuddy/TY` | `main` | `.github/**`、`scripts/**`、`docs/**` | 全部 | CI 流水线 + 门禁脚本 + 用例录入 | `pnpm build && pnpm test && pnpm run check:headers` |

**关键解阻塞项（必须最先交付，主会话要盯）**：

| 交付物 | 由谁 | 何时 | 解谁的锁 |
|---|---|---|---|
| `MemoryRepository` | agent-orm | Wave 1 末 | agent-auth（不用等真实驱动）、agent-cli（生成器自测） |
| `NullCache` | agent-cache | Wave 1 末 | agent-auth（权限缓存先空转）、agent-web |
| Mock server + C-06 样例 | agent-web | Wave 1 末 | agent-web 自己（最早开工，完全不等后端） |
| ADR-0002 定稿 | agent-orm | Wave 1 内 3 人日 | 全项目（ORM 选型不定，M2 全线悬空） |

## 4. 每个 agent 该喂什么（上下文包）

**不要**把整个仓库丢给 agent。每个 agent 的最小上下文包只有五样：

| # | 内容 | 来源 | 为什么 |
|---|---|---|---|
| 1 | 本线 PRD | `docs/prd/prd-00X-*.md` | 需求与验收标准 |
| 2 | 所依赖的契约 | `docs/contracts/*.ts` | 接口签名唯一真相 |
| 3 | 文件头与注释规范 | `docs/70-engineering-standards.md` §1.6 | CI 会拦，不喂必返工 |
| 4 | 本线任务清单与验收 | `docs/80-project-plan.md` 对应 `T-Mx-nn` 行 | 明确任务 ID 与验收用例编号 |
| 5 | 现有同构范例 | `packages/config`、`packages/logger`（已实现） | 让新包风格与已落地包一致 |

**不要喂**：其他线的 PRD、全文架构文档、CHANGELOG、历史讨论。上下文越长，agent 越容易跑偏去改别人的目录。

## 5. Prompt 模板（可直接复制）

### 5.1 新建会话（Wave 1 开工）

把 `<...>` 替换后整段作为会话开场词：

```
你是 <线名>（<线号>）的开发 agent。

【工作区】目录 F:/WorkBuddy/TY-wt/<lane>/，分支 lane/<lane>。所有操作在该目录内完成。
【可写白名单】只允许创建/修改这些路径：<白名单>。其他目录一律只读；需要改动请写进回报，不要动手。
【只读契约】docs/contracts/*.ts 是接口唯一真相，实现签名必须一致；发现契约不对，停止并回报，不要自行修改。

【必读】
- docs/prd/prd-00X-*.md（本线需求与验收）
- docs/contracts/C-0X*.ts（本线依赖的契约）
- docs/70-engineering-standards.md §1.6（中文文件头规范，@author donttemo、@created 当天日期）
- docs/80-project-plan.md 中任务 <T-Mx-nn>

【本次任务】<任务名>（<任务 ID>）
验收：<从计划表抄的验收条件，含用例编号>

【完成判定】在 <worktree 目录> 下执行并通过：
  pnpm install --frozen-lockfile
  pnpm --filter <包名> test
  pnpm --filter <包名> build
  cd F:/WorkBuddy/TY && pnpm run check:headers

【禁止】
- 修改 package.json（根）、pnpm-lock.yaml、turbo.json、tsconfig.base.json、docs/contracts/**
- 改动其他线的目录，或新增与本任务无关的文件
- 伪造测试结果；命令没跑就写"通过"，一律按失败处理
- 一次做多个任务；做完当前任务即停

【回报格式】
1. 改动文件清单（路径 + 行数）
2. 实际执行的命令与真实输出摘要
3. 验收用例对照：编号 → 通过/未通过
4. 未完成项与阻塞原因（无则写"无"）
```

### 5.2 继续同一条线（resume）

```
继续 <线号> 的工作，工作区与分支不变。

上次完成：<已完成项>
本次任务：<下一个 T-Mx-nn>，验收：<验收条件>
约束与回报格式同前。开始前先确认 main 已同步（git fetch && git rebase main），
若契约有更新，先按新契约修正已有实现再开工。
```

### 5.3 换 agent 接手（交接摘要）

新会话只给这段，不给历史对话：

```
接手 <线号>，工作区 F:/WorkBuddy/TY-wt/<lane>/，分支 lane/<lane>。

已完成：<文件/能力清单，含已通过的用例编号>
未完成：<任务 ID + 卡在哪>
已确认的设计决策：<ADR 编号 / 契约版本 / 关键取舍>
已知坑：<方言差异、异步上下文丢失等>
本次任务：<T-Mx-nn>，验收：<验收条件>
约束与回报格式同标准模板。
```

## 6. 主会话的每日节奏

| 时段 | 动作 |
|---|---|
| 开工 | 给每个 agent 派 **1 个**任务（不是一批），后台启动 |
| 收工通知 | agent 回报后：看 `git -C <worktree> diff --stat main` 确认没越界 |
| 评审 | 越界文件 `git checkout` 掉；diff ≤ 400 行，超出要求拆分 |
| 验证 | 在 worktree 内复跑测试命令（**不信任 agent 的自述结果**），再合并 |
| 合并 | `git -C F:/WorkBuddy/TY merge --no-ff lane/<lane>`，跑全量 `pnpm build && pnpm test && pnpm run check:headers` |
| 广播 | 合并后在其余 worktree 执行 `git fetch && git rebase main`，让各线同步 |
| 收尾 | 更新任务板快照；标记阻塞与解阻塞项 |

**主会话自己不写业务代码**。它的产出只有：契约、空包骨架、CI、合并与仲裁。这是 AI 并行能跑起来的前提——一旦编排者自己也下场写代码，评审队列立刻堵死。

## 7. 冲突处理（AI 特有）

| 情况 | 处理 |
|---|---|
| agent 改了别人的目录 | `git checkout` 掉越界改动，让它重做；标 `blocked` 并记录原因 |
| 两个 agent 都要改共享工程文件 | 一律主会话代改；agent 只能在回报里提需求 |
| agent 想改契约 | 停手回报；主会话裁决后统一改，再通知全线 rebase |
| 同一包被两个任务同时改 | 拆：一个任务只改一个子目录；或串行排队 |
| `pnpm-lock.yaml` 冲突 | 丢弃 agent 侧的改动，主会话在新包合并后统一 `pnpm install` 提交 |
| worktree 里 `node_modules` 缺失 | 首次进入执行 `pnpm install --frozen-lockfile --prefer-offline`（pnpm 全局 store 复用，通常很快） |

## 8. 防「AI 造假」的四道闸

1. **命令必回传**：agent 必须贴出真实执行的命令与输出摘要；只写"已通过"无输出 = 未通过。
2. **主会话复跑**：合并前在主工作区或 worktree 复跑一遍测试与构建。
3. **用例编号对照**：回报必须逐条对照 `TC-XXX-nnn`，不允许笼统写"测试通过"。
4. **门禁脚本兜底**：`pnpm run check:headers`（文件头）+ lint + 覆盖率，CI 阻断合并；agent 无法绕过。

另外要求 agent **长任务分段回报**（每完成一个子步骤回报一次），避免长时间静默后一次性交付一大坨无法评审的 diff。

## 9. 失败与接管策略

| 现象 | 动作 |
|---|---|
| agent 卡在某个报错反复重试 | 主会话直接接管：读它的 diff，自己改或换个新 agent 带错误信息重开 |
| 产出与契约不符 | 以契约为准打回重做；连续两次不符，换新会话并只给契约 + 失败点 |
| 上下文过长导致质量下降 | 结束该会话，用 §5.3 交接摘要开新会话 |
| 某线成为关键路径瓶颈（如 ADR-0002） | 加派：拆出独立的短任务 agent（如只做选型对比报告），主会话汇总决策 |
| 集成点 CI 不绿 | 熔断：全线暂停新功能，只修集成缺陷，绿了再放行 |

## 10. 第一天启动清单（可直接照做）

主会话依次执行：

```bash
cd F:/WorkBuddy/TY

# 1. 建 5 条线的工作副本（集中放在 TY-wt 下，便于管理）
mkdir -p ../TY-wt
git worktree add ../TY-wt/l1-orm   -b lane/l1-orm
git worktree add ../TY-wt/l2-auth  -b lane/l2-auth
git worktree add ../TY-wt/l3-cache -b lane/l3-cache
git worktree add ../TY-wt/l4-web   -b lane/l4-web
git worktree add ../TY-wt/l5-cli   -b lane/l5-cli

# 2. 每份副本装依赖（pnpm 全局 store 复用，通常几十秒）
for w in l1-orm l2-auth l3-cache l4-web l5-cli; do
  (cd ../TY-wt/$w && pnpm install --frozen-lockfile --prefer-offline)
done

# 3. 检查副本是否可独立构建
for w in l1-orm l2-auth l3-cache l4-web l5-cli; do
  (cd ../TY-wt/$w && pnpm build) || echo "FAIL $w"
done
```

然后：

1. 主会话写 6 份契约（`docs/contracts/repository.ts`、`cache.ts`、`auth.ts`、`api-web.ts`、`introspector.ts`、`queue.ts`），冻结 C-01/C-02。
2. 主会话建 `packages/orm`、`packages/auth`、`packages/cache`、`packages/queue` 空包骨架（含 `package.json`、`tsconfig.json`、`src/index.ts` 中文文件头）。
3. 主会话建 `apps/admin-web/` 骨架（Vite + Vue3 + Element Plus）。
4. 提交并推送到 `main`，五个 worktree 各自 `git rebase main`。
5. 开 5 个 agent，按 §5.1 模板派发 Wave 1 首个任务（见 §3 表格）。
6. 收回报 → 评审 → 复跑 → 合并 → rebase 广播，进入每日循环。

## 11. 与人工协作的边界

AI 并行适合**边界清晰、有契约、有验收**的任务（本项目的框架包基本都符合）。以下三类建议人工主导，AI 只做辅助：

- **ADR-0002 ORM 选型**：AI 出对比报告，人拍板（影响面太大，且需要口味判断）。
- **跨线契约变更**：主会话（人）裁决，AI 执行同步。
- **里程碑验收与演练**：人主持，AI 出记录与脚本。

## 12. 修订记录

| 日期 | 作者 | 摘要 |
|---|---|---|
| 2026-10-12 | donttemo | 初版：编排者 + 5 执行 agent 拓扑、Wave 0–4 波次、名额表与白名单、prompt 模板（新建/resume/交接）、每日节奏、冲突与防造假、第一天启动命令 |
