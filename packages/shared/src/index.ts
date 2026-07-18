export type PlayerIndex = 0 | 1;

export type GameStatus = 'playing' | 'finished';

export type Winner = PlayerIndex | 'draw' | null;

export type BoardPits = [
  [number, number, number, number, number, number],
  [number, number, number, number, number, number],
];

export interface GameState {
  pits: BoardPits;
  stores: [number, number];
  currentPlayer: PlayerIndex;
  status: GameStatus;
  winner: Winner;
}

export interface PickupStep {
  type: 'pickup';
  player: PlayerIndex;
  pit: number;
  stones: number;
}

export type SowTarget =
  | { kind: 'pit'; player: PlayerIndex; pit: number }
  | { kind: 'store'; player: PlayerIndex };

export interface SowStep {
  type: 'sow';
  target: SowTarget;
  stoneNumber: number;
}

export interface CaptureStep {
  type: 'capture';
  player: PlayerIndex;
  pit: number;
  oppositePit: number;
  stones: number;
}

export interface CollectStep {
  type: 'collect';
  player: PlayerIndex;
  stones: number;
}

export interface FinishStep {
  type: 'finish';
  scores: [number, number];
  winner: Winner;
}

export type MoveStep = PickupStep | SowStep | CaptureStep | CollectStep | FinishStep;

export interface GameMoveResult {
  state: GameState;
  steps: MoveStep[];
  extraTurn: boolean;
  captured: number;
  collected: [number, number];
  ended: boolean;
}

export type RoomStatus = 'waiting' | 'playing' | 'finished';

export interface PublicPlayer {
  index: PlayerIndex;
  name: string;
  connected: boolean;
}

export interface RoomPublicState {
  roomCode: string;
  status: RoomStatus;
  players: [PublicPlayer | null, PublicPlayer | null];
  game: GameState | null;
  revision: number;
  round: number;
  rematchRequestedBy: PlayerIndex[];
}

export interface CreateRoomPayload {
  playerName?: string;
}

export interface JoinRoomPayload {
  roomCode: string;
  playerName?: string;
}

export interface ReconnectRoomPayload {
  roomCode: string;
  sessionToken: string;
}

export interface MakeMovePayload {
  pitIndex: number;
  revision: number;
  moveId: string;
}

export interface LeaveRoomPayload {
  roomCode: string;
}

export interface RoomJoinedPayload {
  room: RoomPublicState;
  playerIndex: PlayerIndex;
  sessionToken: string;
  inviteUrl: string;
}

export interface StateUpdatePayload {
  state: RoomPublicState;
  moveResult?: GameMoveResult;
}

export interface InvalidMovePayload {
  reason:
    | 'room_not_found'
    | 'not_a_player'
    | 'player_disconnected'
    | 'game_not_started'
    | 'game_finished'
    | 'not_your_turn'
    | 'stale_revision'
    | 'duplicate_move'
    | 'invalid_pit';
  state?: RoomPublicState;
}

export interface PlayerConnectionPayload {
  playerIndex: PlayerIndex;
  state: RoomPublicState;
}

export interface RematchRequestPayload {
  playerIndex: PlayerIndex;
  requestedBy: PlayerIndex[];
}

export interface ServerToClientEvents {
  room_joined: (payload: RoomJoinedPayload) => void;
  start_game: (payload: StateUpdatePayload) => void;
  state_update: (payload: StateUpdatePayload) => void;
  game_finished: (payload: StateUpdatePayload) => void;
  invalid_move: (payload: InvalidMovePayload) => void;
  rematch_request: (payload: RematchRequestPayload) => void;
  rematch_start: (payload: StateUpdatePayload) => void;
  player_disconnected: (payload: PlayerConnectionPayload) => void;
  player_reconnected: (payload: PlayerConnectionPayload) => void;
}

export type Acknowledge<T> = (response: T) => void;

export interface ClientToServerEvents {
  create_room: (payload: CreateRoomPayload, acknowledge?: Acknowledge<RoomJoinedPayload>) => void;
  join_room: (payload: JoinRoomPayload, acknowledge?: Acknowledge<RoomJoinedPayload>) => void;
  reconnect_room: (payload: ReconnectRoomPayload, acknowledge?: Acknowledge<RoomJoinedPayload>) => void;
  make_move: (payload: MakeMovePayload) => void;
  rematch_request: () => void;
  leave_room: (payload?: LeaveRoomPayload) => void;
}
