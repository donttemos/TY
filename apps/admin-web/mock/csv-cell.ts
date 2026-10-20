/*
 * @file mock 侧 CSV 单元格编码（与 @fw/auth 的 escapeCsvCell 逐字节同构）
 * @description mock 不引用框架包（mock server 只装前端依赖，拉进 @fw/auth 会带 Nest 运行时），
 *   因此这里保留一份**同源实现**，并通过门禁锁定两侧的危险前缀集合：
 *   ① 任何一侧新增 / 收紧 / 删除防护都必须同步另一侧，否则「dev 全绿、真机产物不同」；
 *   ② 测试向量与 `apps/example-api/src/modules/auth/audit-csv.spec.ts` 保持同一组用例
 *      （= + - @ 制表符 / HYPERLINK 载荷 / 前导空白 / 普通中文不被误伤）。
 *
 *   编码顺序与框架实现一致：空值 → JSON 序列化 → CR/LF 压平 → 危险前缀加单引号 → 引号包裹翻倍。
 *   引号转义 ≠ 公式注入防护：`"=1+1"` 在 Excel 里仍然是公式（引号只是分隔符，不进单元格值）。
 * @author donttemo
 * @created 2026-10-20
 * @module admin-web/mock
 */

/** 公式注入危险前缀（OWASP CSV Injection）：首字符（允许前导空白）= + - @ 或制表符 */
const FORMULA_TRIGGER = /^\s*[=+\-@\t]/;

/** 中和前缀：单引号让表格软件把整格按文本处理 */
const TEXT_GUARD = "'";

/**
 * 把一个值编码成安全的 CSV 单元格
 * @param value 任意值（null / undefined → 空单元格，与后端一致：空串而不是字面量 ""）
 * @returns 可直接用 `,` 连接的单元格文本
 */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  const flattened = text.replace(/[\r\n]+/g, ' ');
  const guarded = FORMULA_TRIGGER.test(flattened) ? `${TEXT_GUARD}${flattened}` : flattened;
  return `"${guarded.replace(/"/g, '""')}"`;
}
