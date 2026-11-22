import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/index.js';
import { PRESETS, validateScene, sceneForMesh, packResult } from '../public/scene.js';
import { MAX_MESH_TRIANGLES } from '../public/mesh.js';

const triangle = [0,0,0,2,0,0,0,2,0];
const modelScene = () => sceneForMesh({name:'Uploaded design',triangles:[...triangle],color:[0.7,0.4,0.2]});
const deferred = () => {let resolve;const promise=new Promise(value=>{resolve=value;});return {promise,resolve};};

async function fixture(t, options={}) {
  const directory=await mkdtemp(join(tmpdir(),'constellation-scene-api-'));
  const app=createApp({port:0,host:'127.0.0.1',dataDir:directory,databaseUrl:null,apiKey:null,...options});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const port=await app.listen(),base=`http://127.0.0.1:${port}`;
  const created=await (await fetch(`${base}/api/rooms`,{method:'POST'})).json();
  const room=app.coordinator.get(created.roomId),url=`${base}/api/rooms/${created.roomId}`;
  const request=(method,value,token=created.hostToken)=>fetch(`${url}/scene`,{method,
    headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(value)});
  const get=async()=>await (await fetch(url)).json();
  const contributor=()=>{
    const client=app.coordinator.connect(room,{readyState:1,send(){}},{label:'API test worker'});
    app.coordinator.message(room,client,{type:'contribute',enabled:true,backend:'cpu',batchSize:4});return client;
  };
  const finish=client=>{
    while(room.run?.status==='running'){
      const job=client.jobs.values().next().value;assert.ok(job);
      assert.equal(app.coordinator.result(room,client,packResult(job,new Uint8Array(job.width*job.height*4),1)),true);
    }
  };
  return {app,room,url,request,get,contributor,finish};
}

test('owner PUT validates and stores an uploaded mesh; public GET exposes scene revision', {timeout:10000}, async t=>{
  const f=await fixture(t),initial=await f.get();
  assert.equal(initial.sceneRevision,0);assert.equal(initial.hostToken,undefined);
  const input=modelScene();input.exposure=999;input.mesh.metal=2;input.mesh.color=[4,-1,0.3];
  const response=await f.request('PUT',{scene:input,revision:initial.sceneRevision});
  assert.equal(response.status,200);const accepted=await response.json(),expected=validateScene(input);
  assert.deepEqual(accepted.scene,expected);assert.equal(accepted.revision,1);
  assert.equal(accepted.scene.exposure,3);assert.equal(accepted.scene.mesh.metal,1);
  assert.deepEqual(accepted.scene.mesh.triangles,triangle);
  const current=await f.get();assert.deepEqual(current.scene,expected);assert.equal(current.sceneRevision,1);
  assert.equal(current.hostToken,undefined);
  const stale=await f.request('PUT',{scene:PRESETS.city,revision:0});
  assert.equal(stale.status,409);assert.deepEqual((await f.get()).scene,expected);
  assert.equal((await f.get()).sceneRevision,1,'Rejected writes cannot advance the revision');
});

test('viewers cannot upload or generate scenes and failed validation preserves the current scene', {timeout:10000}, async t=>{
  let calls=0;const f=await fixture(t,{sceneGenerator:async()=>{calls++;return validateScene(PRESETS.city);}});
  for(const token of [null,'viewer-token'])for(const method of ['PUT','POST']){
    const response=await f.request(method,{scene:modelScene(),mode:'edit',prompt:'Make it sunset'},token);
    assert.equal(response.status,403);await response.arrayBuffer();
  }
  const before=await f.get();
  for(const scene of [
    {spheres:[],boxes:[]},
    {...modelScene(),mesh:{triangles:[0,0,0,0,0,0,0,0,0]}},
    {...modelScene(),mesh:{triangles:[0,0,0,2,0,0,0,null,0]}},
    {...modelScene(),mesh:{triangles:Array.from({length:MAX_MESH_TRIANGLES+1},()=>triangle).flat()}},
  ]){
    const response=await f.request('PUT',{scene,revision:0});assert.equal(response.status,400);await response.arrayBuffer();
    const after=await f.get();assert.deepEqual(after.scene,before.scene);assert.equal(after.sceneRevision,0);
  }
  assert.equal(calls,0);
});

test('oversized scene requests are rejected without changing the room', {timeout:10000}, async t=>{
  const f=await fixture(t),before=await f.get();
  const response=await f.request('PUT',{scene:modelScene(),padding:'x'.repeat(2*1024*1024)});
  assert.equal(response.status,400);assert.match((await response.json()).error,/too large/i);
  const after=await f.get();assert.deepEqual(after.scene,before.scene);assert.equal(after.sceneRevision,0);
});

test('scene upload and AI editing are denied while a render is active', {timeout:10000}, async t=>{
  let calls=0;const f=await fixture(t,{sceneGenerator:async()=>{calls++;return validateScene(PRESETS.city);}});
  f.contributor();f.app.coordinator.start(f.room,{width:256,samples:8});const before=await f.get();
  for(const method of ['PUT','POST']){
    const response=await f.request(method,{scene:modelScene(),mode:'edit',prompt:'Make it sunset'});
    assert.equal(response.status,409);await response.arrayBuffer();
  }
  assert.equal(calls,0);assert.equal(f.room.run.status,'running');
  assert.deepEqual((await f.get()).scene,before.scene);assert.equal(f.room.sceneRevision,0);
});

test('edit API supplies the accepted scene and mode to the injected generator', {timeout:10000}, async t=>{
  const calls=[];
  const f=await fixture(t,{sceneGenerator:async input=>{calls.push(input);return validateScene({...input.currentScene,name:'Sunset design',sun:[1,0.3,0.1]});}});
  const upload=await f.request('PUT',{scene:modelScene(),revision:0});assert.equal(upload.status,200);await upload.arrayBuffer();
  const previous=(await f.get()).scene;
  const response=await f.request('POST',{mode:'edit',prompt:'Keep the model, make it sunset',revision:1});
  assert.equal(response.status,200);const accepted=await response.json();
  assert.equal(calls.length,1);assert.equal(calls[0].mode,'edit');assert.equal(calls[0].apiKey,null);
  assert.equal(calls[0].prompt,'Keep the model, make it sunset');assert.deepEqual(calls[0].currentScene,previous);
  assert.deepEqual(accepted.scene.mesh,previous.mesh);assert.equal(accepted.scene.name,'Sunset design');assert.equal(accepted.revision,2);
  assert.equal((await f.get()).sceneRevision,2);
});

test('a generated response cannot overwrite a newer manually accepted scene', {timeout:10000}, async t=>{
  const entered=deferred(),pending=deferred();
  const f=await fixture(t,{sceneGenerator:async input=>{entered.resolve(input);return pending.promise;}});
  t.after(()=>pending.resolve(validateScene(PRESETS.lunar)));
  const request=f.request('POST',{mode:'edit',prompt:'Make it sunset',revision:0});await entered.promise;
  const manual=await f.request('PUT',{scene:modelScene(),revision:0});assert.equal(manual.status,200);await manual.arrayBuffer();
  const saved=await f.get();pending.resolve(validateScene(PRESETS.lunar));
  const response=await request;assert.equal(response.status,409);assert.match((await response.json()).error,/while Gemini/);
  assert.deepEqual((await f.get()).scene,saved.scene);assert.equal((await f.get()).sceneRevision,1);
});

test('a generated response is rejected if a render starts, including one that finishes before Gemini', {timeout:15000}, async t=>{
  for(const completeBeforeReply of [false,true])await t.test(completeBeforeReply?'render already finished':'render still running',async sub=>{
    const entered=deferred(),pending=deferred();
    const f=await fixture(sub,{sceneGenerator:async()=>{entered.resolve();return pending.promise;}});
    sub.after(()=>pending.resolve(validateScene(PRESETS.lunar)));
    const worker=f.contributor(),request=f.request('POST',{mode:'edit',prompt:'Make it sunset',revision:0});await entered.promise;
    f.app.coordinator.start(f.room,{width:256,samples:8});
    if(completeBeforeReply)f.finish(worker);
    const renderedScene=structuredClone(f.room.scene),revision=f.room.sceneRevision;
    pending.resolve(validateScene(PRESETS.lunar));const response=await request;
    assert.equal(response.status,409);await response.arrayBuffer();
    assert.deepEqual((await f.get()).scene,renderedScene);assert.equal(f.room.sceneRevision,revision);
    assert.equal(f.room.run.status,completeBeforeReply?'complete':'running');
  });
});
