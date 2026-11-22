// Opt-in live integration check: uses the running server's real Gemini key.
// It creates its own browser room and makes at most two generation requests.
// No credentials, request headers, or raw upstream errors are logged.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import { validateScene } from '../public/scene.js';
import { renderTileCPU } from '../public/raytracer.js';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.BASE_URL||'http://localhost:3210';
const directory=new URL('../artifacts/',import.meta.url);
const report={startedAt:new Date().toISOString(),base,passed:false,generationAttempts:[],database:{status:'not_checked'}};
let browser,stage='browser_launch',pageErrorCount=0,consoleErrorCount=0;
const until=async(predicate,label,timeout=45000)=>{
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const value=await predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,50));}
  throw new Error(`Timed out: ${label}`);
};

try {
  browser=await chromium.launch({headless:true,args:JSON.parse(process.env.GPU_ARGS||'[]')});
  const context=await browser.newContext({viewport:{width:1440,height:1080},reducedMotion:'reduce'});
  const page=await context.newPage();page.setDefaultTimeout(20000);
  page.on('pageerror',()=>pageErrorCount++);
  page.on('console',message=>{if(message.type()==='error')consoleErrorCount++;});
  stage='open_studio';
  await page.goto(base);
  await page.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Live connection');
  const roomId=(await page.locator('#room-code').textContent()).trim();report.roomId=roomId;
  const state=async()=>{const response=await fetch(`${base}/api/rooms/${roomId}`);assert.equal(response.ok,true);return response.json();};
  const configResponse=await fetch(`${base}/api/config`);assert.equal(configResponse.ok,true);
  const config=await configResponse.json();
  report.database={status:config.tigerData?'configured_not_verified':'pending_configuration',note:'Database verification is separate from this live Gemini/UI check.'};
  assert.equal(config.gemini,true,'The running server needs a Gemini key');
  assert.equal(await page.locator('#generate-button').isEnabled(),true);
  const initialScene=(await state()).scene;
  const prompt='Create a balanced still life of three spheres: one deep cobalt blue sphere, one copper metallic sphere, and one small warm ivory sphere on a dark ground plane. Use a pale peach sky and name it Cobalt and Copper.';
  await page.locator('#prompt').fill(prompt);
  stage='generate_scene';
  let generatedScene;
  for(let attempt=0;attempt<2;attempt++){
    const started=Date.now();
    const pending=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/rooms/${roomId}/scene`&&response.request().method()==='POST',{timeout:45000});
    await page.locator('#generate-button').click();
    const response=await pending;
    const body=await response.json().catch(()=>null);
    const result={attempt:attempt+1,httpStatus:response.status(),durationMs:Date.now()-started};
    // The server exposes an actionable sanitized message; retain only its code.
    const upstreamCode=typeof body?.error==='string'?body.error.match(/Gemini returned (\d{3})\./)?.[1]:null;
    if(upstreamCode)result.providerHttpStatus=Number(upstreamCode);
    report.generationAttempts.push(result);
    if(response.ok()){
      generatedScene=body?.scene;
      assert.deepEqual(generatedScene,validateScene(generatedScene),'HTTP response must already be normalized by the application');
      break;
    }
    const transient=[429,500,502,503,504].includes(result.providerHttpStatus??result.httpStatus);
    if(attempt||!transient)throw new Error('Scene generation did not return a successful HTTP response');
    // Respect the application's five-second generation throttle, with one retry.
    await new Promise(resolve=>setTimeout(resolve,Math.max(1000,5500-(Date.now()-started))));
  }
  assert.ok(generatedScene);assert.notDeepEqual(generatedScene,initialScene);
  await page.waitForFunction(name=>document.querySelector('#scene-name')?.textContent===name,generatedScene.name);
  assert.deepEqual((await state()).scene,generatedScene,'Room must hold the generated scene');
  report.gemini={status:'verified',source:'Actual Generate scene UI request to the running server',normalized:true,sceneName:generatedScene.name,sphereCount:generatedScene.spheres.length,sceneHash:createHash('sha256').update(JSON.stringify(generatedScene)).digest('hex')};

  stage='initialize_webgpu';
  await page.locator('#contribute-button').click();
  await page.waitForFunction(()=>document.querySelector('#backend-tag')?.textContent==='WEBGPU');
  const adapter=await page.evaluate(async()=>{const adapter=await navigator.gpu?.requestAdapter();return adapter?{vendor:adapter.info?.vendor,architecture:adapter.info?.architecture,isFallbackAdapter:adapter.info?.isFallbackAdapter??adapter.isFallbackAdapter??null}:null;});
  assert.ok(adapter);assert.notEqual(adapter.isFallbackAdapter,true);
  await page.selectOption('#resolution','256');await page.selectOption('#samples','8');
  stage='render_generated_scene';
  await page.locator('#render-button').click();
  const completed=await until(async()=>{const value=await state();return value.run?.status==='complete'&&value;},'generated scene render');
  await page.waitForFunction(()=>document.querySelector('#render-status')?.textContent==='COMPLETE');
  assert.equal(await page.locator('#backend-tag').textContent(),'WEBGPU');
  assert.deepEqual(completed.scene,generatedScene);assert.equal(completed.history[0].scene,generatedScene.name);
  assert.equal(completed.run.completed,64);assert.equal(completed.run.total,64);assert.equal(completed.history[0].backends,'webgpu');
  const pixels=Buffer.from(await page.locator('#render-canvas').evaluate(canvas=>Array.from(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data)));
  const expected=renderTileCPU(generatedScene,{width:256,height:256,samples:8,bounces:4},{x:0,y:0,width:256,height:256});
  assert.equal(pixels.length,256*256*4);
  let difference=0;for(let i=0;i<pixels.length;i++){difference+=Math.abs(pixels[i]-expected[i]);if(i%4===3)assert.equal(pixels[i],255);}
  const meanAbsoluteChannelError=difference/pixels.length,uniqueByteValues=new Set(pixels).size;
  assert.ok(meanAbsoluteChannelError<5,'Rendered image must match the generated scene reference');assert.ok(uniqueByteValues>100,'Rendered image must contain varied pixels');
  assert.equal(pageErrorCount,0);
  report.render={status:'verified',backend:'webgpu',adapter,width:256,height:256,samples:8,completedTiles:64,uniqueByteValues,meanAbsoluteChannelError,imageHash:createHash('sha256').update(pixels).digest('hex')};
  stage='save_evidence';
  await mkdir(directory,{recursive:true});
  await page.screenshot({path:new URL('gemini-ui.png',directory).pathname,fullPage:true});
  report.screenshot='artifacts/gemini-ui.png';report.passed=true;
} catch {
  report.failure={stage,code:'LIVE_UI_VERIFICATION_FAILED'};
  process.exitCode=1;
} finally {
  report.finishedAt=new Date().toISOString();report.pageErrorCount=pageErrorCount;report.consoleErrorCount=consoleErrorCount;
  await mkdir(directory,{recursive:true});await writeFile(new URL('gemini-ui-report.json',directory),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(report,null,2));await browser?.close();
}
