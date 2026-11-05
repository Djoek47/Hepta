/**
 * Local grammar for the things an option list cannot hold: numbers, money,
 * dates, times and durations.
 *
 * This is the piece the local-first claim has been missing. Until now a chore
 * with a name and a chore resolved offline, but "twelve dollars" and "Friday"
 * needed a model — which means any act with a quantity or a date had no
 * degraded mode at all. Everything here runs on device, in a fraction of a
 * millisecond, with no network.
 *
 * Values carry their own label, so the stage shows the word the speaker said
 * rather than a timestamp they never uttered.
 */

import type { Candidate, Ctx } from '@intermenu/aiuic-core';
import { normalize } from './text.js';
import { amounts, revisedBetween, wordsToNumber } from './numbers.js';

export type WhenValue = { at: number; label: string; granularity: 'day' | 'minute' };
export type QuantityValue = { n: number; label: string; unit?: string };
export type DurationValue = { ms: number; label: string };

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

export { wordsToNumber } from './numbers.js';

function fmtMoney(n: number, code?: string): string {
  const sym = code === 'EUR' ? '€' : code === 'GBP' ? '£' : '$';
  const body = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return code ? sym + body : body;
}

/**
 * A number, with its currency when one was spoken. How sure it is depends on
 * how many amounts the sentence holds; see numbers.ts.
 */
export function resolveQuantity(text: string, _ctx?: Ctx): Candidate[] {
  const { found, toks } = amounts(text);
  const cand = (n: number, code: string | undefined, score: number): Candidate => ({
    value: { n, label: fmtMoney(n, code), ...(code ? { unit: code } : {}) } satisfies QuantityValue,
    label: fmtMoney(n, code), score, calibrated: true,
  });
  if (!found.length) return [];

  if (found.length === 1) {
    const a = found[0]!;
    // "fifteen fifty": $15.50 or $1,550. Both, equally, and the person picks.
    if (a.alternatives) return a.alternatives.map((n) => cand(n, a.code, 0.5));
    return [cand(a.n, a.code, 1)];
  }

  // Taken back: the last amount is the one meant, shown as a guess rather than confirmed.
  const last = found[found.length - 1]!, prev = found[found.length - 2]!;
  if (revisedBetween(toks, prev.end, last.start) && !last.alternatives) {
    return [cand(last.n, last.code, 0.7), cand(prev.n, prev.code, 0.2)];
  }
  // "20 dollars for 2 pizzas": the one with a currency is the amount.
  const money = found.filter((a) => a.code && !a.alternatives);
  if (money.length === 1) return [cand(money[0]!.n, money[0]!.code, 1)];
  // Nothing tells them apart.
  return found.flatMap((a) => (a.alternatives ? a.alternatives.map((n) => cand(n, a.code, 0.5)) : [cand(a.n, a.code, 0.5)]));
}

const DAY_MS = 86_400_000;

function atDay(base: Date, offsetDays: number, label: string): WhenValue {
  const d = new Date(base.getTime());
  d.setHours(9, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return { at: d.getTime(), label, granularity: 'day' };
}

function nextWeekday(base: Date, idx: number, forceNext: boolean): number {
  const today = base.getDay();
  let delta = (idx - today + 7) % 7;
  if (delta === 0) delta = 7;
  if (forceNext && delta < 7) delta += 0; // "next friday" still means the coming one
  return delta;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The next occurrence of this wall-clock time, today or tomorrow. */
function clockAt(now: Date, hour24: number, min: number): WhenValue {
  const h = ((hour24 % 24) + 24) % 24;
  const d = new Date(now.getTime());
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  const label = (h % 12 === 0 ? 12 : h % 12) + (min ? ':' + String(min).padStart(2, '0') : '') +
    (h >= 12 ? 'pm' : 'am');
  return { at: d.getTime(), label, granularity: 'minute' };
}

/** Dates and times, relative to `ctx.now`. */
export function resolveWhen(text: string, ctx?: Ctx): Candidate[] {
  const now = ctx?.now ?? new Date();
  const t = normalize(text);
  const out: Candidate[] = [];
  const push = (v: WhenValue, score = 1) =>
    out.push({ value: v, label: v.label, score, calibrated: true });

  if (/\btoday\b/.test(t)) push(atDay(now, 0, 'today'));
  if (/\btomorrow\b/.test(t)) push(atDay(now, 1, 'tomorrow'));
  if (/\bday after tomorrow\b/.test(t)) push(atDay(now, 2, 'the day after tomorrow'));
  if (/\byesterday\b/.test(t)) push(atDay(now, -1, 'yesterday'));

  // French, labelled with the word the speaker used.
  if (/\baujourd[ '-]?hui\b/.test(t)) push(atDay(now, 0, "aujourd'hui"));
  if (/\bapres[ -]?demain\b/.test(t)) push(atDay(now, 2, 'après-demain'));
  else if (/\bdemain\b/.test(t)) push(atDay(now, 1, 'demain'));
  if (/\bhier\b/.test(t)) push(atDay(now, -1, 'hier'));
  if (/\bce soir\b/.test(t)) {
    const d = new Date(now.getTime()); d.setHours(20, 0, 0, 0);
    push({ at: d.getTime(), label: 'ce soir', granularity: 'minute' });
  }
  for (let i = 0; i < JOURS.length; i++) {
    const m = new RegExp('\\b' + JOURS[i] + '(\\s+prochain)?\\b').exec(t);
    if (m) push(atDay(now, nextWeekday(now, i, !!m[1]), cap(JOURS[i]!) + (m[1] ? ' prochain' : '')));
  }

  if (/\btonight\b/.test(t)) {
    const d = new Date(now.getTime()); d.setHours(20, 0, 0, 0);
    push({ at: d.getTime(), label: 'tonight', granularity: 'minute' });
  }
  if (/\bnow\b/.test(t)) push({ at: now.getTime() + 60_000, label: 'right now', granularity: 'minute' });

  for (let i = 0; i < DAYS.length; i++) {
    const re = new RegExp('\\b(next\\s+)?' + DAYS[i] + '\\b');
    const m = re.exec(t);
    if (m) {
      const delta = nextWeekday(now, i, !!m[1]);
      push(atDay(now, delta, (m[1] ? 'next ' : '') + cap(DAYS[i]!)));
    }
  }

  const inDays = /\bin (\d+|[a-z]+) (day|days|week|weeks)\b/.exec(t);
  if (inDays) {
    const n = /^\d+$/.test(inDays[1]!) ? Number(inDays[1]) : wordsToNumber([inDays[1]!]);
    if (n !== null) {
      const mult = inDays[2]!.startsWith('week') ? 7 : 1;
      push(atDay(now, n * mult, 'in ' + n + ' ' + inDays[2]));
    }
  }

  for (let i = 0; i < MONTHS.length; i++) {
    const m = new RegExp('\\b' + MONTHS[i] + '\\s+(\\d{1,2})\\b').exec(t)
      || new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+of\\s+' + MONTHS[i] + '\\b').exec(t);
    if (m) {
      const day = Number(m[1]);
      const d = new Date(now.getTime());
      d.setMonth(i, day); d.setHours(9, 0, 0, 0);
      if (d.getTime() < now.getTime()) d.setFullYear(d.getFullYear() + 1);
      push({ at: d.getTime(), label: cap(MONTHS[i]!) + ' ' + day, granularity: 'day' });
    }
  }

  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 9, 0, 0, 0);
    push({ at: d.getTime(), label: iso[0], granularity: 'day' });
  }

  // Times are read from the RAW text: normalize() strips the colon, and
  // "9:30am" becomes "9 30am", which parses as half past thirty.
  const raw = text.toLowerCase();

  const withMeridiem = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(raw);
  if (withMeridiem) {
    let h = Number(withMeridiem[1]);
    const min = withMeridiem[2] ? Number(withMeridiem[2]) : 0;
    if (withMeridiem[3] === 'pm' && h < 12) h += 12;
    if (withMeridiem[3] === 'am' && h === 12) h = 0;
    push(clockAt(now, h, min));
  } else {
    // A bare hour is genuinely ambiguous, so it is not guessed. Both readings
    // come back at the same score, which lands the slot in NARROW and lets the
    // person settle it in one beat — cheaper than being confidently wrong.
    const digits = /\b(?:at|to|around)\s+(\d{1,2})(?::(\d{2}))?\b/.exec(raw);
    const wordy = /\b(?:at|to|around)\s+([a-z]+)\b/.exec(raw);
    let hour: number | null = null;
    let min = 0;
    if (digits) { hour = Number(digits[1]); min = digits[2] ? Number(digits[2]) : 0; }
    else if (wordy) {
      const n = wordsToNumber([wordy[1]!]);
      if (n !== null && n >= 1 && n <= 12) hour = n;
    }
    if (hour !== null && hour >= 1 && hour <= 12) {
      push(clockAt(now, hour, min), 0.5);
      push(clockAt(now, hour + 12, min), 0.5);
    }
  }

  return out.sort((a, b) => b.score - a.score);
}

const DUR: Record<string, number> = {
  second: 1000, seconds: 1000, minute: 60_000, minutes: 60_000, min: 60_000, mins: 60_000,
  hour: 3_600_000, hours: 3_600_000, day: DAY_MS, days: DAY_MS, week: DAY_MS * 7, weeks: DAY_MS * 7,
};

/** "twenty minutes", "half an hour", "1h30". */
export function resolveDuration(text: string, _ctx?: Ctx): Candidate[] {
  const t = normalize(text);
  if (/\bhalf an hour\b/.test(t)) {
    return [{ value: { ms: 1_800_000, label: 'half an hour' } satisfies DurationValue,
              label: 'half an hour', score: 1, calibrated: true }];
  }
  const m = /\b(\d+|[a-z]+(?: [a-z]+)?)\s+(seconds?|minutes?|mins?|hours?|days?|weeks?)\b/.exec(t);
  if (!m) return [];
  const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : wordsToNumber(m[1]!.split(' '));
  if (n === null) return [];
  const unit = DUR[m[2]!];
  if (!unit) return [];
  return [{ value: { ms: n * unit, label: n + ' ' + m[2] } satisfies DurationValue,
            label: n + ' ' + m[2], score: 1, calibrated: true }];
}

/** Drop-in `SlotDef.resolve` functions, so a host writes none of this. */
export const grammar = {
  quantity: resolveQuantity,
  when: resolveWhen,
  duration: resolveDuration,
} as const;
