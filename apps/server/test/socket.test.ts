import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  InvalidMovePayload,
  RoomJoinedPayload,
  ServerToClientEvents,
  StateUpdatePayload,
} from '@fuwa-hitsuji/shared';
import { createAppServer, type AppServer } from '../src/index.js';

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let activeServer: AppServer | null = null;
const activeClients: ClientSocket[] = [];

afterEach(async () => {
  for (const client of activeClients.splice(0)) {
    client.close();
  }
  if (activeServer !== null) {
    await activeServer.io.close();
    await new Promise<void>((resolve) => activeServer?.httpServer.close(() => resolve()));
    activeServer = null;
  }
});

describe('Socket.IO room play', () => {
  it.each([0, 1] as const)('starts with the picked player (%i) and rejects invalid turns', async (startingPlayer) => {
    const url = await startServer({ startingPlayerPicker: () => startingPlayer });
    const playerOne = await createClient(url);
    const playerTwo = await createClient(url);

    const firstJoined = onceRoomJoined(playerOne);
    playerOne.emit('create_room', {});
    const host = await firstJoined;
    expect(host.room.status).toBe('waiting');
    expect(host.inviteUrl).toContain(`room=${host.room.roomCode}`);

    const firstStart = onceStart(playerOne);
    const secondStart = onceStart(playerTwo);
    const secondJoined = onceRoomJoined(playerTwo);
    playerTwo.emit('join_room', { roomCode: host.room.roomCode });
    const guest = await secondJoined;
    const [startedByHost, startedByGuest] = await Promise.all([firstStart, secondStart]);
    expect(guest.playerIndex).toBe(1);
    expect(startedByHost.state.status).toBe('playing');
    expect(startedByHost.state.revision).toBe(startedByGuest.state.revision);
    expect(startedByHost.state.game?.currentPlayer).toBe(startingPlayer);

    const waitingPlayer = startingPlayer === 0 ? playerTwo : playerOne;
    const activePlayer = startingPlayer === 0 ? playerOne : playerTwo;
    const outOfTurn = onceInvalidMove(waitingPlayer);
    waitingPlayer.emit('make_move', { pitIndex: 0, revision: startedByHost.state.revision, moveId: 'move-0000' });
    await expect(outOfTurn).resolves.toMatchObject({ reason: 'not_your_turn' });

    const update = onceStateUpdate(playerOne);
    activePlayer.emit('make_move', { pitIndex: 0, revision: startedByHost.state.revision, moveId: 'move-0001' });
    const accepted = await update;
    expect(accepted.moveResult?.steps[0]?.type).toBe('pickup');
    expect(accepted.state.revision).toBe(startedByHost.state.revision + 1);

    const duplicate = onceInvalidMove(activePlayer);
    activePlayer.emit('make_move', { pitIndex: 0, revision: startedByHost.state.revision, moveId: 'move-0001' });
    await expect(duplicate).resolves.toMatchObject({ reason: 'duplicate_move' });

    const stale = onceInvalidMove(waitingPlayer);
    waitingPlayer.emit('make_move', { pitIndex: 0, revision: startedByHost.state.revision, moveId: 'move-0002' });
    await expect(stale).resolves.toMatchObject({ reason: 'stale_revision' });
  });

  it('notifies clients when joining or reconnecting an unknown room fails', async () => {
    const url = await startServer();
    const client = await createClient(url);

    const invalidJoin = onceInvalidMove(client);
    client.emit('join_room', { roomCode: 'missing' });
    await expect(invalidJoin).resolves.toMatchObject({ reason: 'room_not_found' });

    const invalidReconnect = onceInvalidMove(client);
    client.emit('reconnect_room', { roomCode: 'missing', sessionToken: 'not-a-token' });
    await expect(invalidReconnect).resolves.toMatchObject({ reason: 'room_not_found' });
  });

  it('lets a player reconnect only with its session token', async () => {
    const url = await startServer();
    const playerOne = await createClient(url);
    const playerTwo = await createClient(url);
    const host = await createAndJoinRoom(playerOne, playerTwo);

    playerOne.close();
    const fakeClient = await createClient(url);
    const fakeReconnect = onceInvalidMove(fakeClient);
    fakeClient.emit('reconnect_room', { roomCode: host.room.roomCode, sessionToken: 'fake-token' });
    await expect(fakeReconnect).resolves.toMatchObject({ reason: 'room_not_found' });

    const reconnected = await createClient(url);
    const joined = onceRoomJoined(reconnected);
    const connection = oncePlayerReconnected(playerTwo);
    reconnected.emit('reconnect_room', { roomCode: host.room.roomCode, sessionToken: host.sessionToken });
    await expect(joined).resolves.toMatchObject({ playerIndex: 0, sessionToken: host.sessionToken });
    await expect(connection).resolves.toMatchObject({ playerIndex: 0 });
  });

  it('rejects moves without changing the game while the opponent is disconnected', async () => {
    const url = await startServer();
    const playerOne = await createClient(url);
    const playerTwo = await createClient(url);
    await createAndJoinRoom(playerOne, playerTwo);

    const disconnected = oncePlayerDisconnected(playerOne);
    playerTwo.close();
    const disconnectedState = await disconnected;
    expect(disconnectedState).toMatchObject({ playerIndex: 1 });

    const rejected = onceInvalidMove(playerOne);
    playerOne.emit('make_move', {
      pitIndex: 0,
      revision: disconnectedState.state.revision,
      moveId: 'move-0003',
    });
    const invalid = await rejected;
    expect(invalid.reason).toBe('player_disconnected');
    expect(invalid.state?.revision).toBe(disconnectedState.state.revision);
    expect(invalid.state?.game).toEqual(disconnectedState.state.game);
  });

  it('opens an expired player slot and alternates the rematch starting player', async () => {
    const url = await startServer({ reconnectWindowMs: 10, startingPlayerPicker: () => 0 });
    const playerOne = await createClient(url);
    const playerTwo = await createClient(url);
    const host = await createAndJoinRoom(playerOne, playerTwo);

    playerOne.close();
    await wait(30);
    const replacement = await createClient(url);
    const replacementStart = onceStart(replacement);
    const playerTwoStart = onceStart(playerTwo);
    const joined = onceRoomJoined(replacement);
    replacement.emit('join_room', { roomCode: host.room.roomCode });
    await expect(joined).resolves.toMatchObject({ playerIndex: 0 });
    const [replacementGame, playerTwoGame] = await Promise.all([replacementStart, playerTwoStart]);
    expect(replacementGame.state.game?.currentPlayer).toBe(0);
    expect(playerTwoGame.state.game?.currentPlayer).toBe(0);

    const finished = await playToFinish([replacement, playerTwo], replacementGame);
    expect(finished.state.status).toBe('finished');
    const firstRequest = onceRematchRequest(replacement);
    replacement.emit('rematch_request');
    await expect(firstRequest).resolves.toMatchObject({ requestedBy: [0] });
    const rematchForOne = onceRematchStart(replacement);
    const rematchForTwo = onceRematchStart(playerTwo);
    playerTwo.emit('rematch_request');
    const [rematchOne, rematchTwo] = await Promise.all([rematchForOne, rematchForTwo]);
    expect(rematchOne.state.game?.currentPlayer).toBe(1);
    expect(rematchTwo.state.game?.currentPlayer).toBe(1);
  });
});

async function startServer(options: Parameters<typeof createAppServer>[1] = {}): Promise<string> {
  activeServer = createAppServer('http://example.test', options);
  await new Promise<void>((resolve) => activeServer?.httpServer.listen(0, () => resolve()));
  const address = activeServer.httpServer.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function createAndJoinRoom(playerOne: ClientSocket, playerTwo: ClientSocket): Promise<RoomJoinedPayload> {
  const hostJoined = onceRoomJoined(playerOne);
  playerOne.emit('create_room', {});
  const host = await hostJoined;
  const hostStart = onceStart(playerOne);
  const guestStart = onceStart(playerTwo);
  const guestJoined = onceRoomJoined(playerTwo);
  playerTwo.emit('join_room', { roomCode: host.room.roomCode });
  await guestJoined;
  await Promise.all([hostStart, guestStart]);
  return host;
}

async function playToFinish(players: [ClientSocket, ClientSocket], initial: StateUpdatePayload): Promise<StateUpdatePayload> {
  let update = initial;
  for (let move = 0; move < 200 && update.state.status !== 'finished'; move += 1) {
    const game = update.state.game;
    if (game === null) throw new Error('Game unexpectedly stopped before finishing.');
    const pitIndex = game.pits[game.currentPlayer].findIndex((stones) => stones > 0);
    if (pitIndex < 0) throw new Error('Current player has no selectable pits.');
    const nextUpdate = onceStateUpdate(players[0]);
    players[game.currentPlayer].emit('make_move', {
      pitIndex,
      revision: update.state.revision,
      moveId: `rematch-move-${move.toString().padStart(4, '0')}`,
    });
    update = await nextUpdate;
  }
  return update;
}

async function createClient(url: string): Promise<ClientSocket> {
  const client: ClientSocket = connect(url, { forceNew: true, reconnection: false, transports: ['websocket'] });
  activeClients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('connect_error', reject);
  });
  return client;
}

function onceRoomJoined(socket: ClientSocket): Promise<RoomJoinedPayload> {
  return new Promise((resolve) => socket.once('room_joined', resolve));
}

function onceStart(socket: ClientSocket): Promise<StateUpdatePayload> {
  return new Promise((resolve) => socket.once('start_game', resolve));
}

function onceStateUpdate(socket: ClientSocket): Promise<StateUpdatePayload> {
  return new Promise((resolve) => socket.once('state_update', resolve));
}

function onceInvalidMove(socket: ClientSocket): Promise<InvalidMovePayload> {
  return new Promise((resolve) => socket.once('invalid_move', resolve));
}

function oncePlayerReconnected(socket: ClientSocket): Promise<{ playerIndex: 0 | 1 }> {
  return new Promise((resolve) => socket.once('player_reconnected', resolve));
}

function oncePlayerDisconnected(socket: ClientSocket): Promise<{ playerIndex: 0 | 1 }> {
  return new Promise((resolve) => socket.once('player_disconnected', resolve));
}

function onceRematchRequest(socket: ClientSocket): Promise<{ requestedBy: Array<0 | 1> }> {
  return new Promise((resolve) => socket.once('rematch_request', resolve));
}

function onceRematchStart(socket: ClientSocket): Promise<StateUpdatePayload> {
  return new Promise((resolve) => socket.once('rematch_start', resolve));
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
