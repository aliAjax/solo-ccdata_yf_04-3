// ============================================================
// 文档模型：活动事件链 + head 指针 + 回退分支存档 + 快照
// 事件只增不删；在回退点上继续操作时，被取代的事件移入 branches
// 只读存档，不会重新激活；快照保存完整事件链，可整体切换恢复。
// ============================================================

import type { Event } from './engine';

export interface Snap { id: string; label: string; at: number; auto?: boolean; chain: Event[] }
export interface Branch { id: string; label: string; events: Event[]; archivedAt: number }
export interface MetaEntry { at: number; text: string }

export interface Doc {
  events: Event[];   // 活动链
  head: number;      // 生效前缀长度（撤销/恢复只移动它）
  branches: Branch[];// 被取代的历史分支（仅记录）
  snaps: Snap[];
  meta: MetaEntry[];
}

export const blankDoc = (): Doc => ({ events: [], head: 0, branches: [], snaps: [], meta: [] });

let uidCounter = 0;
const uid = (tag: string) => `${tag}${Date.now().toString(36)}${(uidCounter++).toString(36)}`;

const isAuto = (e: Event): boolean => e.type === 'REPAIR_ROUND' && !!e.auto;

/** 兼容旧版存储：快照从 head 索引迁移为完整事件链，补 branches 字段 */
export function migrateDoc(raw: unknown): Doc {
  const d = raw as { events?: Event[]; head?: number; branches?: Branch[]; meta?: MetaEntry[];
    snaps?: { id?: string; label?: string; at?: number; auto?: boolean; chain?: Event[]; head?: number }[] };
  if (!d || !Array.isArray(d.events) || typeof d.head !== 'number') return blankDoc();
  const events = d.events;
  const head = Math.min(Math.max(d.head, 0), events.length);
  return {
    events,
    head,
    branches: Array.isArray(d.branches) ? d.branches : [],
    snaps: (d.snaps ?? []).map((s, i) => ({
      id: s.id ?? `s${i}`,
      label: s.label ?? '未命名快照',
      at: s.at ?? 0,
      auto: s.auto,
      chain: Array.isArray(s.chain) ? s.chain : events.slice(0, Math.min(s.head ?? 0, events.length)),
    })),
    meta: Array.isArray(d.meta) ? d.meta : [],
  };
}

/** 追加事件。若当前处于回退点（head < 链长），被取代的尾巴先移入分支存档 */
export function pushEvents(d: Doc, evs: Event[]): Doc {
  let { events, head, branches } = d;
  if (head < events.length) {
    const tail = events.slice(head);
    if (tail.length > 0) {
      branches = [...branches, { id: uid('b'), label: `被新操作取代的 ${tail.length} 步`, events: tail, archivedAt: Date.now() }];
    }
    events = events.slice(0, head);
  }
  events = [...events, ...evs];
  return { ...d, events, branches, head: events.length };
}

/** 撤销一个逻辑步骤：自动派生事件（如自动重排）随其触发事件一起回退 */
export function undo(d: Doc): Doc {
  if (d.head === 0) return d;
  let h = d.head;
  while (h > 0 && isAuto(d.events[h - 1])) h--;
  if (h > 0) h--;
  return { ...d, head: h, meta: [...d.meta, { at: Date.now(), text: `撤销一步（回到第 ${h} 步）` }] };
}

export function redo(d: Doc): Doc {
  if (d.head >= d.events.length) return d;
  let h = d.head + 1;
  while (h < d.events.length && isAuto(d.events[h])) h++;
  return { ...d, head: h, meta: [...d.meta, { at: Date.now(), text: `重做一步（前进到第 ${h} 步）` }] };
}

/** 回到活动链上的任意一步（链内移动，不丢事件） */
export function restoreToStep(d: Doc, k: number): Doc {
  const head = Math.max(0, Math.min(k, d.events.length));
  return { ...d, head, meta: [...d.meta, { at: Date.now(), text: `回到第 ${head} 步` }] };
}

export function takeSnapshot(d: Doc, label: string, auto = false): Doc {
  const snap: Snap = { id: uid('s'), label, at: Date.now(), auto, chain: d.events.slice(0, d.head) };
  return { ...d, snaps: [...d.snaps, snap] };
}

/**
 * 恢复快照。当前链与快照链一致（或为其延伸）时只移动 head；
 * 否则把当前整条链存入分支存档，切换到快照链——原进度不丢失。
 */
export function restoreSnap(d: Doc, snapId: string): Doc {
  const snap = d.snaps.find(s => s.id === snapId);
  if (!snap) return d;
  const prefix = d.events.slice(0, snap.chain.length);
  const sameChain = JSON.stringify(prefix) === JSON.stringify(snap.chain);
  if (sameChain) {
    return { ...d, head: snap.chain.length, meta: [...d.meta, { at: Date.now(), text: `恢复到快照「${snap.label}」（第 ${snap.chain.length} 步）` }] };
  }
  const branch: Branch = { id: uid('b'), label: `恢复「${snap.label}」前的进度（${d.head} 步）`, events: d.events, archivedAt: Date.now() };
  return {
    ...d,
    events: snap.chain.map(e => ({ ...e })),
    head: snap.chain.length,
    branches: d.events.length > 0 ? [...d.branches, branch] : d.branches,
    meta: [...d.meta, { at: Date.now(), text: `恢复到快照「${snap.label}」，原进度已存入回退分支` }],
  };
}
