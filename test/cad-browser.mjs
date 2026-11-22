// An isolated browser exercises the real, lazily loaded OCCT WebAssembly worker.
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import { cubeSTEP } from './cad-fixture.mjs';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const dataDir=await mkdtemp(join(tmpdir(),'constellation-cad-'));
const app=createApp({port:0,host:'127.0.0.1',dataDir,databaseUrl:null,apiKey:null});
const directory=new URL('../artifacts/',import.meta.url),report={passed:false,checks:[]};
let browser;
try {
  const port=await app.listen(),base=`http://127.0.0.1:${port}`;
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();
  const errors=[],requests=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>requests.push(new URL(request.url()).pathname));
  await page.goto(`${base}/healthz`);
  const pagePolicy=(await fetch(`${base}/`)).headers.get('content-security-policy');
  assert.equal(pagePolicy.includes("'unsafe-eval'"),false,'The app page must not allow string evaluation');
  const workerPolicy=(await fetch(`${base}/cad-worker.js`)).headers.get('content-security-policy');
  assert.equal(workerPolicy.includes("'unsafe-eval'"),true,'Only the isolated OCCT worker needs its Embind glue capability');
  report.checks.push('String evaluation scoped to the disposable CAD worker policy');
  assert.equal(requests.some(path=>path.includes('/vendor/occt/')),false);
  report.checks.push('No converter downloaded before import');
  const result=await page.evaluate(async text=>{
    const {importCAD}=await import('/cad-import.js');
    const started=performance.now();
    const mesh=await importCAD(new TextEncoder().encode(text).buffer,'cube.step');
    return {mesh,durationMs:performance.now()-started};
  },cubeSTEP());
  assert.equal(result.mesh.triangles.length/9,12);assert.equal(result.mesh.name,'cube');
  report.checks.push('Real browser Worker converted authored STEP cube into 12 triangles');
  report.conversion={durationMs:result.durationMs,triangles:12};
  // Browser worker requests are not consistently surfaced on Page; verify lazy
  // assets separately from the same origin and preserve the runtime assertion.
  for(const file of ['occt-import-js.js','occt-import-js.wasm','license.occt-import-js.txt','license.occt.txt']) {
    const response=await fetch(`${base}/vendor/occt/${file}`);assert.equal(response.status,200);
    if(file.endsWith('.wasm'))assert.match(response.headers.get('content-type'),/application\/wasm/);
  }
  assert.equal((await fetch(`${base}/vendor/occt/../../package.json`)).status,404);
  report.checks.push('Same-origin JS/WASM and license files available through bounded vendor routes');
  const invalid=await page.evaluate(async()=>{
    const {importCAD}=await import('/cad-import.js');
    try {await importCAD(new TextEncoder().encode('ISO-10303-21;\nHEADER; malformed data').buffer,'bad.step');return null;}
    catch(error){return error.message;}
  });
  assert.match(invalid,/STEP|surface mesh/);report.checks.push('Malformed STEP conversion fails with actionable message');
  const timeout=await page.evaluate(async text=>{
    const {importCAD}=await import('/cad-import.js');
    try {await importCAD(new TextEncoder().encode(text).buffer,'cube.step',{timeoutMs:1});return null;}
    catch(error){return error.message;}
  },cubeSTEP());
  assert.match(timeout,/exceeded/);report.checks.push('Deadline terminates conversion worker');
  await page.goto(base);
  await page.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Live connection');
  const roomId=(await page.locator('#room-code').textContent()).trim();
  await page.locator('#model-file').setInputFiles({name:'cube.step',mimeType:'application/step',buffer:Buffer.from(cubeSTEP())});
  await page.waitForFunction(()=>document.querySelector('#scene-name')?.textContent==='cube');
  const state=await(await fetch(`${base}/api/rooms/${roomId}`)).json();
  assert.deepEqual(state.scene.mesh.triangles,result.mesh.triangles);
  assert.equal(state.scene.mesh.name,'cube');assert.equal(state.scene.spheres.length,0);
  assert.equal(await page.locator('#model-file').isEnabled(),true);
  report.checks.push('Actual host file upload commits converted STEP geometry to the room');
  assert.deepEqual(errors,[]);report.passed=true;
}catch(error){report.error=error.message;process.exitCode=1;}
finally {
  await browser?.close();await app.close();await rm(dataDir,{recursive:true,force:true});
  await mkdir(directory,{recursive:true});await writeFile(new URL('cad-browser-report.json',directory),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
