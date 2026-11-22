// Regressions for an unavailable baseline and Stop controls with no active workers.
import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.BASE_URL||'http://localhost:3210';
const browser=await chromium.launch({headless:true,args:JSON.parse(process.env.GPU_ARGS||'[]')});
const until=async f=>{const deadline=Date.now()+20000;while(Date.now()<deadline){const value=await f();if(value)return value;await new Promise(r=>setTimeout(r,30));}throw new Error('Control test timed out.');};
try {
  const host=await browser.newPage({viewport:{width:1440,height:1080},reducedMotion:'reduce'});host.setDefaultTimeout(20000);
  await host.goto(base);await host.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Live connection');
  const roomId=(await host.locator('#room-code').textContent()).trim();
  const state=async()=>(await fetch(`${base}/api/rooms/${roomId}`)).json();
  const peers=[];
  for(let i=0;i<2;i++){
    const context=await browser.newContext(),page=await context.newPage();page.setDefaultTimeout(20000);
    await page.goto(`${base}/join/${roomId}`);await page.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Live connection');
    await page.fill('#device-name',`Control worker ${i}`);await page.locator('#contribute-button').click();
    await page.waitForFunction(()=>document.querySelector('#backend-tag')?.textContent==='WEBGPU');peers.push({context,page});
  }
  await until(async()=>(await state()).clients.filter(c=>c.enabled).length===2);
  await host.selectOption('#resolution','1024');await host.selectOption('#samples','512');
  await host.locator('#present-button').click();await host.locator('#compare-button').click();
  await until(async()=>{const s=await state();return s.run?.id===1&&s.run.status==='running'&&s.clients.some(c=>c.label==='Control worker 0'&&c.busy);});
  assert.equal(await host.locator('#present-render').isEnabled(),true,'Stop must work during the guided comparison');
  await peers[0].context.close();
  await until(async()=>(await state()).run?.status==='cancelled');
  await host.waitForFunction(()=>document.querySelector('#compare-button')?.textContent.includes('Compare 1 vs crowd'));
  await host.locator('#present-render').click();
  await until(async()=>{const s=await state();return s.run?.id===2&&s.run.status==='running'&&s.clients.some(c=>c.busy);});
  await peers[1].page.locator('#contribute-button').click();
  await until(async()=>(await state()).deviceCounts.eligible===0);
  await host.waitForFunction(()=>document.querySelector('#recovery-banner')?.textContent.includes('Waiting for a device'));
  assert.equal(await host.locator('#present-render').isEnabled(),true,'Stop must remain usable with no active workers');
  await host.locator('#present-render').click();await until(async()=>(await state()).run.status==='cancelled');
  await host.locator('#share-button').click();
  const invite=await host.locator('#share-url').inputValue();
  if(base.startsWith('https:'))assert.equal(invite,`${base}/join/${roomId}`);
  await host.waitForFunction(()=>document.querySelector('#dialog-qr')?.naturalWidth>0);
  const result={base,roomId,soloCancellation:true,presentationStop:true,invite,qrLoaded:true};
  await mkdir(new URL('../artifacts/',import.meta.url),{recursive:true});
  await writeFile(new URL('../artifacts/controls-report.json',import.meta.url),JSON.stringify(result,null,2));console.log(result);
}finally{await browser.close();}
