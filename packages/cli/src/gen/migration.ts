/*
 * @file 迁移风险分级（PRD-016 FR-16-05）
 * @description 对 Prisma 生成的 migration.sql 做语句级风险判定，供 fw gen crud / fw deploy 在
 *   「执行前」决定是自动放行、需要一次确认、还是直接阻断。
 *   判定只看 SQL 文本，不依赖数据库连接（dry 环境下也能给出结论），因此可被单测穷举覆盖。
 *   分级口径：safe=可自动执行；confirm=会改数据形态需一次确认；blocked=可能不可逆，需显式 --allow-destructive。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/gen
 * @since v0.8.0
 */

/** 单条语句的风险级别 */
export type MigrationRisk = 'safe' | 'confirm' | 'blocked';

/** 风险发现项 */
export interface MigrationFinding {
  /** 级别 */
  level: Exclude<MigrationRisk, 'safe'>;
  /** 触发的语句（截断后的单行） */
  statement: string;
  /** 中文原因（面向用户，不暴露正则） */
  reason: string;
}

/** 整体评估结果 */
export interface MigrationAssessment {
  /** 取所有语句中的最高风险 */
  risk: MigrationRisk;
  /** 风险明细（safe 语句不入列） */
  findings: MigrationFinding[];
  /** 语句总数（用于输出摘要） */
  statementCount: number;
}

/** 单行化并截断（输出与断言都更稳） */
function oneLine(statement: string, max = 120): string {
  const flat = statement.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * 判断单条语句的风险
 * @param statement 单条 SQL（已去掉注释）
 * @returns 风险发现项；安全语句返回 null
 */
export function classifyStatement(statement: string): MigrationFinding | null {
  const sql = statement.replace(/\s+/g, ' ').trim();
  if (sql === '') return null;

  if (/^drop\s+table\b/i.test(sql)) {
    return { level: 'blocked', statement: oneLine(sql), reason: '删除表：数据整体丢失且不可逆' };
  }
  if (/^truncate\b/i.test(sql)) {
    return { level: 'blocked', statement: oneLine(sql), reason: '清空表：数据不可恢复' };
  }
  // ALTER TABLE ... DROP COLUMN / DROP CONSTRAINT 中的列删除
  if (/^alter\s+table\b[^;]*\bdrop\s+column\b/i.test(sql)) {
    return { level: 'blocked', statement: oneLine(sql), reason: '删除列：该列历史数据丢失' };
  }
  // 新增非空列且无默认值：存量行无法填充，迁移会直接失败或写入脏值
  if (/^alter\s+table\b[^;]*\badd\s+(column\s+)?\S+[^;]*\bnot\s+null\b/i.test(sql) && !/\bdefault\b/i.test(sql)) {
    return { level: 'blocked', statement: oneLine(sql), reason: '新增非空列且无默认值：存量数据无法满足约束' };
  }
  if (/^alter\s+table\b[^;]*\brename\b/i.test(sql)) {
    return { level: 'confirm', statement: oneLine(sql), reason: '重命名表/列：旧代码按旧名访问会立刻报错' };
  }
  if (/^alter\s+table\b[^;]*\balter\s+column\b[^;]*\btype\b/i.test(sql)) {
    return { level: 'confirm', statement: oneLine(sql), reason: '修改列类型：可能截断或丢失精度' };
  }
  return null;
}

/**
 * 评估整份迁移 SQL
 * @param sql migration.sql 全文
 */
export function assessSql(sql: string): MigrationAssessment {
  const statements = sql
    .replace(/\r\n/g, '\n')
    // 去掉 -- 行注释与 /* */ 块注释，避免注释里的关键字误判
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');

  const findings: MigrationFinding[] = [];
  for (const statement of statements) {
    const finding = classifyStatement(statement);
    if (finding) findings.push(finding);
  }

  const risk: MigrationRisk = findings.some((finding) => finding.level === 'blocked')
    ? 'blocked'
    : findings.length > 0
      ? 'confirm'
      : 'safe';

  return { risk, findings, statementCount: statements.length };
}

/**
 * 把评估结果压成一行中文摘要（输出用）
 * @param assessment 评估结果
 */
export function summarizeAssessment(assessment: MigrationAssessment): string {
  if (assessment.risk === 'safe') return `迁移安全（${assessment.statementCount} 条语句，无破坏性操作）`;
  const reasons = [...new Set(assessment.findings.map((finding) => finding.reason))];
  const label = assessment.risk === 'blocked' ? '迁移含破坏性操作' : '迁移需确认';
  return `${label}：${reasons.join('；')}`;
}
