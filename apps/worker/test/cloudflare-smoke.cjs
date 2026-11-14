const WebSocket = require('ws');
const assert = require('node:assert/strict');
const origin = process.env.SMOKE_ORIGIN || 'http://127.0.0.1:8787';
const wsUrl = (code) => origin.replace(/^http/, 'ws') + '/api/rooms/' + code + '/ws';
const delay = ms => new Promise(r => setTimeout(r,ms));
function client() {
  const events=[];
  let ws;
  return {
    events,
    async connect(code, event, payload) {
      ws = new WebSocket(wsUrl(code), {headers: { Origin: origin }});
      ws.on('message', raw => { try { events.push(JSON.parse(raw.toString())); } catch {} });
      await new Promise((resolve,reject)=>{ ws.once('open',resolve); ws.once('error',reject); });
      this.send(event,payload);
      return this;
    },
    send(event,payload){ ws.send(JSON.stringify({event,payload})); },
    async wait(event,n=0) {
      const until=Date.now()+8000;
      while(Date.now()<until){ const found=events.filter(e=>e.event===event); if(found.length>n) return found[n].payload; await delay(20); }
      throw new Error('Timed out waiting for '+event+' #'+n+'; got: '+JSON.stringify(events.map(e=>e.event)));
    },
    count(event){ return events.filter(e=>e.event===event).length; },
    close(){ if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000); }
  }
}
(async()=>{
  const res=await fetch(origin+'/api/rooms',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({playerName:'Tester A'})});
  if(res.status!==201) throw new Error('HTTP '+res.status+' '+await res.text());
  const created=await res.json();
  assert.match(created.roomCode,/^\d{6}$/);
  assert.match(created.sessionToken,/^[a-f0-9]{64}$/);
  const a=client(); let b=client();
  await a.connect(created.roomCode,'reconnect_room',created);
  const first=await a.wait('room_joined');
  assert.equal(first.playerIndex,0);
  await b.connect(created.roomCode,'join_room',{roomCode:created.roomCode,playerName:'Tester B'});
  const second=await b.wait('room_joined');
  assert.equal(second.playerIndex,1);
  let state=(await a.wait('start_game')).state;
  assert.equal(state.status,'playing');
  console.log('PASS: two players joined, game started, invite code',created.roomCode);
  const wrong=1-state.game.currentPlayer;
  [a,b][wrong].send('make_move',{pitIndex:0,revision:state.revision,moveId:'invalidwrong001'});
  const invalid=await [a,b][wrong].wait('invalid_move');
  assert.equal(invalid.reason,'not_your_turn');
  console.log('PASS: server rejected wrong player move');
  for(let i=0;i<200 && state.status!=='finished';i++){
    const turn=state.game.currentPlayer;
    const pit=state.game.pits[turn].findIndex(n=>n>0);
    assert.ok(pit>=0);
    const n=a.count('state_update');
    [a,b][turn].send('make_move',{pitIndex:pit,revision:state.revision,moveId:'move'+String(i).padStart(8,'0')});
    state=(await a.wait('state_update',n)).state;
    assert.equal(state.game.pits.flat().reduce((s,x)=>s+x,0)+state.game.stores[0]+state.game.stores[1],48);
    if(i===0){
      b.close();
      await a.wait('player_disconnected');
      const bn=client(); await bn.connect(created.roomCode,'reconnect_room',{roomCode:created.roomCode,sessionToken:second.sessionToken});
      const reconnect=await bn.wait('room_joined'); assert.equal(reconnect.playerIndex,1);
      await a.wait('player_reconnected');
      b=bn;
      console.log('PASS: disconnected player rejoined using token');
    }
  }
  assert.equal(state.status,'finished','game did not end');
  console.log('PASS: full game ended',state.game.winner);
  a.send('rematch_request'); await a.wait('rematch_request');
  b.send('rematch_request');
  const again=await a.wait('rematch_start');
  assert.equal(again.state.round,2);
  assert.equal(again.state.status,'playing');
  console.log('PASS: rematch started');
  a.close();(globalThis.recovered||b).close();
})().catch(e=>{console.error('FAIL:',e);process.exitCode=1;});
