import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeConnection } from './native-connection';

class MockSocket {
  static OPEN = 1;
  static instances: MockSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { MockSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  send(frame: string) { this.sent.push(frame); }
  message(event: string, payload: unknown) { this.onmessage?.({ data: JSON.stringify({ event, payload }) }); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
}
const token = 'a'.repeat(64);
const joined = { room: { roomCode: '123456', revision: 1 }, sessionToken: token, playerIndex: 0, inviteUrl: 'https://game.test/?room=123456' };
const all: NativeConnection[] = [];
function client() { const c = new NativeConnection('https://game.test'); all.push(c); c.connect(); return c; }
beforeEach(() => { vi.useFakeTimers(); MockSocket.instances = []; vi.stubGlobal('WebSocket', MockSocket); });
afterEach(() => { for (const c of all.splice(0)) c.close(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('native client reconnect behavior', () => {
  it('creates a room, authenticates over a frame and uses WSS without placing credentials in URLs', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ roomCode: '123456', sessionToken: token }) });
    vi.stubGlobal('fetch', fetcher);
    const c = client(); const listener = vi.fn(); c.on('room_joined', listener);
    c.emit('create_room', {});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledWith('https://game.test/api/rooms', expect.objectContaining({ method: 'POST' }));
    const ws = MockSocket.instances[0]!;
    expect(ws.url).toBe('wss://game.test/api/rooms/123456/ws');
    ws.open();
    expect(JSON.parse(ws.sent[0]!)).toEqual({ event: 'reconnect_room', payload: { roomCode: '123456', sessionToken: token } });
    ws.message('room_joined', joined);
    expect(listener).toHaveBeenCalledWith(joined);
  });

  it('automatically reconnects with the issued token and never replays a move or a join', async () => {
    const c = client(); const attempt = vi.fn(); const disconnected = vi.fn();
    c.io.on('reconnect_attempt', attempt); c.on('disconnect', disconnected);
    c.emit('join_room', { roomCode: '123456' });
    const first = MockSocket.instances[0]!; first.open(); first.message('room_joined', joined);
    c.emit('make_move', { pitIndex: 2, revision: 1, moveId: 'native-move-01' });
    first.close(1006);
    expect(disconnected).toHaveBeenCalledOnce(); expect(attempt).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    const second = MockSocket.instances[1]!; second.open();
    expect(second.sent.map(s => JSON.parse(s))).toEqual([{ event: 'reconnect_room', payload: { roomCode: '123456', sessionToken: token } }]);
    second.message('room_joined', joined);
  });

  it('ignores stale messages and cancels retries when switching rooms or explicitly leaving', async () => {
    const c = client(); const listener = vi.fn(); c.on('room_joined', listener);
    c.emit('join_room', { roomCode: '123456' });
    const stale = MockSocket.instances[0]!; stale.open();
    c.emit('join_room', { roomCode: '654321' });
    stale.message('room_joined', joined);
    expect(listener).not.toHaveBeenCalled();
    const live = MockSocket.instances[1]!; live.open(); live.message('room_joined', { ...joined, room: { roomCode: '654321' } });
    c.emit('leave_room');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(MockSocket.instances).toHaveLength(2);
    expect(JSON.parse(live.sent.at(-1)!)).toEqual({ event: 'leave_room' });
  });

  it('does not reconnect after an authentication failure or session takeover', async () => {
    for (const code of [4001, 4004, 1008]) {
      const c = client(); const invalid = vi.fn(), error = vi.fn(); c.on('invalid_move', invalid); c.on('connect_error', error);
      c.emit('reconnect_room', { roomCode: '123456', sessionToken: token });
      const ws = MockSocket.instances.at(-1)!; ws.open(); ws.close(code);
      const count = MockSocket.instances.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(MockSocket.instances.length).toBe(count);
      if (code === 4001) {
        expect(error).toHaveBeenCalledOnce();
        // The app clears shared localStorage on room_not_found; a takeover must retain the new tab's token.
        expect(invalid).not.toHaveBeenCalled();
      } else expect(invalid).toHaveBeenCalledWith({ reason: 'room_not_found' });
    }
  });

  it('uses heartbeat acknowledgements to detect an unresponsive connection', async () => {
    const c = client(); c.emit('reconnect_room', { roomCode: '123456', sessionToken: token });
    const ws = MockSocket.instances[0]!; ws.open(); ws.message('room_joined', joined);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ws.sent.at(-1)).toBe('ping');
    ws.onmessage?.({ data: 'pong' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ws.readyState).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ws.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(500);
    expect(MockSocket.instances).toHaveLength(2);
  });

  it('drops late room reservations after the client has been closed', async () => {
    let resolve!: (value: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(r => { resolve = r; })));
    const c = client(); c.emit('create_room', {}); c.close();
    resolve({ ok: true, json: async () => ({ roomCode: '123456', sessionToken: token }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(MockSocket.instances).toHaveLength(0);
  });
});
