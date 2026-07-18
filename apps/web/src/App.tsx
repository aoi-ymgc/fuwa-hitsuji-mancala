import { useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { QRCodeSVG } from 'qrcode.react';
import { create } from 'zustand';
import type { ClientToServerEvents, GameMoveResult, InvalidMovePayload, MoveStep, PlayerConnectionPayload, PlayerIndex, RoomJoinedPayload, ServerToClientEvents, StateUpdatePayload } from '@fuwa-hitsuji/shared';
import { applyVisualStep, canPickPit, copyBoard, type AppScreen, type Board, type ConnectionState, type RoomSnapshot } from './game';

type GameStore = {
  screen: AppScreen;
  room: RoomSnapshot | null;
  player: PlayerIndex | null;
  connection: ConnectionState;
  pending: boolean;
  animating: boolean;
  animatedBoard: Board | null;
  notice: string;
  soundOn: boolean;
  set: (patch: Partial<GameStore>) => void;
};

const useGame = create<GameStore>((set) => ({
  screen: 'home', room: null, player: null, connection: 'offline', pending: false,
  animating: false, animatedBoard: null, notice: '', soundOn: localStorage.getItem('fuwa-sound') !== 'off',
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
    room_not_found: 'ルームが見つかりません。コードを確認してください。',
    not_a_player: 'このルームの参加者ではありません。',
    player_disconnected: '相手の再接続を待っています。戻るまで盤面は動かせません。',
    game_not_started: '相手の参加を待っています。',
    game_finished: 'この対局は終了しています。',
    not_your_turn: 'いまは相手の番です。',
    stale_revision: '盤面が更新されました。もう一度選んでください。',
    duplicate_move: 'その手はすでに送信されています。',
    invalid_pit: 'その穴は選べません。自分の石がある穴を選んでください。',
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

function boardFrom(room: RoomSnapshot): Board { return room.game ? { pits: room.game.pits, stores: room.game.stores } : { pits: [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]], stores: [0, 0] }; }

function useSocket() {
  const socket = useRef<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);
  const set = useGame((s) => s.set);

  useEffect(() => {
    const client: Socket<ServerToClientEvents, ClientToServerEvents> = io(import.meta.env.VITE_SOCKET_URL ?? window.location.origin, { autoConnect: false, auth: { token: getToken() } });
    socket.current = client;
    client.on('connect', () => {
      set({ connection: 'connected' });
      const roomCode = localStorage.getItem(roomKey); const sessionToken = localStorage.getItem(sessionKey);
      const inviteCode = new URLSearchParams(window.location.search).get('room')?.trim() ?? '';
      if (roomCode && sessionToken && (!inviteCode || inviteCode === roomCode)) {
        client.emit('reconnect_room', { roomCode, sessionToken });
      }
    });
    client.on('disconnect', () => set({ connection: 'offline' }));
    client.io.on('reconnect_attempt', () => set({ connection: 'reconnecting' }));
    client.on('room_joined', (payload: RoomJoinedPayload) => {
      const room = payload.room;
      if (room) {
        const index = payload.playerIndex;
        localStorage.setItem(roomKey, room.roomCode);
        localStorage.setItem(sessionKey, payload.sessionToken);
        sessionStorage.setItem(playerKey, String(index));
        if (new URLSearchParams(window.location.search).has('room')) {
          window.history.replaceState({}, '', window.location.pathname);
        }
        set({ room, player: index, screen: room.status === 'finished' ? 'result' : room.status === 'playing' ? 'game' : 'waiting', pending: false, notice: '' });
      }
    });
    client.on('start_game', (payload: StateUpdatePayload) => { set({ room: payload.state, screen: 'game', pending: false, notice: '対戦スタート！' }); });
    client.on('rematch_request', () => set({ notice: '相手がもう一局を希望しています。' }));
    client.on('rematch_start', (payload: StateUpdatePayload) => set({ room: payload.state, screen: 'game', pending: false, notice: 'もう一局スタート！' }));
    client.on('state_update', async (payload: StateUpdatePayload) => {
      const room = payload.state; const result: GameMoveResult | undefined = payload.moveResult; const steps: MoveStep[] = result?.steps ?? [];
      const current = useGame.getState().room;
      if (room && current && steps.length) {
        let visual = copyBoard(boardFrom(current));
        set({ animating: true, animatedBoard: visual, pending: false });
        for (const step of steps) {
          visual = applyVisualStep(visual, step); set({ animatedBoard: visual });
          if (step.type === 'sow') sound('sow'); else if (step.type === 'capture') sound('capture');
          await new Promise((resolve) => window.setTimeout(resolve, step.type === 'sow' ? 130 : 260));
        }
        set({ room, animatedBoard: null, animating: false, screen: room.status === 'finished' ? 'result' : 'game', notice: result?.extraTurn ? 'ストアに入ったので、もう一度あなたの番！' : '' });
      } else if (room) set({ room, pending: false, screen: room.status === 'finished' ? 'result' : 'game' });
    });
    client.on('player_disconnected', (payload: PlayerConnectionPayload) => set({ room: payload.state, notice: '相手の通信が途切れました。復帰を待っています。' }));
    client.on('player_reconnected', (payload: PlayerConnectionPayload) => set({ room: payload.state, notice: '相手が戻りました。対戦を再開できます。' }));
    client.on('invalid_move', (payload: InvalidMovePayload) => {
      const patch: Partial<GameStore> = {
        pending: false,
        room: payload.state ?? useGame.getState().room,
        notice: invalidMoveMessage(payload.reason),
      };
      if (payload.reason === 'room_not_found') patch.screen = 'join';
      set(patch);
    });
    client.connect();
    return () => { client.close(); };
  }, [set]);

  return socket;
}

function Header({ onHome }: { onHome: () => void }) {
  const { connection, soundOn, set } = useGame();
  const status = connection === 'connected' ? '接続中' : connection === 'reconnecting' ? '再接続中…' : '未接続';
  return <header className="topbar"><button className="brand" onClick={onHome} aria-label="ホームへ">☁ <span>ふわっとマンカラ</span></button><div className="header-actions"><span className={`connection ${connection}`}>{status}</span><button className="icon-button" aria-label="効果音を切り替え" onClick={() => { const next = !soundOn; localStorage.setItem('fuwa-sound', next ? 'on' : 'off'); set({ soundOn: next }); }}>{soundOn ? '♪' : '♪̸'}</button></div></header>;
}

function Home({ onCreate, onJoin, onRules }: { onCreate: () => void; onJoin: () => void; onRules: () => void }) {
  return <main className="home"><section className="hero"><div className="hero-copy"><p className="eyebrow">2人でゆったり、頭の体操</p><h1>ふわっと<br />マンカラ</h1><p>石をまいて、ストアに集めよう。<br />はじめてでも、すぐ遊べます。</p></div><img src="/assets/hero-mancala.png" alt="マンカラで遊ぶひつじ" className="hero-image" /></section><section className="action-card"><button className="primary-button" onClick={onCreate}>ルームをつくる <span>→</span></button><button className="secondary-button" onClick={onJoin}>コードで参加</button><button className="text-button" onClick={onRules}>マンカラのルールを見る</button></section><p className="home-note">招待リンクを送るだけ。アカウント登録は不要です。</p></main>;
}

function Join({ initialCode, onBack, onJoin }: { initialCode: string; onBack: () => void; onJoin: (code: string) => void }) {
  const [code, setCode] = useState(initialCode.replace(/\D/g, '').slice(0, 6));
  const notice = useGame((s) => s.notice);
  return <main className="panel-page"><button className="back-button" onClick={onBack}>‹ 戻る</button><section className="form-card">{notice && <div className="notice" role="status">{notice}</div>}<span className="card-icon">✉</span><h1>ルームに参加</h1><p>相手から届いた6文字のコードを入力してね。</p><label htmlFor="room-code">ルームコード</label><input id="room-code" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="例：123456" /><button className="primary-button" disabled={!/^\d{6}$/.test(code)} onClick={() => onJoin(code)}>参加する <span>→</span></button></section></main>;
}

function Waiting({ roomId, inviteUrl, onCopy, copied, onLeave }: { roomId: string; inviteUrl: string; onCopy: () => void; copied: boolean; onLeave: () => void }) {
  return <main className="panel-page"><section className="waiting-card"><img className="waiting-image" src="/assets/waiting-room.png" alt="相手を待つふわっとマンカラのひつじ" /><p className="eyebrow">あとひとり</p><h1>相手を待っています</h1><p>このリンクかコードを送って、<br />一緒に遊ぶ相手を招待しよう。</p><div className="invite-code"><span>ルームコード</span><strong>{roomId}</strong></div><figure className="invite-qr"><QRCodeSVG value={inviteUrl} size={168} level="M" bgColor="#fffaf0" fgColor="#3f624d" title="招待リンクのQRコード" /><figcaption>相手のスマホで読み取ってね</figcaption></figure><button className="primary-button" onClick={onCopy}>{copied ? 'コピーしました！' : '招待リンクをコピー'}</button><button className="text-button" onClick={onLeave}>ホームへ戻る</button></section></main>;
}

function Pit({ count, top, selected, onClick }: { count: number; top: boolean; selected: boolean; onClick: () => void }) {
  return <button className={`pit ${top ? 'pit-opponent' : 'pit-self'} ${selected ? 'selectable' : ''}`} disabled={!selected} onClick={onClick} aria-label={`${count}個の石。${selected ? '選択できます' : '選択できません'}`}><span className="stones">{Array.from({ length: Math.min(count, 9) }, (_, i) => <i key={i} />)}</span><b>{count}</b></button>;
}

function Board({ onMove }: { onMove: (pit: number) => void }) {
  const { room, player, pending, animating, animatedBoard } = useGame();
  if (!room) return null;
  const board = animatedBoard ?? boardFrom(room); const playerDisconnected = room.players.some((entry) => entry !== null && !entry.connected); const locked = pending || animating || playerDisconnected;
  const theirRow = player === 0 ? 1 : 0; const myRow = player ?? 0;
  const playPit = (index: number) => { if (canPickPit(room, player, index, locked)) { sound('tap'); onMove(index); } };
  return <section className="game-board" aria-label="マンカラ盤"><div className="player-label opponent"><span>相手</span><small>{room.game?.currentPlayer === theirRow ? '手番です' : '考え中…'}</small></div><div className="board-shell"><div className="store store-left"><span>相手のストア</span><strong>{board.stores[theirRow]}</strong></div><div className="pits-area"><div className="pit-row opponent-row">{[...board.pits[theirRow]].reverse().map((count, index) => <Pit key={index} count={count} top selected={false} onClick={() => undefined} />)}</div><div className="board-divider" /><div className="pit-row">{board.pits[myRow].map((count, index) => <Pit key={index} count={count} top={false} selected={canPickPit(room, player, index, locked)} onClick={() => playPit(index)} />)}</div></div><div className="store store-right"><span>あなたのストア</span><strong>{board.stores[myRow]}</strong></div></div><div className="player-label mine"><span>あなた</span><small>{room.game?.currentPlayer === myRow ? (locked ? '石をまいています…' : '穴を選んでね') : '相手の番です'}</small></div></section>;
}

function Game({ onMove, onLeave }: { onMove: (pit: number) => void; onLeave: () => void }) {
  const { room, player, notice, animating, pending } = useGame(); const [settings, setSettings] = useState(false);
  if (!room) return null; const mine = player ?? 0; const playerDisconnected = room.players.some((entry) => entry !== null && !entry.connected);
  return <main className="game-page"><div className={`turn-banner ${room.game?.currentPlayer === mine ? 'your-turn' : ''}`}><span>{room.game?.currentPlayer === mine ? 'あなたの番' : '相手の番'}</span><b>{room.game?.currentPlayer === mine ? '石のある穴を選んでね' : 'のんびり待ちましょう'}</b></div>{notice && <div className="notice" role="status">{notice}</div>}<Board onMove={onMove} />{playerDisconnected && <p className="move-note reconnect-note" role="status">相手の再接続を待っています。盤面は操作できません。</p>}{animating && <p className="move-note">石をまいています…</p>}{pending && <p className="move-note">送信中…</p>}<button className="settings-button" onClick={() => setSettings(true)}>⚙ 設定</button>{settings && <div className="modal-backdrop" role="presentation" onClick={() => setSettings(false)}><section className="settings-modal" role="dialog" aria-modal="true" aria-label="対戦設定" onClick={(e) => e.stopPropagation()}><h2>対戦設定</h2><p>途中でも通信が戻れば、そのまま再開できます。</p><button className="danger-button" onClick={onLeave}>この対戦から退出</button><button className="secondary-button" onClick={() => setSettings(false)}>閉じる</button></section></div>}</main>;
}

function Result({ onRematch, onHome }: { onRematch: () => void; onHome: () => void }) {
  const { room, player } = useGame(); if (!room) return null;
  const isDraw = room.game?.winner === 'draw'; const won = room.game?.winner === player;
  const mood = won ? 'win' : isDraw ? 'draw' : 'lose';
  return <main className="panel-page"><section className="result-card"><div className={`result-mood ${mood}`} aria-hidden="true" /><p className="eyebrow">GAME FINISHED</p><h1>{isDraw ? '引き分け！' : won ? 'あなたの勝ち！' : 'おつかれさま！'}</h1><p>{isDraw ? '同じ数の石を集めました。' : won ? 'ストアにたくさん集められたね。' : 'もう一局、ゆっくり勝負する？'}</p><div className="score-line"><span>あなた <b>{room.game?.stores[player ?? 0] ?? 0}</b></span><i>—</i><span>相手 <b>{room.game?.stores[player === 0 ? 1 : 0] ?? 0}</b></span></div><button className="primary-button" onClick={onRematch}>もう一局あそぶ</button><button className="text-button" onClick={onHome}>ホームへ戻る</button></section></main>;
}

function Rules({ onBack }: { onBack: () => void }) {
  return <main className="panel-page rules"><button className="back-button" onClick={onBack}>← 戻る</button><h1>マンカラの遊びかた</h1><p className="rule-lead">自分の列の石をまいて、より多くの石を自分のストアに集めた人の勝ちです。</p><div className="rule-diagram" aria-label="石を反時計回りにまく順番"><span>自分の穴</span><b>→</b><span>自分のストア</span><b>→</b><span>相手の穴</span><small>（相手のストアは通り過ぎます）</small></div><ol className="rule-list"><li><span>1</span><div><b>自分側の穴を1つ選ぶ</b><p>自分の列にある、石が入った穴を選びます。</p></div></li><li><span>2</span><div><b>石を反時計回りに1個ずつまく</b><p>自分のストアには置きますが、相手のストアは飛ばします。</p></div></li><li><span>3</span><div><b>空穴で止まったら石を獲得</b><p>最後の石が自分側の空穴に入り、正面の相手の穴に石があれば、両方の石を自分のストアへ入れます。</p></div></li><li><span>4</span><div><b>どちらか片側が空になったら終了</b><p>残った列の石をすべて各自のストアへ回収し、ストアの石が多い方の勝ちです。</p></div></li></ol></main>;
}

export function App() {
  const { screen, room, connection, set } = useGame(); const socket = useSocket(); const [copied, setCopied] = useState(false); const joinedFromUrl = useRef(false);
  const urlRoom = useMemo(() => new URLSearchParams(window.location.search).get('room')?.replace(/\D/g, '').slice(0, 6) ?? '', []);
  useEffect(() => {
    const reconnectingSavedRoom = urlRoom === localStorage.getItem(roomKey) && Boolean(localStorage.getItem(sessionKey));
    if (urlRoom && !room && connection === 'connected' && !joinedFromUrl.current && !reconnectingSavedRoom) {
      joinedFromUrl.current = true; set({ pending: true, notice: '' }); socket.current?.emit('join_room', { roomCode: urlRoom });
    } else if (urlRoom && !room && !reconnectingSavedRoom) set({ screen: 'join' });
    else if (urlRoom && !room && reconnectingSavedRoom) set({ screen: 'join', pending: true, notice: '対局へ再接続しています…' });
  }, [urlRoom, room, connection, set, socket]);
  const clearRoomSession = () => { localStorage.removeItem(roomKey); localStorage.removeItem(sessionKey); };
  const home = () => { window.history.replaceState({}, '', window.location.pathname); set({ screen: 'home', room: null, player: null, notice: '', pending: false }); };
  const homeFromActiveRoom = () => { if (room && room.status !== 'finished') { socket.current?.emit('leave_room', { roomCode: room.roomCode }); clearRoomSession(); } home(); };
  const createRoom = () => { set({ pending: true, notice: '' }); socket.current?.emit('create_room', {}); };
  const joinRoom = (roomCode: string) => { set({ pending: true, notice: '' }); socket.current?.emit('join_room', { roomCode }); };
  const move = (pitIndex: number) => { if (!room) return; set({ pending: true, notice: '' }); socket.current?.emit('make_move', { pitIndex, revision: room.revision, moveId: crypto.randomUUID() }); };
  const inviteUrl = room ? `${window.location.origin}${window.location.pathname}?room=${room.roomCode}` : '';
  const copyInvite = async () => { if (!room) return; try { await navigator.clipboard.writeText(inviteUrl); } catch { window.prompt('このリンクをコピーして送ってね', inviteUrl); } setCopied(true); window.setTimeout(() => setCopied(false), 1800); };
  const rematch = () => { socket.current?.emit('rematch_request'); set({ notice: '相手の返事を待っています。' }); };
  const leave = () => { socket.current?.emit('leave_room', room ? { roomCode: room.roomCode } : undefined); clearRoomSession(); home(); };
  return <div className="app-shell"><Header onHome={homeFromActiveRoom} />{screen === 'home' && <Home onCreate={createRoom} onJoin={() => set({ screen: 'join' })} onRules={() => set({ screen: 'rules' })} />}{screen === 'join' && <Join initialCode={urlRoom} onBack={home} onJoin={joinRoom} />}{screen === 'rules' && <Rules onBack={home} />}{screen === 'waiting' && <Waiting roomId={room?.roomCode ?? '------'} inviteUrl={inviteUrl} onCopy={copyInvite} copied={copied} onLeave={leave} />}{screen === 'game' && <Game onMove={move} onLeave={leave} />}{screen === 'result' && <Result onRematch={rematch} onHome={homeFromActiveRoom} />}</div>;
}
