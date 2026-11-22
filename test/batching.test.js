import test from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../server/coordinator.js';
import { packResult } from '../public/scene.js';

const socket=()=>({readyState:1,messages:[],send(data){this.messages.push(typeof data==='string'?JSON.parse(data):data);}});
const frame=job=>packResult(job,new Uint8Array(job.width*job.height*4).fill(255),10);
const dispatches=client=>client.socket.messages.filter(message=>message.type==='job'||message.type==='jobs');
function setup() {
  let time=1000;
  const c=new Coordinator({now:()=>time,leaseMs:100}),r=c.createRoom();
  const host=c.connect(r,socket(),{token:r.hostToken,label:'Host'});
  const peer=c.connect(r,socket(),{label:'Phone'});
  const enable=(client,batchSize)=>c.message(r,client,{type:'contribute',enabled:true,backend:'webgpu',batchSize});
  const finish=(client,job=client.job)=>{assert.ok(job);time+=10;return c.result(r,client,frame(job));};
  return {c,r,host,peer,enable,finish,advance:ms=>{time+=ms;}};
}

test('batching is opt-in, bounded to four, and shares scene/settings once per dispatch',()=>{
  const {c,r,host,peer,enable}=setup();
  enable(host);enable(peer,1000);c.start(r,{width:256,samples:8});
  assert.equal(host.jobs.size,1);assert.equal(dispatches(host)[0].type,'job');
  assert.equal(peer.batchSize,4);assert.equal(peer.jobs.size,4);
  const batch=dispatches(peer)[0];
  assert.equal(batch.type,'jobs');assert.equal(batch.jobs.length,4);
  assert.deepEqual(batch.scene,r.run.scene);assert.deepEqual(batch.settings,r.run.settings);
  assert.ok(batch.jobs.every(job=>!Object.hasOwn(job,'scene')&&!Object.hasOwn(job,'settings')));
  assert.equal(new Set([...host.jobs.values(),...peer.jobs.values()].map(job=>job.id)).size,5);
  assert.equal(new Set([...host.jobs.values(),...peer.jobs.values()].map(job=>job.lease)).size,5);
  const state=c.state(r).clients.find(client=>client.id===peer.id);
  assert.equal(state.inflight,4);assert.equal(state.batchSize,4);assert.equal(state.busy,true);
});

test('invalid batch sizes remain single-job clients and fractional sizes stay bounded',()=>{
  for(const batchSize of [undefined,null,0,-1,NaN,Infinity,'4',true]) {
    const {c,r,host,enable}=setup();enable(host,batchSize);c.start(r,{width:256,samples:8});
    assert.equal(host.batchSize,1);assert.equal(host.jobs.size,1);assert.equal(dispatches(host)[0].type,'job');
  }
  const {c,r,host,enable}=setup();enable(host,3.9);c.start(r,{width:256,samples:8});
  assert.equal(host.batchSize,3);assert.equal(host.jobs.size,3);
});

test('each result is validated independently and only a drained batch receives more work',()=>{
  const {c,r,host,peer,enable,finish}=setup();enable(host,4);c.start(r,{width:256,samples:8});
  const original=[...host.jobs.values()],accepted=frame(original[2]);
  assert.equal(c.result(r,peer,accepted),false);
  assert.equal(c.result(r,host,packResult(original[0],new Uint8Array(4),10)),false);
  assert.equal(c.result(r,host,packResult(original[0],new Uint8Array(4096),NaN)),false);
  assert.equal(c.result(r,host,accepted),true,'a valid queued job can finish out of order');
  assert.equal(c.result(r,host,accepted),false,'a duplicate cannot add pixels or drain the batch twice');
  assert.equal(host.jobs.size,3);assert.equal(host.job.id,original[0].id);assert.equal(dispatches(host).length,1);
  finish(host,original[0]);finish(host,original[1]);
  assert.equal(host.jobs.size,1);assert.equal(dispatches(host).length,1);
  finish(host,original[3]);
  assert.equal(host.jobs.size,4);assert.equal(dispatches(host).length,2);
  assert.equal(r.run.results.size,4);assert.equal(host.tiles,4);assert.equal(host.pixels,4096);
  assert.ok([...host.jobs.values()].every(job=>!original.some(old=>old.id===job.id)));
});

test('pausing a partially completed batch reassigns only outstanding work with new leases',()=>{
  const {c,r,host,peer,enable,finish}=setup();enable(host,4);c.start(r,{width:256,samples:8});
  const completed=host.job;finish(host);const old=[...host.jobs.values()];
  c.message(r,host,{type:'contribute',enabled:false,reason:'page hidden'});
  assert.equal(host.job,null);assert.equal(host.jobs.size,0);assert.equal(r.run.inflight.size,0);
  assert.equal(r.run.retries,3);assert.equal(r.run.retryReasons['page hidden'],3);
  assert.equal(r.run.completedPixels,1024);assert.equal(r.run.pending.includes(completed.id),false);
  enable(peer,4);
  for(const job of old) {
    assert.equal(peer.jobs.has(job.id),true);assert.notEqual(peer.jobs.get(job.id).lease,job.lease);
    assert.equal(c.result(r,host,frame(job)),false);assert.equal(c.result(r,peer,frame(job)),false);
  }
  assert.equal(r.run.results.size,1);assert.equal(peer.tiles,0);
  assert.equal(r.run.pending.length+r.run.inflight.size+r.run.results.size,r.run.tiles.length);
});

test('disconnect releases the entire batch and repeated disconnects cannot duplicate pending work',()=>{
  const {c,r,host,peer,enable}=setup();enable(peer,4);c.start(r,{width:256,samples:8});
  const old=[...peer.jobs.values()];c.disconnect(r,peer);c.disconnect(r,peer);
  assert.equal(peer.jobs.size,0);assert.equal(peer.job,null);assert.equal(r.run.inflight.size,0);
  assert.equal(r.run.retries,4);assert.equal(r.run.retryReasons.disconnected,4);
  assert.equal(new Set(r.run.pending).size,64);assert.equal(r.run.pending.length,64);
  enable(host,4);assert.deepEqual([...host.jobs.keys()],old.map(job=>job.id));
  assert.ok([...host.jobs.values()].every(job=>!old.some(prior=>prior.lease===job.lease)));
});

test('progress renews queued leases while timeout pauses a stalled batch exactly once',()=>{
  const {c,r,host,peer,enable,finish,advance}=setup();enable(host,4);c.start(r,{width:256,samples:8});
  advance(80);finish(host);advance(20);c.tick();
  assert.equal(host.enabled,true,'progress must keep queued jobs alive beyond their initial lease');
  assert.equal(host.jobs.size,3);assert.equal(r.run.retries,0);
  const old=[...host.jobs.values()];advance(81);c.tick();
  assert.equal(host.enabled,false);assert.equal(host.jobs.size,0);assert.equal(host.job,null);
  assert.equal(host.socket.messages.filter(message=>message.type==='paused').length,1);
  assert.equal(r.run.retries,3);assert.equal(r.run.retryReasons.timeout,3);
  c.tick();assert.equal(host.socket.messages.filter(message=>message.type==='paused').length,1);
  enable(peer,4);
  for(const job of old) assert.equal(peer.jobs.has(job.id),true);
});

test('cancel clears every batch lease and old frames cannot contaminate a new run',()=>{
  const {c,r,host,peer,enable}=setup();enable(host,4);enable(peer,4);c.start(r,{width:256,samples:8});
  const old=[...host.jobs.values()].map(frame);c.cancel(r);
  assert.equal(host.jobs.size,0);assert.equal(peer.jobs.size,0);assert.equal(r.run.inflight.size,0);
  assert.equal(host.job,null);assert.equal(peer.job,null);
  c.start(r,{width:256,samples:8});
  assert.equal(host.jobs.size,4);assert.equal(peer.jobs.size,4);
  for(const bytes of old) assert.equal(c.result(r,host,bytes),false);
  assert.equal(r.run.results.size,0);assert.equal(host.tiles,0);assert.equal(r.run.inflight.size,8);
});

test('batched selected workers complete equal-work solo/crowd runs with honest counters',()=>{
  const {c,r,host,peer,enable,finish}=setup();enable(host,4);enable(peer,3);
  c.start(r,{width:256,samples:8,workerIds:[host.id]});
  assert.equal(peer.jobs.size,0);
  while(r.run.status==='running') finish(host);
  assert.equal(r.history[0].workers,1);assert.equal(dispatches(host).length,16);
  assert.equal(r.history[0].completedPixels,256*256);
  c.start(r,{width:256,samples:8,workerIds:[host.id,peer.id]});
  while(r.run.status==='running') {if(host.job)finish(host);if(peer.job)finish(peer);}
  const state=c.state(r),record=r.history[0];
  assert.equal(record.workers,2);assert.equal(record.completedPixels,256*256);
  assert.equal(record.pixelSamples,256*256*8);assert.equal(record.retries,0);
  assert.equal(record.contributors.reduce((sum,worker)=>sum+worker.tiles,0),64);
  assert.equal(host.jobs.size,0);assert.equal(peer.jobs.size,0);assert.equal(r.run.inflight.size,0);assert.equal(r.run.pending.length,0);
  assert.equal(state.benchmark.eligible,true);assert.equal(state.benchmark.speedup,1);
  assert.equal(state.benchmark.baselineWorkerId,host.id);
});
