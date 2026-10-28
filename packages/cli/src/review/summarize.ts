/*
 * @file 审查结论解析与去重（PRD-017 FR-17-23）
 * @description 分片/多次审查会把同一问题重复报出来；直接把各片文本拼起来，用户得自己比对。
 *   这里把模型输出解析成结构化条目，按「文件 + 行 + 规则」归并：
 *   - 同一位置的同一问题（标题相同或互相包含）合并，严重级取更高，建议去重拼接；
 *   - 解析不出条目时返回空，调用方回退到原文（绝不吞掉模型输出）。
 * @author donttemo
 * @created 2026-10-27
 * @module cli/review
 * @since v0.8.0
 */

/** 严重级（数值越小越严重） */
export type Severity = 'P0' | 'P1' | 'P2';

/** 一条审查结论 */
export interface Finding {
  severity: Severity;
  /** 文件路径（模型可能只给文件名） */
  file?: string;
  /** 行号 */
  line?: number;
  /** 问题标题 */
  title: string;
  /** 修改建议 */
  advice?: string;
  /** 原文行（合并时保留首条） */
  raw: string;
}

/** 合并统计 */
export interface MergeResult {
  findings: Finding[];
  /** 被合并掉的重复条数 */
  merged: number;
}

const SEVERITY_ORDER: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 };

/** 是否普通对象（保持风格一致） */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 规范化标题用于比较
 * @description 去空白、标点、全半角差异；只保留字母数字与中文，避免「补 DTO。」与「补 DTO」被当成两条
 * @param text 原文
 */
export function normalizeTitle(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s，。；、：:,.;!'"`~!@#$%^&*()_+\-=[\]{}|\\<>/?]+/g, '')
    .slice(0, 60);
}

/**
 * 解析模型输出里的结论行
 * @param text 单次或合并后的模型输出
 * @returns 结构化结论（解析不出返回空数组）
 */
export function parseFindings(text: string): Finding[] {
  const findings: Finding[] = [];
  if (typeof text !== 'string' || text.trim() === '') return findings;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    // 只认带严重级前缀的行：`[P0] …`、`- [P1] …`、`**P2** …`
    const match = /^[-*\s]*(?:\*\*)?\[?(P0|P1|P2)\]?(?:\*\*)?\s*[—–:\-]?\s*(.+)$/i.exec(line);
    if (!match) continue;
    const severity = match[1].toUpperCase() as Severity;
    const body = match[2].trim();
    if (body === '') continue;

    // 位置：path:line（允许全角冒号；行号范围只取起始行）
    const location = /([\w./@\-]+\.(?:ts|tsx|js|jsx|vue|prisma|json|sql|md))\s*[:：]\s*(\d+)/i.exec(body);
    // 建议只在箭头后：位置与标题之间的破折号不是建议分隔符
    const arrow = /\s*(?:→|->)\s*/.exec(body);
    const headPart = arrow ? body.slice(0, arrow.index) : body;
    const advice = arrow ? body.slice(arrow.index + arrow[0].length).trim() : undefined;
    let head = headPart
      .replace(/^[（(]?[\w./@\-]+\.(?:ts|tsx|js|jsx|vue|prisma|json|sql|md)\s*[:：]\s*\d+[)）]?\s*[—–:\-]?\s*/i, '')
      .replace(/\s*[:：—–]\s*$/, '')
      .trim();
    if (head === '') head = headPart.trim();

    findings.push({
      severity,
      ...(location ? { file: location[1], line: Number(location[2]) } : {}),
      title: head === '' ? body : head,
      ...(advice && normalizeTitle(advice) !== normalizeTitle(head) ? { advice } : {}),
      raw: line,
    });
  }
  return findings;
}

/**
 * 合并多批结论（同一问题只留一条）
 * @param batches 各片/各次解析结果
 */
export function mergeFindings(batches: Finding[][]): MergeResult {
  // 归并键用文件名（basename）：不同分片里模型可能一次给全路径、一次只给文件名，
  // 用完整路径当键会把同一条问题拆成两条。
  const baseOf = (value?: string): string => (value ? value.split(/[\\/]/).pop() ?? value : '?');
  const byLocation = new Map<string, Finding[]>();
  for (const finding of batches.flat()) {
    const key = `${baseOf(finding.file)}:${finding.line ?? 0}`;
    const bucket = byLocation.get(key);
    if (bucket) bucket.push(finding);
    else byLocation.set(key, [finding]);
  }

  const mergedFindings: Finding[] = [];
  let merged = 0;
  for (const bucket of byLocation.values()) {
    const kept: Finding[] = [];
    for (const finding of bucket) {
      const title = normalizeTitle(finding.title);
      const hit = kept.find((item) => {
        const other = normalizeTitle(item.title);
        if (other === title) return true;
        // 包含关系：短标题至少 6 字、且多出的部分不长，避免「缺少校验」与「缺少校验和日志」被误并
        const shorter = title.length <= other.length ? title : other;
        const longer = shorter === title ? other : title;
        return shorter.length >= 6 && longer.includes(shorter) && longer.length - shorter.length <= 16;
      });
      if (!hit) {
        kept.push({ ...finding });
        continue;
      }
      merged += 1;
      // 展示保留更完整的路径（全路径优先）
      if ((finding.file?.length ?? 0) > (hit.file?.length ?? 0)) hit.file = finding.file;
      // 严重级取更高；建议去重拼接，保留信息量
      if (SEVERITY_ORDER[finding.severity] < SEVERITY_ORDER[hit.severity]) hit.severity = finding.severity;
      const advices = [hit.advice, finding.advice].filter((item): item is string => Boolean(item && item.trim()));
      // 建议也按包含关系去重：保留信息量更大的那条（「给 5 个端点补 @Permissions」胜过「补 @Permissions」）
      const unique: string[] = [];
      for (const advice of advices) {
        const normalized = normalizeTitle(advice);
        const index = unique.findIndex((item) => {
          const other = normalizeTitle(item);
          return other === normalized || other.includes(normalized) || normalized.includes(other);
        });
        if (index < 0) unique.push(advice.trim());
        else if (advice.trim().length > unique[index].length) unique[index] = advice.trim();
      }
      if (unique.length > 0) hit.advice = unique.join('；');
    }
    mergedFindings.push(...kept);
  }

  mergedFindings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (a.file ?? '').localeCompare(b.file ?? '') ||
      (a.line ?? 0) - (b.line ?? 0),
  );
  return { findings: mergedFindings, merged };
}

/**
 * 渲染汇总
 * @param result 合并结果
 * @param rawByBatch 原文（用于标题上方的统计）
 */
export function formatFindings(result: MergeResult): string {
  const counts: Record<Severity, number> = { P0: 0, P1: 0, P2: 0 };
  for (const finding of result.findings) counts[finding.severity] += 1;

  const lines: string[] = [
    `汇总：P0 ${counts.P0} / P1 ${counts.P1} / P2 ${counts.P2}（${result.findings.length} 条${
      result.merged > 0 ? `，合并重复 ${result.merged} 条` : ''
    }）`,
    '',
  ];
  for (const severity of ['P0', 'P1', 'P2'] as const) {
    const group = result.findings.filter((finding) => finding.severity === severity);
    if (group.length === 0) continue;
    lines.push(`${severity}`);
    for (const finding of group) {
      const where = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''} — ` : '';
      lines.push(`- ${where}${finding.title}${finding.advice ? ` → ${finding.advice}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/** 判断是否像审查输出（避免把普通文本硬解析成空汇总） */
export function hasFindings(text: string): boolean {
  return parseFindings(text).length > 0;
}

export { isObject };
