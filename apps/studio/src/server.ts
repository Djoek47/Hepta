/**
 * The studio: serves the page, and one WebSocket session per operator.
 * Keys never leave this process; the page is told only which ones exist.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Clip } from '@hepta/listen';
import { keys, type Env } from './config.js';
import { Session, type ClientMessage } from './session.js';

export type StudioOptions = {
  env: Env;
  /** Directory of built page assets. */
  publicDir: string;
  clipsDir: string;
  port?: number;
  host?: string;
  /** For tests: build the session differently. */
  session?: (send: (m: Record<string, unknown>) => void, clips: Map<string, Clip>) => Session;
};

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
};

export function loadClips(dir: string): Map<string, Clip> {
  const out = new Map<string, Clip>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f);
    const file = f.endsWith('.json') ? p : existsSync(join(p, 'clip.json')) ? join(p, 'clip.json') : null;
    if (!file) continue;
    const c = JSON.parse(readFileSync(file, 'utf8')) as Clip;
    out.set(c.id, c);
  }
  return out;
}

/** Remote media for the URL input, fetched here so the page can play and capture it. */
async function media(url: string, res: ServerResponse): Promise<void> {
  let u: URL;
  try { u = new URL(url); } catch { res.writeHead(400).end('bad url'); return; }
  if (!/^https?:$/.test(u.protocol) || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$)/.test(u.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)) {
    res.writeHead(400).end('only public http(s) media');
    return;
  }
  const r = await fetch(u, { redirect: 'follow' });
  if (!r.ok || !r.body) { res.writeHead(502).end(`upstream ${r.status}`); return; }
  res.writeHead(200, { 'content-type': r.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': 'no-store' });
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

export function startStudio(o: StudioOptions): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const clips = loadClips(o.clipsDir);
  const root = resolve(o.publicDir);
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/clips') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([...clips.values()].map((c) => ({ id: c.id, title: c.title, mode: c.mode, turns: c.turns.length, note: c.note }))));
      return;
    }
    if (url.pathname === '/api/keys') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(keys(o.env)));
      return;
    }
    if (url.pathname === '/media') {
      media(url.searchParams.get('url') ?? '', res).catch((e: unknown) => { if (!res.headersSent) res.writeHead(502); res.end(String(e)); });
      return;
    }
    const rel = normalize(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(root, rel);
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  });

  const wss = new WebSocketServer({ server: http, path: '/ws' });
  wss.on('connection', (ws: WebSocket) => {
    const send = (m: Record<string, unknown>) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
    const session = o.session ? o.session(send, clips) : new Session(send, o.env, clips);
    send({ type: 'hello', keys: keys(o.env), clips: [...clips.values()].map((c) => ({ id: c.id, title: c.title, mode: c.mode })) });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        const copy = new Uint8Array(data.byteLength - (data.byteLength % 2));
        copy.set(data.subarray(0, copy.byteLength));
        session.audio(new Int16Array(copy.buffer));
        return;
      }
      let m: ClientMessage;
      try { m = JSON.parse(data.toString()) as ClientMessage; } catch { send({ type: 'error', message: 'bad message' }); return; }
      session.handle(m).catch((e: unknown) => send({ type: 'error', message: String((e as Error)?.message ?? e) }));
    });
    ws.on('close', () => { void session.stop(); });
  });

  return new Promise((ok) => {
    http.listen(o.port ?? 7474, o.host ?? '127.0.0.1', () => {
      const addr = http.address();
      const port = typeof addr === 'object' && addr ? addr.port : (o.port ?? 7474);
      ok({
        server: http, port,
        close: () => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(); http.close(() => r()); }),
      });
    });
  });
}
