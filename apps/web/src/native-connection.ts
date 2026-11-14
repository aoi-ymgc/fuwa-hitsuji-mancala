import type { ClientToServerEvents, RoomJoinedPayload } from '@fuwa-hitsuji/shared';
import type { GameConnection, Incoming } from './connection';

type Intent = { event: 'join_room'; payload: { roomCode: string; playerName?: string } } | { event: 'reconnect_room'; payload: { roomCode: string; sessionToken: string } };

/** Socket.IO-shaped boundary keeps the existing game screens and animation handlers intact. */
export class NativeConnection implements GameConnection {
  private listeners = new Map<string, Array<(...args: never[]) => void>>();
  private ws: WebSocket | null = null;
  private intent: Intent | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private pongTimeout: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private generation = 0;
  private attempt = 0;
  private reconnectListener = () => {};
  readonly io = { on: (_event: 'reconnect_attempt', listener: () => void) => { this.reconnectListener = listener; } };
  constructor(private readonly origin: string) {}

  on<E extends keyof Incoming>(event: E, listener: Incoming[E]): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as (...args: never[]) => void);
    this.listeners.set(event, list);
    return this;
  }
  connect(): void {
    this.stopped = false;
    queueMicrotask(() => { if (!this.stopped) this.dispatch('connect'); });
  }
  emit<E extends keyof ClientToServerEvents>(event: E, ...args: Parameters<ClientToServerEvents[E]>): this {
    if (this.stopped) return this;
    const payload = args[0];
    if (event === 'create_room') void this.reserve(payload);
    else if (event === 'join_room' || event === 'reconnect_room') {
      const intent = { event, payload } as Intent;
      if (!/^\d{6}$/.test(intent.payload.roomCode)) { this.dispatch('invalid_move', { reason: 'room_not_found' }); return this; }
      // A room_joined callback is the sole authority for remembering a successful connection.
      this.open(intent);
    } else if (event === 'leave_room') {
      this.send(event, payload);
      this.reset();
    } else if (!this.send(event, payload)) {
      this.dispatch('invalid_move', { reason: 'player_disconnected' });
    }
    return this;
  }
  close(): void { this.stopped = true; this.reset(); }

  private async reserve(payload: unknown): Promise<void> {
    this.reset();
    const generation = this.generation;
    try {
      const response = await fetch(`${this.origin}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload ?? {}), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error('Room creation failed');
      const reserved = await response.json() as { roomCode: string; sessionToken: string };
      if (this.stopped || generation !== this.generation) return;
      this.open({ event: 'reconnect_room', payload: reserved });
    } catch (error) {
      if (generation !== this.generation || this.stopped) return;
      this.dispatch('connect_error', error);
      this.dispatch('invalid_move', { reason: 'room_not_found' });
    }
  }
  private open(intent: Intent): void {
    this.reset();
    this.intent = intent;
    this.dial();
  }
  private dial(): void {
    if (this.stopped || !this.intent) return;
    const generation = this.generation;
    const url = new URL(`/api/rooms/${this.intent.payload.roomCode}/ws`, this.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url.toString());
    this.ws = ws;
    const current = () => !this.stopped && generation === this.generation && this.ws === ws;
    const opening = setTimeout(() => { if (current()) ws.close(4000, 'Connection timed out'); }, 10_000);
    ws.onopen = () => {
      clearTimeout(opening);
      if (!current() || !this.intent) { ws.close(); return; }
      this.send(this.intent.event, this.intent.payload);
      this.heartbeat = setInterval(() => {
        if (!current()) return;
        ws.send('ping');
        this.pongTimeout = setTimeout(() => { if (current()) ws.close(4000, 'Heartbeat timed out'); }, 10_000);
      }, 20_000);
    };
    ws.onmessage = (message) => {
      if (!current()) return;
      if (message.data === 'pong') { clearTimeout(this.pongTimeout); return; }
      let data: { event: keyof Incoming; payload: unknown };
      try { data = JSON.parse(String(message.data)); } catch { return; }
      if (data.event === 'room_joined') {
        const joined = data.payload as RoomJoinedPayload;
        this.intent = { event: 'reconnect_room', payload: { roomCode: joined.room.roomCode, sessionToken: joined.sessionToken } };
        this.attempt = 0;
        // Update the app's connection state without asking it to authenticate a second time.
        this.dispatch('room_joined', joined);
        return;
      }
      if (data.event === 'invalid_move' && (data.payload as { reason: string }).reason === 'room_not_found') this.intent = null;
      this.dispatch(data.event, data.payload);
    };
    ws.onerror = () => { if (current()) this.dispatch('connect_error', new Error('WebSocket unavailable')); };
    ws.onclose = (event) => {
      clearTimeout(opening);
      if (!current()) return;
      clearInterval(this.heartbeat); clearTimeout(this.pongTimeout);
      this.ws = null;
      this.dispatch('disconnect');
      if (event.code === 4001) {
        this.intent = null;
        this.dispatch('connect_error', new Error('別の画面で対局が再開されました。'));
        return;
      }
      if ([1000, 1008, 4004].includes(event.code)) {
        this.intent = null;
        this.dispatch('invalid_move', { reason: 'room_not_found' });
        return;
      }
      if (this.intent) {
        this.reconnectListener();
        const delay = Math.min(500 * 2 ** this.attempt++, 5000);
        this.retry = setTimeout(() => this.dial(), delay);
      }
    };
  }
  private reset(): void {
    this.generation++;
    clearTimeout(this.retry); clearInterval(this.heartbeat); clearTimeout(this.pongTimeout);
    const old = this.ws;
    this.ws = null; this.intent = null; this.attempt = 0;
    old?.close();
  }
  private send(event: string, payload: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ event, payload }));
    return true;
  }
  private dispatch(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args as never[]);
  }
}
