import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, type WebSocket } from 'miniflare';
import type { RoomJoinedPayload, StateUpdatePayload, InvalidMovePayload } from '@fuwa-hitsuji/shared';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

let mf: Miniflare;
const origin = 'https://game.test';
const clients: Peer[] = [];
beforeAll(async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL('./fixture.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  mf = new Miniflare({ modules: true, script: result.outputFiles[0]!.text, compatibilityDate: '2026-05-15', durableObjects: { ROOMS: { className: 'MancalaRoom', useSQLite: true } }, bindings: {}, fetchMock: undefined });
  await mf.ready;
});
afterAll(async () => { for (const p of clients) p.close(); await mf?.dispose(); });

class Peer {
  messages: Array<{ event: string; payload: any }> = [];
  waiters: Array<() => void> = [];
  constructor(readonly ws: WebSocket) {
    ws.accept();
    ws.addEventListener('message', event => {
      if (event.data === 'pong') this.messages.push({ event: 'pong', payload: null });
      else this.messages.push(JSON.parse(String(event.data)));
      for (const notify of [...this.waiters]) notify();
    });
    clients.push(this);
  }
  send(event: string, payload?: unknown) { this.ws.send(JSON.stringify({ event, payload })); }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
  async next<T = any>(event: string, predicate: (value: T) => boolean = () => true): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error(`Timed out: ${event}; received ${this.messages.map(m => m.event).join(', ')}`)); }, 3000);
      const cleanup = () => { clearTimeout(timeout); this.waiters = this.waiters.filter(w => w !== check); };
      const check = () => {
        const index = this.messages.findIndex(m => m.event === event && predicate(m.payload));
        if (index < 0) return;
        const message = this.messages.splice(index, 1)[0]!;
        cleanup(); resolve(message.payload);
      };
      this.waiters.push(check); check();
    });
  }
}
async function reserve() {
  const response = await mf.dispatchFetch(`${origin}/api/rooms`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ playerName: 'プレイヤー' }) });
  expect(response.status).toBe(201);
  return await response.json() as { roomCode: string; sessionToken: string };
}
async function socket(code: string): Promise<Peer> {
  const response = await mf.dispatchFetch(`${origin}/api/rooms/${code}/ws`, { headers: { Origin: origin, Upgrade: 'websocket' } });
  expect(response.status).toBe(101);
  return new Peer(response.webSocket!);
}
async function room() {
  const reserved = await reserve();
  const host = await socket(reserved.roomCode);
  host.send('reconnect_room', reserved);
  const joined = await host.next<RoomJoinedPayload>('room_joined');
  const guest = await socket(reserved.roomCode);
  guest.send('join_room', { roomCode: reserved.roomCode });
  const guestJoined = await guest.next<RoomJoinedPayload>('room_joined');
  const state = await host.next<StateUpdatePayload>('start_game');
  expect(await guest.next('start_game')).toEqual(state);
  return { host, guest, joined, guestJoined, reserved, state, players: [host, guest] as const };
}
async function advance(code: string, ms: number) {
  expect((await mf.dispatchFetch(`${origin}/api/rooms/${code}/__advance`, { method: 'POST', body: JSON.stringify({ ms }) })).status).toBe(200);
}
async function snapshot(code: string) {
  const rows = await (await mf.dispatchFetch(`${origin}/api/rooms/${code}/__snapshot`)).json() as Array<{ snapshot: string }>;
  return rows[0] ? JSON.parse(rows[0].snapshot) : null;
}

describe('SQLite Durable Object multiplayer (real workerd WebSockets)', () => {
  it('atomically reserves private rooms, joins two players and rejects third parties without leaking state/tokens', async () => {
    const r = await room();
    expect(r.reserved.roomCode).toMatch(/^\d{6}$/);
    expect(r.joined.inviteUrl).toBe(`${origin}/?room=${r.reserved.roomCode}`);
    expect(r.guestJoined.playerIndex).toBe(1);
    expect(r.guestJoined.sessionToken).not.toBe(r.joined.sessionToken);
    const intruder = await socket(r.reserved.roomCode);
    intruder.send('make_move', { pitIndex: 0, revision: r.state.state.revision, moveId: 'intruder-0001' });
    expect(await intruder.next('invalid_move')).toEqual({ reason: 'not_a_player' });
    intruder.send('join_room', { roomCode: r.reserved.roomCode });
    expect(await intruder.next('invalid_move')).toEqual({ reason: 'room_not_found' });
    const fake = await socket(r.reserved.roomCode);
    fake.send('reconnect_room', { roomCode: r.reserved.roomCode, sessionToken: '0'.repeat(64) });
    expect(await fake.next('invalid_move')).toEqual({ reason: 'room_not_found' });
    const stored = await snapshot(r.reserved.roomCode);
    expect(JSON.stringify(stored)).not.toContain(r.joined.sessionToken);
    expect(JSON.stringify(r.state)).not.toContain('tokenHash');
    expect(stored.players[0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('authoritatively validates turn, pit, revision, duplicate IDs and serializes racing moves', async () => {
    const r = await room();
    const turn = r.state.state.game!.currentPlayer;
    const active = r.players[turn], other = r.players[1 - turn]!;
    other.send('make_move', { pitIndex: 0, revision: r.state.state.revision, moveId: 'wrong-turn-0001' });
    expect((await other.next('invalid_move')).reason).toBe('not_your_turn');
    const cmd = { pitIndex: 2, revision: r.state.state.revision, moveId: 'extra-turn-0001' };
    active.send('make_move', cmd);
    const update = await active.next<StateUpdatePayload>('state_update');
    expect(update.moveResult?.extraTurn).toBe(true);
    expect(update.state.revision).toBe(r.state.state.revision + 1);
    expect(await other.next('state_update')).toEqual(update);
    active.send('make_move', cmd);
    expect((await active.next('invalid_move')).reason).toBe('duplicate_move');
    active.send('make_move', { ...cmd, moveId: 'stale-turn-0001' });
    expect((await active.next('invalid_move')).reason).toBe('stale_revision');
    active.send('make_move', { ...cmd, revision: update.state.revision, moveId: 'empty-pit-0001' });
    expect((await active.next('invalid_move')).reason).toBe('invalid_pit');
    active.send('make_move', { pitIndex: 0, revision: update.state.revision, moveId: 'racing-move-0001' });
    active.send('make_move', { pitIndex: 1, revision: update.state.revision, moveId: 'racing-move-0002' });
    const raceUpdate = await active.next<StateUpdatePayload>('state_update');
    expect(raceUpdate.state.revision).toBe(update.state.revision + 1);
    expect((await active.next('invalid_move')).reason).toBe('stale_revision');
    expect((await snapshot(r.reserved.roomCode)).revision).toBe(raceUpdate.state.revision);
  });

  it('pauses play on disconnect, restores the exact board with the token, and revokes replaced sockets', async () => {
    const r = await room();
    r.guest.close();
    const disconnected = await r.host.next('player_disconnected', p => !p.state.players[1].connected);
    r.host.send('make_move', { pitIndex: 0, revision: r.state.state.revision, moveId: 'paused-move-0001' });
    const rejected = await r.host.next<InvalidMovePayload>('invalid_move');
    expect(rejected.reason).toBe('player_disconnected');
    expect(rejected.state?.game).toEqual(r.state.state.game);
    const returned = await socket(r.reserved.roomCode);
    returned.send('reconnect_room', { roomCode: r.reserved.roomCode, sessionToken: r.guestJoined.sessionToken });
    const joined = await returned.next<RoomJoinedPayload>('room_joined');
    expect(joined.room.game).toEqual(disconnected.state.game);
    expect(joined.room.revision).toBe(disconnected.state.revision);
    await r.host.next('player_reconnected', p => p.playerIndex === 1);
    const takeover = await socket(r.reserved.roomCode);
    takeover.send('reconnect_room', { roomCode: r.reserved.roomCode, sessionToken: r.guestJoined.sessionToken });
    await takeover.next('room_joined');
    await r.host.next('player_reconnected', p => p.playerIndex === 1);
    expect((await snapshot(r.reserved.roomCode)).players[1].connectionId).not.toBe(null);
  });

  it('enforces the 90-second deadline, reopens the expired seat and invalidates its old token', async () => {
    const r = await room();
    r.guest.close();
    await r.host.next('player_disconnected', p => p.playerIndex === 1);
    await advance(r.reserved.roomCode, 89_000);
    expect((await snapshot(r.reserved.roomCode)).players[1]).not.toBe(null);
    // Advancing also trips the unresponsive host watchdog; reconnect it before testing seat replacement.
    const host = await socket(r.reserved.roomCode);
    host.send('reconnect_room', r.reserved);
    await host.next('room_joined');
    await advance(r.reserved.roomCode, 1001);
    await host.next('state_update', p => p.state.players[1] === null);
    const expired = await socket(r.reserved.roomCode);
    expired.send('reconnect_room', { roomCode: r.reserved.roomCode, sessionToken: r.guestJoined.sessionToken });
    expect((await expired.next('invalid_move')).reason).toBe('room_not_found');
    const replacement = await socket(r.reserved.roomCode);
    replacement.send('join_room', { roomCode: r.reserved.roomCode });
    expect((await replacement.next('room_joined')).playerIndex).toBe(1);
    const restarted = await host.next<StateUpdatePayload>('start_game');
    expect(restarted.state.round).toBe(2);
    expect(restarted.state.game?.pits[0]).toEqual([4, 4, 4, 4, 4, 4]);
  });

  it('requires two rematch votes, completes a whole game, conserves 48 stones and alternates the starter', async () => {
    const r = await room();
    const starter = r.state.state.game!.currentPlayer;
    r.host.send('rematch_request');
    expect((await r.host.next('invalid_move')).reason).toBe('game_not_started');
    let update = r.state;
    let capture = false;
    for (let i = 0; i < 200 && update.state.status !== 'finished'; i++) {
      const game = update.state.game!;
      const active = r.players[game.currentPlayer];
      active.send('make_move', { pitIndex: game.pits[game.currentPlayer].findIndex(n => n > 0), revision: update.state.revision, moveId: `full-game-${i}` });
      update = await r.host.next<StateUpdatePayload>('state_update');
      expect(await r.guest.next('state_update')).toEqual(update);
      capture ||= (update.moveResult?.captured ?? 0) > 0;
      expect(update.state.game!.pits.flat().reduce((a, b) => a + b, 0) + update.state.game!.stores[0] + update.state.game!.stores[1]).toBe(48);
      // Stay below the production abuse threshold without slowing down game simulation.
      if (i % 20 === 19) await advance(r.reserved.roomCode, 10_001);
    }
    expect(update.state.status).toBe('finished');
    expect(capture).toBe(true);
    await r.host.next('game_finished'); await r.guest.next('game_finished');
    r.host.send('rematch_request');
    expect((await r.host.next('rematch_request')).requestedBy).toEqual([0]);
    r.host.send('rematch_request');
    expect((await r.host.next('rematch_request')).requestedBy).toEqual([0]);
    r.guest.send('rematch_request');
    const rematch = await r.host.next<StateUpdatePayload>('rematch_start');
    expect(await r.guest.next('rematch_start')).toEqual(rematch);
    expect(rematch.state.game!.currentPlayer).toBe(1 - starter);
    expect(rematch.state.round).toBe(2);
    expect(rematch.state.rematchRequestedBy).toEqual([]);
  });

  it('restores SQL state and socket attachments after reconstructing the room instance', async () => {
    const r = await room();
    const turn = r.state.state.game!.currentPlayer;
    r.players[turn].send('make_move', { pitIndex: 2, revision: r.state.state.revision, moveId: 'durable-move-0001' });
    const accepted = await r.host.next<StateUpdatePayload>('state_update');
    await mf.dispatchFetch(`${origin}/api/rooms/${r.reserved.roomCode}/__reconstruct`);
    r.players[turn].send('make_move', { pitIndex: 2, revision: r.state.state.revision, moveId: 'durable-move-0001' });
    expect((await r.players[turn].next('invalid_move')).reason).toBe('duplicate_move');
    expect((await snapshot(r.reserved.roomCode)).game).toEqual(accepted.state.game);
    r.host.ws.send('ping'); await r.host.next('pong');
  });

  it('keeps rooms isolated and resets the remaining player to waiting after an explicit leave', async () => {
    const a = await room(), b = await room();
    expect(a.reserved.roomCode).not.toBe(b.reserved.roomCode);
    const before = await snapshot(b.reserved.roomCode);
    a.guest.send('leave_room', { roomCode: b.reserved.roomCode });
    const reset = await a.host.next<StateUpdatePayload>('state_update');
    expect(reset.state.status).toBe('waiting');
    expect(reset.state.players[1]).toBe(null);
    expect(reset.state.game).toBe(null);
    expect(await snapshot(b.reserved.roomCode)).toEqual(before);
    const former = await socket(a.reserved.roomCode);
    former.send('reconnect_room', { roomCode: a.reserved.roomCode, sessionToken: a.guestJoined.sessionToken });
    expect(await former.next('invalid_move')).toEqual({ reason: 'room_not_found' });
  });

  it('expires abandoned reservations and unknown-room sockets without leaving active alarms', async () => {
    const r = await reserve();
    await advance(r.roomCode, 90_001);
    expect(await snapshot(r.roomCode)).toBe(null);
    const expired = await socket(r.roomCode);
    expired.send('reconnect_room', r);
    expect(await expired.next('invalid_move')).toEqual({ reason: 'room_not_found' });
    const abandoned = await socket(r.roomCode);
    const closed = new Promise<number>(resolve => abandoned.ws.addEventListener('close', e => resolve(e.code)));
    await advance(r.roomCode, 10_001);
    expect(await closed).toBe(4004);
    // No reservation/state is created by probing an expired code.
    expect(await snapshot(r.roomCode)).toBe(null);
  });

  it('caps pending sockets and times them out before they can claim a seat', async () => {
    const r = await room();
    const a = await socket(r.reserved.roomCode), b = await socket(r.reserved.roomCode);
    expect((await mf.dispatchFetch(`${origin}/api/rooms/${r.reserved.roomCode}/ws`, { headers: { Origin: origin, Upgrade: 'websocket' } })).status).toBe(429);
    const closed = [a, b].map(p => new Promise<number>(resolve => p.ws.addEventListener('close', e => resolve(e.code))));
    await advance(r.reserved.roomCode, 10_001);
    expect(await Promise.all(closed)).toEqual([1008, 1008]);
    const returned = await socket(r.reserved.roomCode);
    returned.send('reconnect_room', r.reserved);
    await returned.next('room_joined');
    expect((await snapshot(r.reserved.roomCode)).players.every((p: any) => p.connectionId !== null)).toBe(true);
  });

  it.each(['null', '{', JSON.stringify({ event: 'make_move', payload: null }), JSON.stringify({ event: 'make_move', payload: { pitIndex: 99, revision: 1, moveId: 'invalid-0001' } }), 'x'.repeat(2049)])('closes malformed frames and preserves both seats: %s', async raw => {
    const r = await room();
    const closed = new Promise<number>(resolve => r.guest.ws.addEventListener('close', e => resolve(e.code)));
    r.guest.ws.send(raw);
    expect(await closed).toBe(1008);
    const paused = await r.host.next('player_disconnected', p => p.playerIndex === 1);
    expect(paused.state.game).toEqual(r.state.state.game);
    expect((await snapshot(r.reserved.roomCode)).players[1].expiresAt).toBeTypeOf('number');
  });

  it('rate limits flooding without letting unauthenticated connections subscribe to broadcasts', async () => {
    const r = await room();
    const intruder = await socket(r.reserved.roomCode);
    const closed = new Promise<number>(resolve => intruder.ws.addEventListener('close', e => resolve(e.code)));
    for (let i = 0; i < 31; i++) intruder.send('rematch_request');
    expect(await closed).toBe(1008);
    expect(intruder.messages.every(m => m.event === 'invalid_move' && m.payload.reason === 'not_a_player')).toBe(true);
    expect((await snapshot(r.reserved.roomCode)).game).toEqual(r.state.state.game);
  });
});

describe('SQLite persistence across local runtime restart', () => {
  it('reopens the same SQLite database and authenticates both seats with their original tokens', async () => {
    const result = await build({ entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
    const path = fileURLToPath(new URL(`../../../.wrangler/test-state/${crypto.randomUUID()}/`, import.meta.url));
    await mkdir(path, { recursive: true });
    const options = { modules: true, script: result.outputFiles[0]!.text, compatibilityDate: '2026-05-15', durableObjects: { ROOMS: { className: 'MancalaRoom', useSQLite: true } }, durableObjectsPersist: path } as const;
    let runtime = new Miniflare(options);
    const previous = mf;
    try {
      await runtime.ready; mf = runtime;
      const r = await room();
      const turn = r.state.state.game!.currentPlayer;
      r.players[turn].send('make_move', { pitIndex: 2, revision: r.state.state.revision, moveId: 'persisted-move-01' });
      const accepted = await r.host.next<StateUpdatePayload>('state_update');
      r.guest.close(); await r.host.next('player_disconnected', p => p.playerIndex === 1);
      r.host.close();
      // Flush the close handler before stopping the entire runtime.
      await runtime.dispatchFetch(`${origin}/health`);
      await runtime.dispose();
      runtime = new Miniflare(options); mf = runtime; await runtime.ready;
      const host = await socket(r.reserved.roomCode), guest = await socket(r.reserved.roomCode);
      host.send('reconnect_room', r.reserved);
      const joined = await host.next<RoomJoinedPayload>('room_joined');
      expect(joined.room.game).toEqual(accepted.state.game);
      expect(joined.room.revision).toBe(accepted.state.revision);
      guest.send('reconnect_room', { roomCode: r.reserved.roomCode, sessionToken: r.guestJoined.sessionToken });
      expect((await guest.next<RoomJoinedPayload>('room_joined')).room.game).toEqual(accepted.state.game);
      r.players[turn];
      const active = turn === 0 ? host : guest;
      active.send('make_move', { pitIndex: 2, revision: r.state.state.revision, moveId: 'persisted-move-01' });
      expect((await active.next('invalid_move')).reason).toBe('duplicate_move');
      host.close(); guest.close();
    } finally { mf = previous; await runtime.dispose(); }
  });
});

describe('Worker HTTP boundary', () => {
  it('rejects cross-origin/missing-origin access, malformed bodies, oversize input and unsupported routes', async () => {
    for (const suppliedOrigin of [undefined, 'https://evil.test']) {
      const headers = suppliedOrigin ? { Origin: suppliedOrigin, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
      expect((await mf.dispatchFetch(`${origin}/api/rooms`, { method: 'POST', headers, body: '{}' })).status).toBe(403);
    }
    for (const body of ['null', '{', '{"playerName":4}']) expect((await mf.dispatchFetch(`${origin}/api/rooms`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body })).status).toBe(400);
    expect((await mf.dispatchFetch(`${origin}/api/rooms`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: 'x'.repeat(1025) })).status).toBe(413);
    expect((await mf.dispatchFetch(`${origin}/api/rooms`, { headers: { Origin: origin } })).status).toBe(405);
    expect((await mf.dispatchFetch(`${origin}/api/rooms/123456/ws`, { headers: { Origin: origin } })).status).toBe(426);
    expect((await mf.dispatchFetch(`${origin}/api/rooms/123456/ws?token=secret`, { headers: { Origin: origin, Upgrade: 'websocket' } })).status).toBe(400);
    expect((await mf.dispatchFetch(`${origin}/socket.io/`)).status).toBe(410);
    expect((await mf.dispatchFetch(`${origin}/health`)).status).toBe(200);
  });
});
