import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { io, type Socket } from 'socket.io-client';
import { QRCodeSVG } from 'qrcode.react';
import { create } from 'zustand';
import type { ClientToServerEvents, GameMoveResult, InvalidMovePayload, MoveStep, PlayerConnectionPayload, PlayerIndex, RoomJoinedPayload, ServerToClientEvents, SowTarget, StateUpdatePayload } from '@fuwa-hitsuji/shared';
import { ANIMATION_TIMING, prefersReducedMotion, stoneMoveDuration, waitForAnimation } from './animation';
import { applyVisualStep, canPickPit, copyBoard, phaseForRoom, screenForRoom, type AppScreen, type Board, type ConnectionState, type GamePhase, type RoomSnapshot } from './game';

type MovingStone = { from: string; to: string; duration: number; stoneNumber: number };
type SpecialEvent = { kind: 'extraTurn' } | { kind: 'capture'; stones: number } | null;

type GameStore = {
  screen: AppScreen;
  room: RoomSnapshot | null;
  player: PlayerIndex | null;
  connection: ConnectionState;
  pending: boolean;
  phase: GamePhase;
  animatedBoard: Board | null;
  movingStone: MovingStone | null;
  activeZone: string | null;
  captureZone: string | null;
  specialEvent: SpecialEvent;
  notice: string;
  soundOn: boolean;
  set: (patch: Partial<GameStore>) => void;
};

const useGame = create<GameStore>((set) => ({
  screen: 'home', room: null, player: null, connection: 'offline', pending: false,
  phase: 'waitingOpponent', animatedBoard: null, movingStone: null, activeZone: null,
  captureZone: null, specialEvent: null, notice: '', soundOn: localStorage.getItem('fuwa-sound') !== 'off',
  set: (patch) => set(patch),
}));

const tokenKey = 'fuwa-mancala-token';
const roomKey = 'fuwa-mancala-room';
const playerKey = 'fuwa-mancala-player';
const sessionKey = 'fuwa-mancala-session';

function getToken() {
  let token = localStorage.getItem(tokenKey);
  if (!token) { token = crypto.randomUUID(); localStorage.setItem(tokenKey, token); }
  return token;
}

function invalidMoveMessage(reason: InvalidMovePayload['reason']) {
  const messages: Record<InvalidMovePayload['reason'], string> = {
    room_not_found: 'ルームが見つかりません。コードを確認してください。', not_a_player: 'このルームの参加者ではありません。',
    player_disconnected: '相手の再接続を待っています。戻るまで盤面は動かせません。', game_not_started: '相手の参加を待っています。',
    game_finished: 'この対局は終了しています。', not_your_turn: 'いまは相手の番です。', stale_revision: '盤面が更新されました。もう一度選んでください。',
    duplicate_move: 'その手はすでに送信されています。', invalid_pit: 'その穴は選べません。自分の石がある穴を選んでください。',
  };
  return messages[reason];
}

function sound(kind: 'tap' | 'sow' | 'capture') {
  if (!useGame.getState().soundOn) return;
  try {
    const ctx = new AudioContext(); const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.frequency.value = kind === 'capture' ? 660 : kind === 'sow' ? 440 : 320;
    gain.gain.setValueAtTime(0.035, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
    osc.connect(gain).connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.08);
  } catch { /* 音が使えない環境では静かに続ける */ }
}

function boardFrom(room: RoomSnapshot): Board {
  return room.game ? { pits: room.game.pits, stores: room.game.stores } : { pits: [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]], stores: [0, 0] };
}

function pitZone(player: PlayerIndex, pit: number) { return `pit-${player}-${pit}`; }
function storeZone(player: PlayerIndex) { return `store-${player}`; }
function targetZone(target: SowTarget) { return target.kind === 'store' ? storeZone(target.player) : pitZone(target.player, target.pit); }
function startingPlayerNotice(state: RoomSnapshot, player: PlayerIndex | null) {
  if (player === null || !state.game) return '対戦スタート！';
  return state.game.currentPlayer === player ? 'あなたが先攻です' : '相手が先攻です';
}

function useSocket() {
  const socket = useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);
  const animationQueue = useRef(Promise.resolve());
  const animationGeneration = useRef(0);
  const set = useGame((s) => s.set);
  const cancelAnimations = () => {
    animationGeneration.current += 1;
    animationQueue.current = Promise.resolve();
  };

  useEffect(() => {
    const client: Socket<ServerToClientEvents, ClientToServerEvents> = io(import.meta.env.VITE_SOCKET_URL ?? window.location.origin, { autoConnect: false, auth: { token: getToken() } });
    socket.current = client;
    const applyRoom = (room: RoomSnapshot, player = useGame.getState().player, generation?: number) => {
      if (generation !== undefined && generation !== animationGeneration.current) return;
      set({ room, screen: screenForRoom(room), phase: phaseForRoom(room, player), pending: false });
    };

    const animateUpdate = async (payload: StateUpdatePayload, generation: number) => {
      const isCurrent = () => generation === animationGeneration.current;
      if (!isCurrent()) return;
      const room = payload.state; const result: GameMoveResult | undefined = payload.moveResult; const steps: MoveStep[] = result?.steps ?? [];
      const current = useGame.getState().room;
      if (!current || !steps.length) { applyRoom(room, undefined, generation); return; }

      const reduced = prefersReducedMotion();
      let visual = copyBoard(boardFrom(current));
      let lastZone: string | null = null;
      set({ phase: 'animating', animatedBoard: visual, pending: false, notice: '', specialEvent: null });

      for (const step of steps) {
        if (!isCurrent()) return;
        if (step.type === 'pickup') {
          lastZone = pitZone(step.player, step.pit);
          visual = applyVisualStep(visual, step);
          set({ animatedBoard: visual, activeZone: lastZone });
          await waitForAnimation(ANIMATION_TIMING.stoneLanding, reduced);
          if (!isCurrent()) return;
        } else if (step.type === 'sow') {
          const to = targetZone(step.target); const duration = stoneMoveDuration(step.stoneNumber, reduced);
          set({ movingStone: lastZone ? { from: lastZone, to, duration, stoneNumber: step.stoneNumber } : null, activeZone: null });
          await waitForAnimation(duration, reduced);
          if (!isCurrent()) return;
          visual = applyVisualStep(visual, step); sound('sow');
          set({ animatedBoard: visual, movingStone: null, activeZone: to });
          await waitForAnimation(ANIMATION_TIMING.stoneLanding, reduced);
          if (!isCurrent()) return;
          lastZone = to;
        } else if (step.type === 'capture') {
          const landing = pitZone(step.player, step.pit); const opposite = pitZone(step.player === 0 ? 1 : 0, step.oppositePit);
          set({ phase: 'specialEvent', activeZone: landing, captureZone: opposite });
          await waitForAnimation(ANIMATION_TIMING.capturePause, reduced);
          if (!isCurrent()) return;
          visual = applyVisualStep(visual, step); sound('capture');
          set({ animatedBoard: visual, specialEvent: { kind: 'capture', stones: step.stones }, activeZone: storeZone(step.player) });
          await waitForAnimation(ANIMATION_TIMING.capture, reduced);
          if (!isCurrent()) return;
          set({ specialEvent: null, captureZone: null, phase: 'animating' });
        } else if (step.type === 'collect') {
          visual = applyVisualStep(visual, step);
          set({ animatedBoard: visual, activeZone: storeZone(step.player) });
          await waitForAnimation(ANIMATION_TIMING.stoneLanding, reduced);
          if (!isCurrent()) return;
        } else {
          await waitForAnimation(ANIMATION_TIMING.resultDelay, reduced);
          if (!isCurrent()) return;
        }
      }

      if (result?.extraTurn && room.status === 'playing') {
        set({ phase: 'specialEvent', specialEvent: { kind: 'extraTurn' }, activeZone: null });
        await waitForAnimation(ANIMATION_TIMING.extraTurn, reduced);
        if (!isCurrent()) return;
      }

      const player = useGame.getState().player;
      set({ room, animatedBoard: null, movingStone: null, activeZone: null, captureZone: null, specialEvent: null,
        phase: phaseForRoom(room, player), screen: screenForRoom(room), notice: result?.extraTurn && room.status === 'playing' ? 'ストアに入ったので、もう一度！' : '' });
    };

    client.on('connect', () => {
      set({ connection: 'connected' });
      const roomCode = localStorage.getItem(roomKey); const sessionToken = localStorage.getItem(sessionKey);
      const inviteCode = new URLSearchParams(window.location.search).get('room')?.trim() ?? '';
      if (roomCode && sessionToken && (!inviteCode || inviteCode === roomCode)) client.emit('reconnect_room', { roomCode, sessionToken });
    });
    client.on('disconnect', () => { cancelAnimations(); set({ connection: 'offline', phase: 'waitingOpponent' }); });
    client.io.on('reconnect_attempt', () => set({ connection: 'reconnecting', phase: 'waitingOpponent' }));
    client.on('room_joined', (payload: RoomJoinedPayload) => {
      cancelAnimations();
      const room = payload.room; const index = payload.playerIndex;
      localStorage.setItem(roomKey, room.roomCode); localStorage.setItem(sessionKey, payload.sessionToken); sessionStorage.setItem(playerKey, String(index));
      if (new URLSearchParams(window.location.search).has('room')) window.history.replaceState({}, '', window.location.pathname);
      set({ room, player: index, screen: screenForRoom(room), phase: phaseForRoom(room, index), pending: false, notice: '' });
    });
    client.on('start_game', ({ state }) => {
      cancelAnimations();
      const player = useGame.getState().player;
      set({ room: state, screen: 'game', phase: phaseForRoom(state, player), pending: false, notice: startingPlayerNotice(state, player) });
    });
    client.on('rematch_request', (payload) => {
      const current = useGame.getState();
      set({ room: current.room ? { ...current.room, rematchRequestedBy: payload.requestedBy } : null,
        notice: payload.playerIndex === current.player ? '相手の返事を待っています。' : '相手がもう一局を希望しています。' });
    });
    client.on('rematch_start', ({ state }) => {
      cancelAnimations();
      const player = useGame.getState().player;
      set({ room: state, screen: 'game', phase: phaseForRoom(state, player), pending: false, notice: startingPlayerNotice(state, player) });
    });
    client.on('state_update', (payload) => {
      const activeRoom = useGame.getState().room;
      if (!activeRoom || activeRoom.roomCode !== payload.state.roomCode) return;
      const generation = animationGeneration.current;
      animationQueue.current = animationQueue.current
        .then(() => animateUpdate(payload, generation))
        .catch(() => applyRoom(payload.state, undefined, generation));
    });
    client.on('player_disconnected', (payload: PlayerConnectionPayload) => {
      cancelAnimations();
      set({ room: payload.state, phase: 'waitingOpponent', notice: '相手の通信が途切れました。復帰を待っています。' });
    });
    client.on('player_reconnected', (payload: PlayerConnectionPayload) => {
      const current = useGame.getState();
      const phase = current.phase === 'animating' || current.phase === 'specialEvent' ? current.phase : phaseForRoom(payload.state, current.player);
      set({ room: payload.state, phase, notice: '相手が戻りました。対戦を再開できます。' });
    });
    client.on('invalid_move', (payload: InvalidMovePayload) => {
      const room = payload.state ?? useGame.getState().room;
      const patch: Partial<GameStore> = { pending: false, room, phase: phaseForRoom(room, useGame.getState().player), notice: invalidMoveMessage(payload.reason) };
      if (payload.reason === 'room_not_found') patch.screen = 'join';
      set(patch);
    });
    client.connect();
    return () => { cancelAnimations(); client.close(); };
  }, [set]);

  return { socket, cancelAnimations };
}

function Header({ onHome }: { onHome: () => void }) {
  const { connection, soundOn, set } = useGame();
  const status = connection === 'connected' ? '接続中' : connection === 'reconnecting' ? '再接続中…' : '未接続';
  return <header className="topbar"><button className="brand" onClick={onHome} aria-label="ホームへ">☁ <span>ふわっとマンカラ</span></button><div className="header-actions"><span className={`connection ${connection}`}>{status}</span><button className="icon-button" aria-label={`効果音を${soundOn ? 'オフ' : 'オン'}にする`} onClick={() => { const next = !soundOn; localStorage.setItem('fuwa-sound', next ? 'on' : 'off'); set({ soundOn: next }); }}>{soundOn ? '♪' : '♪̸'}</button></div></header>;
}

function Home({ onCreate, onJoin, onRules }: { onCreate: () => void; onJoin: () => void; onRules: () => void }) {
  return <main className="home"><i className="scenery cloud cloud-a" /><i className="scenery cloud cloud-b" /><section className="hero"><div className="hero-copy"><p className="eyebrow">2人でゆったり、頭の体操</p><h1>ふわっと<br />マンカラ</h1><p>おはじきをまいて、ストアに集めよう。<br />はじめてでも、すぐ遊べます。</p></div><img src="/assets/hero-mancala-v2.webp" onError={(event) => { event.currentTarget.src = '/assets/hero-mancala.webp'; }} alt="ひつじたちがマンカラで遊ぶ様子" className="hero-image" /></section><section className="action-card"><button className="primary-button" onClick={onCreate}>ルームをつくる <span>→</span></button><button className="secondary-button" onClick={onJoin}>コードで参加</button><button className="text-button" onClick={onRules}>マンカラのルールを見る</button></section><p className="home-note">招待リンクを送るだけ。アカウント登録は不要です。</p></main>;
}

function Join({ initialCode, onBack, onJoin }: { initialCode: string; onBack: () => void; onJoin: (code: string) => void }) {
  const [code, setCode] = useState(initialCode.replace(/\D/g, '').slice(0, 6)); const notice = useGame((s) => s.notice);
  return <main className="panel-page"><button className="back-button" onClick={onBack}>‹ 戻る</button><section className="form-card">{notice && <div className="notice" role="status">{notice}</div>}<span className="card-icon">✉</span><h1>ルームに参加</h1><p>相手から届いた6桁のコードを入力してね。</p><label htmlFor="room-code">ルームコード</label><input id="room-code" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="例：123456" /><button className="primary-button" disabled={!/^\d{6}$/.test(code)} onClick={() => onJoin(code)}>参加する <span>→</span></button></section></main>;
}

function Waiting({ roomId, inviteUrl, onCopy, copied, onLeave }: { roomId: string; inviteUrl: string; onCopy: () => void; copied: boolean; onLeave: () => void }) {
  return <main className="panel-page waiting-page"><section className="waiting-card"><img className="waiting-image" src="/assets/waiting-room.webp" alt="相手を待つひつじ" /><p className="eyebrow">あとひとり</p><h1>相手を待っています</h1><p>リンク・コード・QRから、<br />一緒に遊ぶ相手を招待しよう。</p><div className="waiting-share"><div><div className="invite-code"><span>ルームコード</span><strong>{roomId}</strong></div><button className="primary-button" onClick={onCopy}>{copied ? 'コピーしました！' : '招待リンクをコピー'}</button></div><figure className="invite-qr"><QRCodeSVG value={inviteUrl} size={168} level="M" bgColor="#fffaf0" fgColor="#3f624d" title="招待リンクのQRコード" /><figcaption>相手のスマホで読み取ってね</figcaption></figure></div><button className="text-button" onClick={onLeave}>ホームへ戻る</button></section></main>;
}

function Pit({ count, top, selected, zone, active, captured, label, onClick }: { count: number; top: boolean; selected: boolean; zone: string; active: boolean; captured: boolean; label: string; onClick: () => void }) {
  return <button data-zone={zone} className={`pit ${top ? 'pit-opponent' : 'pit-self'} ${selected ? 'selectable' : ''} ${active ? 'landing' : ''} ${captured ? 'capture-focus' : ''}`} disabled={!selected} onClick={onClick} aria-label={label}><span className="stones" aria-hidden="true">{Array.from({ length: Math.min(count, 8) }, (_, i) => <i className={`ohajiki ohajiki-${i % 4}`} key={i} />)}</span><b className="stone-count">{count}</b></button>;
}

function Board({ onMove }: { onMove: (pit: number) => void }) {
  const { room, player, pending, phase, animatedBoard, activeZone, captureZone } = useGame();
  if (!room) return null;
  const board = animatedBoard ?? boardFrom(room); const playerDisconnected = room.players.some((entry) => entry !== null && !entry.connected);
  const locked = pending || phase !== 'idle' || playerDisconnected; const theirRow = player === 0 ? 1 : 0; const myRow = player ?? 0;
  const playPit = (index: number) => { if (canPickPit(room, player, index, locked)) { sound('tap'); onMove(index); } };
  return <section className={`game-board phase-${phase}`} aria-label="マンカラ盤"><div className="player-label opponent"><span><i className="player-dot opponent-dot" />相手</span><small>{room.game?.currentPlayer === theirRow ? '手番です' : '見守り中'}</small></div><div className="board-shell"><div data-zone={storeZone(theirRow)} className={`store store-left ${activeZone === storeZone(theirRow) ? 'landing' : ''}`}><span>相手のストア</span><strong>{board.stores[theirRow]}</strong></div><div className="pits-area"><div className="pit-row opponent-row">{[...board.pits[theirRow]].reverse().map((count, visualIndex) => { const pit = 5 - visualIndex; const zone = pitZone(theirRow, pit); return <Pit key={pit} count={count} top selected={false} zone={zone} active={activeZone === zone} captured={captureZone === zone} label={`相手側の${pit + 1}番の穴、おはじき${count}個`} onClick={() => undefined} />; })}</div><div className="board-divider"><span>☘</span></div><div className="pit-row">{board.pits[myRow].map((count, pit) => { const zone = pitZone(myRow, pit); const selected = canPickPit(room, player, pit, locked); return <Pit key={pit} count={count} top={false} selected={selected} zone={zone} active={activeZone === zone} captured={captureZone === zone} label={`あなた側の${pit + 1}番の穴、おはじき${count}個。${selected ? '選択できます' : '現在は選択できません'}`} onClick={() => playPit(pit)} />; })}</div></div><div data-zone={storeZone(myRow)} className={`store store-right ${activeZone === storeZone(myRow) ? 'landing' : ''}`}><span>あなたのストア</span><strong>{board.stores[myRow]}</strong></div></div><div className="player-label mine"><span><i className="player-dot mine-dot" />あなた</span><small>{phase === 'animating' ? 'おはじきをまいています…' : phase === 'specialEvent' ? 'すてきな一手！' : room.game?.currentPlayer === myRow ? '穴を選んでね' : '相手の番です'}</small></div></section>;
}

function MovingWool({ move }: { move: MovingStone }) {
  const [style, setStyle] = useState<CSSProperties | null>(null); const [moving, setMoving] = useState(false);
  useEffect(() => {
    const from = document.querySelector<HTMLElement>(`[data-zone="${move.from}"]`); const to = document.querySelector<HTMLElement>(`[data-zone="${move.to}"]`);
    if (!from || !to) return;
    const a = from.getBoundingClientRect(); const b = to.getBoundingClientRect();
    setMoving(false); setStyle({ left: a.left + a.width / 2 - 10, top: a.top + a.height / 2 - 10, '--wool-x': `${b.left + b.width / 2 - a.left - a.width / 2}px`, '--wool-y': `${b.top + b.height / 2 - a.top - a.height / 2}px`, transitionDuration: `${move.duration}ms` } as CSSProperties);
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => setMoving(true)));
    return () => cancelAnimationFrame(frame);
  }, [move]);
  return style ? <span className={`moving-wool ${moving ? 'is-moving' : ''}`} style={style} aria-hidden="true"><i className={`ohajiki ohajiki-${(move.stoneNumber - 1) % 4}`} /></span> : null;
}

function SpecialCutin({ event }: { event: SpecialEvent }) {
  if (!event) return null;
  const capture = event.kind === 'capture';
  return <div className={`special-cutin ${capture ? 'capture-cutin' : 'extra-cutin'}`} role="status" aria-live="assertive"><div className="cutin-card"><img src={capture ? '/assets/cutin-capture.webp' : '/assets/cutin-extra-turn.webp'} alt="" /><div><p>{capture ? 'ごっそりゲット！' : 'もういちど！'}</p>{capture ? <strong>＋{event.stones}</strong> : <span>ストアにぴったり入りました</span>}</div></div></div>;
}

function Game({ onMove, onLeave }: { onMove: (pit: number) => void; onLeave: () => void }) {
  const { room, player, notice, phase, pending, movingStone, specialEvent } = useGame(); const [settings, setSettings] = useState(false);
  if (!room) return null; const mine = player ?? 0; const playerDisconnected = room.players.some((entry) => entry !== null && !entry.connected);
  const myTurn = room.game?.currentPlayer === mine;
  return <main className="game-page"><div className={`turn-banner ${myTurn ? 'your-turn' : ''} phase-${phase}`}><span>{myTurn ? 'あなたの番' : '相手の番'}</span><b>{phase === 'animating' ? 'おはじきがトントン移動中' : phase === 'specialEvent' ? 'スペシャル！' : myTurn ? '光っている穴を選んでね' : 'のんびり待ちましょう'}</b></div>{notice && <div className="notice" role="status">{notice}</div>}<Board onMove={onMove} />{playerDisconnected && <p className="move-note reconnect-note" role="status">相手の再接続を待っています。盤面は操作できません。</p>}{pending && <p className="move-note" role="status">手を送信しています…</p>}<button className="settings-button" onClick={() => setSettings(true)}>⚙ 対戦設定</button>{movingStone && <MovingWool key={`${movingStone.stoneNumber}-${movingStone.to}`} move={movingStone} />}<SpecialCutin event={specialEvent} />{settings && <div className="modal-backdrop" role="presentation" onClick={() => setSettings(false)}><section className="settings-modal" role="dialog" aria-modal="true" aria-label="対戦設定" onClick={(e) => e.stopPropagation()}><h2>対戦設定</h2><p>途中でも通信が戻れば、そのまま再開できます。</p><button className="danger-button" onClick={onLeave}>この対戦から退出</button><button className="secondary-button" onClick={() => setSettings(false)}>閉じる</button></section></div>}</main>;
}

function Result({ onRematch, onHome }: { onRematch: () => void; onHome: () => void }) {
  const { room, player } = useGame(); if (!room) return null;
  const isDraw = room.game?.winner === 'draw'; const won = room.game?.winner === player; const mood = won ? 'win' : isDraw ? 'draw' : 'lose';
  const requested = player !== null && room.rematchRequestedBy.includes(player); const opponentRequested = player !== null && room.rematchRequestedBy.includes(player === 0 ? 1 : 0);
  return <main className={`panel-page result-page ${mood}`}><div className="celebration" aria-hidden="true">{Array.from({ length: 18 }, (_, i) => <i key={i} style={{ '--piece': i } as CSSProperties} />)}</div><section className="result-card"><div className={`result-mood ${mood}`} aria-hidden="true" /><p className="eyebrow">GAME FINISHED</p><h1>{isDraw ? 'ぴったり引き分け！' : won ? 'ふわっと大勝利！' : 'おつかれさま！'}</h1><p>{isDraw ? 'ふたりとも同じ数。いい勝負でした。' : won ? 'おはじきをたくさん集められたね！' : 'あと一歩！次はきっと、もっと上手に。'}</p><div className="score-line"><span>あなた <b>{room.game?.stores[player ?? 0] ?? 0}</b></span><i>—</i><span>相手 <b>{room.game?.stores[player === 0 ? 1 : 0] ?? 0}</b></span></div>{opponentRequested && !requested && <p className="rematch-message">相手がもう一局待っています！</p>}<button className="primary-button" disabled={requested} onClick={onRematch}>{requested ? '相手の返事を待っています…' : opponentRequested ? 'もう一局、受けて立つ！' : 'もう一局あそぶ'}</button><button className="text-button" onClick={onHome}>ホームへ戻る</button></section></main>;
}

const ruleSteps = [
  ['①', '自分の穴を選ぼう', 'おはじきが入っている、自分側の穴をタップ。', 'pick'],
  ['②', 'おはじきを1個ずつまこう', '選んだ穴から反時計回りに、ひとつずつ配ります。', 'sow'],
  ['③', 'ストアならもう一度', '最後のおはじきが自分のストアに入ると、続けてもう一手！', 'extra'],
  ['④', '向かいのおはじきをゲット', '自分の空穴で止まったら、正面のおはじきと一緒に獲得。', 'capture'],
  ['⑤', 'たくさん集めたら勝ち', '片側が空になったら終了。ストアが多い方の勝ちです。', 'win'],
] as const;

function Rules({ onBack }: { onBack: () => void }) {
  return <main className="panel-page rules"><button className="back-button" onClick={onBack}>← 戻る</button><div className="rules-heading"><img src="/assets/waiting-room.webp" alt="ルールを案内するひつじ" /><div><p className="eyebrow">HOW TO PLAY</p><h1>5ステップで<br />すぐ遊べるよ</h1></div></div><p className="rule-lead">自分の列のおはじきをまいて、ストアにたくさん集めましょう。</p><ol className="rule-list">{ruleSteps.map(([number, title, text, kind]) => <li key={kind}><span>{number}</span><img className="rules-board-preview" src="/assets/rules-board.webp" alt="" /><div><b>{title}</b><p>{text}</p></div></li>)}</ol></main>;
}

export function App() {
  const { screen, room, connection, phase, set } = useGame(); const { socket, cancelAnimations } = useSocket(); const [copied, setCopied] = useState(false); const joinedFromUrl = useRef(false);
  const urlRoom = useMemo(() => new URLSearchParams(window.location.search).get('room')?.replace(/\D/g, '').slice(0, 6) ?? '', []);
  useEffect(() => {
    const reconnectingSavedRoom = urlRoom === localStorage.getItem(roomKey) && Boolean(localStorage.getItem(sessionKey));
    if (urlRoom && !room && connection === 'connected' && !joinedFromUrl.current && !reconnectingSavedRoom) { joinedFromUrl.current = true; set({ pending: true, notice: '' }); socket.current?.emit('join_room', { roomCode: urlRoom }); }
    else if (urlRoom && !room && !reconnectingSavedRoom) set({ screen: 'join' });
    else if (urlRoom && !room && reconnectingSavedRoom) set({ screen: 'join', pending: true, notice: '対局へ再接続しています…' });
  }, [urlRoom, room, connection, set, socket]);
  const clearRoomSession = () => {
    localStorage.removeItem(roomKey);
    localStorage.removeItem(sessionKey);
    sessionStorage.removeItem(playerKey);
  };
  const home = () => { cancelAnimations(); window.history.replaceState({}, '', window.location.pathname); set({ screen: 'home', room: null, player: null, notice: '', pending: false, animatedBoard: null, movingStone: null, activeZone: null, captureZone: null, specialEvent: null, phase: 'waitingOpponent' }); };
  const homeFromActiveRoom = () => {
    if (room) {
      if (room.status !== 'finished') socket.current?.emit('leave_room', { roomCode: room.roomCode });
      clearRoomSession();
    }
    home();
  };
  const createRoom = () => { set({ pending: true, notice: '' }); socket.current?.emit('create_room', {}); };
  const joinRoom = (roomCode: string) => { set({ pending: true, notice: '' }); socket.current?.emit('join_room', { roomCode }); };
  const move = (pitIndex: number) => { if (!room || phase !== 'idle') return; set({ pending: true, phase: 'animating', notice: '' }); socket.current?.emit('make_move', { pitIndex, revision: room.revision, moveId: crypto.randomUUID() }); };
  const inviteUrl = room ? `${window.location.origin}${window.location.pathname}?room=${room.roomCode}` : '';
  const copyInvite = async () => { if (!room) return; try { await navigator.clipboard.writeText(inviteUrl); } catch { window.prompt('このリンクをコピーして送ってね', inviteUrl); } setCopied(true); window.setTimeout(() => setCopied(false), 1800); };
  const rematch = () => { socket.current?.emit('rematch_request'); set({ notice: '相手の返事を待っています。' }); };
  const leave = () => { socket.current?.emit('leave_room', room ? { roomCode: room.roomCode } : undefined); clearRoomSession(); home(); };
  return <div className="app-shell"><Header onHome={homeFromActiveRoom} />{screen === 'home' && <Home onCreate={createRoom} onJoin={() => set({ screen: 'join' })} onRules={() => set({ screen: 'rules' })} />}{screen === 'join' && <Join initialCode={urlRoom} onBack={home} onJoin={joinRoom} />}{screen === 'rules' && <Rules onBack={home} />}{screen === 'waiting' && <Waiting roomId={room?.roomCode ?? '------'} inviteUrl={inviteUrl} onCopy={copyInvite} copied={copied} onLeave={leave} />}{screen === 'game' && <Game onMove={move} onLeave={leave} />}{screen === 'result' && <Result onRematch={rematch} onHome={homeFromActiveRoom} />}</div>;
}
