import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createApp } from '../server/index.js';
import { packResult } from '../public/scene.js';
import { renderTileCPU } from '../public/raytracer.js';

test('HTTP + WebSocket: real distributed rendering, owner access, replay, and telemetry', {timeout:30000}, async t=>{
  const directory=await mkdtemp(join(tmpdir(),'constellation-test-'));
  const app=createApp({port:0,host:'127.0.0.1',dataDir:directory,databaseUrl:null,apiKey:null});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const port=await app.listen(),base=`http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/healthz`)).status,200);
  const created=await(await fetch(`${base}/api/rooms`,{method:'POST'})).json();
  assert.match(created.roomId,/^[A-F0-9]{6}$/);
  const roomURL=`${base}/api/rooms/${created.roomId}`;
  const publicRoom=await(await fetch(roomURL)).json();assert.equal(publicRoom.hostToken,undefined);
  const denied=await fetch(`${roomURL}/scene`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"prompt":"hello"}'});
  assert.equal(denied.status,403);
  const qr=await fetch(`${base}/api/qr?room=${created.roomId}`);assert.match(await qr.text(),/<svg/);
  const css=await fetch(`${base}/styles.css`);assert.equal(css.status,200);
  const metrics=await(await fetch(`${roomURL}/metrics`)).json();assert.equal(metrics.source,'local');
  const sockets=[],contributions=new Map();
  async function client(token,work=true) {
    const socket=new WebSocket(`ws://127.0.0.1:${port}/ws`);sockets.push(socket);
    const log=[];let renderError;
    socket.on('message',(data,binary)=>{
      if(binary){log.push({type:'pixels',data});return;}
      const msg=JSON.parse(data);log.push(msg);
      if(msg.type==='job'&&work) {
        try {
          const pixels=renderTileCPU(msg.scene,msg.settings,msg.job);
          contributions.set(socket,(contributions.get(socket)||0)+1);
          setTimeout(()=>{if(socket.readyState===WebSocket.OPEN)socket.send(packResult(msg.job,pixels,5));},2);
        } catch(e) {renderError=e;}
      }
    });
    await once(socket,'open');socket.send(JSON.stringify({type:'hello',roomId:created.roomId,token,label:token?'Desktop':'Phone'}));
    await waitFor(()=>log.find(m=>m.type==='welcome'));
    return {socket,log,error:()=>renderError,send:msg=>socket.send(JSON.stringify(msg))};
  }
  const a=await client(created.hostToken),b=await client();
  b.send({type:'start',width:256,samples:8});await waitFor(()=>b.log.some(m=>m.type==='error'));
  a.send({type:'contribute',enabled:true,backend:'cpu'});b.send({type:'contribute',enabled:true,backend:'cpu'});
  await waitFor(()=>app.coordinator.get(created.roomId).clients.size===2&&[...app.coordinator.get(created.roomId).clients.values()].every(c=>c.enabled));
  a.send({type:'start',width:256,samples:8,bounces:2});
  await waitFor(()=>a.log.find(m=>m.type==='state'&&m.state.run?.status==='complete'),20000);
  assert.equal(a.error(),undefined);assert.equal(b.error(),undefined);
  assert.ok(contributions.get(a.socket)>0);assert.ok(contributions.get(b.socket)>0);
  const complete=await(await fetch(roomURL)).json();assert.equal(complete.run.completed,64);assert.equal(complete.history[0].workers,2);
  const viewer=await client(undefined,false);
  await waitFor(()=>viewer.log.filter(m=>m.type==='pixels').length===64);
  const events=(await readFile(join(directory,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e=>e.type==='tile_completed').length,64);
  assert.equal(events.filter(e=>e.type==='render_completed').length,1);
  for(const s of sockets)s.close();
});

async function waitFor(predicate,timeout=3000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const value=predicate();if(value)return value;await new Promise(r=>setTimeout(r,10));}
  throw new Error('Timed out waiting for the integration condition.');
}
