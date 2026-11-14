import type { InvalidMovePayload, PlayerIndex, RoomJoinedPayload } from '@fuwa-hitsuji/shared';
import { AUTH_MS, HEARTBEAT_MS, RECONNECT_MS, digest, json, parseCommand, randomToken, type Command } from './protocol';
import { createRoom, move, player, publicState, remove, start, type Room, type Player } from './room-state';

interface Attachment {
  id: string;
  origin: string;
  authDeadline: number;
  lastSeen: number;
  rateSince: number;
  rateCount: number;
  closed: boolean;
}

/** One SQLite-backed object owns a six-digit room. No process-local room map or timers. */
export class MancalaRoom {
  constructor(private readonly ctx: DurableObjectState) {
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS room_state (id INTEGER PRIMARY KEY CHECK(id = 1), snapshot TEXT NOT NULL)');
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const url = new URL(request.url);
      const code = url.pathname.split('/')[3]!;
      let room = this.maintain();
      if (request.method === 'POST') {
        if (room) return json({ error: 'collision' }, 409);
        const body = await request.json() as { playerName?: string };
        const token = randomToken();
        room = createRoom(code, await digest(token), body.playerName, this.now());
        this.save(room);
        await this.schedule(room);
        return json({ roomCode: code, sessionToken: token }, 201);
      }
      if (this.sockets().length >= 4) return json({ error: 'too_many_connections' }, 429);
      const pair = new WebSocketPair();
      const now = this.now();
      pair[1].serializeAttachment({ id: crypto.randomUUID(), origin: url.origin, authDeadline: now + AUTH_MS, lastSeen: now, rateSince: now, rateCount: 0, closed: false } satisfies Attachment);
      this.ctx.acceptWebSocket(pair[1]);
      await this.schedule(room);
      return new Response(null, { status: 101, webSocket: pair[0] });
    });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const a = ws.deserializeAttachment() as Attachment;
      if (a.closed) return;
      const room = this.maintain();
      if (!room) {
        this.invalid(ws, undefined, 'room_not_found');
        this.close(ws, 4004, 'Room expired');
        await this.schedule(null);
        return;
      }
      const now = this.now();
      if (now - a.rateSince >= 10_000) { a.rateSince = now; a.rateCount = 0; }
      a.rateCount++;
      a.lastSeen = now;
      ws.serializeAttachment(a);
      const command = parseCommand(raw);
      if (!command || a.rateCount > 30) {
        this.detach(room, ws);
        this.close(ws, 1008, 'Invalid message or rate limit');
      } else {
        await this.command(room, ws, command);
      }
      this.save(room);
      await this.schedule(room);
    });
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.disconnected(ws);
  }
  async webSocketError(ws: WebSocket): Promise<void> {
    await this.disconnected(ws);
  }
  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const room = this.maintain();
      if (room) this.save(room);
      await this.schedule(room);
    });
  }

  private async command(room: Room, ws: WebSocket, command: Command): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment;
    const bound = room.players.find(p => p?.connectionId === a.id);
    if (command.event === 'join_room' || command.event === 'reconnect_room') {
      if (bound || command.payload.roomCode !== room.code || this.now() >= a.authDeadline) {
        this.invalid(ws, bound ? room : undefined, 'not_a_player'); return;
      }
      let p: Player | undefined;
      let token: string;
      const reconnect = command.event === 'reconnect_room';
      if (command.event === 'reconnect_room') {
        token = command.payload.sessionToken;
        const hash = await digest(token);
        p = room.players.find((candidate): candidate is Player => candidate?.tokenHash === hash);
      } else {
        const index = room.players.findIndex(candidate => candidate === null);
        if (index >= 0) {
          token = randomToken();
          p = player(index as PlayerIndex, await digest(token), command.payload.playerName, this.now());
          room.players[index as PlayerIndex] = p;
        } else token = '';
      }
      if (!p) {
        this.invalid(ws, undefined, 'room_not_found');
        this.close(ws, 4004, 'Room unavailable');
        return;
      }
      // Revocation occurs before closing the old socket; its delayed close cannot unbind this seat.
      const oldId = p.connectionId;
      p.connectionId = a.id;
      p.expiresAt = null;
      for (const old of this.sockets()) {
        if ((old.deserializeAttachment() as Attachment).id === oldId) this.close(old, 4001, 'Session replaced');
      }
      this.save(room);
      const joined: RoomJoinedPayload = { room: publicState(room), playerIndex: p.index, sessionToken: token!, inviteUrl: `${a.origin}/?room=${room.code}` };
      this.send(ws, 'room_joined', joined);
      if (reconnect) this.broadcast(room, 'player_reconnected', { playerIndex: p.index, state: publicState(room) });
      if (!room.game && room.players.every(candidate => candidate !== null && candidate.connectionId !== null)) {
        start(room);
        this.save(room);
        this.broadcast(room, 'start_game', { state: publicState(room) });
      }
      return;
    }
    if (!bound) { this.invalid(ws, undefined, 'not_a_player'); return; }
    if (command.event === 'make_move') {
      const result = move(room, bound.index, command.payload.pitIndex, command.payload.revision, command.payload.moveId);
      if (!result.accepted) { this.invalid(ws, room, result.reason); return; }
      this.save(room);
      const update = { state: publicState(room), moveResult: result };
      this.broadcast(room, 'state_update', update);
      if (result.ended) this.broadcast(room, 'game_finished', update);
    } else if (command.event === 'rematch_request') {
      if (room.players.some(p => !p?.connectionId)) { this.invalid(ws, room, 'player_disconnected'); return; }
      if (room.game?.status !== 'finished') { this.invalid(ws, room, 'game_not_started'); return; }
      if (!room.rematchRequestedBy.includes(bound.index)) room.rematchRequestedBy.push(bound.index);
      this.save(room);
      this.broadcast(room, 'rematch_request', { playerIndex: bound.index, requestedBy: [...room.rematchRequestedBy].sort() });
      if (room.rematchRequestedBy.length === 2) {
        room.startingPlayer = room.startingPlayer === 0 ? 1 : 0;
        start(room);
        this.save(room);
        this.broadcast(room, 'rematch_start', { state: publicState(room) });
      }
    } else if (command.event === 'leave_room') {
      remove(room, bound.index);
      this.save(room);
      this.broadcast(room, 'player_disconnected', { playerIndex: bound.index, state: publicState(room) });
      this.broadcast(room, 'state_update', { state: publicState(room) });
      this.close(ws, 1000, 'Left room');
    }
  }

  private maintain(): Room | null {
    const rows = this.ctx.storage.sql.exec<{ snapshot: string }>('SELECT snapshot FROM room_state WHERE id = 1').toArray();
    if (!rows[0]) {
      for (const ws of this.sockets()) {
        if (this.now() >= (ws.deserializeAttachment() as Attachment).authDeadline) this.close(ws, 4004, 'Room expired');
      }
      return null;
    }
    const room = JSON.parse(rows[0].snapshot) as Room;
    const before = JSON.stringify(room);
    const now = this.now();
    for (const ws of this.sockets()) {
      const a = ws.deserializeAttachment() as Attachment;
      const bound = room.players.some(p => p?.connectionId === a.id);
      const lastSeen = Math.max(a.lastSeen, this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0);
      if ((!bound && now >= a.authDeadline) || (bound && now - lastSeen >= HEARTBEAT_MS)) {
        this.detach(room, ws);
        this.close(ws, bound ? 4000 : 1008, 'Connection timed out');
      }
    }
    const ids = new Set(this.sockets().map(ws => (ws.deserializeAttachment() as Attachment).id));
    for (const p of room.players) {
      if (!p) continue;
      if (p.connectionId !== null && !ids.has(p.connectionId)) {
        p.connectionId = null;
        p.expiresAt = now + RECONNECT_MS;
        this.broadcast(room, 'player_disconnected', { playerIndex: p.index, state: publicState(room) });
      }
      if (p.connectionId === null && p.expiresAt !== null && now >= p.expiresAt) {
        remove(room, p.index);
        this.save(room);
        this.broadcast(room, 'player_disconnected', { playerIndex: p.index, state: publicState(room) });
        this.broadcast(room, 'state_update', { state: publicState(room) });
      }
    }
    if (JSON.stringify(room) !== before) this.save(room);
    if (room.players.every(p => p === null)) {
      for (const ws of this.sockets()) this.close(ws, 4004, 'Room expired');
      return null;
    }
    return room;
  }
  private async disconnected(ws: WebSocket): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const room = this.maintain();
      if (room) { this.detach(room, ws); this.save(room); }
      this.close(ws, 1000, 'Disconnected');
      await this.schedule(room);
    });
  }
  private detach(room: Room, ws: WebSocket): void {
    const id = (ws.deserializeAttachment() as Attachment).id;
    const p = room.players.find(candidate => candidate?.connectionId === id);
    if (!p) return;
    p.connectionId = null;
    p.expiresAt = this.now() + RECONNECT_MS;
    room.rematchRequestedBy = [];
    this.save(room);
    this.broadcast(room, 'player_disconnected', { playerIndex: p.index, state: publicState(room) });
  }
  private sockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter(ws => !(ws.deserializeAttachment() as Attachment).closed);
  }
  private save(room: Room): void {
    if (room.players.every(p => p === null)) this.ctx.storage.sql.exec('DELETE FROM room_state WHERE id = 1');
    else this.ctx.storage.sql.exec('INSERT INTO room_state (id, snapshot) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot', JSON.stringify(room));
  }
  private async schedule(room: Room | null): Promise<void> {
    const deadlines = room?.players.flatMap(p => p?.expiresAt !== null && p?.expiresAt !== undefined ? [p.expiresAt] : []) ?? [];
    for (const ws of this.sockets()) {
      const a = ws.deserializeAttachment() as Attachment;
      if (room?.players.some(p => p?.connectionId === a.id)) deadlines.push(Math.max(a.lastSeen, this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0) + HEARTBEAT_MS);
      else deadlines.push(a.authDeadline);
    }
    if (deadlines.length) await this.ctx.storage.setAlarm(Math.max(this.now() + 1, Math.min(...deadlines)));
    else await this.ctx.storage.deleteAlarm();
  }
  private close(ws: WebSocket, code: number, reason: string): void {
    const a = ws.deserializeAttachment() as Attachment;
    a.closed = true;
    ws.serializeAttachment(a);
    try { ws.close(code, reason); } catch { /* Already closed. */ }
  }
  private send(ws: WebSocket, event: string, payload: unknown): void {
    try { ws.send(JSON.stringify({ event, payload })); } catch { /* Close/error handler retains the seat for reconnect. */ }
  }
  private broadcast(room: Room, event: string, payload: unknown): void {
    const ids = new Set(room.players.flatMap(p => p?.connectionId ? [p.connectionId] : []));
    for (const ws of this.sockets()) if (ids.has((ws.deserializeAttachment() as Attachment).id)) this.send(ws, event, payload);
  }
  private invalid(ws: WebSocket, room: Room | undefined, reason: InvalidMovePayload['reason']): void {
    this.send(ws, 'invalid_move', { reason, ...(room ? { state: publicState(room) } : {}) });
  }
  protected now(): number { return Date.now(); }
}
