import { json, name, record } from './protocol';
export { MancalaRoom } from './room';

export interface Env { ROOMS: DurableObjectNamespace; ASSETS: Fetcher }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true, transport: 'websocket' });
    if (url.pathname.startsWith('/socket.io')) return json({ error: 'Use native WebSocket /api/rooms/:code/ws' }, 410);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    // Same-origin POST and WS only. Tokens never appear in URLs, query strings, logs, or broadcasts.
    if (request.headers.get('Origin') !== url.origin) return json({ error: 'origin_rejected' }, 403);
    if (url.search) return json({ error: 'query_not_allowed' }, 400);
    if (url.pathname === '/api/rooms') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') return json({ error: 'json_required' }, 415);
      const reader = request.body?.getReader();
      if (!reader) return json({ error: 'body_required' }, 400);
      let text = ''; let bytes = 0;
      const decoder = new TextDecoder();
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 1024) { await reader.cancel(); return json({ error: 'body_too_large' }, 413); }
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
      let body: unknown;
      try { body = JSON.parse(text); } catch { return json({ error: 'invalid_json' }, 400); }
      if (!record(body) || !name(body.playerName)) return json({ error: 'invalid_payload' }, 400);
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = (crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).toString().padStart(6, '0');
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const response = await stub.fetch(new Request(`${url.origin}/api/rooms/${code}/reserve`, { method: 'POST', body: JSON.stringify(body) }));
        if (response.status !== 409) return response;
      }
      return json({ error: 'rooms_busy' }, 503);
    }
    const match = /^\/api\/rooms\/(\d{6})\/ws$/.exec(url.pathname);
    if (!match) return json({ error: 'not_found' }, 404);
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'websocket_required' }, 426);
    return env.ROOMS.get(env.ROOMS.idFromName(match[1]!)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
