import { describe, expect, it } from 'vitest';
import { TOTAL_STONES, applyMove, createInitialGameState, totalStones } from '../src/index.js';
import type { GameState } from '../src/index.js';

const state = (
  pits0: [number, number, number, number, number, number],
  pits1: [number, number, number, number, number, number],
  stores: [number, number],
  currentPlayer: 0 | 1 = 0,
): GameState => ({ pits: [pits0, pits1], stores, currentPlayer, status: 'playing', winner: null });

describe('カラハの初期状態', () => {
  it('各6穴に4石、ストア0石、合計48石で開始する', () => {
    const initial = createInitialGameState();
    expect(initial.pits).toEqual([[4, 4, 4, 4, 4, 4], [4, 4, 4, 4, 4, 4]]);
    expect(initial.stores).toEqual([0, 0]);
    expect(initial.currentPlayer).toBe(0);
    expect(totalStones(initial)).toBe(TOTAL_STONES);
  });
});

describe('石まき', () => {
  it.each([0, 1] as const)('両プレイヤーの全6穴は初期状態で選択可能', (player) => {
    for (const pit of [0, 1, 2, 3, 4, 5]) {
      const result = applyMove(createInitialGameState(player), player, pit);
      expect(result.accepted).toBe(true);
      expect(totalStones(result.state)).toBe(TOTAL_STONES);
    }
  });

  it('通常手は選択穴を空にし、次の穴へ1石ずつ配り、手番を渡す', () => {
    const result = applyMove(createInitialGameState(), 0, 0);
    expect(result.accepted).toBe(true);
    expect(result.state.pits).toEqual([[0, 5, 5, 5, 5, 4], [4, 4, 4, 4, 4, 4]]);
    expect(result.state.currentPlayer).toBe(1);
    expect(result.steps.map((step) => step.type)).toEqual(['pickup', 'sow', 'sow', 'sow', 'sow']);
    expect(totalStones(result.state)).toBe(TOTAL_STONES);
  });

  it('最後の石が自分のストアなら追加ターンとなる', () => {
    const result = applyMove(state([1, 0, 0, 0, 0, 1], [1, 0, 0, 0, 0, 0], [22, 23]), 0, 5);
    expect(result.accepted).toBe(true);
    expect(result.state.stores).toEqual([23, 23]);
    expect(result.extraTurn).toBe(true);
    expect(result.state.currentPlayer).toBe(0);
  });

  it('相手ストアは必ず飛ばし、周回しても石の合計を保つ', () => {
    const result = applyMove(state([14, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [10, 24]), 0, 0);
    expect(result.accepted).toBe(true);
    expect(result.state.stores[1]).toBe(24);
    expect(result.steps.filter((step) => step.type === 'sow')).toHaveLength(14);
    expect(totalStones(result.state)).toBe(TOTAL_STONES);
  });
});

describe('獲得と終了処理', () => {
  it('自分側の空穴への最後の1石は向かいの石とともに獲得する', () => {
    const result = applyMove(state([0, 1, 0, 0, 0, 0], [0, 0, 0, 5, 0, 0], [20, 22]), 0, 1);
    expect(result.accepted).toBe(true);
    expect(result.captured).toBe(6);
    expect(result.state.pits[0][2]).toBe(0);
    expect(result.state.pits[1][3]).toBe(0);
    expect(result.state.stores[0]).toBe(26);
    expect(result.steps.some((step) => step.type === 'capture')).toBe(true);
    expect(totalStones(result.state)).toBe(TOTAL_STONES);
  });

  it('向かいの穴が空なら、最後の1石は獲得しない', () => {
    const result = applyMove(state([0, 1, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [23, 24]), 0, 1);
    expect(result.accepted).toBe(true);
    expect(result.captured).toBe(0);
    expect(result.state.stores).toEqual([24, 24]);
  });

  it('片側が空になったら残りをストアへ回収し、勝者を確定する', () => {
    const result = applyMove(state([0, 0, 0, 0, 0, 1], [2, 0, 0, 0, 0, 0], [21, 24]), 0, 5);
    expect(result.accepted).toBe(true);
    expect(result.ended).toBe(true);
    expect(result.state.status).toBe('finished');
    expect(result.state.pits).toEqual([[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]]);
    expect(result.state.stores).toEqual([22, 26]);
    expect(result.collected).toEqual([0, 2]);
    expect(result.state.winner).toBe(1);
    expect(result.steps.at(-1)).toMatchObject({ type: 'finish', winner: 1 });
    expect(totalStones(result.state)).toBe(TOTAL_STONES);
  });

  it('最終ストアが同数なら draw になる', () => {
    const result = applyMove(state([0, 0, 0, 0, 0, 1], [1, 0, 0, 0, 0, 0], [23, 23]), 0, 5);
    expect(result.accepted).toBe(true);
    expect(result.state.status).toBe('finished');
    expect(result.state.stores).toEqual([24, 24]);
    expect(result.state.winner).toBe('draw');
  });
});

describe('不正手と純粋性', () => {
  it.each([-1, 6, 1.5])('範囲外の穴 %s は状態を一切変えない', (pit) => {
    const before = createInitialGameState();
    const result = applyMove(before, 0, pit);
    expect(result).toMatchObject({ accepted: false, reason: 'pit-out-of-range' });
    expect(result.state).toBe(before);
    expect(result.steps).toEqual([]);
  });

  it('手番外のプレイヤー、空の穴、終了済みの対局を拒否する', () => {
    const before = createInitialGameState();
    expect(applyMove(before, 1, 0)).toMatchObject({ accepted: false, reason: 'not-your-turn', state: before });
    const empty = state([0, 4, 4, 4, 4, 4], [4, 4, 4, 4, 4, 4], [4, 0]);
    expect(applyMove(empty, 0, 0)).toMatchObject({ accepted: false, reason: 'empty-pit', state: empty });
    const finished = { ...before, status: 'finished' as const, winner: 0 as const };
    expect(applyMove(finished, 0, 0)).toMatchObject({ accepted: false, reason: 'game-finished', state: finished });
  });

  it('有効手も入力状態を変更せず、常に48石を保つ', () => {
    const before = createInitialGameState();
    const snapshot = structuredClone(before);
    const result = applyMove(before, 0, 2);
    expect(before).toEqual(snapshot);
    expect(result.state).not.toBe(before);
    expect(totalStones(result.state)).toBe(TOTAL_STONES);
  });
});
