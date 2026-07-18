import type {
  BoardPits,
  GameMoveResult,
  GameState,
  MoveStep,
  PlayerIndex,
  Winner,
} from '@fuwa-hitsuji/shared';

/** UI・通信から独立した、標準カラハ（6穴、各4石）のルール実装。 */
export const PIT_COUNT = 6;
export const INITIAL_STONES_PER_PIT = 4;
export const TOTAL_STONES = PIT_COUNT * INITIAL_STONES_PER_PIT * 2;

export type Player = PlayerIndex;
export type PitIndex = 0 | 1 | 2 | 3 | 4 | 5;
export type PitRow = BoardPits[0];
export type Board = Pick<GameState, 'pits' | 'stores'>;
export type { GameState } from '@fuwa-hitsuji/shared';

export interface PitTarget {
  kind: 'pit';
  player: Player;
  pit: PitIndex;
}

export interface StoreTarget {
  kind: 'store';
  player: Player;
}

export type Target = PitTarget | StoreTarget;

export type AnimationStep = MoveStep;

export type InvalidMoveReason = 'game-finished' | 'not-your-turn' | 'pit-out-of-range' | 'empty-pit';

export type MoveResult = GameMoveResult & {
  accepted: boolean;
  steps: AnimationStep[];
  collected: [number, number];
  ended: boolean;
  reason?: InvalidMoveReason;
};

type RingTarget = PitTarget | StoreTarget;
const OTHER_PLAYER: Record<Player, Player> = { 0: 1, 1: 0 };

export function createInitialGameState(startingPlayer: Player = 0): GameState {
  return {
    pits: [
      [4, 4, 4, 4, 4, 4],
      [4, 4, 4, 4, 4, 4],
    ],
    stores: [0, 0],
    currentPlayer: startingPlayer,
    status: 'playing',
    winner: null,
  };
}

/** createInitialGameState の後方互換エイリアス。 */
export const createInitialState = createInitialGameState;

export function cloneState(state: GameState): GameState {
  return {
    ...state,
    pits: [[...state.pits[0]] as PitRow, [...state.pits[1]] as PitRow],
    stores: [...state.stores] as [number, number],
  };
}

export function totalStones(board: Board): number {
  return board.stores[0] + board.stores[1]
    + board.pits[0].reduce((sum, stones) => sum + stones, 0)
    + board.pits[1].reduce((sum, stones) => sum + stones, 0);
}

export function isGameOver(board: Board): boolean {
  return board.pits[0].every((stones) => stones === 0)
    || board.pits[1].every((stones) => stones === 0);
}

/**
 * 指定プレイヤーの一手を解決する。player が現在手番でなければ状態を変えず拒否する。
 */
export function applyMove(state: GameState, player: Player, pit: number): MoveResult {
  if (state.status === 'finished') return invalid(state, 'game-finished');
  if (player !== state.currentPlayer) return invalid(state, 'not-your-turn');
  if (!isPitIndex(pit)) return invalid(state, 'pit-out-of-range');
  if (state.pits[player][pit] === 0) return invalid(state, 'empty-pit');

  const next = cloneState(state);
  const stonesToSow = next.pits[player][pit];
  const steps: AnimationStep[] = [{ type: 'pickup', player, pit, stones: stonesToSow }];
  next.pits[player][pit] = 0;

  const ring = makeRing(player);
  let ringIndex = ring.findIndex((target) => target.kind === 'pit' && target.player === player && target.pit === pit);
  if (ringIndex < 0) throw new Error('Selected pit is missing from the sowing ring.');

  let lastTarget: RingTarget | undefined;
  for (let stoneNumber = 1; stoneNumber <= stonesToSow; stoneNumber += 1) {
    do {
      ringIndex = (ringIndex + 1) % ring.length;
    } while (isOpponentStore(ring[ringIndex], player));

    const target = ring[ringIndex];
    if (target === undefined) throw new Error('Sowing ring unexpectedly has no target.');
    addStone(next, target);
    steps.push({ type: 'sow', target: copyTarget(target), stoneNumber });
    lastTarget = target;
  }

  let captured = 0;
  if (lastTarget?.kind === 'pit'
    && lastTarget.player === player
    && next.pits[player][lastTarget.pit] === 1) {
    const oppositePit = oppositeOf(lastTarget.pit);
    const oppositeStones = next.pits[OTHER_PLAYER[player]][oppositePit];
    if (oppositeStones > 0) {
      captured = oppositeStones + 1;
      next.pits[player][lastTarget.pit] = 0;
      next.pits[OTHER_PLAYER[player]][oppositePit] = 0;
      next.stores[player] += captured;
      steps.push({ type: 'capture', player, pit: lastTarget.pit, stones: captured, oppositePit });
    }
  }

  let collected: [number, number] = [0, 0];
  const ended = isGameOver(next);
  if (ended) {
    collected = collectRemaining(next, steps);
    next.status = 'finished';
    next.winner = winnerFor(next.stores);
    steps.push({ type: 'finish', winner: next.winner, scores: [...next.stores] as [number, number] });
  }

  const extraTurn = !ended && lastTarget?.kind === 'store' && lastTarget.player === player;
  next.currentPlayer = extraTurn ? player : OTHER_PLAYER[player];
  assertConservedStones(next);
  return { accepted: true, state: next, steps, extraTurn, captured, collected, ended };
}

function invalid(state: GameState, reason: InvalidMoveReason): MoveResult {
  return { accepted: false, state, steps: [], reason, extraTurn: false, captured: 0, collected: [0, 0], ended: false };
}

function makeRing(player: Player): RingTarget[] {
  const opponent = OTHER_PLAYER[player];
  const ownPits = [0, 1, 2, 3, 4, 5].map((pit) => ({ kind: 'pit' as const, player, pit: pit as PitIndex }));
  const opponentPits = [5, 4, 3, 2, 1, 0].map((pit) => ({ kind: 'pit' as const, player: opponent, pit: pit as PitIndex }));
  return [...ownPits, { kind: 'store', player }, ...opponentPits, { kind: 'store', player: opponent }];
}

function addStone(board: Board, target: RingTarget): void {
  if (target.kind === 'store') board.stores[target.player] += 1;
  else board.pits[target.player][target.pit] += 1;
}

function copyTarget(target: RingTarget): Target {
  return target.kind === 'store'
    ? { kind: 'store', player: target.player }
    : { kind: 'pit', player: target.player, pit: target.pit };
}

function collectRemaining(board: Board, steps: AnimationStep[]): [number, number] {
  const collected: [number, number] = [0, 0];
  for (const player of [0, 1] as const) {
    const stones = board.pits[player].reduce((sum, pitStones) => sum + pitStones, 0);
    if (stones > 0) {
      board.pits[player] = [0, 0, 0, 0, 0, 0];
      board.stores[player] += stones;
      collected[player] = stones;
      steps.push({ type: 'collect', player, stones });
    }
  }
  return collected;
}

function winnerFor(stores: [number, number]): Winner {
  if (stores[0] === stores[1]) return 'draw';
  return stores[0] > stores[1] ? 0 : 1;
}

function oppositeOf(pit: PitIndex): PitIndex {
  return (PIT_COUNT - 1 - pit) as PitIndex;
}

function isPitIndex(value: number): value is PitIndex {
  return Number.isInteger(value) && value >= 0 && value < PIT_COUNT;
}

function isOpponentStore(target: RingTarget | undefined, player: Player): boolean {
  return target?.kind === 'store' && target.player !== player;
}

function assertConservedStones(board: Board): void {
  const stones = totalStones(board);
  if (stones !== TOTAL_STONES) throw new Error(`Stone conservation violated: expected ${TOTAL_STONES}, got ${stones}.`);
}
