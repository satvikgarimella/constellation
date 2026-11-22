import test from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../server/coordinator.js';
import { packResult } from '../public/scene.js';

const socket=()=>({readyState:1,messages:[],send(data){this.messages.push(typeof data==='string'?JSON.parse(data):data);}});
function setup() {
  let time=1000;
  const c=new Coordinator({now:()=>time,leaseMs:100}),r=c.createRoom();
  const host=c.connect(r,socket(),{token:r.hostToken,label:'Host'});
  const peer=c.connect(r,socket(),{label:'Phone'});
  const enable=client=>c.message(r,client,{type:'contribute',enabled:true,backend:'cpu'});
  const finish=client=>{const j=client.job;assert.ok(j);time+=10;return c.result(r,client,packResult(j,new Uint8Array(j.width*j.height*4).fill(255),10));};
  return {c,r,host,peer,enable,finish,advance:ms=>{time+=ms;}};
}

test('faster workers pull more tiles, a joining worker gets work, and the run completes',()=>{
  const {c,r,host,peer,enable,finish}=setup();
  enable(host);c.message(r,host,{type:'start',width:256,samples:8});
  for(let i=0;i<4;i++) assert.equal(finish(host),true);
  enable(peer);assert.ok(peer.job);assert.notEqual(host.job.id,peer.job.id);
  while(r.run.status==='running') {if(host.job)finish(host);if(host.job)finish(host);if(peer.job)finish(peer);}
  assert.equal(r.run.results.size,64);assert.equal(r.run.inflight.size,0);assert.equal(r.run.pending.length,0);
  assert.ok(host.tiles>peer.tiles);assert.equal(r.history[0].workers,2);
  assert.equal(r.history[0].backends,'cpu');
});

test('disconnect reassigns a lease and rejects late, duplicate, malformed, and wrong-worker results',()=>{
  const {c,r,host,peer,enable,finish}=setup();
  enable(host);enable(peer);c.start(r,{width:256,samples:8});
  const old={...peer.job},oldFrame=packResult(old,new Uint8Array(old.width*old.height*4),10);
  assert.equal(c.result(r,host,oldFrame),false);
  assert.equal(c.result(r,peer,new Uint8Array(4)),false);
  assert.equal(c.result(r,peer,packResult(old,new Uint8Array(4),10)),false);
  assert.equal(c.result(r,peer,packResult(old,new Uint8Array(old.width*old.height*4),NaN)),false);
  c.disconnect(r,peer);assert.equal(r.run.retries,1);finish(host);
  assert.equal(host.job.id,old.id);assert.notEqual(host.job.lease,old.lease);
  assert.equal(c.result(r,peer,oldFrame),false);assert.equal(c.result(r,host,oldFrame),false);
  const accepted=packResult(host.job,new Uint8Array(host.job.width*host.job.height*4),10);
  assert.equal(c.result(r,host,accepted),true);assert.equal(c.result(r,host,accepted),false);
  assert.equal(r.run.results.size,2);
});

test('expired workers are paused and their work becomes available to another worker',()=>{
  const {c,r,host,peer,enable,advance}=setup();
  enable(host);c.start(r,{width:256,samples:8});const old=host.job;
  advance(101);c.tick();assert.equal(host.enabled,false);assert.equal(host.job,null);
  assert.ok(host.socket.messages.some(m=>m.type==='paused'));
  enable(peer);assert.equal(peer.job.id,old.id);assert.notEqual(peer.job.lease,old.lease);
});

test('only an owner can start/cancel and cancelled results cannot contaminate the next run',()=>{
  const {c,r,host,peer,enable}=setup();enable(peer);
  assert.throws(()=>c.message(r,peer,{type:'start'}),/owner/);
  c.message(r,host,{type:'start',width:256,samples:8});
  const old=packResult(peer.job,new Uint8Array(peer.job.width*peer.job.height*4),10);
  assert.throws(()=>c.message(r,peer,{type:'cancel'}),/owner/);
  c.message(r,host,{type:'cancel'});assert.equal(r.run.status,'cancelled');
  c.message(r,host,{type:'start',width:256,samples:8});assert.equal(r.run.id,2);
  assert.equal(c.result(r,peer,old),false);assert.equal(r.run.results.size,0);
});

test('late viewers receive all completed pixels and ownership without host privileges',()=>{
  const {c,r,host,enable,finish}=setup();enable(host);c.start(r,{width:256,samples:8});finish(host);finish(host);
  const s=socket();c.connect(r,s,{token:'incorrect'});
  assert.equal(s.messages[0].isHost,false);assert.equal(s.messages[0].state.run.completed,2);
  assert.equal(s.messages.filter(m=>Buffer.isBuffer(m)).length,2);
  assert.equal(s.messages.find(m=>m.type==='tile-owners').owners.length,2);
});

test('explicit selection keeps ready outsiders waiting and produces a comparable solo/crowd pair',()=>{
  const {c,r,host,peer,enable,finish}=setup();enable(host);enable(peer);
  c.message(r,host,{type:'start',width:256,samples:8,workerIds:[peer.id]});
  assert.equal(host.job,null);assert.ok(peer.job);
  const newcomer=c.connect(r,socket(),{label:'Another phone'});enable(newcomer);assert.equal(newcomer.job,null);
  while(r.run.status==='running') finish(peer);
  assert.equal(r.history[0].workers,1);assert.equal(r.history[0].contributors[0].id,peer.id);
  assert.deepEqual(r.history[0].workerIds,[peer.id]);
  assert.equal(c.state(r).benchmark.reason,'solo_baseline');
  c.message(r,host,{type:'start',width:256,samples:8,workerIds:[peer.id,newcomer.id]});
  assert.equal(host.job,null);
  while(r.run.status==='running') {if(peer.job)finish(peer);if(newcomer.job)finish(newcomer);}
  const state=c.state(r);
  assert.equal(state.benchmark.eligible,true);assert.equal(state.benchmark.baselineWorkerId,peer.id);
  assert.equal(state.benchmark.baselineRunId,1);assert.equal(state.benchmark.crowdRunId,2);
  assert.equal(state.benchmark.speedup,1,'equal elapsed times must report 1×, not invent speedup');
  assert.equal(state.deviceCounts.ready,3);assert.equal(state.deviceCounts.eligible,2);assert.equal(state.deviceCounts.contributing,2);
});

test('invalid worker selection cannot accidentally launch a different set of devices',()=>{
  const {c,r,host,peer,enable}=setup();enable(peer);
  for(const workerIds of [[],[host.id],['unknown'],'all']) assert.throws(()=>c.message(r,host,{type:'start',workerIds}),/selected|Select/);
  assert.equal(r.run,null);
  c.message(r,host,{type:'start',workerIds:[peer.id,peer.id]});
  assert.deepEqual(r.run.workerIds,[peer.id]);assert.equal(host.job,null);assert.ok(peer.job);
});

test('completed work counters use accepted pixels and samples, including retry details',()=>{
  const {c,r,host,peer,enable,finish}=setup();enable(host);enable(peer);
  c.start(r,{width:256,samples:32});finish(host);
  const before=c.state(r);assert.equal(before.run.completedPixels,1024);assert.equal(before.run.pixelSamples,32768);
  assert.equal(before.run.pixelSamplesPerSecond,3276800);assert.equal(before.run.startedAt,1000);
  c.message(r,peer,{type:'contribute',enabled:false,reason:'page hidden'});
  const after=c.state(r);assert.equal(after.run.retries,1);assert.equal(after.run.retryReasons['page hidden'],1);
  assert.equal(after.run.lastReassignment.label,'Phone');assert.equal(after.run.lastReassignment.reason,'page hidden');
  assert.equal(after.run.completedPixels,1024,'uncompleted/reassigned tiles do not increase throughput');
  assert.equal(typeof r.events.find(e=>e.type==='tile_reassigned').time,'string');
});

test('backend changes are retained in completed history instead of mislabelling a fallback',()=>{
  const {c,r,host,enable,finish}=setup();enable(host);c.message(r,host,{type:'contribute',enabled:true,backend:'webgpu'});
  c.start(r,{width:256,samples:8});finish(host);
  c.message(r,host,{type:'contribute',enabled:true,backend:'cpu'});
  while(r.run.status==='running') finish(host);
  assert.equal(r.history[0].backends,'cpu+webgpu');
  assert.deepEqual(r.history[0].contributors[0].backends,['cpu','webgpu']);
});

test('showcase settings accept 2048 resolution and 512 samples while keeping bounded jobs',()=>{
  const {c,r,peer,enable}=setup();enable(peer);
  c.start(r,{width:2048,samples:512});
  assert.equal(r.run.tiles.length,4096);assert.equal(peer.job.width,32);assert.equal(peer.job.height,32);
  c.cancel(r);assert.throws(()=>c.start(r,{width:4096,samples:512}),/settings/);
});
