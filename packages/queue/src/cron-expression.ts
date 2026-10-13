/*
 * @file cron 表达式解析与下一次触发时刻计算
 * @description 自研实现（不引入 cron-parser 等运行时依赖，保证 memory 驱动「零依赖」承诺）：
 *   支持 5 段（`分 时 日 月 周`）与 6 段（含秒 `秒 分 时 日 月 周`），
 *   语法覆盖 `*` / `?` / `a` / `a,b` / `a-b` / `a-b/n` / `a/n`，月份与星期支持英文缩写别名；
 *   日与周同时受限时按标准 cron 语义取「或」，其一为 `*` 时按另一字段判定。
 *   时区支持：`timezone` 传入 IANA 名称时按该时区解释墙钟时间（内部用 Intl 做双向换算）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import { CronExpressionError } from './errors.js';

/** 段范围内的取值集合 + 是否为「未受限」（`*` / `?`） */
interface ParsedField {
  /** 允许的取值集合 */
  values: Set<number>;
  /** 是否为通配（未受限）；用于日/周的「或」语义判定 */
  wildcard: boolean;
}

/** 段定义 */
interface FieldSpec {
  /** 字段名（报错提示） */
  label: string;
  /** 最小值 */
  min: number;
  /** 最大值（允许比自然最大值多 1，用于星期 7 = 0 的映射） */
  max: number;
  /** 别名表（英文缩写 → 数值） */
  aliases?: Record<string, number>;
  /** 归一化：把越界别名值折回主范围（星期 7 → 0） */
  normalize?: (value: number) => number;
}

/** 月份别名 */
const MONTH_ALIASES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

/** 星期别名 */
const DOW_ALIASES: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};

/** 段定义表（顺序即 6 段语法的顺序） */
const FIELD_SPECS: FieldSpec[] = [
  { label: '秒', min: 0, max: 59 },
  { label: '分', min: 0, max: 59 },
  { label: '时', min: 0, max: 23 },
  { label: '日', min: 1, max: 31 },
  { label: '月', min: 1, max: 12, aliases: MONTH_ALIASES },
  { label: '周', min: 0, max: 7, aliases: DOW_ALIASES, normalize: (value) => (value === 7 ? 0 : value) },
];

/** 搜索结果窗口：一年（覆盖 2 月 29 日等最长间隔） */
const MAX_SEARCH_MS = 400 * 24 * 3_600_000;

/** 墙钟时间字段 */
interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * 时区助手：把 UTC 时刻与某时区的墙钟时间互相换算。
 * `timeZone` 为空时退化为服务器本地时区（用本地 getter/setter，零开销）。
 */
class Zone {
  private readonly formatter?: Intl.DateTimeFormat;

  /**
   * @param timeZone IANA 时区名（可选）
   */
  constructor(private readonly timeZone?: string) {
    if (timeZone) {
      this.formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    }
  }

  /**
   * 时刻 → 墙钟时间
   * @param instant UTC 时刻（毫秒）
   */
  parts(instant: number): WallClock {
    if (!this.formatter) {
      const d = new Date(instant);
      return {
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        day: d.getDate(),
        hour: d.getHours(),
        minute: d.getMinutes(),
        second: d.getSeconds(),
      };
    }
    const bag: Record<string, string> = {};
    for (const part of this.formatter.formatToParts(new Date(instant))) {
      bag[part.type] = part.value;
    }
    // hour12:false 在部分实现下会把 0 点渲染为 24，需要折回 0
    const hour = Number(bag.hour) % 24;
    return {
      year: Number(bag.year),
      month: Number(bag.month),
      day: Number(bag.day),
      hour,
      minute: Number(bag.minute),
      second: Number(bag.second),
    };
  }

  /**
   * 墙钟时间 → 时刻（毫秒）；不存在的墙钟（夏令时跳变）落到跳变之后的时刻
   * @param wall 目标墙钟
   */
  toInstant(wall: WallClock): number {
    if (!this.formatter) {
      return new Date(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second).getTime();
    }
    const target = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
    let guess = target;
    // 两轮偏移修正即可收敛（时区偏移为分钟级稳定值）
    for (let i = 0; i < 2; i++) {
      const p = this.parts(guess);
      const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      guess += target - asUtc;
    }
    return guess;
  }
}

/** 已解析的 cron 表达式 */
export class CronExpression {
  /** 原始表达式（已归一化空白） */
  readonly expression: string;

  /** 是否包含秒段 */
  readonly hasSeconds: boolean;

  /** 时区名（可选） */
  readonly timeZone: string | undefined;

  private readonly zone: Zone;

  /** 各段解析结果（未包含秒段时索引 0 为 `undefined`） */
  private readonly fields: (ParsedField | undefined)[];

  /**
   * @param expression cron 表达式
   * @param timeZone IANA 时区名（可选）
   */
  constructor(expression: string, timeZone?: string) {
    this.expression = expression.trim().replace(/\s+/g, ' ');
    this.timeZone = timeZone;
    this.zone = new Zone(timeZone);
    const parts = this.expression.split(' ');
    if (parts.length !== 5 && parts.length !== 6) {
      throw new CronExpressionError(expression, '需要 5 段（分 时 日 月 周）或 6 段（秒 分 时 日 月 周）');
    }
    this.hasSeconds = parts.length === 6;
    const specs = this.hasSeconds ? FIELD_SPECS : FIELD_SPECS.slice(1);
    this.fields = parts.map((part, index) => parseField(part, specs[index], expression));
  }

  /** 秒段（无秒段时为 undefined） */
  private get secondField(): ParsedField | undefined {
    return this.hasSeconds ? this.fields[0] : undefined;
  }

  private get minuteField(): ParsedField {
    return this.fields[this.hasSeconds ? 1 : 0] as ParsedField;
  }

  private get hourField(): ParsedField {
    return this.fields[this.hasSeconds ? 2 : 1] as ParsedField;
  }

  private get dayField(): ParsedField {
    return this.fields[this.hasSeconds ? 3 : 2] as ParsedField;
  }

  private get monthField(): ParsedField {
    return this.fields[this.hasSeconds ? 4 : 3] as ParsedField;
  }

  private get weekField(): ParsedField {
    return this.fields[this.hasSeconds ? 5 : 4] as ParsedField;
  }

  /**
   * 给定时刻是否命中本表达式
   * @param instant 时刻（毫秒）
   */
  matches(instant: number): boolean {
    const p = this.zone.parts(instant);
    if (!this.monthField.values.has(p.month)) return false;
    if (!this.matchDay(p)) return false;
    if (!this.hourField.values.has(p.hour)) return false;
    if (!this.minuteField.values.has(p.minute)) return false;
    const secondField = this.secondField;
    return secondField ? secondField.values.has(p.second) : true;
  }

  /**
   * 计算严格晚于 `from` 的下一次触发时刻
   * @param from 起始时刻（默认当前时间）
   * @returns 下一次触发时刻
   * @throws CronExpressionError 一年内没有匹配时刻（如 2 月 30 日）
   */
  next(from: Date = new Date()): Date {
    const step = this.hasSeconds ? 1000 : 60_000;
    let cursor = Math.floor(from.getTime() / step) * step + step;
    const deadline = from.getTime() + MAX_SEARCH_MS;
    // 夏令时回拨等边界下 toInstant 可能落到当前游标之前；强制游标严格前进，杜绝死循环
    const advance = (target: number): void => {
      cursor = Math.max(target, cursor + step);
    };
    while (cursor <= deadline) {
      const p = this.zone.parts(cursor);
      if (!this.monthField.values.has(p.month)) {
        advance(this.zone.toInstant({ year: p.month === 12 ? p.year + 1 : p.year, month: p.month === 12 ? 1 : p.month + 1, day: 1, hour: 0, minute: 0, second: 0 }));
        continue;
      }
      if (!this.matchDay(p)) {
        advance(this.zone.toInstant({ ...addDays(p, 1), hour: 0, minute: 0, second: 0 }));
        continue;
      }
      if (!this.hourField.values.has(p.hour)) {
        const hour = nextValue(this.hourField, p.hour);
        advance(hour === null
          ? this.zone.toInstant({ ...addDays(p, 1), hour: 0, minute: 0, second: 0 })
          : this.zone.toInstant({ ...p, hour, minute: 0, second: 0 }));
        continue;
      }
      if (!this.minuteField.values.has(p.minute)) {
        const minute = nextValue(this.minuteField, p.minute);
        advance(minute === null
          ? this.zone.toInstant({ ...p, hour: p.hour + 1, minute: 0, second: 0 })
          : this.zone.toInstant({ ...p, minute, second: 0 }));
        continue;
      }
      const secondField = this.secondField;
      if (secondField && !secondField.values.has(p.second)) {
        const second = nextValue(secondField, p.second);
        advance(second === null ? this.zone.toInstant({ ...p, minute: p.minute + 1, second: 0 }) : this.zone.toInstant({ ...p, second }));
        continue;
      }
      return new Date(cursor);
    }
    throw new CronExpressionError(this.expression, '未来一年内没有匹配时刻');
  }

  /** 日/周组合判定（两个都受限时取「或」，否则取受限的那个） */
  private matchDay(p: WallClock): boolean {
    const dayOk = this.dayField.values.has(p.day);
    // 星期由「墙钟日历日」直接推出（用 UTC 构造同一日历日，避免受服务器本地时区影响）
    const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
    const weekOk = this.weekField.values.has(dow);
    if (this.dayField.wildcard && this.weekField.wildcard) return true;
    if (this.dayField.wildcard) return weekOk;
    if (this.weekField.wildcard) return dayOk;
    return dayOk || weekOk;
  }
}

/** 日期 +1 天（按月内日历推进，不做时区换算） */
function addDays(p: WallClock, days: number): WallClock {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: 0, minute: 0, second: 0 };
}

/** 集合中大于 `value` 的最小值；不存在返回 null */
function nextValue(field: ParsedField, value: number): number | null {
  let best: number | null = null;
  for (const candidate of field.values) {
    if (candidate > value && (best === null || candidate < best)) best = candidate;
  }
  return best;
}

/**
 * 解析单个段
 * @param raw 段文本
 * @param spec 段定义
 * @param expression 完整表达式（报错提示）
 */
function parseField(raw: string, spec: FieldSpec | undefined, expression: string): ParsedField {
  if (!spec) throw new CronExpressionError(expression, `段数超出定义：${raw}`);
  const text = raw.trim();
  if (text.length === 0) throw new CronExpressionError(expression, '存在空段');
  if (text === '*' || text === '?') {
    return { values: new Set(rangeValues(spec.min, spec.max, spec.normalize)), wildcard: true };
  }
  const values = new Set<number>();
  for (const token of text.split(',')) {
    if (token.trim().length === 0) throw new CronExpressionError(expression, `存在空取值：${raw}`);
    const [rangePart, stepPart] = token.split('/');
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) <= 0) {
        throw new CronExpressionError(expression, `步长非法：${token}`);
      }
      step = Number(stepPart);
    }
    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = spec.min;
      end = spec.max;
    } else if (rangePart.includes('-')) {
      const [from, to] = rangePart.split('-');
      start = parseValue(from, spec, expression);
      end = parseValue(to, spec, expression);
    } else {
      start = parseValue(rangePart, spec, expression);
      end = stepPart !== undefined ? spec.max : start;
    }
    if (start > end) throw new CronExpressionError(expression, `区间起止颠倒：${token}`);
    for (let value = start; value <= end; value += step) {
      values.add(spec.normalize ? spec.normalize(value) : value);
    }
  }
  if (values.size === 0) throw new CronExpressionError(expression, `段无有效取值：${raw}`);
  return { values, wildcard: false };
}

/** 段取值 → 数值（支持英文别名） */
function parseValue(raw: string, spec: FieldSpec, expression: string): number {
  const text = raw.trim().toUpperCase();
  const alias = spec.aliases?.[text];
  const value = alias ?? Number(text);
  if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
    throw new CronExpressionError(expression, `${spec.label}段取值越界：${raw}（允许 ${spec.min}-${spec.max}）`);
  }
  return value;
}

/** 生成 [min, max] 的取值数组 */
function rangeValues(min: number, max: number, normalize?: (value: number) => number): number[] {
  const out: number[] = [];
  for (let value = min; value <= max; value++) out.push(normalize ? normalize(value) : value);
  return out;
}

/**
 * 解析 cron 表达式（带缓存，避免重复解析）
 * @param expression cron 表达式
 * @param timeZone IANA 时区名（可选）
 */
export function parseCron(expression: string, timeZone?: string): CronExpression {
  const key = `${timeZone ?? ''} ${expression}`;
  const cached = CACHE.get(key);
  if (cached) return cached;
  const parsed = new CronExpression(expression, timeZone);
  CACHE.set(key, parsed);
  return parsed;
}

/** 解析结果缓存 */
const CACHE = new Map<string, CronExpression>();
