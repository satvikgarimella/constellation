// Real WebGPU and distributed UI regression, using isolated browser contexts
// on one machine. This is not a physical-phone performance benchmark.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/index.js';
import {renderTileCPU} from '../public/raytracer.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const directory=new URL('../artifacts/',import.meta.url);
await mkdir(directory,{recursive:true});
const dataDir=await mkdtemp(join(tmpdir(),'constellation-scenes-'));
const app=createApp({port:0,host:'127.0.0.1',dataDir,databaseUrl:null,apiKey:process.env.GENERATED_SCENE?'unused-test-key':null,publicUrl:''});
let browser;
const report={method:'Two isolated WebGPU browser contexts on one computer, full tile assembly and CPU reference comparison.',scenes:[],errors:[]};
try {
  const port=await app.listen(),base=`http://127.0.0.1:${port}`;
  browser=await chromium.launch({headless:true,args:JSON.parse(process.env.GPU_ARGS||'[]')});
  const host=await browser.newPage({viewport:{width:1440,height:1080},reducedMotion:'reduce'});
  host.setDefaultTimeout(30000);
  const capture=page=>{page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text());});};
  capture(host);
  await host.goto(base);await host.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Live connection');
  const roomId=(await host.locator('#room-code').textContent()).trim();
  const workers=[];
  for(let i=0;i<2;i++) {
    const context=await browser.newContext({viewport:{width:390,height:844},reducedMotion:'reduce'});
    const page=await context.newPage();capture(page);
    await page.goto(`${base}/join/${roomId}`);
    await page.locator('#device-name').fill(`Isolated GPU ${i+1}`);
    await page.locator('#contribute-button').click();
    await page.waitForFunction(()=>document.querySelector('#backend-tag')?.textContent==='WEBGPU',{},{timeout:30000});
    workers.push(page);
  }
  report.adapter=await host.evaluate(async()=>{const a=await navigator.gpu.requestAdapter();return{vendor:a.info.vendor,architecture:a.info.architecture,fallback:a.info.isFallbackAdapter};});
  const scenes=[{preset:'aurora',file:'aurora-desert'},{preset:'city',file:'neon-city'}];
  if(process.env.GENERATED_SCENE)scenes.push({scene:JSON.parse(await readFile(process.env.GENERATED_SCENE,'utf8')),file:'gemini-landscape'});
  for(const item of scenes) {
    if(item.preset)await host.locator(`[data-preset="${item.preset}"]`).click();
    else {
      // A live API response can be replayed through the actual generation UI
      // without making another paid request during this renderer regression.
      await host.route('**/api/rooms/*/scene',route=>{
        const room=app.coordinator.get(roomId);room.scene=item.scene;app.coordinator.broadcast(room);
        return route.fulfill({json:{scene:item.scene}});
      });
      await host.locator('#prompt').fill('A desert with northern lights');
      await host.locator('#generate-button').click();
      await host.waitForFunction(name=>document.querySelector('#scene-name')?.textContent===name,item.scene.name);
      await host.reload();
      await host.waitForFunction(()=>document.querySelector('#render-status')?.textContent==='SCENE READY');
      const viewer=await browser.newPage();
      await viewer.goto(`${base}/r/${roomId}`);
      await viewer.waitForFunction(()=>document.querySelector('#render-status')?.textContent==='SCENE READY');
      await viewer.close();
    }
    await host.locator('[data-workload="preview"]').click();
    assert.equal(await host.locator('#render-status').textContent(),'SCENE READY','A changed scene must not label the old image complete');
    const previousId=(await(await fetch(`${base}/api/rooms/${roomId}`)).json()).run?.id||0;
    const started=performance.now();
    await host.locator('#render-button').click();
    while(true) {
      const current=(await(await fetch(`${base}/api/rooms/${roomId}`)).json()).run;
      if(current?.id>previousId&&current.status==='complete')break;
      if(performance.now()-started>120000)throw new Error('Distributed render timed out');
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    await host.waitForFunction(()=>document.querySelector('#render-status')?.textContent==='COMPLETE',{},{timeout:120000});
    const elapsedMs=performance.now()-started;
    const state=await(await fetch(`${base}/api/rooms/${roomId}`)).json();
    assert.equal(state.run.completed,64);
    assert.equal(state.run.contributors.length,2,'Both independent workers must contribute actual tiles');
    for(const worker of workers)assert.equal(await worker.locator('#backend-tag').textContent(),'WEBGPU','No silent CPU fallback');
    if(item.preset==='aurora'){assert.equal(state.scene.spheres.length,0);assert.ok(state.scene.terrain.height>0);assert.ok(state.scene.aurora.strength>0);}
    if(item.preset==='city'){assert.equal(state.scene.spheres.length,0);assert.equal(state.scene.boxes.length,36);}
    const pixels=await host.locator('#render-canvas').evaluate(c=>Array.from(c.getContext('2d').getImageData(0,0,c.width,c.height).data));
    const cpuStarted=performance.now();
    const cpu=renderTileCPU(state.scene,state.run.settings,{x:0,y:0,width:256,height:256});
    const cpuReferenceMs=performance.now()-cpuStarted;
    const error=pixels.reduce((sum,v,i)=>sum+Math.abs(v-cpu[i]),0)/pixels.length;
    assert.ok(error<5,`${item.file} GPU/CPU mean absolute channel error ${error} is too large`);
    assert.ok(new Set(pixels).size>100,'Rendered image must not be blank');
    const data=await host.locator('#render-canvas').evaluate(c=>c.toDataURL('image/png').split(',')[1]);
    await writeFile(new URL(`${item.file}.png`,directory),Buffer.from(data,'base64'));
    await host.screenshot({path:new URL(`${item.file}-studio.png`,directory).pathname,fullPage:true});
    report.scenes.push({name:state.scene.name,preset:item.preset||'live-gemini-response',tiles:state.run.completed,workers:state.run.contributors.length,meanAbsolutePixelError:error,elapsedMs,cpuReferenceMs,settings:state.run.settings});
    console.log(JSON.stringify(report.scenes.at(-1)));
  }
  await host.setViewportSize({width:390,height:844});
  assert.equal(await host.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Studio must fit phone width');
  await host.screenshot({path:new URL('landscapes-mobile.png',directory).pathname,fullPage:true});
  assert.deepEqual(report.errors,[]);
  report.passed=true;
} catch(error) {report.passed=false;report.failure=error.message;throw error;}
finally {
  await writeFile(new URL('landscapes-report.json',directory),JSON.stringify(report,null,2));
  await browser?.close();await app.close();await rm(dataDir,{recursive:true,force:true});
}
