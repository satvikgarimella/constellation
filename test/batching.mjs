// Real-browser queue regression. Every render runs sequentially on one computer;
// this is correctness evidence, not a measurement of physical-device scaling.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import { PRESETS,validateScene } from '../public/scene.js';
import { renderTileCPU } from '../public/raytracer.js';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.BASE_URL||'http://localhost:3210';
const browser=await chromium.launch({headless:true,args:JSON.parse(process.env.GPU_ARGS||'[]')});
const directory=new URL('../artifacts/',import.meta.url);
const errors=[],notices=[],report={base,passed:false,scope:'Sequential browser correctness on one computer; no physical crowd-speed claim.'};
const until=async(predicate,label,timeout=45000)=>{
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const result=await predicate();if(result)return result;await new Promise(resolve=>setTimeout(resolve,25));}
  throw new Error(`Timed out: ${label}`);
};
const hash=pixels=>createHash('sha256').update(pixels).digest('hex');
const key=job=>`${job.runId}:${job.id}:${job.lease}`;

// Observe actual Worker dispatches without replacing the renderer or transport.
// The optional action clicks a real UI control immediately after a render has
// been posted, making pause/cancel deterministic while three jobs remain queued.
function installProbe(){
  const probe=window.__batchProbe={workers:[],batches:[],requests:[],actions:[],nextAction:null};
  const NativeWebSocket=window.WebSocket,NativeWorker=window.Worker;
  window.WebSocket=class extends NativeWebSocket {
    constructor(...args){
      super(...args);
      this.addEventListener('message',({data})=>{
        if(typeof data!=='string')return;
        const message=JSON.parse(data);
        if(message.type==='job'||message.type==='jobs')probe.batches.push({type:message.type,jobs:(message.jobs||[message.job]).map(({runId,id,lease})=>({runId,id,lease,dispatched:false}))});
      });
    }
  };
  window.Worker=class extends NativeWorker {
    constructor(...args){
      super(...args);
      this.record={id:probe.workers.length,active:0,maxActive:0,terminated:false,backends:[],requests:0,results:0};
      probe.workers.push(this.record);
      this.addEventListener('message',({data})=>{
        if(data.type==='result'||data.type==='error'){this.record.active--;this.record.results++;}
        if(data.backend)this.record.backends.push(data.backend);
      });
    }
    postMessage(message,...args){
      if(message.type==='render'){
        const {runId,id,lease}=message.job;
        this.record.active++;this.record.requests++;this.record.maxActive=Math.max(this.record.maxActive,this.record.active);
        const request={runId,id,lease,workerId:this.record.id,sequence:probe.requests.length};probe.requests.push(request);
        const batch=probe.batches.find(batch=>batch.jobs.some(job=>job.runId===runId&&job.id===id&&job.lease===lease));
        const assigned=batch?.jobs.find(job=>job.id===id&&job.lease===lease);if(assigned)assigned.dispatched=true;
        if(probe.nextAction){
          const action=probe.nextAction;probe.nextAction=null;
          probe.actions.push({action,workerId:this.record.id,requestSequence:request.sequence,active:this.record.active,queuedInBatch:batch?.jobs.filter(job=>!job.dispatched).length??0,batchJobs:batch?.jobs.map(job=>({...job}))||[]});
          queueMicrotask(()=>document.querySelector(action==='pause'?'#contribute-button':'#stop-button').click());
        }
      }
      return super.postMessage(message,...args);
    }
    terminate(){this.record.terminated=true;this.record.active=0;return super.terminate();}
  };
}

async function openWorker(query='',label='GPU batched'){
  const context=await browser.newContext({viewport:{width:1440,height:1080},reducedMotion:'reduce'});
  await context.addInitScript(installProbe);
  const page=await context.newPage();page.setDefaultTimeout(20000);
  page.on('pageerror',error=>errors.push(`${label}: ${error.message}`));
  page.on('console',message=>{if(message.type()==='error')errors.push(`${label}: ${message.text()}`);if(message.type()==='info')notices.push(`${label}: ${message.text()}`);});
  await page.goto(`${base}/${query}`);
  await page.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Live connection');
  const roomId=(await page.locator('#room-code').textContent()).trim();
  const state=async()=>{const response=await fetch(`${base}/api/rooms/${roomId}`);assert.equal(response.ok,true);return response.json();};
  await page.locator('#device-name').fill(label);await page.locator('#contribute-button').click();
  const backend=query.includes('cpu=1')?'CPU WORKER':'WEBGPU';
  await page.waitForFunction(expected=>document.querySelector('#backend-tag')?.textContent===expected,backend);
  return {page,context,roomId,state,backend};
}

async function startRender(worker,{preset='orbit',width=256,samples=8,action=null}={}){
  const before=await worker.state(),runId=(before.run?.id||0)+1;
  await worker.page.locator(`[data-preset=${preset}]`).click();
  await worker.page.selectOption('#resolution',String(width));await worker.page.selectOption('#samples',String(samples));
  if(action)await worker.page.evaluate(action=>{window.__batchProbe.nextAction=action;},action);
  await worker.page.locator('#render-button').click();
  return runId;
}

async function complete(worker,runId){
  const state=await until(async()=>{const state=await worker.state();return state.run?.id===runId&&state.run.status==='complete'&&state;},`run ${runId} completes`);
  await worker.page.waitForFunction(()=>document.querySelector('#render-status')?.textContent==='COMPLETE');
  assert.equal(await worker.page.locator('#backend-tag').textContent(),worker.backend,'Rendering must not silently change backend');
  assert.equal(state.run.completed,state.run.total);assert.equal(state.run.inflight,0);
  assert.equal(state.history[0].backends,worker.backend==='WEBGPU'?'webgpu':'cpu');
  const pixels=Buffer.from(await worker.page.locator('#render-canvas').evaluate(canvas=>Array.from(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data)));
  for(let i=3;i<pixels.length;i+=4)assert.equal(pixels[i],255,'Every final pixel must be present');
  return {state,pixels,hash:hash(pixels)};
}

function compareCPU(pixels,preset,width=256,samples=8){
  const expected=renderTileCPU(validateScene(PRESETS[preset]),{width,height:width,samples,bounces:4},{x:0,y:0,width,height:width});
  assert.equal(pixels.length,expected.length);
  let difference=0;for(let i=0;i<pixels.length;i++)difference+=Math.abs(pixels[i]-expected[i]);
  return {expected:Buffer.from(expected),meanAbsoluteChannelError:difference/pixels.length};
}

function checkProbe(probe,{backend,batchSize}){
  assert.ok(probe.requests.length>0,'The real renderer must receive jobs');
  assert.ok(probe.batches.some(batch=>batch.jobs.length===batchSize),`Expected batches of ${batchSize}`);
  assert.ok(probe.batches.every(batch=>batch.jobs.length<=batchSize),'Coordinator must bound every batch');
  for(const worker of probe.workers){
    assert.ok(worker.maxActive<=1,`Worker ${worker.id} overlapped ${worker.maxActive} render operations`);
    assert.ok(worker.active>=0,'Each result must correspond to an active request');
    assert.ok(worker.backends.every(value=>value===backend),'Backend must remain stable through batching and restarts');
  }
  for(const action of probe.actions){
    assert.equal(action.active,1);assert.equal(action.queuedInBatch,3,'Control must run with pending jobs in the four-tile batch');
    assert.equal(probe.workers[action.workerId].terminated,true,'Pause/cancel must terminate the active worker');
    const discarded=new Set(action.batchJobs.map(key));
    assert.equal(probe.requests.some(request=>request.sequence>action.requestSequence&&discarded.has(key(request))),false,'A cleared queue must never dispatch an old lease after resume');
  }
  return {workersCreated:probe.workers.length,renderRequests:probe.requests.length,maximumConcurrentRequests:Math.max(...probe.workers.map(worker=>worker.maxActive)),largestBatch:Math.max(...probe.batches.map(batch=>batch.jobs.length)),controls:probe.actions.map(({action,queuedInBatch})=>({action,queuedInBatch}))};
}

try {
  const gpu=await openWorker();
  report.adapter=await gpu.page.evaluate(async()=>{const adapter=await navigator.gpu.requestAdapter();return adapter?{vendor:adapter.info?.vendor,architecture:adapter.info?.architecture,isFallbackAdapter:adapter.info?.isFallbackAdapter??adapter.isFallbackAdapter??null}:null;});
  assert.ok(report.adapter,'This regression requires WebGPU');assert.notEqual(report.adapter.isFallbackAdapter,true,'Use a hardware WebGPU adapter');
  const baseline=await complete(gpu,await startRender(gpu));
  const baselineCPU=compareCPU(baseline.pixels,'orbit');assert.ok(baselineCPU.meanAbsoluteChannelError<5,`GPU/reference difference ${baselineCPU.meanAbsoluteChannelError}`);
  const pausedRun=await startRender(gpu,{action:'pause'});
  const paused=await until(async()=>{const state=await gpu.state();return state.run?.id===pausedRun&&state.run.status==='running'&&state.deviceCounts.eligible===0&&state.run.inflight===0&&state;},'pause releases every lease');
  assert.equal(paused.run.retries,4);assert.equal(await gpu.page.locator('#backend-tag').textContent(),'STANDBY');
  await gpu.page.locator('#contribute-button').click();await gpu.page.waitForFunction(()=>document.querySelector('#backend-tag')?.textContent==='WEBGPU');
  const resumed=await complete(gpu,pausedRun);assert.deepEqual(resumed.pixels,baseline.pixels,'Paused/resumed GPU image must exactly match uninterrupted GPU output');
  const cancelledRun=await startRender(gpu,{action:'cancel'});
  await until(async()=>{const state=await gpu.state();return state.run?.id===cancelledRun&&state.run.status==='cancelled'&&state.run.inflight===0;},'cancel releases every lease');
  await gpu.page.waitForFunction(()=>document.querySelector('#backend-tag')?.textContent==='WEBGPU');
  const afterCancel=await complete(gpu,await startRender(gpu,{preset:'solstice',samples:16}));
  const nextCPU=compareCPU(afterCancel.pixels,'solstice',256,16);assert.ok(nextCPU.meanAbsoluteChannelError<5,'Next render must use its new scene/settings without stale tiles');
  assert.notEqual(afterCancel.hash,baseline.hash);
  report.gpuBatched={...checkProbe(await gpu.page.evaluate(()=>window.__batchProbe),{backend:'webgpu',batchSize:4}),initialHash:baseline.hash,resumedHash:resumed.hash,nextSceneHash:afterCancel.hash,referenceMeanError:baselineCPU.meanAbsoluteChannelError,nextSceneReferenceMeanError:nextCPU.meanAbsoluteChannelError,pauseRecoveredTiles:resumed.state.run.retries};
  await gpu.context.close();

  const gpuSerial=await openWorker('?batch=1','GPU serial');
  const serial=await complete(gpuSerial,await startRender(gpuSerial));
  assert.deepEqual(serial.pixels,baseline.pixels,'Batched GPU image must exactly match one-tile-at-a-time GPU output');
  report.gpuSerial={...checkProbe(await gpuSerial.page.evaluate(()=>window.__batchProbe),{backend:'webgpu',batchSize:1}),hash:serial.hash};
  await gpuSerial.context.close();

  let cpuBaseline;
  report.cpu=[];
  for(const batchSize of [1,4]){
    const cpu=await openWorker(`?cpu=1&batch=${batchSize}`,`CPU batch ${batchSize}`);
    const result=await complete(cpu,await startRender(cpu,{preset:'solstice'}));
    const reference=compareCPU(result.pixels,'solstice');assert.deepEqual(result.pixels,reference.expected,'CPU browser image must exactly match the full reference image');
    if(cpuBaseline)assert.deepEqual(result.pixels,cpuBaseline,'CPU batching must preserve every pixel');else cpuBaseline=result.pixels;
    report.cpu.push({batchSize,...checkProbe(await cpu.page.evaluate(()=>window.__batchProbe),{backend:'cpu',batchSize}),hash:result.hash});
    await cpu.context.close();
  }
  assert.deepEqual(errors,[]);report.passed=true;
} catch(error) {
  report.failure=error.message;throw error;
} finally {
  report.consoleErrors=errors;report.notices=notices;
  await mkdir(directory,{recursive:true});await writeFile(new URL('batching-browser-report.json',directory),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));await browser.close();
}
