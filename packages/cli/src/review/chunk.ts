/*
 * @file 审查分片规划（PRD-017 FR-17-23 补强）
 * @description 一次把 9 个文件 61KB 丢给推理模型，实测 180 秒也跑不完；让用户「少选文件」是把问题推回去。
 *   这里按体积预算切片，逐片调用再合并，每片都能在超时内完成。
 *   规则：贪心装填；单个文件超预算时独占一片并标注；片数超过上限时把剩余并入最后一片并给出 warning。
 * @author donttemo
 * @created 2026-10-27
 * @module cli/review
 * @since v0.8.0
 */

/** 单片默认预算（经验值：24KB ≈ 8k tokens，推理模型通常 30~60s 可回） */
export const DEFAULT_CHUNK_BUDGET_BYTES = 24 * 1024;

/** 默认最多片数（再多说明该拆任务，而不是继续堆调用） */
export const DEFAULT_MAX_CHUNKS = 6;

/** 可切片的最小文件形状 */
export interface ChunkableFile {
  path: string;
  bytes: number;
}

/** 一个分片 */
export interface ReviewChunk<T extends ChunkableFile> {
  /** 从 0 开始 */
  index: number;
  files: T[];
  bytes: number;
  /** 单片就超过预算（无法再拆） */
  oversized: boolean;
  /** 分组标签：按模型分组时为模型名 / shared */
  label?: string;
}

/** 规划结果 */
export interface ChunkPlan<T extends ChunkableFile> {
  chunks: ReviewChunk<T>[];
  warnings: string[];
}

/**
 * 按体积预算规划分片
 * @param files 待审文件（保持原顺序）
 * @param options 预算、片数上限
 */
export function planReviewChunks<T extends ChunkableFile>(
  files: T[],
  options: { budgetBytes?: number; maxChunks?: number; perFile?: boolean; groupBy?: 'size' | 'model' } = {},
): ChunkPlan<T> {
  const budget = options.budgetBytes ?? DEFAULT_CHUNK_BUDGET_BYTES;
  const maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS;
  const warnings: string[] = [];
  const chunks: ReviewChunk<T>[] = [];

  /** 贪心装箱（同一组内） */
  const pack = (group: T[], label?: string): ReviewChunk<T>[] => {
    const packed: ReviewChunk<T>[] = [];
    for (const file of group) {
      const current = packed[packed.length - 1];
      if (current && current.bytes + file.bytes <= budget) {
        current.files.push(file);
        current.bytes += file.bytes;
        continue;
      }
      packed.push({
        index: packed.length,
        files: [file],
        bytes: file.bytes,
        oversized: file.bytes > budget,
        ...(label === undefined ? {} : { label }),
      });
    }
    return packed;
  };

  // 逐文件模式：一个文件一次调用。好处是失败隔离、行号准确、单片必然最小；
  // 代价是跨文件因果（controller 缺权限 + seed 权限码无人消费）会被拆散。
  if (options.perFile === true) {
    return {
      chunks: files.map((file, index) => ({
        index,
        files: [file],
        bytes: file.bytes,
        oversized: file.bytes > budget,
      })),
      warnings,
    };
  }

  // 按模型分组：同模型的文件必须一起看（controller 缺权限 + seed 权限码无人消费这类因果）。
  // 接线文件（shared）默认**随组发送**：模块注册类问题必须同时看到 demo-item.module 与 app.module。
  // 约束：模型组超过 3 个时不复制（避免 ×N 放大），shared 单独成组；体积装不下的部分也单独成组。
  if (options.groupBy === 'model') {
    const groups = new Map<string, T[]>();
    const shared: T[] = [];
    for (const file of files) {
      if ((file as { model?: string }).model === 'shared') {
        shared.push(file);
        continue;
      }
      const key = (file as { model?: string }).model ?? 'shared';
      const bucket = groups.get(key);
      if (bucket) bucket.push(file);
      else groups.set(key, [file]);
    }

    const attach = groups.size > 0 && groups.size <= 3;
    const attached = new Set<T>();
    for (const [label, group] of groups) {
      const packed = pack(group, label);
      if (attach) {
        for (const file of shared) {
          const target = packed.find((chunk) => chunk.bytes + file.bytes <= budget);
          if (!target) continue;
          target.files.push(file);
          target.bytes += file.bytes;
          attached.add(file);
        }
      }
      chunks.push(...packed);
    }

    const leftover = shared.filter((file) => !attached.has(file));
    if (leftover.length > 0) chunks.push(...pack(leftover, 'shared'));

    if (!attach && shared.length > 0) {
      warnings.push(`模型较多（${groups.size} 个）：接线文件（shared）单独成组，避免每个模型组重复携带；模块注册类问题建议用 --split=auto 复核`);
    } else if (attach && leftover.length > 0) {
      warnings.push(`有 ${leftover.length} 个 shared 文件体积过大，未能并入模型组，已单独成组（行号跨段需按段头换算）`);
    }

    const indexed = chunks.map((chunk, index) => ({ ...chunk, index }));
    if (indexed.length > maxChunks) {
      warnings.push(
        `按模型分组后共 ${indexed.length} 片（上限 ${maxChunks}）：不会跨模型合并（会混淆因果），必要时分批审查`,
      );
    }
    return { chunks: indexed, warnings };
  }

  for (const file of files) {
    const current = chunks[chunks.length - 1];
    if (current && current.bytes + file.bytes <= budget) {
      current.files.push(file);
      current.bytes += file.bytes;
      continue;
    }
    chunks.push({
      index: chunks.length,
      files: [file],
      bytes: file.bytes,
      // 单个文件本身就超预算：独占一片，标记出来（界面可提示「该文件过大」）
      oversized: file.bytes > budget,
    });
  }

  if (chunks.length > maxChunks) {
    const head = chunks.slice(0, maxChunks - 1);
    const tail = chunks.slice(maxChunks - 1);
    const merged: ReviewChunk<T> = {
      index: head.length,
      files: tail.flatMap((chunk) => chunk.files),
      bytes: tail.reduce((sum, chunk) => sum + chunk.bytes, 0),
      oversized: tail.some((chunk) => chunk.oversized),
    };
    warnings.push(
      `文件较多，已把最后 ${tail.length} 片合并为一片（上限 ${maxChunks} 片）；如仍超时，请按模型分批审查`,
    );
    return { chunks: [...head, merged], warnings };
  }

  return { chunks, warnings };
}

/** 文件切段结果 */
export interface FileSlice {
  content: string;
  bytes: number;
  /** 起始行（1 基，含） */
  fromLine: number;
  /** 结束行（1 基，含） */
  toLine: number;
  totalLines: number;
}

/**
 * 把超大文件按行切成不超过预算的段
 * @description 文件粒度切不动时（单个 40KB 文件），按行切；每段头部标注行号范围，
 *   结论里的行号需要加上 `fromLine - 1`，调用方要把这句提示打出来。
 * @param content 文件内容
 * @param budgetBytes 每段预算
 * @returns 段列表（单段时原样返回）
 */
export function splitFileContent(content: string, budgetBytes: number): FileSlice[] {
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;
  const slices: FileSlice[] = [];
  let start = 0;
  let current: string[] = [];
  let currentBytes = 0;

  const flush = (endExclusive: number): void => {
    if (current.length === 0) return;
    const body = current.join('\n');
    const fromLine = start + 1;
    const toLine = endExclusive;
    slices.push({
      // 段头写清范围：模型据此计算绝对行号
      content: `// [分片] ${fromLine}-${toLine} 行（共 ${totalLines} 行），引用行号请加上偏移 ${fromLine - 1}\n${body}`,
      bytes: Buffer.byteLength(body, 'utf8'),
      fromLine,
      toLine,
      totalLines,
    });
    start = endExclusive;
    current = [];
    currentBytes = 0;
  };

  lines.forEach((line, index) => {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (current.length > 0 && currentBytes + lineBytes > budgetBytes) flush(index);
    current.push(line);
    currentBytes += lineBytes;
  });
  flush(totalLines);
  return slices;
}

/** 展开后的文件（带切段信息） */
export type ExpandedFile<T extends ChunkableFile> = T & { slice?: FileSlice };

/**
 * 把超过预算的文件按行展开成多段
 * @description 审查与 dry-run 共用：预演必须显示**真实会发送的分段**，
 *   否则用户以为一次发 61KB，实际发的是 3 片。
 * @param files 收集到的文件
 * @param budgetBytes 单片预算
 */
export function expandOversizedFiles<T extends ChunkableFile & { content?: string }>(
  files: T[],
  budgetBytes: number,
): { files: ExpandedFile<T>[]; log: string[] } {
  const expanded: ExpandedFile<T>[] = [];
  const log: string[] = [];
  for (const file of files) {
    if (file.bytes <= budgetBytes || typeof file.content !== 'string') {
      expanded.push(file);
      continue;
    }
    const slices = splitFileContent(file.content, budgetBytes);
    if (slices.length <= 1) {
      expanded.push(file);
      continue;
    }
    log.push(
      `${file.path} 单文件 ${Math.round(file.bytes / 1024)}KB 超过预算，切为 ${slices.length} 段；引用行号需按段头偏移换算`,
    );
    for (const slice of slices) {
      expanded.push({ ...file, content: slice.content, bytes: slice.bytes, slice });
    }
  }
  return { files: expanded, log };
}
