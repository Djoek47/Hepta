/**
 * npm start → http://127.0.0.1:7474
 */
import { existsSync, readFileSync } from 'node:fs';
import { startStudio } from './server.js';

function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
}

loadEnv('.env');
const port = Number(process.env.PORT ?? 7474);
const { port: bound } = await startStudio({ env: process.env, publicDir: 'apps/studio/public', clipsDir: 'bench/clips', port, host: process.env.HOST ?? '127.0.0.1' });
const k = { anthropic: !!process.env.ANTHROPIC_API_KEY, deepgram: !!process.env.DEEPGRAM_API_KEY, assemblyai: !!process.env.ASSEMBLYAI_API_KEY };
console.log(`Hepta Listen studio: http://127.0.0.1:${bound}`);
console.log(`keys: Claude ${k.anthropic ? 'yes' : 'no'} · Deepgram ${k.deepgram ? 'yes' : 'no'} · AssemblyAI ${k.assemblyai ? 'yes' : 'no'}${!k.deepgram && !k.assemblyai ? '  (scripted clips work without keys)' : ''}`);
