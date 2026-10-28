/*
 * @file 迁移风险分级单测（PRD-016 FR-16-05）
 * @description 穷举安全 / 需确认 / 阻断三类语句，并锁定「注释里的关键字不算数」与「取最高风险」两条口径。
 * @author donttemo
 * @created 2026-10-22
 * @module cli
 */

import { describe, expect, it } from 'vitest';
import { assessSql, classifyStatement, summarizeAssessment } from '../migration.js';

describe('classifyStatement', () => {
  it('建表 / 建索引 / 新增可空列视为安全', () => {
    expect(classifyStatement('CREATE TABLE "Order" ("id" TEXT PRIMARY KEY)')).toBeNull();
    expect(classifyStatement('CREATE INDEX "Order_code_idx" ON "Order"("code")')).toBeNull();
    expect(classifyStatement('ALTER TABLE "Order" ADD COLUMN "remark" TEXT')).toBeNull();
    expect(classifyStatement('ALTER TABLE "Order" ADD COLUMN "qty" INTEGER NOT NULL DEFAULT 0')).toBeNull();
  });

  it('删表 / 清表 / 删列视为阻断', () => {
    expect(classifyStatement('DROP TABLE "Order"')?.level).toBe('blocked');
    expect(classifyStatement('TRUNCATE TABLE "Order"')?.level).toBe('blocked');
    expect(classifyStatement('ALTER TABLE "Order" DROP COLUMN "remark"')?.level).toBe('blocked');
  });

  it('新增非空列且无默认值视为阻断（存量数据无法满足约束）', () => {
    const finding = classifyStatement('ALTER TABLE "Order" ADD COLUMN "code2" TEXT NOT NULL');
    expect(finding?.level).toBe('blocked');
    expect(finding?.reason).toContain('非空列');
  });

  it('重命名与改类型视为需确认', () => {
    expect(classifyStatement('ALTER TABLE "Order" RENAME COLUMN "code" TO "sn"')?.level).toBe('confirm');
    expect(classifyStatement('ALTER TABLE "Order" ALTER COLUMN "qty" TYPE BIGINT')?.level).toBe('confirm');
  });

  it('空语句返回 null', () => {
    expect(classifyStatement('   ')).toBeNull();
  });
});

describe('assessSql', () => {
  it('纯安全迁移的整体风险为 safe', () => {
    const assessment = assessSql('CREATE TABLE "A" ("id" TEXT);\nCREATE INDEX "a_idx" ON "A"("id");');
    expect(assessment.risk).toBe('safe');
    expect(assessment.statementCount).toBe(2);
    expect(assessment.findings).toEqual([]);
  });

  it('取所有语句中的最高风险（confirm 与 blocked 混合 → blocked）', () => {
    const assessment = assessSql(
      'ALTER TABLE "A" RENAME COLUMN "x" TO "y";\nALTER TABLE "A" DROP COLUMN "z";',
    );
    expect(assessment.risk).toBe('blocked');
    expect(assessment.findings).toHaveLength(2);
  });

  it('注释里的关键字不参与判定', () => {
    const assessment = assessSql('-- DROP TABLE "A" 只是注释\n/* DROP TABLE "B" */\nCREATE TABLE "C" ("id" TEXT);');
    expect(assessment.risk).toBe('safe');
  });

  it('CRLF 与多行语句可正确切分', () => {
    const assessment = assessSql('CREATE TABLE "A" (\r\n  "id" TEXT\r\n);\r\n');
    expect(assessment.statementCount).toBe(1);
    expect(assessment.risk).toBe('safe');
  });
});

describe('summarizeAssessment', () => {
  it('安全迁移给出一行摘要', () => {
    expect(summarizeAssessment(assessSql('CREATE TABLE "A" ("id" TEXT);'))).toContain('迁移安全');
  });

  it('风险迁移去重列出原因', () => {
    const text = summarizeAssessment(
      assessSql('DROP TABLE "A";\nDROP TABLE "B";'),
    );
    expect(text).toContain('破坏性');
    expect(text).toContain('删除表');
    expect(text.split('删除表').length - 1).toBe(1);
  });
});
