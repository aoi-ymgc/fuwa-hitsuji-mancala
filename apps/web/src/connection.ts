import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@fuwa-hitsuji/shared';
import { NativeConnection } from './native-connection';

export type Incoming = ServerToClientEvents & { connect: () => void; disconnect: () => void; connect_error: (error: Error) => void };
export interface GameConnection {
  on<E extends keyof Incoming>(event: E, listener: Incoming[E]): GameConnection;
  emit<E extends keyof ClientToServerEvents>(event: E, ...args: Parameters<ClientToServerEvents[E]>): GameConnection;
  io: { on(event: 'reconnect_attempt', listener: () => void): unknown };
  connect(): void;
  close(): void;
}
export function createConnection(token: string): GameConnection {
  if (import.meta.env.VITE_TRANSPORT === 'native') return new NativeConnection(window.location.origin);
  const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(import.meta.env.VITE_SOCKET_URL ?? window.location.origin, { autoConnect: false, auth: { token } });
  // Socket.IO's conditional listener types are more restrictive than this shared boundary.
  return socket as unknown as GameConnection;
}
