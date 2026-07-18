import type { BoardPits, MoveStep, PlayerIndex, RoomPublicState } from '@fuwa-hitsuji/shared';

export type AppScreen = 'home' | 'join' | 'rules' | 'waiting' | 'game' | 'result';
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export type Board = { pits: BoardPits; stores: [number, number] };
export type RoomSnapshot = RoomPublicState;
export const demoBoard: Board = { pits: [[4, 4, 4, 4, 4, 4], [4, 4, 4, 4, 4, 4]], stores: [0, 0] };

export function canPickPit(state: RoomSnapshot | null, myPlayer: PlayerIndex | null, index: number, locked: boolean) {
  return Boolean(state?.game && myPlayer !== null && state.status === 'playing' && state.game.currentPlayer === myPlayer && state.game.pits[myPlayer][index] > 0 && !locked);
}

export function copyBoard(board: Board): Board {
  return { pits: [[...board.pits[0]], [...board.pits[1]]], stores: [...board.stores] as [number, number] };
}

/** Applies the same incremental board changes described by the server's MoveStep. */
export function applyVisualStep(board: Board, step: MoveStep): Board {
  const next = copyBoard(board);

  switch (step.type) {
    case 'pickup':
      next.pits[step.player][step.pit] = 0;
      break;
    case 'sow':
      if (step.target.kind === 'store') next.stores[step.target.player] += 1;
      else next.pits[step.target.player][step.target.pit] += 1;
      break;
    case 'capture':
      next.pits[step.player][step.pit] = 0;
      next.pits[step.player === 0 ? 1 : 0][step.oppositePit] = 0;
      next.stores[step.player] += step.stones;
      break;
    case 'collect':
      next.pits[step.player] = [0, 0, 0, 0, 0, 0];
      next.stores[step.player] += step.stones;
      break;
    case 'finish':
      break;
  }

  return next;
}
