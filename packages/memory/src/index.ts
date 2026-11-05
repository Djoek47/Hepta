/**
 * Memory. What the app knows about you, and how it came to know it.
 *
 * Two rules, and they are the same rule the rest of the system runs on:
 *
 *   1. A fact is only ever written because the user SAID it. Nothing infers,
 *      nothing enriches, nothing concludes. `source` has one value for a
 *      reason.
 *   2. Writing and forgetting are ACTS. They get a preview, a HOLD and an
 *      undo like everything else, because a thing that quietly rewrites what
 *      it believes about you is the one behaviour nobody forgives.
 */

import { defineAct, type ActDef, type CommitResult, type Filled } from '@intermenu/aiuic-core';

export type Fact = {
  key: string;
  value: string;
  /** ISO. When the user said it, not when it was inferred — nothing is inferred. */
  at: string;
  /** The user told us. There is no other way in. */
  source: 'stated';
};

export type Snapshot = { version: 1; facts: Fact[] };

export interface Store {
  load(): string | null;
  save(serialized: string): void;
}

/** Survives nothing. The default, so a host must choose to persist. */
export class EphemeralStore implements Store {
  private s: string | null = null;
  load(): string | null { return this.s; }
  save(v: string): void { this.s = v; }
}

type WebStorage = { getItem(k: string): string | null; setItem(k: string, v: string): void };
declare const localStorage: WebStorage | undefined;

/** Browser storage, wrapped so a private window or blocked cookies cannot throw. */
export class BrowserStore implements Store {
  constructor(private readonly key = 'heckit.memory') {}
  load(): string | null {
    try { return localStorage?.getItem(this.key) ?? null; } catch { return null; }
  }
  save(v: string): void {
    try { localStorage?.setItem(this.key, v); } catch { /* storage refused; memory stays in RAM */ }
  }
}

export const MAX_FACTS = 400;
export const MAX_VALUE = 600;

export class Memory {
  private facts: Fact[] = [];

  constructor(
    private readonly store: Store = new EphemeralStore(),
    /** Keys the host never wants written, whatever the user says. */
    private readonly blocked: readonly string[] = [],
  ) {
    this.restore();
  }

  private restore(): void {
    const raw = this.store.load();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Snapshot;
      if (parsed?.version === 1 && Array.isArray(parsed.facts)) {
        this.facts = parsed.facts.filter((f) => f && typeof f.key === 'string' && typeof f.value === 'string');
      }
    } catch { this.facts = []; }
  }

  private persist(): void {
    this.store.save(JSON.stringify({ version: 1, facts: this.facts } satisfies Snapshot));
  }

  get size(): number { return this.facts.length; }
  all(): Fact[] { return this.facts.map((f) => ({ ...f })); }
  get(key: string): string | undefined { return this.facts.find((f) => f.key === key)?.value; }
  has(key: string): boolean { return this.get(key) !== undefined; }

  /** Upsert. Returns what was there before, so undo has something to restore. */
  put(key: string, value: string, at = new Date().toISOString()): string | undefined {
    if (this.blocked.includes(key)) return undefined;
    const v = String(value).slice(0, MAX_VALUE);
    const i = this.facts.findIndex((f) => f.key === key);
    const previous = i >= 0 ? this.facts[i]!.value : undefined;
    const fact: Fact = { key, value: v, at, source: 'stated' };
    if (i >= 0) this.facts[i] = fact;
    else {
      this.facts.push(fact);
      if (this.facts.length > MAX_FACTS) this.facts.shift();
    }
    this.persist();
    return previous;
  }

  forget(key: string): Fact | undefined {
    const i = this.facts.findIndex((f) => f.key === key);
    if (i < 0) return undefined;
    const [gone] = this.facts.splice(i, 1);
    this.persist();
    return gone;
  }

  /** Only the keys asked for. A prompt that carries everything carries nothing. */
  recall(keys: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const k of keys) { const v = this.get(k); if (v !== undefined) out[k] = v; }
    return out;
  }

  /** Keys with nothing behind them — what an interview should still ask about. */
  gaps(expected: string[]): string[] {
    return expected.filter((k) => !this.has(k));
  }

  clear(): void { this.facts = []; this.persist(); }
}

/**
 * Remembering and forgetting as acts, so both get a preview and an undo.
 * `remember` is self-scoped. `forget` is too, but it is not reversible by
 * re-deriving anything — the undo restores the exact fact that was removed.
 */
export function memoryActs(mem: Memory): ActDef[] {
  const remember = defineAct({
    name: 'remember',
    phrases: ['remember', 'note that', 'for next time'],
    slots: {
      key: { primitive: 'chip', options: () => [], required: true, order: 1 },
      value: { primitive: 'ghostField', fill: 'local', options: () => [], required: true, order: 2 },
    },
    radius: 'self',
    commit: (f: Filled): CommitResult => {
      const key = String(f.key);
      const previous = mem.put(key, String(f.value));
      return { id: key, previous: previous ?? null };
    },
    undo: (r) => {
      if (r.previous === null || r.previous === undefined) mem.forget(r.id);
      else mem.put(r.id, String(r.previous));
    },
  });

  const forget = defineAct({
    name: 'forget',
    phrases: ['forget', 'drop that', 'that is wrong'],
    slots: {
      key: { primitive: 'chip', options: () => mem.all().map((f) => ({ value: f.key, label: f.key })), required: true, order: 1 },
    },
    radius: 'self',
    commit: (f: Filled): CommitResult => {
      const gone = mem.forget(String(f.key));
      return { id: String(f.key), previous: gone?.value ?? null };
    },
    undo: (r) => { if (r.previous !== null && r.previous !== undefined) mem.put(r.id, String(r.previous)); },
  });

  return [remember, forget];
}

export * from './graph.js';
