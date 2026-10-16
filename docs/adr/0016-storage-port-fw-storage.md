# ADR-0016 · 文件存储端口 @fw/storage：端口 + local/s3 双驱动，S3 走 optional peer 结构化最小接口

- 状态：已采纳
- 日期：2026-10-16
- 关联：PRD-010（E-09 / AC5 收编）、[api-spec §3.16](../40-api-spec.md)、[数据字典 §3.19](../30-data-dictionary.md)、ADR-0004（cache 抽象同构先例）、ADR-0012（框架自有端口）

## 背景

1. E-08（admin 全栈模板）交付了模板自有的附件上传模块（本地磁盘 fs 直写 + upload_files 元数据表），注释预留「E-09 落地后平移为 StoragePort 适配」；98 清单 7.1 隐含「上传走对象存储」缺框架侧端口。
2. E-09 验收口径：单测双驱动 + mock 同构（N-02 逐字节纪律）、codegen 识别附件字段、数据字典补表。

## 决策

1. **端口 + 多驱动 + `*_DRIVER` 枚举**（先例 cache/queue/transport/config-center）：`StoragePort`（put/get/delete/exists/stat/ping/close）为唯一业务依赖面，`STORAGE_DRIVER=local|s3` 装配切换，非法取值启动即失败（zod 枚举 + s3 桶名缺失启动即失败双保险）；业务与控制器只注入 `StorageService` 门面（校验 + key 生成 + 端口代理）。
2. **S3 走 optional peer + 结构化最小接口**（沿用 @fw/cache 对 ioredis 的 M4 先例）：`@aws-sdk/client-s3` 声明为 `peerDependenciesMeta.optional`，仅在 `STORAGE_DRIVER=s3` 时经变量名动态 `import()` 懒加载（local 驱动下 SDK 不进依赖图）；框架导出面只暴露本包定义的最小结构类型（`S3ClientLike` / `S3CommandFactory`），不泄漏 SDK 类型；未安装且启用时启动即失败并给出安装命令。**本仓 lockfile 因 pnpm `auto-install-peers` 默认会装上 SDK**——外部消费者按需安装。
3. **校验在门面层默认收紧**（NFR 安全）：20MB 上限（`STORAGE_MAX_MB`，与任务产物口径一致）+ 扩展名白名单（`STORAGE_ALLOWED_EXTS`，11 类默认与 E-08 模板一致），超限/越权类型一律 `400/1001` 不静默截断；存储 key 由服务端生成（`<yyyyMM>/<uuid><ext>`），不透传用户输入；端口层 key 卫兵（禁 `..`/反斜杠/绝对路径/空段）+ local 驱动 resolve 越界最终防线。
4. **下载契约 = 登录即可 + 裸字节流**（与任务产物下载同款 `@Res()` 直写约定）：元数据与下载登录即可（我自己的上传产物），上传消耗存储面显式成码 `file:create`（seed 授予 user 角色）；响应不包统一信封（`res.headersSent` 语义），Content-Disposition 走 RFC 5987。
5. **元数据表归 example-api**（数据字典 §3.19）：内容在存储端口、元数据在库（`upload_files`），业务附件字段约定为 `*FileId` / `*AttachmentId` 的 String 列存本表 id——codegen 据此生成 upload 控件（FileUpload 组件），后端照常按 string 接收；不做物理外键（沿本仓跨库约定）。
6. **E-08 模板收编**：模板 upload 模块删除自有 fs 实现，改注入 `@fw/storage` StorageService，业务接口与端点契约不变（AC5 收编承诺兑现，smoke-template-admin 7/7 复验）。

## 备选方案

| 方案 | 优点 | 缺点 | 未选原因 |
|---|---|---|---|
| **optional peer + 结构化最小接口（本决策）** | local 零依赖；SDK 版本升级不破框架类型；测试注入 fake 无需真实 SDK 与网络 | 动态 import 无法在编译期校验 SDK 形状（启动期形状守卫补位） | — |
| 硬依赖 @aws-sdk/client-s3 | 类型全、API 面完整 | 小系统被迫背 ~30 包依赖图（违背 PRD-004 AC-001「小系统零 Redis」同款原则） | 违背框架「默认轻、按需装」约定 |
| 自研 SigV4 REST 客户端（零依赖直签） | 零依赖、零动态加载 | 签名 / 分段上传 / 兼容性矩阵自担（COS/OSS/MinIO 差异），长期维护面大 | 框架不重复造存储 SDK |
| 元数据也放对象存储（无 upload_files 表） | 少一张表 | 丢失归属人 / 审计 / 软删语义，业务查询（我的附件列表）要打存储 API | 归属与配额是业务语义，落库 |

## 后果

**正面**：
- 带附件的业务 CRUD 不再每项目重写上传；`STORAGE_DRIVER` 一改即切 local/s3，业务代码 diff = 0。
- 双驱动单测 45 条（local 真实临时目录 / s3 fake 客户端）+ mock 三端点逐字节同构（smoke-mock 140/140）+ 模板冒烟 7/7。
- 新配置键 10 个全部登记 `ENV_KEY_PATHS`（97 键），「加键必须登记」门禁自动强制。

**负面 / 代价**：
- s3 驱动在真实对象存储上的端到端（MinIO/AWS）本机无环境未实测——fake 客户端覆盖语义，真实端点连通性归入 E-05/E-11 环境到位后补测（AC8 同款纪律）。
- 本仓 lockfile 因 `auto-install-peers` 默认纳入 @aws-sdk/client-s3（约 +30 包）；CI 安装体积上升属预期。
- 下载为整 Buffer 回放（20MB 上限内），不做 Range/分片——大文件流式下载列为非目标。
