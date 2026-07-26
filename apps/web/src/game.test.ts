import { describe, expect, it } from 'vitest';
import type { MoveStep } from '@fuwa-hitsuji/shared';
import { applyVisualStep, canPickPit, demoBoard, phaseForRoom, screenForRoom, type Board } from './game';

const state = { roomCode: 'SHEEP', status: 'playing' as const, players: [null, null] as [null, null], game: { ...demoBoard, currentPlayer: 0 as const, status: 'playing' as const, winner: null }, revision: 0, round: 1, rematchRequestedBy: [] as (0 | 1)[] };

describe('canPickPit', () => {
  it('自分の手番に石がある穴だけを選べる', () => {
    expect(canPickPit(state, 0, 0, false)).toBe(true);
    expect(canPickPit(state, 1, 0, false)).toBe(false);
    expect(canPickPit({ ...state, game: { ...state.game, pits: [[0, 4, 4, 4, 4, 4], [4, 4, 4, 4, 4, 4]] } }, 0, 0, false)).toBe(false);
  });
});

describe('client presentation state', () => {
  it('手番と待機状態から操作フェーズを決める', () => {
    expect(phaseForRoom(state, 0)).toBe('idle');
    expect(phaseForRoom(state, 1)).toBe('waitingOpponent');
  });

  it('waiting の state_update は待機画面へ戻す', () => {
    expect(screenForRoom({ ...state, status: 'waiting', game: null })).toBe('waiting');
  });
});

describe('applyVisualStep', () => {
  it('server MoveStep と同じ順序で pickup・sow・capture・collect を盤面に反映する', () => {
    const steps: MoveStep[] = [
      { type: 'pickup', player: 0, pit: 2, stones: 1 },
      { type: 'sow', target: { kind: 'pit', player: 0, pit: 3 }, stoneNumber: 1 },
      { type: 'capture', player: 0, pit: 3, oppositePit: 2, stones: 6 },
      { type: 'collect', player: 1, stones: 4 },
      { type: 'finish', scores: [6, 4], winner: 0 },
    ];
    const initial: Board = { pits: [[0, 0, 1, 0, 0, 0], [0, 0, 4, 0, 0, 0]], stores: [0, 0] };

    const afterPickup = applyVisualStep(initial, steps[0]);
    expect(afterPickup.pits[0][2]).toBe(0);

    const final = steps.reduce(applyVisualStep, initial);
    expect(final).toEqual({ pits: [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]], stores: [6, 4] });
  });
});
