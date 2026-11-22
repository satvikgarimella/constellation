// Expanded compatibility evidence: public licensed CAD + original geometric
// fixtures. No credentials, external services, or physical-device speed claims.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/index.js';
import {renderTileCPU} from '../public/raytracer.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const fixtures=new URL('./fixtures/models/',import.meta.url),out=new URL('../artifacts/',import.meta.url);
const cases=[
  {file:'cadquery-cube-cylinder.step',name:'Curved STEP assembly',format:'STEP',source:'CadQuery Apache-2.0 sample at e87cba2232bd974fa569008dca7e5d71f0dc977c',minimumTriangles:20},
  {file:'hollow-gear.stl',name:'Hollow mechanical gear',format:'Binary STL',source:'Original deterministic CC0 validation fixture',expectedTriangles:640},
  {file:'hollow-vase.obj',name:'Hollow curved vase',format:'Triangulated OBJ',source:'Original deterministic CC0 validation fixture',expectedTriangles:1728}
];
const report={startedAt:new Date().toISOString(),passed:false,cases:[],checks:[],limitations:[
  'The user’s own CAD files were not available; this is representative public/synthetic model validation.',
  'Two isolated browser workers share one Mac GPU; this is not physical-phone compatibility or speedup evidence.',
  'Single material and flat shading are intentional. Original CAD colors/textures are not preserved.'
]};
const dataDir=await mkdtemp(join(tmpdir(),'constellation-corpus-'));
const app=createApp({port:0,host:'127.0.0.1',dataDir,databaseUrl:null,apiKey:null});
let browser,stage='start',pageErrors=[];
const until=async fn=>{const end=Date.now()+120000;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,100));}throw new Error('Timed out waiting for browser render');};
try{
  await mkdir(out,{recursive:true});const base=`http://127.0.0.1:${await app.listen()}`;
  browser=await chromium.launch({headless:true,args:JSON.parse(process.env.GPU_ARGS||'[]')});
  const host=await browser.newPage({viewport:{width:1440,height:1080},reducedMotion:'reduce'});host.setDefaultTimeout(60000);
  host.on('pageerror',e=>pageErrors.push(e.message));await host.goto(base);
  await host.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Live connection');
  const roomId=(await host.locator('#room-code').textContent()).trim();
  const state=async()=>(await fetch(`${base}/api/rooms/${roomId}`)).json();
  const adapters=[];
  for(let i=0;i<2;i++){
    const context=await browser.newContext();const page=await context.newPage();page.setDefaultTimeout(30000);
    page.on('pageerror',e=>pageErrors.push(e.message));await page.goto(`${base}/join/${roomId}`);
    await page.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Live connection');
    await page.locator('#device-name').fill(`Model validation GPU ${i+1}`);await page.locator('#contribute-button').click();
    await page.waitForFunction(()=>document.querySelector('#backend-tag')?.textContent==='WEBGPU');
    const adapter=await page.evaluate(async()=>{const a=await navigator.gpu.requestAdapter();return {vendor:a.info.vendor,architecture:a.info.architecture,isFallbackAdapter:a.info.isFallbackAdapter??a.isFallbackAdapter};});
    assert.equal(adapter.isFallbackAdapter,false);adapters.push(adapter);
  }
  report.adapters=adapters;await until(async()=>((await state()).deviceCounts.ready===2));
  const images=[];
  for(const entry of cases){
    stage=`${entry.format}: import`;
    const buffer=await readFile(new URL(entry.file,fixtures));
    if(entry.format==='STEP')assert.match(buffer.toString(),/CYLINDRICAL_SURFACE/);
    const ready=host.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname===`/api/rooms/${roomId}/scene`);
    const started=Date.now();await host.locator('#model-file').setInputFiles({name:entry.file,mimeType:'application/octet-stream',buffer});
    const response=await ready;assert.equal(response.ok(),true);const scene=(await response.json()).scene;
    const importMs=Date.now()-started;assert.ok(scene.mesh);const triangles=scene.mesh.triangles.length/9;
    if(entry.expectedTriangles)assert.equal(triangles,entry.expectedTriangles);else assert.ok(triangles>=entry.minimumTriangles);
    assert.equal(scene.spheres.length,0);assert.equal(scene.boxes.length,0);assert.ok(triangles<=10000);
    await host.waitForFunction(name=>document.querySelector('#scene-name')?.textContent===name,scene.name);
    const previous=(await state()).run?.id||0;
    stage=`${entry.format}: distributed WebGPU render`;
    await host.locator('[data-workload="preview"]').click();await host.locator('#render-button').click();
    const complete=await until(async()=>{const s=await state();return s.run?.id>previous&&s.run.status==='complete'&&s;});
    await host.waitForFunction(()=>document.querySelector('#render-status')?.textContent==='COMPLETE');
    assert.equal(complete.run.completed,64);assert.equal(complete.run.retries,0);assert.equal(complete.run.contributors.length,2);
    assert.ok(complete.run.contributors.every(c=>c.backend==='webgpu'&&c.tiles>0));assert.deepEqual(complete.scene,scene);
    stage=`${entry.format}: CPU pixel reference`;
    const pixels=Uint8ClampedArray.from(await host.locator('#render-canvas').evaluate(canvas=>Array.from(canvas.getContext('2d').getImageData(0,0,256,256).data)));
    const expected=renderTileCPU(scene,complete.run.settings,{x:0,y:0,width:256,height:256});
    assert.equal(pixels.length,expected.length);let error=0,maxError=0;
    for(let i=0;i<pixels.length;i++){const difference=Math.abs(pixels[i]-expected[i]);error+=difference;maxError=Math.max(maxError,difference);if(i%4===3)assert.equal(pixels[i],255);}
    const meanError=error/pixels.length;assert.ok(meanError<5);assert.ok(new Set(pixels).size>100);
    const dataURL=await host.locator('#render-canvas').evaluate(canvas=>canvas.toDataURL());
    const stem=entry.file.replace(/\.[^.]+$/,'');await writeFile(new URL(`model-corpus-${stem}.png`,out),Buffer.from(dataURL.split(',')[1],'base64'));
    images.push({title:entry.name,details:`${entry.format} · ${triangles.toLocaleString()} triangles`,dataURL});
    report.cases.push({...entry,bytes:buffer.length,sha256:createHash('sha256').update(buffer).digest('hex'),triangles,importMs,tiles:64,workers:complete.run.contributors.map(c=>({label:c.label,tiles:c.tiles,backend:c.backend})),meanAbsolutePixelError:meanError,maxChannelDifference:maxError,image:`artifacts/model-corpus-${stem}.png`,passed:true});
    console.log(`PASS ${entry.name}: ${triangles} triangles, GPU/CPU mean byte error ${meanError}`);
  }
  stage='invalid file preservation';const before=(await state()).scene;
  await host.locator('#model-file').setInputFiles({name:'broken.stl',mimeType:'application/octet-stream',buffer:Buffer.from('this is not an STL')});
  await host.waitForFunction(()=>document.querySelector('#scene-action-status')?.textContent.includes('valid')||document.querySelector('#scene-action-status')?.textContent.includes('Invalid'));
  assert.deepEqual((await state()).scene,before);report.checks.push('Invalid STL preserves the previously accepted scene');
  const sheet=await host.evaluate(async images=>{
    const canvas=document.createElement('canvas');canvas.width=1240;canvas.height=500;const c=canvas.getContext('2d');c.fillStyle='#101812';c.fillRect(0,0,1240,500);
    for(let i=0;i<images.length;i++){
      const x=20+i*410;c.fillStyle='#e1ebd9';c.font='bold 22px system-ui';c.fillText(images[i].title,x,35);c.fillStyle='#acc29d';c.font='15px system-ui';c.fillText(images[i].details,x,60);
      const image=new Image();image.src=images[i].dataURL;await image.decode();c.drawImage(image,x,80,390,390);
    }
    return canvas.toDataURL();
  },images);
  await writeFile(new URL('model-corpus-contact-sheet.png',out),Buffer.from(sheet.split(',')[1],'base64'));
  assert.deepEqual(pageErrors,[]);report.checks.push('No browser page errors');report.passed=true;
}catch(error){report.failure={stage,message:error.message};process.exitCode=1;console.error(`FAIL ${stage}: ${error.message}`);}
finally{
  await browser?.close();await app.close();await rm(dataDir,{recursive:true,force:true});report.finishedAt=new Date().toISOString();
  await writeFile(new URL('model-corpus-report.json',out),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,cases:report.cases.length,report:'artifacts/model-corpus-report.json'},null,2));
}
