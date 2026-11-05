/**
 * What a proposal from outside the person may put in a slot.
 *
 * A model (or an outside MCP caller) proposes values. The card shows a label;
 * commit() receives the value. If the two can disagree, the person says yes to
 * one thing and another is written. The second independent review proved it:
 * `{ id: 'mallory', label: 'Maya' }` showed "Maya" and paid Mallory, and
 * `{ n: 5000, label: '$50' }` showed "$50" and paid 5000.
 *
 * So a proposed value is never trusted as a value. It is admitted only through
 * the slot's own machinery, the same way a spoken word is:
 *
 *   a slot with options   the value must BE one of them (or name one by label
 *                         or alias), and the host's own option value is used
 *   a slot with resolve   the value's words go through the resolver, and the
 *                         resolver's value is used; the proposal's number is not
 *   anything else         plain text only
 *
 * Whatever does not pass is left empty, for the person to fill.
 */

import type { Ctx, Filled, Option, SlotDef } from './types.js';
import { classify } from './act-run.js';

export type Admitted = { ok: true; value: unknown } | { ok: false; why: string };

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** The words a proposed value carries, for a resolver to read. */
function wordsOf(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (v && typeof v === 'object' && typeof (v as { label?: unknown }).label === 'string') return (v as { label: string }).label;
  return null;
}

export function admitValue(slot: SlotDef, value: unknown, ctx: Ctx, filled: Filled = {}): Admitted {
  // Free text has no closed set to smuggle past: the card shows the very string
  // that commit() receives, so there is nothing for a label to disagree with.
  // (Its resolver reads the leftovers of a spoken sentence and cannot confirm a
  // phrase handed to it on its own — which refused every proposed title until
  // this case was added.)
  if (slot.primitive === 'ghostField') {
    const text = typeof value === 'string' ? value : wordsOf(value);
    if (text !== null && text.trim() && text.length <= 500) return { ok: true, value: text.trim() };
    return { ok: false, why: 'it carries no text' };
  }
  if (slot.options) {
    let options: Option[] | Promise<Option[]>;
    try { options = slot.options(ctx, filled); } catch { return { ok: false, why: 'its options could not be read' }; }
    if (!Array.isArray(options)) return { ok: false, why: 'its options are not available yet' };
    const exact = options.find((o) => same(o.value, value));
    if (exact) return { ok: true, value: exact.value };
    if (typeof value === 'string') {
      const w = norm(value);
      const named = options.filter((o) => norm(o.label) === w || (o.aliases ?? []).some((a) => norm(a) === w));
      if (named.length === 1) return { ok: true, value: named[0]!.value };
      if (named.length > 1) return { ok: false, why: `"${value}" names more than one option` };
    }
    return { ok: false, why: 'it is not one of the options offered' };
  }
  if (slot.resolve) {
    const words = wordsOf(value);
    if (words === null) return { ok: false, why: 'it carries no words to check' };
    const v = classify(slot.resolve(words, ctx, filled));
    if (v.outcome === 'filled' && !v.provisional) return { ok: true, value: v.value };
    return { ok: false, why: `"${words.slice(0, 40)}" does not read as one clear value` };
  }
  if (typeof value === 'string' && value.length <= 500) return { ok: true, value };
  return { ok: false, why: 'only plain text is accepted here' };
}
