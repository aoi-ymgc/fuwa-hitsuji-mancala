import { randomBytes, randomInt } from 'node:crypto';
import {
  applyMove,
  createInitialGameState,
} from '@fuwa-hitsuji/game-core';
import type {
  CreateRoomPayload,
  GameMoveResult,
  GameState,
  InvalidMovePayload,
  JoinRoomPayload,
  PlayerConnectionPayload,
  PlayerIndex,
  PublicPlayer,
  ReconnectRoomPayload,
  RematchRequestPayload,
  RoomJoinedPayload,
  RoomPublicState,
  RoomStatus,
  StateUpdatePayload,
} from '@fuwa-hitsuji/shared';

const RECONNECT_WINDOW_MS = 90_000;
const ROOM_CODE_MAX = 1_000_000;

interface PlayerSession {
  index: PlayerIndex;
  name: string;
  token: string;
  socketId: string | null;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
}

interface Room {
  code: string;
  players: [PlayerSession | null, PlayerSession | null];
  status: RoomStatus;
  game: GameState | null;
  revision: number;
  round: number;
  startingPlayer: PlayerIndex;
  rematchRequestedBy: Set<PlayerIndex>;
  processedMoveIds: Set<string>;
}

interface SocketBinding {
  roomCode: string;
  playerIndex: PlayerIndex;
}

export type RoomEvent =
  | { event: 'start_game'; roomCode: string; payload: StateUpdatePayload }
  | { event: 'state_update'; roomCode: string; payload: StateUpdatePayload }
  | { event: 'game_finished'; roomCode: string; payload: StateUpdatePayload }
  | { event: 'rematch_request'; roomCode: string; payload: RematchRequestPayload }
  | { event: 'rematch_start'; roomCode: string; payload: StateUpdatePayload }
  | { event: 'player_disconnected'; roomCode: string; payload: PlayerConnectionPayload }
  | { event: 'player_reconnected'; roomCode: string; payload: PlayerConnectionPayload };

export interface RoomManagerOptions {
  onEvent?: (event: RoomEvent) => void;
  inviteBaseUrl?: string;
  reconnectWindowMs?: number;
  /** Used by tests to make the first player deterministic. */
  startingPlayerPicker?: () => PlayerIndex;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly socketBindings = new Map<string, SocketBinding>();
  private readonly onEvent: (event: RoomEvent) => void;
  private readonly inviteBaseUrl: string;
  private readonly reconnectWindowMs: number;
  private readonly startingPlayerPicker: () => PlayerIndex;

  public constructor(options: RoomManagerOptions = {}) {
    this.onEvent = options.onEvent ?? (() => undefined);
    this.inviteBaseUrl = options.inviteBaseUrl ?? 'http://localhost:5173';
    this.reconnectWindowMs = options.reconnectWindowMs ?? RECONNECT_WINDOW_MS;
    this.startingPlayerPicker = options.startingPlayerPicker ?? (() => randomInt(2) as PlayerIndex);
  }

  public createRoom(socketId: string, payload: CreateRoomPayload): RoomJoinedPayload {
    const code = this.createRoomCode();
    const player = this.createPlayer(0, payload.playerName);
    const room: Room = {
      code,
      players: [player, null],
      status: 'waiting',
      game: null,
      revision: 0,
      round: 0,
      startingPlayer: this.startingPlayerPicker(),
      rematchRequestedBy: new Set<PlayerIndex>(),
      processedMoveIds: new Set<string>(),
    };

    this.rooms.set(code, room);
    return this.bindPlayer(room, player, socketId);
  }

  public joinRoom(
    socketId: string,
    payload: JoinRoomPayload,
    onJoined?: (joined: RoomJoinedPayload) => void,
  ): RoomJoinedPayload | null {
    const room = this.rooms.get(this.normalizeCode(payload.roomCode));
    if (room === undefined) {
      return null;
    }

    const playerIndex = room.players.findIndex((player) => player === null);
    if (playerIndex === -1) {
      return null;
    }
    const player = this.createPlayer(playerIndex as PlayerIndex, payload.playerName);
    room.players[player.index] = player;
    const joined = this.bindPlayer(room, player, socketId);
    onJoined?.(joined);
    if (room.players[0] !== null && room.players[1] !== null) {
      this.startGame(room, 'start_game');
    }
    return joined;
  }

  public reconnectRoom(
    socketId: string,
    payload: ReconnectRoomPayload,
    onJoined?: (joined: RoomJoinedPayload) => void,
  ): RoomJoinedPayload | null {
    const room = this.rooms.get(this.normalizeCode(payload.roomCode));
    if (room === undefined) {
      return null;
    }

    const player = room.players.find((candidate) => candidate?.token === payload.sessionToken);
    if (player === undefined || player === null) {
      return null;
    }

    if (player.disconnectTimer !== null) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }
    if (player.socketId !== null) {
      this.socketBindings.delete(player.socketId);
    }
    const joined = this.bindPlayer(room, player, socketId);
    onJoined?.(joined);
    const connection: PlayerConnectionPayload = {
      playerIndex: player.index,
      state: this.toPublicState(room),
    };
    this.emit({ event: 'player_reconnected', roomCode: room.code, payload: connection });
    return joined;
  }

  public makeMove(socketId: string, pitIndex: number, revision: number, moveId: string): InvalidMovePayload | null {
    const binding = this.socketBindings.get(socketId);
    const room = binding === undefined ? undefined : this.rooms.get(binding.roomCode);
    if (binding === undefined || room === undefined) {
      return { reason: 'not_a_player' };
    }
    if (room.players.some((player) => player === null || player.socketId === null)) {
      return this.invalid(room, 'player_disconnected');
    }
    if (room.status === 'waiting' || room.game === null) {
      return this.invalid(room, 'game_not_started');
    }
    if (room.status === 'finished') {
      return this.invalid(room, 'game_finished');
    }
    if (!this.isMoveId(moveId) || room.processedMoveIds.has(moveId)) {
      return this.invalid(room, 'duplicate_move');
    }
    if (room.revision !== revision) {
      return this.invalid(room, 'stale_revision');
    }
    if (!Number.isInteger(pitIndex) || pitIndex < 0 || pitIndex > 5) {
      return this.invalid(room, 'invalid_pit');
    }

    let result: GameMoveResult;
    try {
      const move = applyMove(room.game, binding.playerIndex, pitIndex);
      if (!move.accepted) {
        return this.invalid(room, this.toInvalidMoveReason(move.reason));
      }
      result = move;
    } catch {
      return this.invalid(room, 'invalid_pit');
    }

    room.game = result.state;
    room.status = result.state.status === 'finished' ? 'finished' : 'playing';
    room.revision += 1;
    room.processedMoveIds.add(moveId);
    const payload: StateUpdatePayload = {
      state: this.toPublicState(room),
      moveResult: result,
    };
    this.emit({ event: 'state_update', roomCode: room.code, payload });
    if (result.ended) {
      this.emit({ event: 'game_finished', roomCode: room.code, payload });
    }
    return null;
  }

  public requestRematch(socketId: string): InvalidMovePayload | null {
    const binding = this.socketBindings.get(socketId);
    const room = binding === undefined ? undefined : this.rooms.get(binding.roomCode);
    if (binding === undefined || room === undefined) {
      return { reason: 'not_a_player' };
    }
    if (room.status !== 'finished') {
      return this.invalid(room, 'game_not_started');
    }

    room.rematchRequestedBy.add(binding.playerIndex);
    this.emit({
      event: 'rematch_request',
      roomCode: room.code,
      payload: {
        playerIndex: binding.playerIndex,
        requestedBy: this.rematchPlayers(room),
      },
    });

    if (room.rematchRequestedBy.size === 2 && room.players[0] !== null && room.players[1] !== null) {
      room.startingPlayer = room.startingPlayer === 0 ? 1 : 0;
      this.startGame(room, 'rematch_start');
    }
    return null;
  }

  public disconnect(socketId: string): void {
    const binding = this.socketBindings.get(socketId);
    if (binding === undefined) {
      return;
    }
    this.socketBindings.delete(socketId);
    const room = this.rooms.get(binding.roomCode);
    const player = room?.players[binding.playerIndex];
    if (room === undefined || player === null || player === undefined || player.socketId !== socketId) {
      return;
    }

    player.socketId = null;
    player.disconnectTimer = setTimeout(() => this.expirePlayer(room.code, player.index), this.reconnectWindowMs);
    this.emit({
      event: 'player_disconnected',
      roomCode: room.code,
      payload: { playerIndex: player.index, state: this.toPublicState(room) },
    });
  }

  public leaveRoom(socketId: string): void {
    const binding = this.socketBindings.get(socketId);
    if (binding === undefined) {
      return;
    }
    this.socketBindings.delete(socketId);
    const room = this.rooms.get(binding.roomCode);
    if (room === undefined) {
      return;
    }
    const player = room.players[binding.playerIndex];
    if (player?.socketId === socketId) {
      player.socketId = null;
    }
    this.removePlayer(room, binding.playerIndex);
  }

  public getRoomCodeForSocket(socketId: string): string | null {
    return this.socketBindings.get(socketId)?.roomCode ?? null;
  }

  private startGame(room: Room, event: 'start_game' | 'rematch_start'): void {
    room.game = createInitialGameState(room.startingPlayer);
    room.status = 'playing';
    room.round += 1;
    room.revision += 1;
    room.rematchRequestedBy.clear();
    room.processedMoveIds.clear();
    this.emit({
      event,
      roomCode: room.code,
      payload: { state: this.toPublicState(room) },
    });
  }

  private bindPlayer(room: Room, player: PlayerSession, socketId: string): RoomJoinedPayload {
    player.socketId = socketId;
    this.socketBindings.set(socketId, { roomCode: room.code, playerIndex: player.index });
    return {
      room: this.toPublicState(room),
      playerIndex: player.index,
      sessionToken: player.token,
      inviteUrl: `${this.inviteBaseUrl.replace(/\/$/, '')}/?room=${room.code}`,
    };
  }

  private expirePlayer(roomCode: string, playerIndex: PlayerIndex): void {
    const room = this.rooms.get(roomCode);
    const player = room?.players[playerIndex];
    if (room === undefined || player === null || player === undefined || player.socketId !== null) {
      return;
    }
    this.removePlayer(room, playerIndex);
  }

  private removePlayer(room: Room, playerIndex: PlayerIndex): void {
    const player = room.players[playerIndex];
    if (player?.disconnectTimer !== null && player?.disconnectTimer !== undefined) {
      clearTimeout(player.disconnectTimer);
    }
    room.players[playerIndex] = null;

    if (room.players[0] === null && room.players[1] === null) {
      this.rooms.delete(room.code);
      return;
    }

    room.status = 'waiting';
    room.game = null;
    room.revision += 1;
    room.rematchRequestedBy.clear();
    room.processedMoveIds.clear();
    this.emit({
      event: 'player_disconnected',
      roomCode: room.code,
      payload: { playerIndex, state: this.toPublicState(room) },
    });
    this.emit({ event: 'state_update', roomCode: room.code, payload: { state: this.toPublicState(room) } });
  }

  private toPublicState(room: Room): RoomPublicState {
    return {
      roomCode: room.code,
      status: room.status,
      players: [this.toPublicPlayer(room.players[0]), this.toPublicPlayer(room.players[1])],
      game: room.game,
      revision: room.revision,
      round: room.round,
      rematchRequestedBy: this.rematchPlayers(room),
    };
  }

  private toPublicPlayer(player: PlayerSession | null): PublicPlayer | null {
    if (player === null) {
      return null;
    }
    return { index: player.index, name: player.name, connected: player.socketId !== null };
  }

  private rematchPlayers(room: Room): PlayerIndex[] {
    return [0, 1].filter((index): index is PlayerIndex => room.rematchRequestedBy.has(index as PlayerIndex));
  }

  private invalid(room: Room, reason: InvalidMovePayload['reason']): InvalidMovePayload {
    return { reason, state: this.toPublicState(room) };
  }

  private toInvalidMoveReason(
    reason: 'game-finished' | 'not-your-turn' | 'pit-out-of-range' | 'empty-pit' | undefined,
  ): InvalidMovePayload['reason'] {
    switch (reason) {
      case 'game-finished':
        return 'game_finished';
      case 'not-your-turn':
        return 'not_your_turn';
      case 'pit-out-of-range':
      case 'empty-pit':
      default:
        return 'invalid_pit';
    }
  }

  private createRoomCode(): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = randomInt(ROOM_CODE_MAX).toString().padStart(6, '0');
      if (!this.rooms.has(code)) {
        return code;
      }
    }
    throw new Error('Failed to allocate a room code');
  }

  private createPlayer(index: PlayerIndex, requestedName: string | undefined): PlayerSession {
    const name = requestedName?.trim().slice(0, 20) || `プレイヤー${index + 1}`;
    return {
      index,
      name,
      token: randomBytes(32).toString('base64url'),
      socketId: null,
      disconnectTimer: null,
    };
  }

  private normalizeCode(code: string): string {
    return code.trim();
  }

  private isMoveId(moveId: string): boolean {
    return /^[A-Za-z0-9_-]{8,128}$/.test(moveId);
  }

  private emit(event: RoomEvent): void {
    this.onEvent(event);
  }
}
