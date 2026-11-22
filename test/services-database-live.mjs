// Opt-in real-service check. Run only against the intended live app:
// BASE_URL=https://your-studio.example node test/services-database-live.mjs
// Optional: PLAYWRIGHT_MODULE and GPU_ARGS, as in test/webgpu.mjs.
// Creates one fresh room, renders 64 real WebGPU tiles, and verifies persisted
// analytics. It leaves those telemetry events in the configured database.
// No Gemini calls or direct database credentials are used. One local Chromium
// context is correctness evidence, not a physical-phone or crowd-speed test.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';

const directory=new URL('../artifacts/',import.meta.url);
const report={
  startedAt:new Date().toISOString(),passed:false,
  scope:'Real application WebGPU render to configured database analytics, using one isolated Chromium context on this computer; not physical-phone evidence.',
  sideEffects:'Creates one room and retains its render telemetry in the configured database.',
};
let browser,stage='validate_target',pageErrorCount=0,consoleErrorCount=0;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function json(url,label) {
  const response=await fetch(url,{signal:AbortSignal.timeout(10000)});
  assert.equal(response.ok,true,`${label} HTTP request must succeed`);
  return response.json();
}
async function until(predicate,label,timeout=45000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) {
    const value=await predicate();if(value)return value;
    await pause(250);
  }
  throw new Error(`Timed out: ${label}`);
}

try {
  assert.ok(process.env.BASE_URL,'Set BASE_URL explicitly to opt into the real-service test');
  const target=new URL(process.env.BASE_URL);
  assert.ok(['http:','https:'].includes(target.protocol),'BASE_URL must use HTTP or HTTPS');
  assert.ok(!target.username&&!target.password&&!target.search&&!target.hash&&target.pathname==='/','BASE_URL must be an origin without credentials, paths, or query parameters');
  assert.ok(target.protocol==='https:'||['127.0.0.1','localhost','[::1]'].includes(target.hostname),'Remote targets require HTTPS');
  const base=target.origin;report.base=base;

  stage='database_readiness';
  const config=await json(`${base}/api/config`,'Configuration');
  report.configuration={tigerData:config.tigerData===true,databaseReady:config.databaseReady===true};
  assert.equal(config.tigerData,true,'The running app must have a database configured');
  assert.equal(config.databaseReady,true,'Wait for the running app to report databaseReady before this test');

  stage='browser_launch';
  const args=JSON.parse(process.env.GPU_ARGS||'[]');
  assert.ok(Array.isArray(args)&&args.every(value=>typeof value==='string'),'GPU_ARGS must be a JSON array of Chromium arguments');
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
  browser=await chromium.launch({headless:true,args,timeout:20000});
  const context=await browser.newContext({viewport:{width:1440,height:1080},reducedMotion:'reduce'});
  const page=await context.newPage();page.setDefaultTimeout(20000);page.setDefaultNavigationTimeout(20000);
  // Count errors without retaining raw URLs, headers, provider errors, or secrets.
  page.on('pageerror',()=>pageErrorCount++);
  page.on('console',message=>{if(message.type()==='error')consoleErrorCount++;});

  stage='fresh_host_room';
  await page.goto(base);
  await page.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Live connection');
  const roomId=(await page.locator('#room-code').textContent()).trim();
  assert.match(roomId,/^[A-F0-9]{6}$/);report.roomId=roomId;
  const state=()=>json(`${base}/api/rooms/${roomId}`,'Room state');
  const initial=await state();assert.equal(initial.run,null);assert.equal(initial.clients.length,1);
  const workerId=initial.clients[0].id;

  stage='initialize_webgpu';
  await page.locator('#device-name').fill('Live database GPU verifier');
  await page.locator('#contribute-button').click();
  await page.waitForFunction(()=>document.querySelector('#backend-tag')?.textContent==='WEBGPU');
  const adapter=await page.evaluate(async()=>{
    const value=await navigator.gpu?.requestAdapter();
    return value?{vendor:value.info?.vendor,architecture:value.info?.architecture,isFallbackAdapter:value.info?.isFallbackAdapter??value.isFallbackAdapter??null}:null;
  });
  assert.ok(adapter,'WebGPU must expose an adapter');
  assert.notEqual(adapter.isFallbackAdapter,true,'Use a hardware WebGPU adapter for this check');
  await page.selectOption('#resolution','256');await page.selectOption('#samples','8');

  stage='render';
  await page.locator('#render-button').click();
  const completed=await until(async()=>{const value=await state();return value.run?.status==='complete'&&value;},'GPU render completion');
  await page.waitForFunction(()=>document.querySelector('#render-status')?.textContent==='COMPLETE');
  assert.equal(await page.locator('#backend-tag').textContent(),'WEBGPU');
  assert.equal(completed.run.completed,64);assert.equal(completed.run.total,64);assert.equal(completed.run.completedPixels,65536);
  assert.equal(completed.run.inflight,0);assert.equal(completed.run.retries,0);
  assert.equal(completed.history[0].backends,'webgpu');assert.equal(completed.history[0].workers,1);
  const contributors=completed.run.contributors;
  assert.deepEqual(contributors.map(worker=>worker.id),[workerId]);
  assert.equal(contributors[0].tiles,64);assert.equal(contributors[0].pixels,65536);
  const pixels=Buffer.from(await page.locator('#render-canvas').evaluate(canvas=>Array.from(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data)));
  assert.equal(pixels.length,256*256*4);
  for(let i=3;i<pixels.length;i+=4)assert.equal(pixels[i],255,'All rendered pixels must be present');
  const uniqueByteValues=new Set(pixels).size;assert.ok(uniqueByteValues>100,'The image must contain varied rendered pixels');
  report.render={backend:'webgpu',adapter,runId:completed.run.id,width:256,height:256,samples:8,completedTiles:64,completedPixels:65536,workerIds:[workerId],uniqueByteValues,imageHash:createHash('sha256').update(pixels).digest('hex')};

  stage='persisted_metrics';
  const metrics=await until(async()=>{
    const value=await json(`${base}/api/rooms/${roomId}/metrics`,'Database metrics');
    if(value.source!=='postgres')return false;
    assert.ok(Array.isArray(value.workers));
    assert.ok(value.workers.every(worker=>worker.worker_id===workerId),'Persisted metrics must identify the actual rendering worker');
    const tiles=value.workers.reduce((sum,worker)=>sum+worker.tiles,0),pixelCount=value.workers.reduce((sum,worker)=>sum+worker.pixels,0);
    assert.ok(tiles<=64&&pixelCount<=65536,'Persisted metrics must not count duplicate work');
    return tiles===64&&pixelCount===65536&&value;
  },'64 persisted tiles and 65,536 pixels');
  assert.equal(metrics.source,'postgres');assert.equal(metrics.workers.length,1);
  assert.deepEqual(metrics.workers.map(worker=>worker.worker_id),contributors.map(worker=>worker.id));
  assert.equal(metrics.workers[0].tiles,contributors[0].tiles);assert.equal(metrics.workers[0].pixels,contributors[0].pixels);
  assert.ok(Number.isFinite(metrics.workers[0].average_ms)&&metrics.workers[0].average_ms>=0);
  report.database={
    status:'verified',source:metrics.source,tiles:64,pixels:65536,
    workers:metrics.workers.map(worker=>({workerId:worker.worker_id,tiles:worker.tiles,pixels:worker.pixels,averageMs:worker.average_ms})),
    check:'Actual application render events were written and returned by the database-backed metrics endpoint for the same fresh room and contributor.',
    providerIdentity:'PostgreSQL connectivity alone does not identify the provider; confirm the configured service in Tiger Console.',
  };

  stage='save_evidence';
  await page.waitForFunction(()=>document.querySelector('#telemetry-label')?.textContent==='TIGER DATA'&&document.querySelector('#db-metrics')?.textContent.includes('64 completed tiles'));
  assert.equal(pageErrorCount,0,'No browser page errors are allowed');
  assert.equal(consoleErrorCount,0,'No browser console errors are allowed');
  await mkdir(directory,{recursive:true});
  await page.screenshot({path:new URL('database-ui.png',directory).pathname,fullPage:true,timeout:10000});
  assert.equal(pageErrorCount,0);assert.equal(consoleErrorCount,0);
  report.screenshot='artifacts/database-ui.png';report.passed=true;
} catch {
  report.failure={stage,code:'LIVE_DATABASE_UI_VERIFICATION_FAILED'};
  process.exitCode=1;
} finally {
  try {await browser?.close();}
  catch {report.passed=false;report.failure={stage:'browser_cleanup',code:'BROWSER_CLOSE_FAILED'};process.exitCode=1;}
  if(pageErrorCount||consoleErrorCount) {report.passed=false;report.failure??={stage:'browser_errors',code:'BROWSER_ERRORS_OBSERVED'};process.exitCode=1;}
  report.finishedAt=new Date().toISOString();report.pageErrorCount=pageErrorCount;report.consoleErrorCount=consoleErrorCount;
  await mkdir(directory,{recursive:true});
  await writeFile(new URL('database-ui-report.json',directory),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(report,null,2));
}
