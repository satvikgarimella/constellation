// Run with: node test/load.mjs
// Isolated loopback protocol test: 32 simulated workers submit synthetic pixels.
// This does not exercise browsers, phones, WebGPU, or path-tracing performance.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createApp } from '../server/index.js';
import { packResult } from '../public/scene.js';

const directory=await mkdtemp(join(tmpdir(),'constellation-scaling-'));
// Explicit empty service configuration keeps this test away from real accounts,
// even when the operator's shell already contains application credentials.
const app=createApp({port:0,host:'127.0.0.1',dataDir:directory,databaseUrl:null,apiKey:null,publicUrl:''});
const peers=[],failures=[];
const report={
  label:'Simulated WebSocket clients and deterministic test pixels on one computer; not phones, GPU rendering, or a speed benchmark.',
  checkedAt:new Date().toISOString(),
  method:'A separate coordinator on an ephemeral loopback port; 32 workers with sequential four-job batches, followed by disconnect recovery and a 100-session admission check.',
  tests:[],passed:false,
};
let maxBatchSize=0;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function bounded(promise,label,ms=10000) {
  let timer;
  try {return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Timed out: ${label}`)),ms);})]);}
  finally {clearTimeout(timer);}
}
async function until(predicate,timeout=15000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) {
    if(failures.length)throw failures[0];
    const value=predicate();if(value)return value;
    await pause(10);
  }
  throw new Error('Timed out waiting for protocol condition.');
}
async function request(url,options={}) {return fetch(url,{...options,signal:AbortSignal.timeout(5000)});}
async function healthy(origin) {
  const response=await request(`${origin}/healthz`);
  assert.equal(response.status,200);assert.equal((await response.json()).ok,true);return true;
}
function pixels(job) {
  const result=new Uint8Array(job.width*job.height*4);
  for(let i=0;i<result.length;i+=4) {result[i]=job.id%256;result[i+1]=Math.floor(job.id/256);result[i+2]=127;result[i+3]=255;}
  return result;
}
async function connect(port,room,{token,worker=false,index=0}={}) {
  const socket=new WebSocket(`ws://127.0.0.1:${port}/ws`,{handshakeTimeout:5000});
  const peer={socket,worker,index,clientId:null,queue:[],processing:false,frames:new Map(),sent:new Map(),dropOnRun:null,label:worker?`Simulated worker ${index}`:'Protocol viewer'};
  peers.push(peer);
  async function drain() {
    if(peer.processing)return;peer.processing=true;
    try {
      while(peer.queue.length&&socket.readyState===WebSocket.OPEN) {
        const job=peer.queue.shift();await pause(10+(index%5));
        if(socket.readyState!==WebSocket.OPEN)break;
        socket.send(packResult(job,pixels(job),10+(index%5)));
        peer.sent.set(job.runId,(peer.sent.get(job.runId)||0)+1);
      }
    } catch(error) {failures.push(error);} finally {peer.processing=false;}
  }
  socket.on('message',(data,binary)=>{
    try {
      if(binary) {
        assert.ok(data.length>=16);const runId=data.readUInt32LE(0),tileId=data.readUInt32LE(4);
        const received=peer.frames.get(runId)||new Set();
        assert.equal(received.has(tileId),false,'duplicate broadcast tile');received.add(tileId);peer.frames.set(runId,received);
        assert.equal(data.length,4112);assert.equal(data[16],tileId%256);assert.equal(data[17],Math.floor(tileId/256));assert.equal(data[18],127);assert.equal(data[19],255);
        return;
      }
      const message=JSON.parse(data);
      if(message.type==='error')throw new Error(message.message);
      if(message.type==='welcome') {
        peer.clientId=message.clientId;
        if(worker)socket.send(JSON.stringify({type:'contribute',enabled:true,backend:'cpu',batchSize:4}));
      }
      if(message.type==='job'||message.type==='jobs') {
        const jobs=message.jobs||[message.job];assert.ok(jobs.length>0&&jobs.length<=4);maxBatchSize=Math.max(maxBatchSize,jobs.length);
        assert.equal(worker,true,'viewer must never receive work');
        assert.equal(peer.queue.length,0,'no refill while queued work remains');
        if(peer.dropOnRun===jobs[0].runId) {socket.close(1000,'simulated participant leaving');return;}
        peer.queue.push(...jobs);drain();
      }
    } catch(error) {failures.push(error);}
  });
  socket.on('error',error=>failures.push(error));
  await bounded(once(socket,'open'),'WebSocket handshake');
  socket.send(JSON.stringify({type:'hello',roomId:room.roomId,token,label:peer.label}));
  await until(()=>peer.clientId);return peer;
}
async function closePeer(peer) {
  if(peer.socket.readyState===WebSocket.CLOSED)return;
  const closed=once(peer.socket,'close');peer.socket.close();await bounded(closed,'WebSocket close');
}

try {
  const port=await bounded(app.listen(),'test server start'),origin=`http://127.0.0.1:${port}`;
  await healthy(origin);
  const created=await request(`${origin}/api/rooms`,{method:'POST'});assert.equal(created.status,201);
  const roomInfo=await created.json(),host=await connect(port,roomInfo,{token:roomInfo.hostToken});
  const workers=await Promise.all(Array.from({length:32},(_,index)=>connect(port,roomInfo,{worker:true,index})));
  const room=app.coordinator.get(roomInfo.roomId);
  await until(()=>room.clients.size===33&&[...room.clients.values()].filter(client=>client.enabled).length===32);
  host.socket.send(JSON.stringify({type:'start',width:1024,samples:8,bounces:2}));
  await until(()=>room.run?.status==='complete'&&[host,...workers].every(peer=>peer.frames.get(1)?.size===1024));
  assert.equal(room.history[0].workers,32);assert.equal(room.run.results.size,1024);assert.equal(room.run.retries,0);assert.equal(room.run.completedPixels,1048576);assert.equal(room.run.inflight.size,0);assert.equal(room.run.pending.length,0);
  assert.ok(workers.every(peer=>(peer.sent.get(1)||0)>0));
  const contributionCounts=room.history[0].contributors.map(worker=>worker.tiles);
  report.tests.push({name:'32 active participants plus host',passed:true,connectedSessions:33,contributingWorkers:32,tiles:1024,completedPixels:1048576,retries:0,allClientsReceivedAllTiles:true,minimumTilesPerWorker:Math.min(...contributionCounts),maximumTilesPerWorker:Math.max(...contributionCounts),syntheticWorkloadSeconds:room.history[0].seconds,healthyAfterRun:await healthy(origin)});

  for(const peer of workers.slice(0,8))peer.dropOnRun=2;
  host.socket.send(JSON.stringify({type:'start',width:1024,samples:8,bounces:2}));
  const survivors=workers.slice(8);
  await until(()=>room.run?.id===2&&room.run.status==='complete'&&[host,...survivors].every(peer=>peer.frames.get(2)?.size===1024));
  assert.equal(room.history[0].initialWorkers.length,32);assert.equal(room.history[0].workers,24);assert.equal(room.run.retries,32);assert.equal(room.run.retryReasons.disconnected,32);assert.equal(room.run.results.size,1024);assert.equal(room.run.completedPixels,1048576);assert.equal(room.run.inflight.size,0);assert.equal(room.run.pending.length,0);
  report.tests.push({name:'Eight participants disconnect with four leased tiles each',passed:true,initialWorkers:32,disconnectedWorkers:8,remainingContributors:24,reassignedTiles:32,tiles:1024,allSurvivorsReceivedAllTiles:true,syntheticWorkloadSeconds:room.history[0].seconds,healthyAfterRecovery:await healthy(origin)});
  const events=(await readFile(join(directory,'events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(event=>event.type==='tile_completed').length,2048);assert.equal(events.filter(event=>event.type==='tile_reassigned').length,32);
  await Promise.all(peers.map(closePeer));await until(()=>room.clients.size===0);

  const capacityResponse=await request(`${origin}/api/rooms`,{method:'POST'});assert.equal(capacityResponse.status,201);
  const capacityInfo=await capacityResponse.json();
  for(let offset=0;offset<100;offset+=10)await Promise.all(Array.from({length:10},(_,i)=>connect(port,capacityInfo,{index:offset+i})));
  const capacityRoom=app.coordinator.get(capacityInfo.roomId);assert.equal(capacityRoom.clients.size,100);
  const excess=new WebSocket(`ws://127.0.0.1:${port}/ws`,{handshakeTimeout:5000});peers.push({socket:excess});
  await bounded(once(excess,'open'),'capacity probe handshake');
  const rejected=once(excess,'close');excess.send(JSON.stringify({type:'hello',roomId:capacityInfo.roomId,label:'101st simulated session'}));
  const [code,reason]=await bounded(rejected,'capacity rejection');
  assert.equal(code,1008);assert.equal(reason.toString(),'Room is full.');assert.equal(capacityRoom.clients.size,100);
  report.tests.push({name:'Configured room capacity',passed:true,acceptedSessions:100,rejectedSession:101,closeCode:code,closeReason:reason.toString(),renderingTestedAtThisCount:false,healthyAfterRejection:await healthy(origin)});
  await Promise.all(peers.map(closePeer));await until(()=>capacityRoom.clients.size===0);
  report.healthyAfterAllDisconnects=await healthy(origin);
  assert.equal(failures.length,0);report.maxObservedBatchSize=maxBatchSize;report.passed=true;
} catch(error) {
  // All inputs are generated locally; never include room tokens or full frames.
  report.error=error instanceof Error?error.message:'Protocol load test failed.';
  process.exitCode=1;
} finally {
  for(const peer of peers)if(peer.socket.readyState!==WebSocket.CLOSED)peer.socket.terminate();
  try {await bounded(app.close(),'test server shutdown');}
  catch {app.server.closeAllConnections();report.passed=false;report.cleanupError='Test server shutdown did not complete.';process.exitCode=1;}
  await rm(directory,{recursive:true,force:true});
  report.finishedAt=new Date().toISOString();
  const artifacts=new URL('../artifacts/',import.meta.url);
  await mkdir(artifacts,{recursive:true});
  await writeFile(new URL('load-report.json',artifacts),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
