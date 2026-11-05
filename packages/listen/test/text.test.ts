import { describe, expect, it } from 'vitest';
import { keyOverlap, numbers, relDiff, stem } from '../src/text.js';

describe('numbers as they are said', () => {
  const read = (s: string) => numbers(s).map((n) => [n.value, n.unit ?? null, !!n.year]);
  it('reads digits with their units and scales', () => {
    expect(read('Our plan builds 40,000 homes by 2028, fully funded.')).toEqual([[40000, 'homes', false], [2028, null, true]]);
    expect(read('And the grid alone is 60 billion pounds.')).toEqual([[60e9, '£', false]]);
    expect(read('Growth this year is 3 percent, the fastest in the G7.')).toEqual([[3, '%', false]]);
  });
  it('reads number words through the ported grammar', () => {
    expect(read('six hundred and fifty pounds')).toEqual([[650, '£', false]]);
  });
  it('reads the words that are numbers in all but spelling', () => {
    expect(read('We will halve waiting lists by 2027.')).toEqual([[50, '%', false], [2027, null, true]]);
    expect(read('profits doubled last year')).toEqual([[100, '%', false]]);
  });
});

describe('words that meet', () => {
  it('stems plural, past and -ing forms to the same root', () => {
    expect(stem('homes')).toBe(stem('home'));
    expect(stem('funded')).toBe(stem('funding'));
    expect(stem('housing')).toBe(stem('house'));
    expect(stem('companies')).toBe(stem('company'));
  });
  it('measures how much of a set of keys a sentence covers', () => {
    expect(keyOverlap('the housing funding question', ['housing', 'fund'])).toBe(1);
    expect(keyOverlap('crime is up', ['housing', 'fund'])).toBe(0);
  });
  it('compares numbers relatively', () => {
    expect(relDiff(3, 5)).toBeCloseTo(0.4);
    expect(relDiff(400, 420)).toBeLessThan(0.25);
  });
});
