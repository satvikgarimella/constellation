// Isolated UI acceptance with a stubbed Gemini provider and actual hardware
// WebGPU rendering. Every browser context shares this computer's GPU: measured
// times here verify the benchmark workflow, not physical-device speedup.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/index.js';
import {PRESETS,validateScene} from '../public/scene.js';
import {renderTileCPU} from '../public/raytracer.js';
import {median} from '../public/benchmark.js';

const output=new URL('../artifacts/',import.meta.url);
await mkdir(output,{recursive:true});
const dataDir=await mkdtemp(join(tmpdir(),'constellation-upgrades-'));
const report={startedAt:new Date().toISOString(),passed:false,checks:[],
  limitations:['Gemini provider is injected; no real Gemini service call is made.',
    'Two isolated browser contributors share one Mac GPU; this is not physical-device scaling evidence.'],
  pageErrors:[],consoleErrors:[],externalRequests:[]};
const generationCalls=[];
const app=createApp({port:0,host:'127.0.0.1',dataDir,databaseUrl:null,apiKey:'test-key',publicUrl:'',
  sceneGenerator:async input=>{
    generationCalls.push({mode:input.mode,prompt:input.prompt,currentScene:structuredClone(input.currentScene)});
    if(generationCalls.length===2)throw new Error('Controlled edit failure.');
    return validateScene({...input.currentScene,name:'Sunset City',skyTop:[0.45,0.12,0.08],skyBottom:[0.95,0.48,0.2],sun:[1,0.45,0.2],exposure:1.7});
  }});
let browser,stage='dependencies',base;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const passed=name=>{report.checks.push(name);console.log(`PASS ${name}`);};
const until=async(predicate,label,timeout=90000)=>{
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const value=await predicate();if(value)return value;await pause(50);}
  throw new Error(`Timed out: ${label}`);
};
const sceneResponse=(page,method)=>page.waitForResponse(response=>response.request().method()===method&&/\/api\/rooms\/[^/]+\/scene$/.test(new URL(response.url()).pathname));
const capture=page=>{
  page.setDefaultTimeout(30000);page.setDefaultNavigationTimeout(30000);
  page.on('pageerror',error=>report.pageErrors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push(message.text());});
};
async function createContext(options={}) {
  const context=await browser.newContext({reducedMotion:'reduce',...options});
  // No provider, CDN, telemetry, or unrelated website is allowed in this test.
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin!==base){report.externalRequests.push(`${url.origin}${url.pathname}`);return route.abort();}
    return route.continue();
  });
  return context;
}

try {
  // Fail before launch if parallel CAD implementation has not been saved yet.
  await readFile(new URL('../public/cad-import.js',import.meta.url));
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
  const port=await app.listen();base=`http://127.0.0.1:${port}`;
  browser=await chromium.launch({headless:true,args:JSON.parse(process.env.GPU_ARGS||'[]')});
  const hostContext=await createContext({viewport:{width:1440,height:1080}}),host=await hostContext.newPage();capture(host);
  const sentStarts=[];
  host.on('websocket',socket=>socket.on('framesent',event=>{
    if(typeof event.payload!=='string')return;
    const message=JSON.parse(event.payload);
    if(message.type==='start')sentStarts.push({bytes:Buffer.byteLength(event.payload),hasScene:Object.hasOwn(message,'scene')});
  }));
  stage='new_host';await host.goto(base);
  await host.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Live connection');
  assert.match(await host.title(),/^Host · /);
  const roomId=(await host.locator('#room-code').textContent()).trim();report.roomId=roomId;
  const state=async()=>{const response=await fetch(`${base}/api/rooms/${roomId}`);assert.equal(response.status,200);return response.json();};

  stage='preset_commit';
  const presetResponse=sceneResponse(host,'PUT');await host.locator('[data-preset="city"]').click();
  assert.equal((await presetResponse).status(),200);
  await host.waitForFunction(()=>document.querySelector('#scene-name')?.textContent==='Neon City');
  const city=(await state()).scene;assert.deepEqual(city,validateScene(PRESETS.city));
  assert.equal((await state()).sceneRevision,1);passed('Preset selection commits the validated scene to the server');

  stage='edit_current_scene';
  const editStarted=Date.now(),editResponse=sceneResponse(host,'POST');
  await host.locator('#prompt').fill('Keep the buildings and make the lighting sunset.');await host.locator('#edit-button').click();
  const editedResponse=await editResponse;assert.equal(editedResponse.status(),200);
  const edited=(await editedResponse.json()).scene;
  await host.waitForFunction(()=>document.querySelector('#scene-name')?.textContent==='Sunset City');
  assert.equal(generationCalls.length,1);assert.equal(generationCalls[0].mode,'edit');assert.deepEqual(generationCalls[0].currentScene,city);
  assert.deepEqual(edited.boxes,city.boxes);assert.deepEqual(edited.spheres,city.spheres);assert.notDeepEqual(edited.sun,city.sun);
  assert.deepEqual((await state()).scene,edited);assert.equal(await host.locator('#scene-undo').isEnabled(),true);
  passed('Edit current scene sends mode and current geometry, then accepts changed lighting');

  stage='undo_redo';
  const undoResponse=sceneResponse(host,'PUT');await host.locator('#scene-undo').click();assert.equal((await undoResponse).status(),200);
  await host.waitForFunction(()=>document.querySelector('#scene-name')?.textContent==='Neon City');assert.deepEqual((await state()).scene,city);
  const redoResponse=sceneResponse(host,'PUT');await host.locator('#scene-redo').click();assert.equal((await redoResponse).status(),200);
  await host.waitForFunction(()=>document.querySelector('#scene-name')?.textContent==='Sunset City');assert.deepEqual((await state()).scene,edited);
  passed('Undo and Redo restore matching browser and server scenes');

  stage='failed_edit_preserves_scene';
  await pause(Math.max(0,5200-(Date.now()-editStarted)));
  const beforeFailure=await state(),versionBefore=await host.locator('#scene-version').textContent();
  const failureResponse=sceneResponse(host,'POST');await host.locator('#prompt').fill('Controlled provider failure');await host.locator('#edit-button').click();
  assert.equal((await failureResponse).status(),400);
  await host.waitForFunction(()=>document.querySelector('#scene-action-status')?.textContent==='Controlled edit failure.');
  assert.equal(generationCalls.length,2);assert.deepEqual((await state()).scene,beforeFailure.scene);
  assert.equal((await state()).sceneRevision,beforeFailure.sceneRevision);assert.equal(await host.locator('#scene-version').textContent(),versionBefore);
  assert.equal(await host.locator('#edit-button').isEnabled(),true);passed('Failed AI edits preserve the accepted scene and history');

  stage='sample_model';
  const sampleResponse=sceneResponse(host,'PUT');await host.locator('#sample-model').click();assert.equal((await sampleResponse).status(),200);
  const sample=await until(async()=>{const value=await state();return value.scene.mesh&&value.scene.name==='demo-chair'&&value;},'sample mesh accepted');
  assert.ok(sample.scene.mesh.triangles.length>9);assert.equal(sample.scene.boxes.length,0);assert.equal(sample.scene.spheres.length,0);
  passed('Sample chair imports as actual mesh geometry');

  stage='file_upload';
  const chairBytes=await readFile(new URL('../public/models/demo-chair.obj',import.meta.url));
  const uploadResponse=sceneResponse(host,'PUT');
  await host.locator('#model-file').setInputFiles({name:'review-chair.obj',mimeType:'text/plain',buffer:chairBytes});
  assert.equal((await uploadResponse).status(),200);
  await host.waitForFunction(()=>document.querySelector('#scene-name')?.textContent==='review-chair');
  const uploaded=await state();assert.deepEqual(uploaded.scene.mesh.triangles,sample.scene.mesh.triangles);
  assert.equal(uploaded.scene.name,'review-chair');passed('File picker uploads and commits a real OBJ model');

  stage='invalid_model';
  const beforeInvalid=await state();
  await host.locator('#model-file').setInputFiles({name:'broken.obj',mimeType:'text/plain',buffer:Buffer.from('v 0 0 0\nf 1 2 3\n')});
  await host.waitForFunction(()=>document.querySelector('#scene-action-status')?.textContent.includes('unavailable vertex'));
  assert.deepEqual((await state()).scene,beforeInvalid.scene);assert.equal((await state()).sceneRevision,beforeInvalid.sceneRevision);
  assert.equal(await host.locator('#model-file').isEnabled(),true);passed('Invalid model input leaves the previous scene intact');
  const retryResponse=sceneResponse(host,'PUT');
  await host.locator('#model-file').setInputFiles({name:'review-chair.obj',mimeType:'text/plain',buffer:chairBytes});
  assert.equal((await retryResponse).status(),200);assert.deepEqual((await state()).scene,uploaded.scene);
  await host.waitForFunction(()=>document.querySelector('#scene-action-status')?.textContent.startsWith('review-chair ·'));
  await host.locator('#prompt').fill('Make this chair copper with warm studio lighting.');
  passed('A valid upload succeeds immediately after a rejected model');

  stage='two_hardware_workers';
  const workers=[];
  for(let index=0;index<2;index++){
    const context=await createContext({viewport:{width:390,height:844}}),page=await context.newPage();capture(page);
    const jobFrames=[];
    page.on('websocket',socket=>socket.on('framereceived',event=>{
      if(typeof event.payload!=='string')return;
      const message=JSON.parse(event.payload);
      if(message.type==='jobs'||message.type==='job')jobFrames.push({runId:(message.jobs?.[0]??message.job).runId,hasScene:Object.hasOwn(message,'scene'),bytes:Buffer.byteLength(event.payload)});
    }));
    await page.goto(`${base}/join/${roomId}`);await page.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Live connection');
    await page.locator('#device-name').fill(`Upgrade GPU ${index+1}`);await page.locator('#contribute-button').click();
    await page.waitForFunction(()=>document.querySelector('#backend-tag')?.textContent==='WEBGPU');
    const adapter=await page.evaluate(async()=>{const value=await navigator.gpu.requestAdapter();return {vendor:value.info?.vendor,architecture:value.info?.architecture,isFallbackAdapter:value.info?.isFallbackAdapter??value.isFallbackAdapter??null};});
    assert.equal(adapter.isFallbackAdapter,false);workers.push({page,adapter,jobFrames});
  }
  const ready=await until(async()=>{const value=await state();return value.deviceCounts.ready===2&&value;},'two GPU workers');
  const workerIds=ready.clients.filter(client=>client.enabled).map(client=>client.id);
  assert.ok(ready.clients.filter(client=>client.enabled).every(client=>client.backend==='webgpu'));
  report.adapters=workers.map(worker=>worker.adapter);passed('Two isolated hardware WebGPU workers opt in');

  stage='uploaded_mesh_render';
  await host.locator('[data-workload="preview"]').click();await host.locator('#render-button').click();
  const rendered=await until(async()=>{const value=await state();return value.run?.status==='complete'&&value;},'uploaded mesh render',120000);
  await host.waitForFunction(()=>document.querySelector('#render-status')?.textContent==='COMPLETE');
  assert.equal(rendered.run.completed,64);assert.equal(rendered.run.retries,0);assert.equal(rendered.run.contributors.length,2);
  assert.ok(rendered.run.contributors.every(worker=>worker.tiles>0&&worker.backend==='webgpu'));
  assert.deepEqual(rendered.scene,uploaded.scene);
  const pixels=Buffer.from(await host.locator('#render-canvas').evaluate(canvas=>Array.from(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data)));
  const reference=renderTileCPU(rendered.scene,rendered.run.settings,{x:0,y:0,width:256,height:256});
  assert.equal(pixels.length,reference.length);let difference=0;
  for(let i=0;i<pixels.length;i++){difference+=Math.abs(pixels[i]-reference[i]);if(i%4===3)assert.equal(pixels[i],255);}
  const pixelError=difference/pixels.length;assert.ok(pixelError<5,`Mesh GPU/CPU mean channel error ${pixelError}`);assert.ok(new Set(pixels).size>100);
  report.mesh={triangles:rendered.scene.mesh.triangles.length/9,tiles:rendered.run.completed,contributors:rendered.run.contributors,
    meanAbsoluteChannelError:pixelError,imageHash:createHash('sha256').update(pixels).digest('hex')};
  const png=await host.locator('#render-canvas').evaluate(canvas=>canvas.toDataURL('image/png').split(',')[1]);
  await writeFile(new URL('upgrades-chair.png',output),Buffer.from(png,'base64'));
  await host.locator('#toast').waitFor({state:'hidden'});
  await host.screenshot({path:new URL('upgrades-model-studio.png',output).pathname,fullPage:true});
  passed('Uploaded chair completes on both GPUs and matches CPU reference pixels');

  stage='repeated_scaling';
  await host.selectOption('#baseline-device',workerIds[0]);
  const baselineRun=rendered.run.id;
  await host.locator('#scaling-start').click();
  const locked=await host.evaluate(()=>Object.fromEntries(['edit-button','generate-button','model-file','sample-model','resolution','samples','baseline-device','compare-button','scene-undo'].map(id=>[id,document.getElementById(id).disabled])));
  assert.ok(Object.values(locked).every(Boolean),JSON.stringify(locked));
  await host.waitForFunction(()=>document.querySelector('#scaling-status')?.textContent.startsWith('Complete ·'),{},{timeout:120000});
  assert.equal((await state()).run.id-baselineRun,8,'Two cohorts require two warmups plus six measured renders');
  assert.equal(await host.locator('#scaling-results svg[role="img"]').count(),1);assert.equal(await host.locator('.scaling-table tbody tr').count(),2);
  assert.equal(await host.locator('#edit-button').isEnabled(),true);assert.equal(await host.locator('#scaling-export').isEnabled(),true);
  const downloadPromise=host.waitForEvent('download');await host.locator('#scaling-export').click();const download=await downloadPromise;
  const exportPath=new URL('upgrades-scaling-export.json',output).pathname;await download.saveAs(exportPath);
  const exported=JSON.parse(await readFile(exportPath,'utf8'));
  assert.equal(exported.status,'complete');assert.equal(exported.runs.length,8);assert.equal(exported.runs.filter(run=>run.warmup).length,2);
  assert.deepEqual(exported.summaries.map(summary=>summary.count),[1,2]);assert.ok(exported.summaries.every(summary=>summary.trials===3&&summary.complete));
  assert.equal(new Set(exported.runs.map(run=>run.fingerprint)).size,1);
  for(const summary of exported.summaries){
    const times=exported.runs.filter(run=>!run.warmup&&run.count===summary.count).map(run=>run.seconds);
    assert.equal(summary.medianSeconds,median(times));assert.equal(summary.minSeconds,Math.min(...times));assert.equal(summary.maxSeconds,Math.max(...times));
    assert.equal(summary.speedup,exported.summaries[0].medianSeconds/summary.medianSeconds);
  }
  assert.match(exported.method.hardware,/not proof of separate physical devices/);
  assert.equal(exported.runs.some(run=>run.contributors.length!==run.count),false);
  report.scaling={renderCount:8,measuredTrials:6,summaries:exported.summaries,controlsLocked:locked,hardwareCaveat:exported.method.hardware};
  await host.screenshot({path:new URL('upgrades-scaling-studio.png',output).pathname,fullPage:true});passed('Scaling benchmark completes eight honest renders with graph, medians, control locks, and export');

  stage='large_mesh_protocol';
  const previousRunId=(await state()).run.id;
  // Repeated faces keep the visible chair unchanged while exceeding the old
  // 32KB WebSocket request limit with a real 1,200-triangle validated scene.
  const largeResponse=sceneResponse(host,'PUT');
  await host.locator('#model-file').setInputFiles({name:'large-chair.obj',mimeType:'text/plain',buffer:Buffer.concat(Array.from({length:10},()=>chairBytes))});
  assert.equal((await largeResponse).status(),200);
  const largeScene=(await state()).scene;
  assert.equal(largeScene.mesh.triangles.length/9,1200);assert.ok(Buffer.byteLength(JSON.stringify(largeScene))>32768);
  await host.locator('#render-button').click();
  const largeRender=await until(async()=>{const value=await state();return value.run?.id>previousRunId&&value.run.status==='complete'&&value;},'large mesh render',120000);
  await host.waitForFunction(()=>document.querySelector('#render-status')?.textContent==='COMPLETE');
  assert.equal(largeRender.run.completed,64);assert.equal(largeRender.run.retries,0);assert.equal(largeRender.run.contributors.length,2);
  const largePixels=Buffer.from(await host.locator('#render-canvas').evaluate(canvas=>Array.from(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data)));
  assert.equal(largePixels.length,pixels.length);let duplicateDifference=0;
  for(let index=0;index<pixels.length;index++)duplicateDifference+=Math.abs(largePixels[index]-pixels[index]);
  const duplicateMeanError=duplicateDifference/pixels.length;assert.ok(duplicateMeanError<5,'Duplicated mesh faces must preserve the visible chair');
  assert.equal(sentStarts.at(-1).hasScene,false);assert.ok(sentStarts.at(-1).bytes<32768);
  const cachedJobs=workers.map(worker=>worker.jobFrames.filter(frame=>frame.runId===largeRender.run.id));
  for(const frames of cachedJobs){assert.ok(frames.length>1);assert.equal(frames[0].hasScene,true);assert.ok(frames[0].bytes>32768);assert.ok(frames.slice(1).every(frame=>!frame.hasScene));}
  report.largeMesh={triangles:1200,sceneBytes:Buffer.byteLength(JSON.stringify(largeScene)),startFrame:sentStarts.at(-1),workerJobFrames:cachedJobs,tiles:64,duplicateMeanError};
  passed('A scene larger than 32KB renders with small start messages and cached worker geometry');

  stage='viewer_permissions';
  const viewerContext=await createContext({viewport:{width:390,height:844}}),viewer=await viewerContext.newPage();capture(viewer);
  await viewer.goto(`${base}/r/${roomId}`);await viewer.waitForFunction(()=>document.querySelector('#studio-role')?.textContent==='Viewer');
  for(const id of ['edit-button','generate-button','model-file','sample-model','scene-undo','scene-redo','render-button','compare-button','scaling-start'])assert.equal(await viewer.locator(`#${id}`).isDisabled(),true,id);
  assert.equal(await viewer.locator('#viewer-banner').isVisible(),true);
  assert.equal(await viewer.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  passed('Viewer tabs cannot edit, import, render, or benchmark');

  stage='mobile_layout';
  await host.setViewportSize({width:390,height:844});
  assert.equal(await host.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Host studio must fit mobile width');
  await host.locator('#toast').waitFor({state:'hidden'});
  await host.screenshot({path:new URL('upgrades-mobile-host.png',output).pathname,fullPage:true});
  await workers[0].page.screenshot({path:new URL('upgrades-mobile-worker.png',output).pathname,fullPage:true});
  passed('Host and viewer layouts fit a 390px phone viewport');
  assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.externalRequests,[]);
  const unexpectedConsole=report.consoleErrors.filter(message=>!/^Failed to load resource: the server responded with a status of 400/.test(message));
  assert.deepEqual(unexpectedConsole,[],'Only the deliberate failed edit may log a resource error');
  report.providerCalls=generationCalls.length;report.passed=true;
} catch(error) {
  report.failure={stage,message:error.message};process.exitCode=1;
} finally {
  report.finishedAt=new Date().toISOString();
  await writeFile(new URL('upgrades-report.json',output),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  await browser?.close();await app.close();await rm(dataDir,{recursive:true,force:true});
}
