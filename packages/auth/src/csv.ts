/*
 * @file 审计导出 CSV 单元格编码（PRD-015 FR-15-19 安全加固）
 * @description 单元格编码是一条固定顺序的职责链，顺序不可调换：
 *   ① null / undefined → 空单元格（空串，不是字面量 `""`：两者在运营读表时不同义）；
 *   ② 非字符串先 JSON 序列化（before / after 快照就是这么进 CSV 的）；
 *   ③ CR / LF 压成空格：一行数据被拆成多行时，Excel 会把续行读成一条新记录；
 *   ④ **危险前缀中和**：以 `= + - @` 或制表符开头的单元格会被 Excel / WPS / Sheets 当成公式执行
 *      （DDE、`HYPERLINK()`、`cmd|' /C ...'`），加单引号前缀强制按文本解析；
 *   ⑤ 最后才做引号包裹 + 内部引号翻倍。
 *
 *   为什么必须在这一层做：**引号转义 ≠ 公式注入防护**。`"=1+1"` 在 Excel 里仍然是公式——
 *   引号只是 CSV 的分隔符，不进单元格值。也不能只靠 UI 输入校验：导入数据、历史数据、
 *   内部服务写入（配置中心 / 定时任务 / 迁移脚本）都会绕过前端把危险前缀写进库。
 *
 *   防护代价：被中和的单元格在表格软件里会显示一个前导单引号（其余字符一个不少，不截断、
 *   不丢弃）。这是「可读性」与「不执行」之间的取舍，与 OWASP CSV Injection 的推荐做法一致；
 *   若下游脚本要还原原值，去掉首字符即可（本仓的运维读表场景不需要还原）。
 *
 *   同一份规则在 admin-web 的 mock 侧有一份逐字节同构的实现（`apps/admin-web/mock/csv-cell.ts`），
 *   两侧由门禁与单测锁定，改动必须同步。
 * @author donttemo
 * @created 2026-10-20
 * @module @fw/auth
 */

/**
 * 公式注入的危险前缀（OWASP CSV Injection）
 *
 * 首字符（允许先出现空白）为 `=` `+` `-` `@` 或制表符即判危险：前三个是公式起始符，
 * `@` 在 Lotus 兼容模式与部分工具里同样触发求值，制表符可被用来把内容顶进后续单元格。
 */
const FORMULA_TRIGGER = /^\s*[=+\-@\t]/;

/** 中和前缀：单引号让表格软件把整格按文本处理 */
const TEXT_GUARD = "'";

/**
 * 把一个值编码成安全的 CSV 单元格（含引号转义与公式注入防护）
 * @param value 任意值（null / undefined → 空单元格）
 * @returns 可直接用 `,` 连接的单元格文本
 */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  const flattened = text.replace(/[\r\n]+/g, ' ');
  const guarded = FORMULA_TRIGGER.test(flattened) ? `${TEXT_GUARD}${flattened}` : flattened;
  return `"${guarded.replace(/"/g, '""')}"`;
}
