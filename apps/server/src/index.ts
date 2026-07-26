import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from '@fuwa-hitsuji/shared';
import { RoomManager, type RoomEvent, type RoomManagerOptions } from './room-manager.js';

type MancalaSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

export interface AppServer {
  app: express.Express;
  httpServer: ReturnType<typeof createServer>;
  io: SocketIOServer<ClientToServerEvents, ServerToClientEvents>;
  roomManager: RoomManager;
}

export function createAppServer(
  inviteBaseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:5173',
  roomManagerOptions: Pick<RoomManagerOptions, 'reconnectWindowMs' | 'startingPlayerPicker'> = {},
): AppServer {
  const app = express();
  const httpServer = createServer(app);
  const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: true, credentials: true },
  });
  const roomManager = new RoomManager({
    inviteBaseUrl,
    ...roomManagerOptions,
    onEvent: (event) => dispatchRoomEvent(io, event),
  });

  app.get('/health', (_request, response) => {
    response.json({ ok: true });
  });

  const webDist = [
    process.env.WEB_DIST_PATH,
    resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist'),
    resolve(process.cwd(), 'apps/web/dist'),
    resolve(process.cwd(), '../web/dist'),
  ].find((candidate): candidate is string => candidate !== undefined && existsSync(resolve(candidate, 'index.html')));
  if (webDist !== undefined) {
    app.use(express.static(webDist));
    app.get('*', (_request, response) => {
      response.sendFile(resolve(webDist, 'index.html'));
    });
  } else {
    console.error('Web build was not found. Run the web workspace build before starting the server.');
  }

  io.on('connection', (socket) => registerSocketHandlers(socket, roomManager));
  return { app, httpServer, io, roomManager };
}

function registerSocketHandlers(socket: MancalaSocket, roomManager: RoomManager): void {
  socket.on('create_room', (payload, acknowledge) => {
    leaveExistingRoom(socket, roomManager);
    const joined = roomManager.createRoom(socket.id, payload);
    socket.join(joined.room.roomCode);
    socket.emit('room_joined', joined);
    acknowledge?.(joined);
  });

  socket.on('join_room', (payload, acknowledge) => {
    leaveExistingRoom(socket, roomManager);
    const roomCode = payload.roomCode.trim();
    socket.join(roomCode);
    let roomJoined = false;
    const joined = roomManager.joinRoom(socket.id, payload, (result) => {
      roomJoined = true;
      socket.emit('room_joined', result);
      acknowledge?.(result);
    });
    if (joined === null) {
      socket.leave(roomCode);
      socket.emit('invalid_move', { reason: 'room_not_found' });
      return;
    }
    if (!roomJoined) {
      socket.emit('room_joined', joined);
      acknowledge?.(joined);
    }
  });

  socket.on('reconnect_room', (payload, acknowledge) => {
    leaveExistingRoom(socket, roomManager);
    const roomCode = payload.roomCode.trim();
    socket.join(roomCode);
    let roomJoined = false;
    const joined = roomManager.reconnectRoom(socket.id, payload, (result) => {
      roomJoined = true;
      socket.emit('room_joined', result);
      acknowledge?.(result);
    });
    if (joined === null) {
      socket.leave(roomCode);
      socket.emit('invalid_move', { reason: 'room_not_found' });
      return;
    }
    if (!roomJoined) {
      socket.emit('room_joined', joined);
      acknowledge?.(joined);
    }
  });

  socket.on('make_move', (payload) => {
    const invalid = roomManager.makeMove(socket.id, payload.pitIndex, payload.revision, payload.moveId);
    if (invalid !== null) {
      socket.emit('invalid_move', invalid);
    }
  });

  socket.on('rematch_request', () => {
    const invalid = roomManager.requestRematch(socket.id);
    if (invalid !== null) {
      socket.emit('invalid_move', invalid);
    }
  });

  socket.on('leave_room', () => {
    const roomCode = roomManager.getRoomCodeForSocket(socket.id);
    roomManager.leaveRoom(socket.id);
    if (roomCode !== null) {
      socket.leave(roomCode);
    }
  });

  socket.on('disconnect', () => roomManager.disconnect(socket.id));
}

function leaveExistingRoom(socket: MancalaSocket, roomManager: RoomManager): void {
  const roomCode = roomManager.getRoomCodeForSocket(socket.id);
  if (roomCode === null) {
    return;
  }
  roomManager.leaveRoom(socket.id);
  socket.leave(roomCode);
}

function dispatchRoomEvent(
  io: SocketIOServer<ClientToServerEvents, ServerToClientEvents>,
  event: RoomEvent,
): void {
  switch (event.event) {
    case 'start_game':
      io.to(event.roomCode).emit('start_game', event.payload);
      return;
    case 'state_update':
      io.to(event.roomCode).emit('state_update', event.payload);
      return;
    case 'game_finished':
      io.to(event.roomCode).emit('game_finished', event.payload);
      return;
    case 'rematch_request':
      io.to(event.roomCode).emit('rematch_request', event.payload);
      return;
    case 'rematch_start':
      io.to(event.roomCode).emit('rematch_start', event.payload);
      return;
    case 'player_disconnected':
      io.to(event.roomCode).emit('player_disconnected', event.payload);
      return;
    case 'player_reconnected':
      io.to(event.roomCode).emit('player_reconnected', event.payload);
  }
}

if (process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT ?? 3000);
  const { httpServer } = createAppServer();
  httpServer.listen(port, () => {
    console.log(`Mancala server is listening on port ${port}`);
  });
}
