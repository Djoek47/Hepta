/**
 * Memory v2: one memory, shared by every role, with versions.
 *
 * All four roles read it — the aggregator searches it, the orchestrator plans
 * against it, the conductor wakes up to it — and exactly one holds the pen.
 * That is not a convention. `openMemory()` returns the reader and the writer
 * as two separate objects, and whoever is handed only the reader has no
 * method that writes.
 *
 * VERSIONS are branches, like git. A line of thought can explore "what if the
 * budget were 650" on a branch of its own, and be kept, merged or dropped.
 * The rule that keeps that safe:
 *
 *   A BRANCH HOLDS ONLY THOUGHTS.
 *
 * Findings, threads and notes may live on a branch. Facts, decisions,
 * delegations and standing orders are REAL — the person said it, the contract
 * committed it, the person allowed it — and they are written to `main` or
 * nowhere. Nothing real can be hypothetical, and no amount of merging can
 * turn a thought into a fact.
 *
 * FACTS carry the words they came from. The v1 rule stands: a fact is only
 * ever written because the person said it. A finding from a bank feed is a
 * finding, forever; it is never promoted to "what we know about you".
 */

import type { Store } from './index.js';

export type Role = 'conductor' | 'congregator' | 'orchestrator' | 'aggregator' | 'person';

export type MemRecord =
  /** The person said it. `said` is the utterance, kept as provenance. */
  | { kind: 'fact'; key: string; value: string; said: string }
  | { kind: 'forget'; key: string; said: string }
  /** Something a source reported. Never becomes a fact. */
  | { kind: 'finding'; source: string; claim: string; value?: unknown }
  /** The contract committed it. */
  | { kind: 'decision'; act: string; id: string; summary: string }
  | { kind: 'undone'; act: string; id: string }
  /** The person lowered a tool's radius. */
  | { kind: 'delegation'; tool: string; radius: string }
  /** The score: what the conductor may do unattended. */
  | { kind: 'order'; id: string; text: string; active: boolean; spec?: unknown }
  /** A line of thought — Hepta's threads, the loop's steps, a hunch. */
  | { kind: 'thought'; topic: string; text: string };

export type Commit = {
  id: string;
  parent: string | null;
  /** Set on a merge. */
  from?: string;
  branch: string;
  at: number;
  by: Role;
  note: string;
  records: MemRecord[];
};

/** What a branch believes at its head, folded from its history. */
export type View = {
  branch: string;
  head: string | null;
  facts: Record<string, { value: string; said: string; at: number }>;
  findings: { source: string; claim: string; value?: unknown; at: number }[];
  decisions: { act: string; id: string; summary: string; at: number; undone: boolean }[];
  delegations: Record<string, string>;
  orders: Record<string, { text: string; active: boolean; spec?: unknown; at: number }>;
  thoughts: { topic: string; text: string; at: number }[];
};

export const REAL_KINDS = new Set<MemRecord['kind']>(['fact', 'forget', 'decision', 'undone', 'delegation', 'order']);
export const MAIN = 'main';
export const MAX_FINDINGS = 500;
export const MAX_THOUGHTS = 500;
export const MAX_COMMITS = 5000;

export class MemoryError extends Error {
  constructor(message: string) { super(message); this.name = 'MemoryError'; }
}

type Persisted = { version: 2; commits: Commit[]; branches: Record<string, string | null> };

class Graph {
  commits = new Map<string, Commit>();
  order: string[] = [];
  branches = new Map<string, string | null>([[MAIN, null]]);
  seq = 0;

  constructor(private readonly store: Store, private readonly now: () => number) {
    const raw = store.load();
    if (!raw) return;
    try {
      const p = JSON.parse(raw) as Persisted;
      if (p?.version !== 2) return;
      for (const c of p.commits) { this.commits.set(c.id, c); this.order.push(c.id); }
      this.branches = new Map(Object.entries(p.branches));
      if (!this.branches.has(MAIN)) this.branches.set(MAIN, null);
      this.seq = this.order.length;
    } catch {
      // A corrupt file must not take the app down. It starts empty, and the
      // old file is left where it is for someone to look at.
    }
  }

  persist(): void {
    const commits = this.order.map((id) => this.commits.get(id)!);
    this.store.save(JSON.stringify({ version: 2, commits, branches: Object.fromEntries(this.branches) } satisfies Persisted));
  }

  chain(branch: string): Commit[] {
    if (!this.branches.has(branch)) throw new MemoryError(`no branch "${branch}"`);
    const out: Commit[] = [];
    let id = this.branches.get(branch) ?? null;
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      seen.add(id);
      const c = this.commits.get(id);
      if (!c) break;
      out.push(c);
      id = c.parent;
    }
    return out.reverse();
  }

  view(branch: string): View {
    const v: View = {
      branch, head: this.branches.get(branch) ?? null,
      facts: {}, findings: [], decisions: [], delegations: {}, orders: {}, thoughts: [],
    };
    // Undoing a decision also takes back what that decision wrote: a
    // delegation it granted, an order it created. Otherwise an undone
    // "let it go ahead" comes back the next time anything reads memory.
    const decidedIn = new Map<string, string>();       // act/id -> commit id
    const delegations: Record<string, { radius: string; commit: string }[]> = {};
    const orderCommit = new Map<string, string>();     // order id -> commit id
    const revoked = new Set<string>();                 // commit ids whose decision was undone
    for (const c of this.chain(branch)) {
      for (const r of c.records) {
        if (r.kind === 'decision') decidedIn.set(`${r.act}/${r.id}`, c.id);
        if (r.kind === 'undone') { const cid = decidedIn.get(`${r.act}/${r.id}`); if (cid) revoked.add(cid); }
      }
    }
    for (const c of this.chain(branch)) {
      for (const r of c.records) {
        switch (r.kind) {
          case 'fact': v.facts[r.key] = { value: r.value, said: r.said, at: c.at }; break;
          case 'forget': delete v.facts[r.key]; break;
          case 'finding': v.findings.push({ source: r.source, claim: r.claim, ...(r.value !== undefined ? { value: r.value } : {}), at: c.at }); break;
          case 'decision': v.decisions.push({ act: r.act, id: r.id, summary: r.summary, at: c.at, undone: false }); break;
          case 'undone': { const d = [...v.decisions].reverse().find((x) => x.act === r.act && x.id === r.id); if (d) d.undone = true; break; }
          case 'delegation': (delegations[r.tool] ??= []).push({ radius: r.radius, commit: c.id }); break;
          case 'order': orderCommit.set(r.id, c.id); v.orders[r.id] = { text: r.text, active: r.active, ...(r.spec !== undefined ? { spec: r.spec } : {}), at: c.at }; break;
          case 'thought': v.thoughts.push({ topic: r.topic, text: r.text, at: c.at }); break;
        }
      }
    }
    for (const [tool, stack] of Object.entries(delegations)) {
      const standing = stack.filter((d) => !revoked.has(d.commit));
      if (standing.length) v.delegations[tool] = standing[standing.length - 1]!.radius;
    }
    for (const [id, cid] of orderCommit) if (revoked.has(cid) && v.orders[id]) v.orders[id]!.active = false;
    v.findings = v.findings.slice(-MAX_FINDINGS);
    v.thoughts = v.thoughts.slice(-MAX_THOUGHTS);
    return v;
  }

  add(branch: string, by: Role, note: string, records: MemRecord[], from?: string): Commit {
    const c: Commit = {
      id: `c${++this.seq}`, parent: this.branches.get(branch) ?? null, branch,
      at: this.now(), by, note, records, ...(from ? { from } : {}),
    };
    this.commits.set(c.id, c);
    this.order.push(c.id);
    this.branches.set(branch, c.id);
    this.persist();
    return c;
  }
}

/** Handed to every role. Nothing on it writes. */
export type MemoryReader = {
  view(branch?: string): View;
  branches(): string[];
  history(branch?: string): readonly Commit[];
  /** Facts, findings, decisions and thoughts whose words overlap the query, best first. */
  search(query: string, branch?: string): { kind: string; text: string; at: number }[];
};

/** Held by one role. The only object that can change what is remembered. */
export type MemoryWriter = {
  /** Write to a branch. Real records are refused anywhere but main. */
  commit(branch: string, by: Role, note: string, records: MemRecord[]): Commit;
  /** Start a line of thought from a branch's current head. */
  branch(name: string, from?: string): void;
  /** Bring a line of thought into main. Only thoughts and findings exist to bring. */
  merge(name: string, by: Role, note: string): Commit | null;
  /** Let a line of thought go. Main cannot be dropped. */
  drop(name: string): void;
};

const tokens = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9$€£]+/).filter((w) => w.length > 2));

export function openMemory(store: Store, now: () => number = () => Date.now()): { reader: MemoryReader; writer: MemoryWriter } {
  const g = new Graph(store, now);

  const reader: MemoryReader = {
    view: (branch = MAIN) => g.view(branch),
    branches: () => [...g.branches.keys()],
    history: (branch = MAIN) => Object.freeze(g.chain(branch).map((c) => Object.freeze({ ...c, records: [...c.records] }))),
    search(query, branch = MAIN) {
      const q = tokens(query);
      if (q.size === 0) return [];
      const v = g.view(branch);
      const items: { kind: string; text: string; at: number }[] = [
        // A fact travels with the words it came from: that is what makes it one.
        ...Object.entries(v.facts).map(([k, f]) => ({ kind: 'fact', text: `${k}: ${f.value} (said: "${f.said}")`, at: f.at })),
        ...v.findings.map((f) => ({ kind: 'finding', text: `${f.source}: ${f.claim}`, at: f.at })),
        ...v.decisions.map((d) => ({ kind: 'decision', text: `${d.act}: ${d.summary}${d.undone ? ' (undone)' : ''}`, at: d.at })),
        ...v.thoughts.map((t) => ({ kind: 'thought', text: `${t.topic}: ${t.text}`, at: t.at })),
      ];
      return items
        .map((it) => ({ it, score: [...tokens(it.text)].filter((w) => q.has(w)).length }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || b.it.at - a.it.at)
        .slice(0, 20)
        .map((x) => x.it);
    },
  };

  const writer: MemoryWriter = {
    commit(branch, by, note, records) {
      if (!g.branches.has(branch)) throw new MemoryError(`no branch "${branch}"`);
      if (branch !== MAIN) {
        const real = records.filter((r) => REAL_KINDS.has(r.kind));
        if (real.length) {
          throw new MemoryError(`a line of thought holds only thoughts; ${real.map((r) => r.kind).join(', ')} ${real.length === 1 ? 'is' : 'are'} real and belong${real.length === 1 ? 's' : ''} on main`);
        }
      }
      for (const r of records) {
        if (r.kind === 'fact' || r.kind === 'forget') {
          if (!r.said || !r.said.trim()) throw new MemoryError(`a ${r.kind} needs the words it came from`);
          if (by !== 'person' && by !== 'congregator') throw new MemoryError(`only the person's words, recorded by the congregator, become facts — not the ${by}`);
        }
        if (r.kind === 'fact' && r.value.length > 600) throw new MemoryError('a fact is at most 600 characters');
      }
      if (g.order.length >= MAX_COMMITS) throw new MemoryError('memory is full; compact it before writing more');
      return g.add(branch, by, note, records);
    },
    branch(name, from = MAIN) {
      if (!/^[a-z0-9][a-z0-9._-]{0,48}$/i.test(name)) throw new MemoryError(`bad branch name "${name}"`);
      if (g.branches.has(name)) throw new MemoryError(`branch "${name}" exists`);
      if (!g.branches.has(from)) throw new MemoryError(`no branch "${from}"`);
      g.branches.set(name, g.branches.get(from) ?? null);
      g.persist();
    },
    merge(name, by, note) {
      if (name === MAIN) throw new MemoryError('main is already main');
      const base = new Set(g.chain(MAIN).map((c) => c.id));
      const ahead = g.chain(name).filter((c) => !base.has(c.id));
      // Only thoughts can be on a branch (commit refuses anything else), but
      // the filter is kept so a merge can never be the door a fact walks in by.
      const records = ahead.flatMap((c) => c.records).filter((r) => !REAL_KINDS.has(r.kind));
      if (records.length === 0) return null;
      return g.add(MAIN, by, note, records, name);
    },
    drop(name) {
      if (name === MAIN) throw new MemoryError('main cannot be dropped');
      g.branches.delete(name);
      g.persist();
    },
  };

  return { reader, writer };
}
