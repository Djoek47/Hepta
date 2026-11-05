/**
 * Words, stems and numbers. Tier 0: no model, no network, microseconds.
 */
import { amounts, endsInOpenNumber } from '@intermenu/aiuic-resolve';

export { endsInOpenNumber };

const STOP = new Set(`a an the and or but so because if then than that this these those there here it its it's is are was were be been being
am do does did done doing have has had having i me my mine we us our ours you your yours he him his she her hers they them their theirs
what which who whom whose when where why how not no nor of in on at to from by for with about as into onto over under again further once
all any both each few more most other some such only own same too very can could will would shall should may might must just also
up down out off now well yeah yes okay ok oh mm um uh like really actually let's lets let get got go going gone say said says tell told
one ever even still yet much many lot lots thing things way ways something anything nothing everything someone anyone everyone
make made take taken put see seen look know think want need right sure quite rather around already though although while whether
im i'm you're we're they're he's she's that's what's there's isn't aren't wasn't weren't don't doesn't didn't won't wouldn't can't couldn't
haven't hasn't hadn't shouldn't i've we've you've they've i'll we'll you'll i'd we'd you'd per cent percent tonight evening good welcome
thank thanks please question asked asking answer point minister shadow chancellor moderator panel panelist doctor teacher parent host
hepta mr mrs ms sir madam year years month months week weeks day days time times today alone frankly simply honestly respect`.split(/\s+/));

/** Lowercased words, apostrophes kept, everything else a separator. */
export function words(s: string): string[] {
  return s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9'%£$€.\s-]/g, ' ').replace(/(\D)\.|\.(\D|$)/g, '$1 $2')
    .split(/[\s-]+/).map((w) => w.replace(/^'+|'+$/g, '')).filter(Boolean);
}

/**
 * A light stemmer: enough that "homes"/"home", "funded"/"funding"/"fund" and
 * "housing"/"house" meet. Trailing e always goes, so both sides of a pair
 * lose it the same way.
 */
export function stem(w: string): string {
  let s = w.toLowerCase();
  if (s.length <= 3) return s;
  if (s.endsWith('ies') && s.length > 4) s = s.slice(0, -3) + 'y';
  else if (s.endsWith('ied') && s.length > 4) s = s.slice(0, -3) + 'y';
  else if (/(s|x|z|ch|sh)es$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith('ing') && s.length >= 6) s = s.slice(0, -3);
  else if (s.endsWith('ed') && s.length >= 5) s = s.slice(0, -2);
  else if (s.endsWith('s') && !/(ss|us|is)$/.test(s)) s = s.slice(0, -1);
  if (/([b-df-hj-np-tv-z])\1$/.test(s) && !/(ll|ss|zz)$/.test(s)) s = s.slice(0, -1);
  if (s.endsWith('e') && s.length > 3) s = s.slice(0, -1);
  return s;
}

/** Content words: what a sentence is about, stemmed. */
export function contentStems(s: string): string[] {
  const out: string[] = [];
  for (const w of words(s)) {
    if (STOP.has(w) || w.length < 3 || /^\d/.test(w)) continue;
    out.push(stem(w));
  }
  return out;
}

export function isStop(w: string): boolean {
  return STOP.has(w.toLowerCase());
}

/** Share of `keys` found in `text` (keys may be multi-word; each key is all-or-nothing). */
export function keyOverlap(text: string, keys: string[]): number {
  if (keys.length === 0) return 0;
  const have = new Set(contentStems(text));
  const all = new Set(words(text).map(stem));
  let hit = 0;
  for (const k of keys) {
    const parts = words(k).map(stem);
    if (parts.length > 0 && parts.every((p) => have.has(p) || all.has(p))) hit++;
  }
  return hit / keys.length;
}

export function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const A = new Set(a);
  const B = new Set(b);
  let i = 0;
  for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i);
}

// ------------------------------------------------------------------- numbers

export type Num = { value: number; unit?: string; raw: string; index: number; year?: boolean };

const SCALE: Record<string, number> = { thousand: 1e3, k: 1e3, million: 1e6, m: 1e6, billion: 1e9, bn: 1e9, trillion: 1e12 };

const NUMBER_WORD = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)\b/;
const UNIT_AFTER = /^\s*(%|percent\b|per cent\b|percentage points?\b)?\s*(thousand\b|million\b|billion\b|trillion\b|bn\b|k\b|m\b)?\s*(%|percent\b|per cent\b|pounds\b|dollars\b|euros\b|homes\b|houses\b|people\b|patients\b|children\b|posts\b|jobs\b|vacancies\b)?/;

/**
 * Numbers with their units, in the order said. Digits are read here (with a
 * scale word after them: "60 billion"); number words go through the ported
 * grammar ("six hundred and fifty"). Years are marked, not dropped: "by 2028"
 * is a deadline, and a changed deadline is a moved goalpost.
 */
export function numbers(text: string): Num[] {
  const out: Num[] = [];
  const lower = text.toLowerCase();
  const re = /\d[\d,]*(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower)) !== null) {
    const prev = lower[m.index - 1] ?? ' ';
    if (/[a-z]/.test(prev)) continue; // "g7", "covid19": part of a word
    const digits = m[0].replace(/,+$/, '');
    if (!/^\d{1,3}(,\d{3})*(\.\d+)?$|^\d+(\.\d+)?$/.test(digits)) continue;
    let v = Number(digits.replace(/,/g, ''));
    if (!Number.isFinite(v)) continue;
    const cur = /([£$€])\s?$/.exec(lower.slice(Math.max(0, m.index - 2), m.index))?.[1];
    const after = UNIT_AFTER.exec(lower.slice(m.index + digits.length)) ?? [];
    const scale = after[2] ? SCALE[after[2].trim()] : undefined;
    if (scale) v *= scale;
    const pctWord = (x?: string) => !!x && /%|percent|per cent|percentage/.test(x);
    const pct = pctWord(after[1]) || pctWord(after[3]) ? '%' : undefined;
    const tail = after[3] && !pctWord(after[3]) ? after[3].trim() : undefined;
    const noun = tail === 'pounds' ? '£' : tail === 'dollars' ? '$' : tail === 'euros' ? '€' : tail;
    const year = !cur && !pct && !scale && !noun && /^(19|20)\d\d$/.test(digits);
    out.push({ value: v, unit: pct ?? cur ?? noun, raw: (cur ?? '') + digits + (after[0] ?? '').trimEnd(), index: m.index, ...(year ? { year: true } : {}) });
  }
  // Number words, read by the ported grammar, with the digits taken out first.
  if (NUMBER_WORD.test(lower)) {
    const wordsOnly = lower.replace(/[£$€]?\d[\d,.]*/g, ' ');
    for (const a of amounts(wordsOnly).found) {
      if (out.some((o) => o.value === a.n)) continue;
      const at = NUMBER_WORD.exec(lower)?.index ?? 0;
      const tail = lower.slice(at).split(/\s+/).slice(0, 8).join(' ');
      const pct = /\b(percent|per cent)\b/.test(tail);
      const unit = pct ? '%' : a.code === 'GBP' ? '£' : a.code === 'USD' ? '$' : a.code === 'EUR' ? '€' : undefined;
      out.push({ value: a.n, raw: String(a.n), index: at, ...(unit ? { unit } : {}) });
    }
  }
  // Words that are numbers in all but spelling.
  const WORDY: [RegExp, number][] = [[/\bhalve[sd]?\b|\bin half\b/, 50], [/\bdoubled?\b/, 100], [/\btripled?\b/, 200]];
  for (const [r, v] of WORDY) {
    const mm = r.exec(lower);
    if (mm && !out.some((o) => o.value === v && o.unit === '%')) out.push({ value: v, unit: '%', raw: mm[0], index: mm.index });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Relative difference between two values, or 1 when one of them is zero. */
export function relDiff(a: number, b: number): number {
  if (a === b) return 0;
  const base = Math.max(Math.abs(a), Math.abs(b));
  return base === 0 ? 0 : Math.abs(a - b) / base;
}

/** "02:14" from milliseconds. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
