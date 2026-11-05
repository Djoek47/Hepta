/**
 * npm run e2e:capture
 *
 * The page's audio path, end to end in a real browser: a WAV file chosen in
 * the File input plays in the page, the AudioWorklet taps it, it is
 * downsampled to 16 kHz PCM and streamed to the studio — at broadcast speed.
 * The recognizer is a fake that counts samples, so no key is needed.
 */
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SttProvider } from '@hepta/listen';
import { startStudio } from '../apps/studio/src/server.js';
import { Session } from '../apps/studio/src/session.js';

const SECONDS = 3;
let samples = 0;
let firstAt = 0;
let lastAt = 0;
const fake: SttProvider = {
  name: 'counting', diarizes: 'none',
  async open() {
    return {
      send(pcm) { if (!firstAt) firstAt = Date.now(); lastAt = Date.now(); samples += pcm.length; },
      async finish() {}, close() {}, on() { return () => {}; },
    };
  },
};

function wav(seconds: number, rate = 44100): Buffer {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 12000), 44 + i * 2);
  return b;
}

// Playwright is not a dependency of Hepta: use the one installed on this machine.
type Page = { on(e: 'pageerror', fn: (e: unknown) => void): void; goto(u: string): Promise<unknown>; waitForFunction(fn: () => boolean): Promise<unknown>;
  selectOption(s: string, v: string): Promise<unknown>; setInputFiles(s: string, f: string): Promise<void>; click(s: string): Promise<void>; waitForTimeout(ms: number): Promise<void> };
let chromium: { launch(o: { args: string[] }): Promise<{ newPage(): Promise<Page>; close(): Promise<void> }> };
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.error('This check needs Playwright with Chromium: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'hepta-e2e-'));
const file = join(dir, 'tone.wav');
writeFileSync(file, wav(SECONDS));

const studio = await startStudio({
  env: { DEEPGRAM_API_KEY: 'not-used' }, publicDir: 'apps/studio/public', clipsDir: 'bench/clips', port: 0,
  session: (send, clips) => new Session(send, {}, clips, () => fake),
});
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const errors: string[] = [];
page.on('pageerror', (e: unknown) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${studio.port}/`);
await page.waitForFunction(() => !(document.querySelector('#input option[value=file]') as HTMLOptionElement).disabled);
await page.selectOption('#input', 'file');
await page.setInputFiles('#file', file);
await page.click('#go');
await page.waitForTimeout((SECONDS + 1.5) * 1000);
await browser.close();
await studio.close();

const got = samples / 16000;
const span = (lastAt - firstAt) / 1000;
console.log(`sent ${SECONDS} s of audio; the studio received ${got.toFixed(2)} s of 16 kHz PCM over ${span.toFixed(2)} s of wall time`);
if (errors.length) console.log('page errors:', errors);
const ok = got > SECONDS * 0.85 && got < SECONDS * 1.15 && span > SECONDS * 0.7 && errors.length === 0;
console.log(ok ? 'OK: real time, end to end' : 'FAILED');
process.exit(ok ? 0 : 1);
