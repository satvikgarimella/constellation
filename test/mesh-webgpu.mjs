// Real shader regression in an isolated browser. No external services or secrets.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/index.js';
import {parseModel} from '../public/mesh.js';
import {sceneForMesh,validateScene,PRESETS,createTiles} from '../public/scene.js';
import {renderTileCPU} from '../public/raytracer.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const dataDir=await mkdtemp(join(tmpdir(),'constellation-mesh-'));
const app=createApp({port:0,host:'127.0.0.1',dataDir,apiKey:null,databaseUrl:null});
let browser;
try {
  const port=await app.listen();
  browser=await chromium.launch({headless:true,args:JSON.parse(process.env.GPU_ARGS||'[]')});
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${port}/healthz`);
  const model=parseModel(await readFile(new URL('../public/models/demo-chair.obj',import.meta.url)),'chair.obj');
  const scene=sceneForMesh(model),settings={width:64,height:64,samples:8,bounces:4};
  const jobs=createTiles(64,64).map(tile=>({scene,settings,job:{...tile,runId:1,lease:tile.id+1}}));
  // Switching back to a preset catches stale mesh buffers/cache state.
  jobs.push({scene:validateScene(PRESETS.solstice),settings:{width:32,height:32,samples:8,bounces:4},job:{id:0,x:0,y:0,width:32,height:32,runId:2,lease:5}});
  const result=await page.evaluate(async jobs=>{
    const adapter=await navigator.gpu?.requestAdapter();
    if(!adapter)throw new Error('Hardware WebGPU adapter unavailable.');
    const adapterInfo={vendor:adapter.info.vendor,architecture:adapter.info.architecture,fallback:adapter.info.isFallbackAdapter??adapter.isFallbackAdapter};
    return new Promise((resolve,reject)=>{
      const worker=new Worker('/render-worker.js',{type:'module'}),pixels=[],notices=[];let index=0;
      const timer=setTimeout(()=>{worker.terminate();reject(new Error('Mesh GPU test timed out.'));},60000);
      const fail=message=>{clearTimeout(timer);worker.terminate();reject(new Error(message));};
      worker.onerror=event=>fail(event.message);
      worker.onmessage=({data})=>{
        if(data.type==='notice'){notices.push(data.message);return;}
        if(data.type==='error'||data.type==='backend')return fail(data.message||data.reason||'Renderer changed backend.');
        if(data.type==='ready') {
          if(data.backend!=='webgpu')return fail(`GPU initialization failed: ${notices.join('; ')}`);
          worker.postMessage({type:'render',...jobs[index]});
        } else if(data.type==='result') {
          if(data.backend!=='webgpu')return fail('Unexpected CPU fallback.');
          pixels.push(Array.from(data.pixels));index++;
          if(index<jobs.length)worker.postMessage({type:'render',...jobs[index]});
          else {clearTimeout(timer);worker.terminate();resolve({pixels,adapterInfo,notices});}
        }
      };
      worker.postMessage({type:'init'});
    });
  },jobs);
  assert.equal(result.adapterInfo.fallback,false);
  const errors=result.pixels.map((pixels,i)=>{
    const reference=renderTileCPU(jobs[i].scene,jobs[i].settings,jobs[i].job);
    const error=pixels.reduce((sum,value,k)=>sum+Math.abs(value-reference[k]),0)/pixels.length;
    assert.ok(error<5,`Job ${i} GPU/CPU mean channel difference ${error}`);return error;
  });
  const full=new Uint8ClampedArray(64*64*4);
  for(let i=0;i<4;i++) {const {job}=jobs[i],pixels=result.pixels[i];for(let row=0;row<job.height;row++)full.set(pixels.slice(row*job.width*4,(row+1)*job.width*4),((job.y+row)*64+job.x)*4);}
  const image=await page.evaluate(pixels=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=64;canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels),64,64),0,0);return canvas.toDataURL().split(',')[1];},Array.from(full));
  const output=new URL('../artifacts/',import.meta.url);await mkdir(output,{recursive:true});
  await writeFile(new URL('mesh-webgpu.png',output),Buffer.from(image,'base64'));
  const report={passed:true,adapter:result.adapterInfo,triangles:model.triangles.length/9,meanAbsoluteChannelErrors:errors,notices:result.notices,scope:'Direct real WebGPU mesh worker, four independent tiles, then a mesh-free preset; CPU reference comparison. One Mac, no speedup claim.'};
  await writeFile(new URL('mesh-webgpu-report.json',output),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
} finally {await browser?.close();await app.close();await rm(dataDir,{recursive:true,force:true});}
