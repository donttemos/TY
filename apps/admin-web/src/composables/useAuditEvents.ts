/*
 * @file 审计事件注册表消费（PRD-015 FR-15-14/16，ADR-0032 R1）
 * @description 事件码 → 名称/说明/风险/摘要模板/字段中文名的前端唯一入口。
 *   注册表由服务端 `GET /api/v1/audit-logs/events` 下发（代码内单源），前端**不维护第二份翻译表**：
 *   本文件只做缓存与查询，不定义任何事件文案。
 *
 *   缓存与降级：
 *   - 模块级单例（页面、详情、筛选共享），按 `version` 指纹判断是否需要刷新；
 *   - 并发加载合并为一次请求（inflight 复用）；
 *   - 加载失败不阻塞页面：返回空表，展示层走「原始码 + 未登记」降级链（NFR-15-6）。
 * @author donttemo
 * @created 2026-10-20
 * @module admin-web/composables
 */

import { computed, ref } from 'vue';
import { fetchAuditEvents } from '@/api/audit';
import type { AuditEventDefinition } from '@/api/types';

/** 模块级缓存（跨组件共享；测试可用 resetAuditEventsCache 清空） */
const items = ref<AuditEventDefinition[]>([]);
const version = ref('');
const loading = ref(false);
const failed = ref(false);
let inflight: Promise<void> | null = null;

/**
 * 加载注册表（默认命中缓存即返回）
 * @param force 忽略缓存强制刷新（version 变化的兜底入口）
 */
async function loadAuditEvents(force = false): Promise<void> {
  if (inflight) return inflight;
  if (!force && items.value.length > 0) return;
  loading.value = true;
  failed.value = false;
  inflight = (async () => {
    try {
      const registry = await fetchAuditEvents();
      items.value = registry.items ?? [];
      version.value = registry.version ?? '';
    } catch {
      // 注册表不可用时页面仍需可用：保留旧缓存（若有），标记失败让调用方决定是否提示
      failed.value = true;
    } finally {
      loading.value = false;
      inflight = null;
    }
  })();
  return inflight;
}

/** 清空缓存（测试与登出时调用） */
export function resetAuditEventsCache(): void {
  items.value = [];
  version.value = '';
  failed.value = false;
  inflight = null;
}

/**
 * 注册表消费入口
 */
export function useAuditEvents() {
  /** 事件码 → 定义（未登记返回 undefined，调用方走降级链） */
  function find(code: string | null | undefined): AuditEventDefinition | undefined {
    if (!code) return undefined;
    return items.value.find((item) => item.code === code);
  }

  /** 按风险等级取事件码集合（「按风险筛选」展开为 `event=a,b`，ADR-0032 R9） */
  function codesByRisk(risk: string): string[] {
    return items.value.filter((item) => item.risk === risk && !item.deprecated).map((item) => item.code);
  }

  /** 事件下拉选项：按分类分组，label 带事件名，便于运营用业务词检索 */
  const eventOptions = computed(() =>
    items.value
      .filter((item) => !item.deprecated)
      .map((item) => ({ label: item.name, value: item.code })),
  );

  return { items, version, loading, failed, load: loadAuditEvents, find, codesByRisk, eventOptions };
}
