import test from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../server/coordinator.js';
import { PRESETS, validateScene, sceneForMesh, packResult } from '../public/scene.js';

const socket=()=>({readyState:1,messages:[],send(value){this.messages.push(typeof value==='string'?JSON.parse(value):value);}});
const messages=(client,type)=>client.socket.messages.filter(message=>message?.type===type);
const jobs=client=>client.socket.messages.filter(message=>message?.type==='job'||message?.type==='jobs');
const scene=()=>sceneForMesh({name:'Cached model',triangles:[0,0,0,2,0,0,0,2,0]});
function setup() {
  let time=1000;const coordinator=new Coordinator({now:()=>time}),room=coordinator.createRoom();
  const connect=options=>coordinator.connect(room,socket(),options);
  const enable=(client,batchSize=4)=>coordinator.message(room,client,{type:'contribute',enabled:true,backend:'cpu',batchSize});
  const finishBatch=client=>{
    const batch=[...client.jobs.values()];assert.ok(batch.length);
    for(const job of batch){time+=1;assert.equal(coordinator.result(room,client,packResult(job,new Uint8Array(job.width*job.height*4),1)),true);}
  };
  return {coordinator,room,connect,enable,finishBatch};
}

test('cache clients get a full welcome and only receive the scene again after it changes',()=>{
  const h=setup(),cached=h.connect({sceneCache:true}),legacy=h.connect({});
  const welcome=messages(cached,'welcome')[0];
  assert.deepEqual(welcome.state.scene,PRESETS.aurora);assert.equal(welcome.state.sceneRevision,0);
  assert.ok(messages(cached,'state').every(message=>!Object.hasOwn(message.state,'scene')));
  h.coordinator.broadcast(h.room);h.coordinator.broadcast(h.room);
  assert.ok(messages(cached,'state').every(message=>!Object.hasOwn(message.state,'scene')));
  assert.ok(messages(legacy,'state').every(message=>Object.hasOwn(message.state,'scene')));
  h.coordinator.setScene(h.room,scene());
  const changed=messages(cached,'state').at(-1);assert.deepEqual(changed.state.scene,scene());assert.equal(changed.state.sceneRevision,1);
  h.coordinator.broadcast(h.room);
  const unchanged=messages(cached,'state').at(-1);assert.equal(Object.hasOwn(unchanged.state,'scene'),false);assert.equal(unchanged.state.sceneRevision,1);
  assert.deepEqual(messages(legacy,'state').at(-1).state.scene,scene());
  assert.deepEqual(h.coordinator.state(h.room).scene,scene(),'Per-client omission must not remove scene data from direct state/HTTP responses');
});

test('first cached batch contains the full scene, subsequent batches omit it, and each new run resets delivery',()=>{
  const h=setup(),client=h.connect({sceneCache:true});h.enable(client);
  h.coordinator.setScene(h.room,scene());h.coordinator.start(h.room,{width:256,samples:8});
  const first=jobs(client)[0];assert.equal(first.type,'jobs');assert.equal(first.jobs.length,4);
  assert.deepEqual(first.scene,scene());assert.equal(first.jobs[0].runId,1);
  h.finishBatch(client);const second=jobs(client).at(-1);
  assert.equal(Object.hasOwn(second,'scene'),false);assert.equal(second.jobs[0].runId,1);assert.deepEqual(second.settings,first.settings);
  h.coordinator.cancel(h.room);h.coordinator.start(h.room,{width:256,samples:8});
  const nextRun=jobs(client).at(-1);assert.equal(nextRun.jobs[0].runId,2);assert.deepEqual(nextRun.scene,scene());
  h.finishBatch(client);assert.equal(Object.hasOwn(jobs(client).at(-1),'scene'),false);
});

test('cached single-tile workers also receive geometry once per run and retain it across pause/resume',()=>{
  const h=setup(),client=h.connect({sceneCache:true});h.enable(client,1);
  h.coordinator.start(h.room,{width:256,samples:8});
  assert.equal(jobs(client)[0].type,'job');assert.ok(jobs(client)[0].scene);
  h.finishBatch(client);assert.equal(Object.hasOwn(jobs(client).at(-1),'scene'),false);
  h.coordinator.message(h.room,client,{type:'contribute',enabled:false});h.enable(client,1);
  assert.equal(Object.hasOwn(jobs(client).at(-1),'scene'),false);
  assert.equal(jobs(client).at(-1).job.runId,1);
});

test('legacy clients and non-boolean cache flags retain full scenes in every state and job',()=>{
  for(const options of [{},{sceneCache:false},{sceneCache:'true'}]){
    const h=setup(),client=h.connect(options);h.enable(client);
    h.coordinator.start(h.room,{width:256,samples:8});h.finishBatch(client);h.finishBatch(client);h.coordinator.broadcast(h.room);
    assert.ok(jobs(client).length>=3);
    for(const job of jobs(client))assert.deepEqual(job.scene,validateScene(PRESETS.aurora));
    assert.ok(messages(client,'state').every(message=>Object.hasOwn(message.state,'scene')));
  }
});

test('a cached late join and reconnection receive complete scene context before their first job',()=>{
  const h=setup(),first=h.connect({sceneCache:true});h.enable(first);
  h.coordinator.setScene(h.room,scene());h.coordinator.start(h.room,{width:256,samples:8});h.finishBatch(first);
  const late=h.connect({sceneCache:true});
  const welcome=messages(late,'welcome')[0];assert.deepEqual(welcome.state.scene,scene());assert.equal(welcome.state.run.completed,4);
  assert.equal(late.socket.messages.filter(Buffer.isBuffer).length,4,'Cached clients still receive completed pixel replay');
  h.enable(late);assert.deepEqual(jobs(late)[0].scene,scene());assert.equal(jobs(late)[0].jobs[0].runId,1);
  h.coordinator.disconnect(h.room,late);
  const reconnect=h.connect({sceneCache:true});h.enable(reconnect);
  assert.deepEqual(messages(reconnect,'welcome')[0].state.scene,scene());assert.deepEqual(jobs(reconnect)[0].scene,scene());
});
