import type { ClientToServerEvents } from '@fuwa-hitsuji/shared';

export const RECONNECT_MS = 90_000;
export const AUTH_MS = 10_000;
export const HEARTBEAT_MS = 60_000;
export const MAX_MESSAGE_BYTES = 2048;
export type Command = { [K in keyof ClientToServerEvents]: { event: K; payload: Parameters<ClientToServerEvents[K]>[0] } }[keyof ClientToServerEvents];

export function parseCommand(raw: string | ArrayBuffer): Command | null {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!record(value) || typeof value.event !== 'string') return null;
  const p = value.payload;
  switch (value.event) {
    case 'create_room': return null; // Creation is an atomic HTTP reservation.
    case 'join_room':
      return record(p) && code(p.roomCode) && name(p.playerName) ? { event: value.event, payload: { roomCode: p.roomCode, ...(typeof p.playerName === 'string' ? { playerName: p.playerName } : {}) } } : null;
    case 'reconnect_room':
      return record(p) && code(p.roomCode) && typeof p.sessionToken === 'string' && /^[a-f0-9]{64}$/.test(p.sessionToken) ? { event: value.event, payload: { roomCode: p.roomCode, sessionToken: p.sessionToken } } : null;
    case 'make_move':
      return record(p) && Number.isInteger(p.pitIndex) && typeof p.pitIndex === 'number' && p.pitIndex >= 0 && p.pitIndex <= 5 && Number.isSafeInteger(p.revision) && typeof p.revision === 'number' && p.revision >= 0 && typeof p.moveId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(p.moveId)
        ? { event: value.event, payload: { pitIndex: p.pitIndex, revision: p.revision, moveId: p.moveId } } : null;
    case 'rematch_request': return p === undefined || record(p) ? { event: value.event, payload: undefined } : null;
    case 'leave_room': return p === undefined || (record(p) && code(p.roomCode)) ? { event: value.event, payload: undefined } : null;
    default: return null;
  }
}
export function record(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
export function code(v: unknown): v is string { return typeof v === 'string' && /^\d{6}$/.test(v); }
export function name(v: unknown): boolean { return v === undefined || (typeof v === 'string' && v.length <= 100); }
export function randomToken(): string { return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''); }
export async function digest(token: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), b => b.toString(16).padStart(2, '0')).join('');
}
export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
