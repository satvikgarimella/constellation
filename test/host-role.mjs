// Isolated studio-role regression: node test/host-role.mjs
// Optional PLAYWRIGHT_MODULE can point to an installed Playwright index.mjs.
// Creates synthetic rooms on an ephemeral loopback server. No rendering,
// provider credentials, user browser sessions, or credential migration is used.
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';

const temporary=await mkdtemp(join(tmpdir(),'constellation-host-role-'));
const app=createApp({port:0,host:'127.0.0.1',dataDir:temporary,databaseUrl:null,apiKey:null,publicUrl:''});
const artifacts=new URL('../artifacts/',import.meta.url);
const report={startedAt:new Date().toISOString(),passed:false,scope:'Studio roles and explicit new-room navigation in isolated browser contexts; no real-user session or provider access.',checks:[]};
let browser,stage='launch',pageErrors=0,consoleErrors=0;
async function live(page) {await page.waitForFunction(()=>document.querySelector('#connection')?.textContent==='Live connection');}
async function open(context,url) {
  const page=await context.newPage();page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(15000);
  page.on('pageerror',()=>pageErrors++);page.on('console',message=>{if(message.type()==='error')consoleErrors++;});
  await page.goto(url);await live(page);return page;
}
async function presetsEnabled(page,expected) {
  const values=await page.locator('[data-preset]').evaluateAll(buttons=>buttons.map(button=>!button.disabled));
  assert.ok(values.length>0);assert.ok(values.every(value=>value===expected));
}

try {
  const port=await app.listen(),base=`http://127.0.0.1:${port}`;
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
  browser=await chromium.launch({headless:true,timeout:20000});
  const ownerContext=await browser.newContext({viewport:{width:1440,height:1080},reducedMotion:'reduce'});
  const viewerContext=await browser.newContext({viewport:{width:1440,height:1080},reducedMotion:'reduce'});
  await mkdir(artifacts,{recursive:true});

  stage='creator_without_contributors';
  const creator=await open(ownerContext,base);
  const originalId=(await creator.locator('#room-code').textContent()).trim();assert.match(originalId,/^[A-F0-9]{6}$/);
  assert.equal(await creator.locator('#studio-role').textContent(),'Host');
  assert.equal(await creator.title(),`Host · ${originalId} — Constellation`);
  assert.equal(await creator.locator('#viewer-banner').isVisible(),false);
  await presetsEnabled(creator,true);assert.equal(await creator.locator('#resolution').isEnabled(),true);
  assert.equal(await creator.locator('#render-button').isEnabled(),false,'A host still needs a contributor before rendering');
  assert.equal(app.coordinator.state(app.coordinator.get(originalId)).deviceCounts.ready,0);
  report.checks.push({name:'Creator has scene controls with zero contributors and a Host role/title',passed:true});

  stage='independent_viewer';
  const viewer=await open(viewerContext,`${base}/r/${originalId}`);
  assert.equal(await viewer.locator('#studio-role').textContent(),'Viewer');
  assert.equal(await viewer.title(),`Viewer · ${originalId} — Constellation`);
  assert.equal(await viewer.locator('#viewer-banner').isVisible(),true);
  assert.match(await viewer.locator('#viewer-banner').textContent(),/original host tab/);
  assert.match(await viewer.locator('#viewer-banner').textContent(),/new room.*Invite your devices again/s);
  await presetsEnabled(viewer,false);assert.equal(await viewer.locator('#resolution').isEnabled(),false);
  assert.equal(await viewer.locator('#render-button').isEnabled(),false);
  assert.equal(await viewer.locator('#contribute-button').isEnabled(),true);
  const createOwn=viewer.getByRole('link',{name:'Create my own studio'});
  assert.equal(await createOwn.getAttribute('href'),'/');assert.equal(await createOwn.getAttribute('target'),null);
  await viewer.screenshot({path:new URL('host-role-viewer.png',artifacts).pathname,fullPage:true,timeout:10000});
  for(const width of [390,320]) {
    await viewer.setViewportSize({width,height:844});
    assert.equal(await viewer.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`Viewer banner must fit a ${width}px viewport`);
  }
  await viewer.setViewportSize({width:1440,height:1080});
  report.checks.push({name:'Independent viewer sees role guidance and disabled scene controls; mobile layout fits',passed:true});

  stage='explicit_new_studio';
  await createOwn.click();
  await viewer.waitForURL(url=>url.pathname.startsWith('/r/')&&url.pathname!==`/r/${originalId}`);await live(viewer);
  const ownId=(await viewer.locator('#room-code').textContent()).trim();assert.notEqual(ownId,originalId);
  assert.equal(viewerContext.pages().length,1,'The action must stay in the same tab');
  assert.equal(await viewer.locator('#studio-role').textContent(),'Host');
  assert.equal(await viewer.title(),`Host · ${ownId} — Constellation`);
  assert.equal(await viewer.locator('#viewer-banner').isVisible(),false);
  await presetsEnabled(viewer,true);assert.equal(await viewer.locator('#resolution').isEnabled(),true);
  assert.ok(app.coordinator.get(originalId));assert.equal(await creator.locator('#room-code').textContent(),originalId);
  await viewer.screenshot({path:new URL('host-role-created.png',artifacts).pathname,fullPage:true,timeout:10000});
  report.checks.push({name:'Create my own studio creates a different owned room in the same tab and preserves the old room',passed:true});

  stage='join_page_title';
  const joinContext=await browser.newContext();
  const contributor=await open(joinContext,`${base}/join/${originalId}`);
  assert.equal(await contributor.title(),`Contribute · ${originalId} — Constellation`);
  assert.match(await contributor.locator('#view-studio').textContent(),/Watch the full studio/);
  report.checks.push({name:'Join pages identify their contribution role and room in the browser title',passed:true});

  assert.ok([...app.coordinator.rooms.values()].every(room=>room.run===null),'Role navigation must never start a render');
  assert.equal(pageErrors,0);assert.equal(consoleErrors,0);report.passed=true;
} catch {
  report.failure={stage,code:'HOST_ROLE_REGRESSION_FAILED'};process.exitCode=1;
} finally {
  try {await browser?.close();}
  finally {await app.close();await rm(temporary,{recursive:true,force:true});}
  report.pageErrors=pageErrors;report.consoleErrors=consoleErrors;
  if(pageErrors||consoleErrors){report.passed=false;process.exitCode=1;}
  report.finishedAt=new Date().toISOString();await mkdir(artifacts,{recursive:true});
  await writeFile(new URL('host-role-report.json',artifacts),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(report,null,2));
}
