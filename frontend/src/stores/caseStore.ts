import { create } from 'zustand';
import { db, ensureSeed } from '../db';
import type { CaseInput, CaseSlot, TypeCase } from '../types/case';
import { capacityOf } from '../types/case';
import { makeId, toPlain } from '../utils/format';
import { cellLabel, matrixIdsOf, validateCapacity } from '../utils/layout';

interface CaseState {
  cases: TypeCase[];
  loaded: boolean;
  loading: boolean;
  error: string;
  load: () => Promise<void>;
  createCase: (input: CaseInput) => Promise<TypeCase>;
  updateCase: (id: string, patch: Partial<TypeCase>) => Promise<void>;
  saveSlots: (id: string, slots: CaseSlot[]) => Promise<void>;
  removeCase: (id: string) => Promise<void>;
}

export const useCaseStore = create<CaseState>((set, get) => ({
  cases: [],
  loaded: false,
  loading: false,
  error: '',

  load: async () => {
    set({ loading: true, error: '' });
    try {
      await ensureSeed();
      const cases = await db.cases.toArray();
      set({ cases: cases.sort((a, b) => (a.code < b.code ? -1 : 1)), loaded: true, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : '字盘档案读取失败' });
    }
  },

  createCase: async (input) => {
    const now = new Date().toISOString();
    const rows = Number(input.rows);
    const cols = Number(input.cols);
    const row: TypeCase = toPlain({
      id: makeId('case'),
      code: input.code.trim(),
      kind: input.kind,
      rows,
      cols,
      slots: [] as CaseSlot[],
      workStation: input.workStation.trim(),
      matrixId: [] as string[],
      createdAt: now,
      updatedAt: now,
    });
    if (capacityOf(rows, cols) <= 0) throw new Error('字盘容量不合法，请检查行列数');
    await db.cases.add(row);
    set((s) => ({ cases: [...s.cases, row].sort((a, b) => (a.code < b.code ? -1 : 1)) }));
    return row;
  },

  updateCase: async (id, patch) => {
    const plain = toPlain(patch);
    const next: Partial<TypeCase> = { ...plain, updatedAt: new Date().toISOString() };
    if (plain.rows || plain.cols) {
      const current = get().cases.find((c) => c.id === id);
      const rows = plain.rows ?? current?.rows ?? 0;
      const cols = plain.cols ?? current?.cols ?? 0;
      const slots = plain.slots ?? current?.slots ?? [];
      const check = validateCapacity(rows, cols, slots);
      if (check.overCapacity) throw new Error(check.message);
    }
    await db.cases.update(id, next);
    set((s) => ({ cases: s.cases.map((c) => (c.id === id ? { ...c, ...next } : c)) }));
  },

  /** 保存格位布局：同时刷新 matrixId 多值索引，便于按字模反查字盘 */
  saveSlots: async (id, slots) => {
    const current = get().cases.find((c) => c.id === id);
    if (!current) throw new Error('未找到字盘');
    const check = validateCapacity(current.rows, current.cols, slots);
    if (check.overCapacity) throw new Error(check.message);
    // 实物唯一占用：本盘草稿里的字模若仍在其它字盘落库布局中，阻止本次保存
    const foreign = foreignHoldings(get().cases, id, slots);
    if (foreign.length) throw new Error(describeForeignHoldings(foreign));
    const plainSlots = toPlain(slots);
    const next: Partial<TypeCase> = {
      slots: plainSlots,
      matrixId: matrixIdsOf(plainSlots),
      updatedAt: new Date().toISOString(),
    };
    await db.cases.update(id, next);
    set((s) => ({ cases: s.cases.map((c) => (c.id === id ? { ...c, ...next } : c)) }));
  },

  removeCase: async (id) => {
    await db.cases.delete(id);
    set((s) => ({ cases: s.cases.filter((c) => c.id !== id) }));
  },
}));

/** 找出存放指定字模的字盘与格位 */
export function findCaseHolding(cases: TypeCase[], matrixId: string): Array<{ typeCase: TypeCase; slots: CaseSlot[] }> {
  const out: Array<{ typeCase: TypeCase; slots: CaseSlot[] }> = [];
  for (const c of cases) {
    const slots = c.slots.filter((s) => s.matrixId === matrixId);
    if (slots.length) out.push({ typeCase: c, slots });
  }
  return out;
}

/** 一枚字模在他盘（非当前编辑盘）的唯一占用信息 */
export interface ForeignHolding {
  matrixId: string;
  character: string;
  /** 原字盘（落库版本） */
  typeCase: TypeCase;
  /** 原字盘中的格位 */
  slots: CaseSlot[];
}

/**
 * 检查待保存（或编辑中）的布局：其中有哪些字模仍被其它字盘的落库布局占用。
 * 只看落库版本——原盘未保存的取出草稿不算已取出，保存时才会真正解除占用。
 */
export function foreignHoldings(
  cases: TypeCase[],
  currentCaseId: string,
  slots: CaseSlot[],
): ForeignHolding[] {
  const out: ForeignHolding[] = [];
  for (const id of new Set(slots.map((s) => s.matrixId).filter(Boolean))) {
    const slot = slots.find((s) => s.matrixId === id);
    const held = findForeignHolding(cases, currentCaseId, id, slot?.character ?? '');
    out.push(...held);
  }
  return out;
}

/** 指定字模在他盘（非当前编辑盘）落库布局中的占用 */
export function findForeignHolding(
  cases: TypeCase[],
  currentCaseId: string,
  matrixId: string,
  character = '',
): ForeignHolding[] {
  const out: ForeignHolding[] = [];
  for (const c of cases) {
    if (c.id === currentCaseId) continue;
    const held = c.slots.filter((x) => x.matrixId === matrixId);
    if (held.length) {
      out.push({ matrixId, character: character || held[0].character, typeCase: c, slots: held });
    }
  }
  return out;
}

/** 他盘占用冲突的可读说明，用于阻止保存 / 落位时的提示文案 */
export function describeForeignHoldings(items: ForeignHolding[]): string {
  const detail = items
    .map((h) => {
      const cells = h.slots.map((s) => cellLabel(s.row, s.col)).join('、');
      return `「${h.character}」仍在字盘 ${h.typeCase.code} 的 ${cells}`;
    })
    .join('；');
  return `保存被阻止：${detail}。请先到原字盘取出并保存，再落位到新盘；本次未改动任何字盘布局。`;
}
