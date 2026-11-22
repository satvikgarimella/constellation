// Three independent browser contexts exercise the actual UI, Worker, shader and WebSockets.
// They share the testing computer's GPU; this verifies coordination, not physical crowd scaling.
import assert from 'node:assert/strict';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.BASE_URL||'http://localhost:3210';
const directory=new URL('../artifacts/',import.meta.url);await mkdir(directory,{recursive:true});
const browser=await chromium.launch({headless:true,args:JSON.parse(process.env.GPU_ARGS||'[]')});
const errors=[],notices=[];
const watch=p=>{p.setDefaultTimeout(20000);p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')errors.push(m.text());if(m.type()==='info')notices.push(m.text());});};
const until=async(predicate,timeout=90000)=>{const end=Date.now()+timeout;while(Date.now()<end){const result=await predicate();if(result)return result;await new Promise(r=>setTimeout(r,40));}throw new Error('Demo test timed out.');};
try {
  const host=await browser.newPage({viewport:{width:1440,height:1080},reducedMotion:'reduce'});watch(host);
  await host.goto(base);await host.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Live connection');
  const roomId=(await host.locator('#room-code').textContent()).trim();
  const state=async()=>(await fetch(`${base}/api/rooms/${roomId}`)).json();
  assert.equal(await host.locator('#contribute-button').isEnabled(),true);
  const peers=[];
  for(let i=1;i<=3;i++){
    const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,reducedMotion:'reduce'});
    const page=await context.newPage();watch(page);
    await page.goto(`${base}/join/${roomId}`);await page.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Live connection');
    await page.fill('#device-name',`GPU browser ${i}`);await page.locator('#contribute-button').click();
    await page.waitForFunction(()=>document.querySelector('#backend-tag')?.textContent==='WEBGPU');
    peers.push({context,page});
  }
  await until(async()=>(await state()).clients.filter(c=>c.enabled).length===3);
  await host.locator('[data-workload=preview]').click();
  await host.locator('#compare-button').click();
  let complete=await until(async()=>{const s=await state();return s.history.length===2&&s.run.status==='complete'&&s;});
  assert.equal(complete.history[1].workers,1);assert.equal(complete.history[0].workers,3);
  assert.equal(complete.benchmark.eligible,true);assert.equal(complete.history[0].backends,'webgpu');
  assert.equal(complete.clients.filter(c=>c.label==='Mac browser').every(c=>!c.enabled),true,'host remains a controller');
  await host.waitForFunction(()=>document.querySelector('#benchmark-title')?.textContent.includes('× solo'));
  const comparison=complete.benchmark;
  const download=host.waitForEvent('download');await host.locator('#export-report').click();
  const reportPath=new URL('demo-benchmark.json',directory).pathname;await(await download).saveAs(reportPath);
  const exported=JSON.parse(await readFile(reportPath,'utf8'));assert.equal(exported.benchmark.eligible,true);assert.equal('hostToken' in exported,false);
  // A real longer GPU render gives a contributor time to disconnect while holding a lease.
  await host.selectOption('#resolution','1024');await host.selectOption('#samples','256');
  await host.locator('#render-button').click();
  await until(async()=>{const s=await state();return s.run.id===3&&s.clients.some(c=>c.label==='GPU browser 3'&&c.busy);});
  await peers[2].context.close();
  complete=await until(async()=>{const s=await state();return s.run.id===3&&s.run.status==='complete'&&s;});
  assert.ok(complete.run.retries>=1);assert.equal(complete.run.completed,1024);
  assert.equal(complete.history[0].backends,'webgpu');
  assert.ok(complete.run.contributors.length>=2);
  await host.waitForFunction(()=>document.querySelector('#render-status')?.textContent==='COMPLETE');
  assert.equal(await host.locator('#recovery-banner').isVisible(),true);
  await host.locator('.toggle-label').click();
  await host.screenshot({path:new URL('demo-three-workers.png',directory).pathname,fullPage:true});
  await host.locator('#present-button').click();
  assert.equal(await host.locator('.scene-panel').isVisible(),false);
  await host.screenshot({path:new URL('demo-presentation.png',directory).pathname,fullPage:true});
  await peers[0].page.screenshot({path:new URL('demo-phone.png',directory).pathname,fullPage:true});
  assert.equal(await host.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.equal(await peers[0].page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const report={base,roomId,contexts:3,hardwareNote:'Three browser workers share this test computer. Physical phones are not simulated hardware.',comparison,recoveredTiles:complete.run.retries,completedTiles:complete.run.completed,backend:complete.history[0].backends,errors,notices};
  assert.deepEqual(errors,[]);await writeFile(new URL('demo-report.json',directory),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
