import { applyMove, createInitialGameState } from '@fuwa-hitsuji/game-core';
import type { GameState, InvalidMovePayload, PlayerIndex, RoomPublicState } from '@fuwa-hitsuji/shared';
import { RECONNECT_MS } from './protocol';

export interface Player {
  index: PlayerIndex;
  name: string;
  tokenHash: string;
  connectionId: string | null;
  expiresAt: number | null;
}
export interface Room {
  schema: 1;
  code: string;
  players: [Player | null, Player | null];
  game: GameState | null;
  revision: number;
  round: number;
  startingPlayer: PlayerIndex;
  rematchRequestedBy: PlayerIndex[];
  processedMoveIds: string[];
}
export function player(index: PlayerIndex, hash: string, requestedName: string | undefined, now: number): Player {
  return { index, name: requestedName?.trim().slice(0, 20) || `プレイヤー${index + 1}`, tokenHash: hash, connectionId: null, expiresAt: now + RECONNECT_MS };
}
export function createRoom(code: string, hash: string, requestedName: string | undefined, now: number): Room {
  return { schema: 1, code, players: [player(0, hash, requestedName, now), null], game: null, revision: 0, round: 0, startingPlayer: (crypto.getRandomValues(new Uint8Array(1))[0]! % 2) as PlayerIndex, rematchRequestedBy: [], processedMoveIds: [] };
}
export function publicState(room: Room): RoomPublicState {
  return { roomCode: room.code, status: room.game?.status ?? 'waiting', players: room.players.map(p => p && ({ index: p.index, name: p.name, connected: p.connectionId !== null })) as RoomPublicState['players'], game: room.game, revision: room.revision, round: room.round, rematchRequestedBy: [...room.rematchRequestedBy] };
}
export function start(room: Room): void {
  room.game = createInitialGameState(room.startingPlayer);
  room.round++;
  room.revision++;
  room.rematchRequestedBy = [];
  room.processedMoveIds = [];
}
export function remove(room: Room, index: PlayerIndex): void {
  room.players[index] = null;
  room.game = null;
  room.revision++;
  room.rematchRequestedBy = [];
  room.processedMoveIds = [];
}
export function move(room: Room, index: PlayerIndex, pit: number, revision: number, id: string) {
  const invalid = (reason: InvalidMovePayload['reason']) => ({ accepted: false as const, reason });
  if (room.players.some(p => !p || !p.connectionId)) return invalid('player_disconnected');
  if (!room.game) return invalid('game_not_started');
  if (room.game.status === 'finished') return invalid('game_finished');
  if (room.processedMoveIds.includes(id)) return invalid('duplicate_move');
  if (room.revision !== revision) return invalid('stale_revision');
  const result = applyMove(room.game, index, pit);
  if (!result.accepted) return invalid(result.reason === 'not-your-turn' ? 'not_your_turn' : 'invalid_pit');
  room.game = result.state;
  room.revision++;
  room.processedMoveIds.push(id);
  // Older replayed messages still fail their monotonic revision check.
  room.processedMoveIds = room.processedMoveIds.slice(-512);
  return { ...result, accepted: true as const };
}
