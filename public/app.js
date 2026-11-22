import { PRESETS, TILE_SIZE, packResult } from './scene.js';

const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const logo=`<svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M20 4v32M4 20h32M8.7 8.7l22.6 22.6M8.7 31.3L31.3 8.7" stroke="currentColor" stroke-width="2.4"/><circle cx="20" cy="20" r="5.5" fill="var(--bg)" stroke="currentColor" stroke-width="2.4"/></svg>`;
const arrow='<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5" stroke="currentColor" stroke-width="1.5"/></svg>';
let roomId,token,state,config,ws,clientId,isHost=false,worker=null,backend=null,contributing=false,wantsToContribute=false,currentJob=null,connected=false,currentRunId=null,roomScene=null,selectedPreset='orbit',joinURL='',reconnectTimer,toastTimer,wakeLock=null,initialized=false;
let chart=[],lastChartTime=0,owners=new Map(),receivedTiles=new Set(),metricsFetchedAt=0;
let comparison=null,baselineDevice='',rendererReason='',generating=false,lastRecoveryKey='',scenePending=false;
let jobQueue=[];
// Small batches amortize network round trips. Keep one GPU operation in flight
// because the renderer reuses its uniform, output, and readback buffers.
const batchSize=new URLSearchParams(location.search).get('batch')==='1'?1:4;
const joinView=location.pathname.startsWith('/join/');
const forceCPU=new URLSearchParams(location.search).get('cpu')==='1';
let deviceName=localStorage.getItem('constellation-device')||(/iPhone/.test(navigator.userAgent)?'iPhone':/iPad/.test(navigator.userAgent)?'iPad':/Android/.test(navigator.userAgent)?'Android phone':/Mac/.test(navigator.userAgent)?'Mac browser':'Browser device');

function toast(message) {$('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),4500);}
function send(message) {if(ws?.readyState===WebSocket.OPEN) ws.send(JSON.stringify(message));}
const seconds=n=>n<60?`${n.toFixed(1)}s`:`${Math.floor(n/60)}m ${Math.floor(n%60)}s`;
const format=n=>new Intl.NumberFormat('en',{maximumFractionDigits:1}).format(n);

function studioMarkup() {
  return `<header class="topbar"><a class="brand" href="/">${logo}<span>constellation<span class="brand-dot">.</span></span></a><div class="topbar-right"><span id="studio-role" class="tag studio-role" aria-live="polite">Connecting</span><span id="connection" class="connection"><i></i>Connecting</span><button class="button primary compact presentation-control" id="present-render" disabled>Render</button><button class="button secondary compact" id="present-button">Present</button><button class="button secondary compact" id="share-button">Invite devices ${arrow}</button></div></header>
  <main class="studio"><section class="intro"><div><div class="eyebrow"><span class="tiny-star">✳</span> A BROWSER-POWERED RENDER STUDIO</div><h1>Every device. <span>Part of the picture.</span></h1></div><div class="room-tag">YOUR CONSTELLATION <strong id="room-code"></strong></div></section>
  <section id="viewer-banner" class="viewer-banner hidden" role="status"><div><strong>You’re viewing this studio.</strong><p>Open the original host tab to choose scenes and start renders. You can still contribute from this tab.</p><p class="hint">Creating your own studio makes a new room. Invite your devices again.</p></div><a class="button primary" href="/">Create my own studio ${arrow}</a></section>
  <section class="demo-strip"><div><span class="demo-step">01</span><strong>Invite the room</strong><span>Scan the QR</span></div><div><span class="demo-step">02</span><strong>Contribute compute</strong><span>Keep phones open</span></div><div><span class="demo-step">03</span><strong>Render together</strong><span>Watch every tile arrive</span></div><span id="network-status" class="network-status">Checking connection…</span></section>
  <section class="stats" aria-label="Live render statistics"><div><span class="stat-label">Contributing devices</span><strong id="stat-devices">0 <small>online</small></strong></div><div><span class="stat-label">Tiles rendered</span><strong id="stat-tiles">0 <small>/ —</small></strong></div><div><span class="stat-label" title="Completed pixels multiplied by samples, divided by elapsed seconds">Render throughput</span><strong id="stat-rate">— <small>M samples / sec</small></strong></div><div><span class="stat-label">Elapsed time</span><strong id="stat-time">—</strong></div><div><span class="stat-label">Recovered tiles</span><strong id="stat-retries">0</strong></div></section>
  <section class="workbench"><aside class="scene-panel panel"><div class="panel-heading"><span class="section-number">01</span><h2>The scene</h2></div><p class="muted small">Choose a world to render together.</p><div class="presets">${Object.entries(PRESETS).map(([id,s])=>`<button class="preset ${id===selectedPreset?'selected':''}" data-preset="${id}"><span class="preset-art ${id}"><i></i><i></i><i></i></span><span><strong>${s.name}</strong><small>${{aurora:'Dunes & northern lights',city:'Towers & neon reflections',orbit:'Chrome & luminous',solstice:'Warm & reflective',lunar:'Cool & cinematic',orchard:'Soft & sunlit'}[id]}</small></span><span class="selection-dot"></span></button>`).join('')}</div>
  <div class="divider"></div><div class="label-row"><label for="prompt">Describe your scene</label><span class="tag" id="gemini-tag">GEMINI</span></div><textarea id="prompt" rows="3" maxlength="600" placeholder="A desert with northern lights, or a neon city skyline…"></textarea><button class="button secondary wide" id="generate-button">Generate scene <span>✧</span></button><p class="hint" id="gemini-hint">Checking scene generation…</p>
  <div class="divider"></div><div class="quality-picks" aria-label="Render workload"><button data-workload="preview">Quick check</button><button data-workload="showcase">Live demo</button><button data-workload="poster">Poster</button></div><div class="setting-grid"><label>Resolution<select id="resolution"><option value="256">256 × 256</option><option value="512" selected>512 × 512</option><option value="768">768 × 768</option><option value="1024">1024 × 1024</option><option value="2048">2048 × 2048</option></select></label><label>Quality<select id="samples"><option value="8">8 samples</option><option value="16">16 samples</option><option value="32" selected>32 samples</option><option value="64">64 samples</option><option value="128">128 samples</option><option value="256">256 samples</option><option value="512">512 samples</option></select></label></div>
  <button class="button primary wide render-button" id="render-button" disabled>Start render ${arrow}</button><button class="button danger wide hidden" id="stop-button">Stop render</button><p id="render-hint" class="hint centered">Connect a contributing device to begin.</p></aside>
  <section class="render-panel panel"><div class="render-heading"><div><span class="live-dot" id="render-dot"></span><h2 id="scene-name">Orbit</h2><span class="tag" id="render-status">READY</span></div><button class="icon-button" id="download-button" title="Download rendered image" aria-label="Download rendered image" disabled><svg viewBox="0 0 20 20" fill="none"><path d="M10 3v9m-3-3 3 3 3-3M4 13v4h12v-4" stroke="currentColor" stroke-width="1.5"/></svg></button></div>
  <p class="scene-description" id="scene-description"></p><div class="canvas-wrap"><canvas id="render-canvas" width="512" height="512" aria-label="Distributed rendered image"></canvas><canvas id="owner-canvas" width="512" height="512" aria-hidden="true"></canvas><div class="canvas-empty" id="canvas-empty"><div class="orbital"><span></span><span></span><i></i><b></b><em></em></div><h3>A shared effort.<br>A clearer picture.</h3><p>Your image will appear here as devices<br>finish their part of the render.</p><button class="button secondary" id="empty-contribute">Use this device ${arrow}</button></div><div class="scene-pending hidden" id="scene-pending" role="status">New scene ready. Start a render to update this image.</div><div class="canvas-caption"><span id="canvas-details">PATH TRACED · 32 × 32 TILES</span><span id="canvas-percent">0%</span></div></div>
  <div id="recovery-banner" class="recovery-banner hidden" role="status"></div><div class="progress-track"><div id="progress-bar"></div></div><div class="render-footer"><label class="toggle-label"><input type="checkbox" id="show-owners"><span class="toggle"></span>Contribution map</label><span id="render-footer-status">Waiting for the first device</span></div>
  <div class="benchmark"><div class="benchmark-result"><span class="benchmark-icon">↗</span><div><strong id="benchmark-title">One device. Then the whole room.</strong><p id="benchmark-copy">Compare two real renders with identical scene and settings.</p></div></div><div class="benchmark-controls"><label>Solo device<select id="baseline-device" aria-label="Solo benchmark device"><option value="">Waiting for devices</option></select></label><button class="button primary" id="compare-button" disabled>Compare 1 vs crowd ${arrow}</button><button class="icon-button" id="export-report" aria-label="Download benchmark report" title="Download benchmark report" disabled>↓</button></div><p id="compare-hint" class="hint">Connect at least two devices using the same renderer.</p></div></section>
  <aside class="devices-panel panel"><div class="panel-heading"><span class="section-number">02</span><h2>The constellation</h2><span class="count-pill" id="device-count">0</span></div><p class="muted small">A little power from everyone.</p>
  <div class="local-device"><div class="label-row"><label for="device-name">This device</label><span class="tag" id="backend-tag">STANDBY</span></div><input id="device-name" maxlength="40" value="${esc(deviceName)}" aria-label="Device name"><button class="button primary wide" id="contribute-button">Contribute compute <span>+</span></button><p class="hint" id="contribute-hint">Opt in to render. You can pause anytime.</p></div>
  <div class="devices-list" id="devices-list"><div class="empty-devices"><span>◎</span><p>No contributors yet.<br>Invite someone to get started.</p></div></div>
  <button class="invite-card" id="qr-card"><img id="qr-image" alt="Scan to join this render room"><div><strong>Better, together.</strong><p>Scan to contribute<br>from another device.</p><span>Share room ↗</span></div></button>
  <div class="activity"><div class="label-row"><h3>Live activity</h3><span class="small muted" id="telemetry-label">LOCAL</span></div><svg class="sparkline" viewBox="0 0 240 56" preserveAspectRatio="none" aria-label="Average tile throughput over time"><path d="M0 53H240" stroke="#30382f"/><polyline id="sparkline" points="0,53 240,53" fill="none" stroke="#b7d1ae" stroke-width="2"/></svg><p class="hint">Run average · tiles per second</p><div id="activity-log"></div><div id="db-metrics" class="hint"></div></div></aside></section>
  <footer class="footer"><span><i></i> Real work. Real devices. One shared image.</span><span>WebGPU when available · <a href="https://github.com/satvikgarimella/constellation" target="_blank" rel="noopener">Source ↗</a> · <a href="#about" id="about-link">How it works ↗</a></span></footer></main>
  <dialog id="share-dialog"><button class="dialog-close" aria-label="Close invite dialog">×</button><div class="eyebrow">GROW YOUR CONSTELLATION</div><h2>Bring another device.</h2><p>Open this link or scan the code, then tap<br><strong>Contribute compute</strong> on the joining device.</p><img id="dialog-qr" alt="QR code to join"><div class="share-url"><input id="share-url" readonly aria-label="Join URL"><button class="button primary compact" id="copy-button">Copy</button></div><p class="hint" id="share-note"></p></dialog>
  <dialog id="about-dialog"><button class="dialog-close" aria-label="Close explanation">×</button><div class="eyebrow">SMALL TILES. SHARED COMPUTE.</div><h2>Your browser is a renderer.</h2><p>Every contributing device receives the scene and a small tile to calculate. It traces rays locally and sends the finished pixels back. Faster devices pick up more work.</p><p>When a device leaves, its unfinished tile returns to the queue. The server assembles the image; it does not render it.</p><p>Throughput is measured from completed tiles and elapsed time. CPU and WebGPU renderers are identified on each device. Benchmarks compare completed runs with the same scene, quality, resolution, and renderer type.</p><p class="hint">This prototype trusts participating devices' pixel results. It is not a verified marketplace for untrusted computation.</p></dialog>`;
}

function joinMarkup() {
  return `<header class="topbar"><a class="brand" href="/">${logo}<span>constellation<span class="brand-dot">.</span></span></a><span id="connection" class="connection"><i></i>Connecting</span></header><main class="join-page"><div class="eyebrow">YOU'RE PART OF THE PICTURE</div><h1>Small contribution.<br><span>Shared creation.</span></h1><p class="join-intro">Lend this device a little computing power.<br>Help room <strong id="room-code"></strong> render something together.</p><div class="join-orbit">${logo}<span id="backend-tag" class="tag">STANDBY</span></div><div class="join-controls"><label for="device-name">Give your device a name</label><input id="device-name" maxlength="40" value="${esc(deviceName)}"><button class="button primary wide" id="contribute-button">Contribute compute <span>+</span></button><p id="contribute-hint" class="hint centered">Uses this device's processor while the page is visible.<br>Pause anytime. Keep this page open while contributing.</p></div><div id="device-readiness" class="device-readiness" role="status"></div><div class="join-stats"><div><strong id="my-tiles">0</strong><span>your tiles</span></div><div><strong id="join-progress">0%</strong><span>image complete</span></div><div><strong id="stat-devices">0</strong><span>devices together</span></div></div><div class="join-preview"><canvas id="render-canvas" width="512" height="512" aria-label="The shared image"></canvas><div id="canvas-empty"><p>Waiting for the host to start a render.</p></div></div><a id="view-studio" class="text-link">Watch the full studio ${arrow}</a></main>`;
}

async function boot() {
  try {
    config=await (await fetch('/api/config')).json();
    const match=location.pathname.match(/^\/(?:r|join)\/([a-f0-9]{6})$/i);
    if(match) roomId=match[1].toUpperCase();
    else {
      const response=await fetch('/api/rooms',{method:'POST'});const created=await response.json();if(!response.ok)throw new Error(created.error);
      roomId=created.roomId;sessionStorage.setItem(`constellation-host-${roomId}`,created.hostToken);history.replaceState(null,'',`/r/${roomId}${location.search}`);
    }
    token=sessionStorage.getItem(`constellation-host-${roomId}`);
    const response=await fetch(`/api/rooms/${roomId}`);if(!response.ok)throw new Error('This room has expired. Start a new studio to continue.');
    state=await response.json();roomScene=state.scene;selectedPreset=Object.entries(PRESETS).find(([,scene])=>scene.name===roomScene.name)?.[0]||null;
    $('#app').innerHTML=joinView?joinMarkup():studioMarkup();document.body.classList.toggle('joining',joinView);
    $('#room-code').textContent=roomId;
    const local=['localhost','127.0.0.1','[::1]'].includes(location.hostname);
    const base=config.publicUrl||(local&&config.lanUrls.length?config.lanUrls[0]:location.origin);
    joinURL=`${base}/join/${roomId}`;
    bindEvents();connect();initialized=true;
    if(joinView) $('#view-studio').href=`/r/${roomId}`;
    else {
      const qr=`/api/qr?room=${roomId}&base=${encodeURIComponent(base)}`;
      $('#qr-image').src=qr;$('#dialog-qr').src=qr;$('#share-url').value=joinURL;
      $('#share-note').textContent=base.startsWith('https:')?'WebGPU is available on supported browsers.':'Local link: devices must be on the same Wi-Fi. HTTP connections use the CPU fallback; HTTPS enables WebGPU.';
      $('#generate-button').disabled=!config.gemini;$('#prompt').disabled=!config.gemini;
      $('#gemini-hint').textContent=config.gemini?'Create dunes, skylines, or abstract scenes using terrain, boxes, and spheres. Add stars or northern lights.':'AI scene creation is not connected. The presets are ready to render.';
      $('#gemini-tag').classList.toggle('inactive',!config.gemini);
      $('#telemetry-label').textContent=config.tigerData?(config.databaseReady?'TIGER DATA':'CONNECTING'):'LOCAL';
    }
    update(state);contributionUI();
    if(!joinView) updateNetworkStatus();
  } catch(error) {$('#app').innerHTML=`<div class="fatal">${logo}<h1>Couldn't open the studio.</h1><p>${esc(error.message)}</p><a class="button primary" href="/">Start a new studio</a></div>`;}
}

function connect() {
  ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws`);ws.binaryType='arraybuffer';
  ws.onopen=()=>send({type:'hello',roomId,token,label:deviceName});
  ws.onmessage=({data})=>{
    if(typeof data!=='string'){drawTile(data);return;}
    const msg=JSON.parse(data);
    if(msg.type==='welcome') {
      clientId=msg.clientId;isHost=msg.isHost;connected=true;connectionUI();contributionUI();
      if(joinView)$('#view-studio').innerHTML=`${isHost?'Open host controls':'Watch the full studio'} ${arrow}`;
      // Reset tile cache on reconnect; the server replays the current image.
      currentRunId=null;update(msg.state);
      if(wantsToContribute&&!document.hidden) beginContribution();
    } else if(msg.type==='state')update(msg.state);
    else if(msg.type==='job'||msg.type==='jobs') {
      if(!contributing||!worker){send({type:'contribute',enabled:false});return;}
      for(const job of msg.jobs||[msg.job])jobQueue.push({job,scene:msg.scene,settings:msg.settings});
      renderNextJob();
    } else if(msg.type==='cancel') {currentJob=null;restartWorker();}
    else if(msg.type==='tile-owners'&&msg.runId===currentRunId){for(const owner of msg.owners)owners.set(owner.tileId,owner);drawOwners(msg.owners);}
    else if(msg.type==='paused'){stopContribution();toast(msg.reason);}
    else if(msg.type==='error'){comparison=null;toast(msg.message);update(state);}
  };
  ws.onclose=event=>{
    connected=false;comparison=null;connectionUI();pauseWorker();
    if(event.code===1008){toast(event.reason||'Room unavailable.');return;}
    clearTimeout(reconnectTimer);reconnectTimer=setTimeout(connect,1500);
  };
  ws.onerror=()=>{};
}
function connectionUI() {
  const el=$('#connection');if(!el)return;
  el.innerHTML=`<i></i>${connected?'Live connection':'Reconnecting…'}`;el.classList.toggle('online',connected);
  if(!joinView) {
    $('#viewer-banner').classList.toggle('hidden',!connected||isHost);
    $('#studio-role').textContent=connected?(isHost?'Host':'Viewer'):'Connecting';
    $('#studio-role').classList.toggle('host',connected&&isHost);
  }
  if(connected)document.title=`${joinView?'Contribute':isHost?'Host':'Viewer'} · ${roomId} — Constellation`;
}

function renderNextJob(){
  if(currentJob||!contributing||!worker||!connected)return;
  const next=jobQueue.shift();if(!next)return;
  currentJob=next.job;worker.postMessage({type:'render',...next});
}

async function beginContribution() {
  if(worker||!connected)return;
  wantsToContribute=true;
  deviceName=$('#device-name').value.trim().slice(0,40)||'Browser device';localStorage.setItem('constellation-device',deviceName);
  $('#contribute-button').disabled=true;$('#contribute-button').textContent='Preparing renderer…';
  const activeWorker=new Worker('/render-worker.js',{type:'module'});worker=activeWorker;
  activeWorker.onmessage=({data})=>{
    if(worker!==activeWorker)return;
    if(data.type==='ready') {
      if(!wantsToContribute)return;
      backend=data.backend;rendererReason=data.reason||rendererReason;contributing=true;
      send({type:'contribute',enabled:true,backend,label:deviceName,batchSize});contributionUI();
      if(navigator.wakeLock&&!document.hidden) navigator.wakeLock.request('screen').then(lock=>{wakeLock=lock;}).catch(()=>{});
    } else if(data.type==='result') {
      if(currentJob?.runId!==data.job.runId||currentJob?.id!==data.job.id||currentJob?.lease!==data.job.lease)return;
      if(contributing&&ws.readyState===WebSocket.OPEN) ws.send(packResult(data.job,data.pixels,data.durationMs));
      currentJob=null;renderNextJob();
    } else if(data.type==='backend') {backend=data.backend;send({type:'contribute',enabled:true,backend,label:deviceName,batchSize});contributionUI();toast(data.reason);}
    else if(data.type==='notice'){rendererReason=data.message;console.info(data.message);}
    else if(data.type==='error') {toast(data.message);stopContribution();}
  };
  activeWorker.onerror=event=>{if(worker!==activeWorker)return;toast(`Renderer stopped: ${event.message}`);stopContribution();};
  activeWorker.postMessage({type:'init',forceCPU});
}
function pauseWorker(){worker?.terminate();worker=null;contributing=false;currentJob=null;jobQueue=[];wakeLock?.release().catch(()=>{});wakeLock=null;contributionUI();}
function stopContribution(){wantsToContribute=false;send({type:'contribute',enabled:false,reason:'paused'});pauseWorker();}
function restartWorker(){const wanted=wantsToContribute;pauseWorker();if(wanted&&!document.hidden)beginContribution();}
function contributionUI() {
  const button=$('#contribute-button');if(!button)return;
  button.disabled=!connected;button.innerHTML=contributing?'Pause contribution <span>Ⅱ</span>':'Contribute compute <span>+</span>';
  button.classList.toggle('is-contributing',contributing);
  $('#backend-tag').textContent=contributing?(backend==='webgpu'?'WEBGPU':'CPU WORKER'):'STANDBY';
  $('#backend-tag').classList.toggle('active',contributing);
  $('#contribute-hint').textContent=contributing?`${backend==='webgpu'?'GPU':'CPU'} rendering is active. Keep this page visible. Pause anytime.`:wantsToContribute&&document.hidden?'Paused while this page is hidden. Return to resume.':'Opt in to render. You can pause anytime.';
  $('#empty-contribute')?.classList.toggle('hidden',contributing);updateReadiness();
}

function bindEvents() {
  $('#contribute-button').onclick=()=>contributing||worker?stopContribution():beginContribution();
  if(joinView)return;
  $('#empty-contribute').onclick=beginContribution;
  $('#present-render').onclick=()=>{if(state.run?.status==='running'){comparison=null;send({type:'cancel'});}else if(isHost){send({type:'start',...renderConfig()});}};
  $('#present-button').onclick=()=>{const on=document.body.classList.toggle('presenting');$('#present-button').textContent=on?'Edit scene':'Present';};
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){document.body.classList.remove('presenting');$('#present-button').textContent='Present';}});
  $('#resolution').onchange=$('#samples').onchange=()=>document.querySelectorAll('[data-workload]').forEach(b=>b.classList.remove('selected'));
  $('#baseline-device').onchange=()=>{baselineDevice=$('#baseline-device').value;updateCompareControls();};
  $('#compare-button').onclick=startComparison;
  $('#export-report').onclick=()=>downloadJSON({project:'Constellation',exportedAt:new Date().toISOString(),roomId,benchmark:state.benchmark,history:state.history,note:'Device counts are browser sessions; use separate physical devices to measure crowd scaling. Timings include networking and browser overhead.'},`constellation-${roomId}-benchmark.json`);
  for(const button of document.querySelectorAll('[data-workload]')) button.onclick=()=>{
    const settings={preview:[256,8],showcase:[1024,128],poster:[2048,256]}[button.dataset.workload];
    $('#resolution').value=settings[0];$('#samples').value=settings[1];
    document.querySelectorAll('[data-workload]').forEach(b=>b.classList.toggle('selected',b===button));
  };
  for(const el of document.querySelectorAll('[data-preset]')) el.onclick=()=>{
    if(state.run?.status==='running'||comparison||!isHost)return;
    selectedPreset=el.dataset.preset;roomScene=structuredClone(PRESETS[selectedPreset]);scenePending=true;
    document.querySelectorAll('[data-preset]').forEach(b=>b.classList.toggle('selected',b===el));
    $('#scene-name').textContent=roomScene.name;update(state);
  };
  $('#render-button').onclick=()=>{
    if(!isHost)return;
    comparison=null;send({type:'start',...renderConfig()});
  };
  $('#stop-button').onclick=()=>{comparison=null;send({type:'cancel'});};
  $('#show-owners').onchange=()=>$('#owner-canvas').classList.toggle('visible',$('#show-owners').checked);
  $('#download-button').onclick=()=>{const a=document.createElement('a');a.download=`constellation-${roomId}-${currentRunId}.png`;a.href=$('#render-canvas').toDataURL('image/png');a.click();};
  $('#share-button').onclick=$('#qr-card').onclick=()=>$('#share-dialog').showModal();
  document.querySelectorAll('.dialog-close').forEach(b=>b.onclick=()=>b.closest('dialog').close());
  document.querySelectorAll('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d)d.close();}));
  $('#copy-button').onclick=async()=>{try{await navigator.clipboard.writeText(joinURL);toast('Join link copied.');}catch{$('#share-url').select();document.execCommand('copy');toast('Join link copied.');}};
  $('#about-link').onclick=e=>{e.preventDefault();$('#about-dialog').showModal();};
  $('#generate-button').onclick=async()=>{
    const prompt=$('#prompt').value.trim();if(prompt.length<3){toast('Describe the scene you want to create.');return;}
    const button=$('#generate-button');generating=true;button.disabled=true;button.textContent='Imagining your scene…';update(state);
    try {
      const response=await fetch(`/api/rooms/${roomId}/scene`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({prompt})});
      const result=await response.json();if(!response.ok)throw new Error(result.error);
      roomScene=result.scene;selectedPreset=null;scenePending=true;document.querySelectorAll('[data-preset]').forEach(b=>b.classList.remove('selected'));$('#scene-name').textContent=roomScene.name;toast('Scene created. Start a render to see it.');
    } catch(error){toast(error.message);}finally{generating=false;button.innerHTML='Generate scene <span>✧</span>';update(state);}
  };
}

function update(next) {
  state=next;const run=state.run;
  if(!isHost&&state.scene){roomScene=state.scene;scenePending=!!state.scenePending;}
  else if(state.scenePending)scenePending=true;
  const active=state.clients.filter(c=>c.enabled),running=run?.status==='running';
  const percent=run?Math.round(run.completed/run.total*100):0;
  if(run&&run.id!==currentRunId) {
    currentRunId=run.id;scenePending=!!state.scenePending;receivedTiles.clear();owners.clear();chart=[];lastChartTime=0;
    const canvas=$('#render-canvas');canvas.width=run.settings.width;canvas.height=run.settings.height;
    if($('#owner-canvas')){$('#owner-canvas').width=canvas.width;$('#owner-canvas').height=canvas.height;}
    if(!joinView)$('#sparkline').setAttribute('points','0,53 240,53');
    $('#canvas-empty').classList.add('hidden');roomScene=state.scene;
  }
  if(joinView) {
    $('#stat-devices').textContent=active.length;$('#join-progress').textContent=`${percent}%`;
    $('#my-tiles').textContent=state.clients.find(c=>c.id===clientId)?.tiles||0;updateReadiness();
    return;
  }
  const eligible=state.deviceCounts?.eligible??active.length;$('#stat-devices').innerHTML=`${running?eligible:active.length} <small>${running?'rendering':'ready'}</small>`;
  $('#stat-tiles').innerHTML=`${run?format(run.completed):0} <small>/ ${run?format(run.total):'—'}</small>`;
  $('#stat-rate').innerHTML=`${run?((run.pixelSamplesPerSecond||0)/1e6).toFixed(1):'—'} <small>M samples / sec</small>`;
  $('#stat-retries').textContent=run?.retries||0;
  $('#present-render').disabled=!isHost||!connected||(!running&&(generating||!!comparison||!active.length));$('#present-render').textContent=running?'Stop render':'Render';
  $('#stat-time').textContent=run?seconds(run.elapsed):'—';
  $('#scene-name').textContent=roomScene?.name||state.scene.name;
  $('#scene-description').textContent=roomScene?.description||state.scene.description;
  $('#scene-pending').classList.toggle('hidden',!scenePending||running);
  $('#render-status').textContent=running?'RENDERING':scenePending?'SCENE READY':run?.status==='complete'?'COMPLETE':run?.status==='cancelled'?'STOPPED':'READY';
  $('#render-status').classList.toggle('active',running);$('#render-dot').classList.toggle('active',running);
  $('#canvas-percent').textContent=`${percent}%`;$('#progress-bar').style.width=`${percent}%`;
  $('#canvas-details').textContent=run?`${run.settings.width} × ${run.settings.height} · ${run.settings.samples} SAMPLES · ${run.settings.bounces} BOUNCES`:'PATH TRACED · 32 × 32 TILES';
  $('#render-button').disabled=running||!!comparison||generating||!active.length||!isHost||!connected;
  $('#render-button').classList.toggle('hidden',running);$('#stop-button').classList.toggle('hidden',!running||!isHost);
  $('#render-hint').textContent=!isHost?'Only the room owner can start a render.':running?'Devices render small batches of tiles.':!active.length?'Connect a contributing device to begin.':'All connected devices will share the work.';
  $('#resolution').disabled=$('#samples').disabled=running||!!comparison||generating||!isHost;
  document.querySelectorAll('[data-workload]').forEach(b=>b.disabled=running||!!comparison||generating||!isHost);
  $('#generate-button').disabled=!config.gemini||running||!!comparison||generating||!isHost;
  document.querySelectorAll('[data-preset]').forEach(b=>b.disabled=running||!!comparison||generating||!isHost);
  $('#download-button').disabled=!run?.completed;
  $('#render-footer-status').textContent=scenePending&&!running?'New scene ready — select Start render.':running?`${run.inflight} tiles in flight · ${run.retries} reassigned`:run?.status==='complete'?`Completed by ${run.contributors.length} device${run.contributors.length===1?'':'s'}`:run?.status==='cancelled'?'Render stopped — partial image available':'Waiting for the first device';
  $('#device-count').textContent=active.length;
  const recovery=run?.lastReassignment;$('#recovery-banner').classList.toggle('hidden',!recovery);
  if(recovery){$('#recovery-banner').textContent=`Recovered ${run.retries} tile${run.retries===1?'':'s'} · ${recovery.label} ${recovery.reason==='disconnected'?'disconnected':'paused or timed out'}. ${eligible?'Remaining devices take over.':'Waiting for a device to resume.'}`;const key=`${run.id}:${run.retries}`;if(key!==lastRecoveryKey){lastRecoveryKey=key;toast(eligible?'A tile was recovered. The remaining devices are continuing.':'Unfinished tiles are saved. Waiting for a contributor to resume.');}}
  const devices=state.clients.filter(c=>c.backend);
  $('#devices-list').innerHTML=devices.length?devices.map(c=>`<div class="device-row"><span class="device-icon" style="--device-color:${c.color}"><svg viewBox="0 0 24 24" fill="none"><rect x="6" y="3" width="12" height="18" rx="3" stroke="currentColor" stroke-width="1.5"/><path d="M10 17h4" stroke="currentColor" stroke-width="1.5"/></svg></span><div class="device-info"><strong>${esc(c.label)}${c.id===clientId?'<small>YOU</small>':''}</strong><span>${c.backend==='webgpu'?'WebGPU':'CPU'} · ${c.enabled?(c.busy?'Rendering':running&&run.workerIds&&!run.workerIds.includes(c.id)?'Waiting for crowd run':'Ready'):'Paused'}</span></div><div class="device-tiles">${c.tiles}<small>tiles</small></div><i class="node-dot ${c.enabled?'active':''}"></i></div>`).join(''):'<div class="empty-devices"><span>◎</span><p>No contributors yet.<br>Invite someone to get started.</p></div>';
  if(run&&run.elapsed-lastChartTime>0.45&&running) {
    lastChartTime=run.elapsed;chart.push(run.tilesPerSecond);if(chart.length>90)chart.shift();
    const max=Math.max(1,...chart);$('#sparkline').setAttribute('points',chart.map((v,i)=>`${i/Math.max(1,chart.length-1)*240},${52-v/max*46}`).join(' '));
  }
  $('#activity-log').innerHTML=state.events.slice(0,4).map(e=>`<div class="event-row"><i></i><span>${esc(eventLabel(e))}</span><time>${new Date(e.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time></div>`).join('')||'<p class="hint">Connections and completed runs appear here.</p>';
  updateBenchmark();updateCompareControls();advanceComparison();
  if(config.tigerData&&Date.now()-metricsFetchedAt>5000) {metricsFetchedAt=Date.now();fetchMetrics();}
}
function eventLabel(e) {
  return ({device_joined:`${e.label} joined`,device_left:`${e.label} disconnected`,render_started:`Started ${e.scene}`,render_completed:`Render complete · ${e.workers} device${e.workers===1?'':'s'}`,render_cancelled:'Render stopped',tile_reassigned:`Tile ${e.tileId} returned to queue`})[e.type]||e.type;
}
function updateBenchmark() {
  const latest=state.history[0],comparisonResult=state.benchmark;
  if(!latest)return;
  if(comparisonResult?.eligible) {
    const b=comparisonResult;
    $('#benchmark-title').textContent=`${b.speedup.toFixed(2)}× solo throughput · ${latest.workers} contributors`;
    $('#benchmark-copy').textContent=`${seconds(b.baselineSeconds)} solo → ${seconds(b.crowdSeconds)} together. Same scene and settings; ${b.baselineWorkerLabel||'baseline device'} participated in both. ${b.speedup<1?'The crowd was slower on this run.':Math.min(b.baselineSeconds,b.crowdSeconds)<1?'Short run: increase the workload and repeat for a stronger measurement.':'Repeat to check consistency.'}`;
  } else {
    const explanations={mixed_backends:'A renderer changed or CPU and GPU work were mixed. Use matching renderers for a comparison.',backend_mismatch:'The completed runs used different renderers.',baseline_worker_missing:'The solo device must also contribute to the crowd run.',matching_baseline_needed:'Use Compare 1 vs crowd to record matching runs.',insufficient_timing:'Increase the workload to collect measurable render time.'};
    $('#benchmark-title').textContent=latest.workers===1?'Solo baseline recorded.':'A matching solo baseline is needed.';
    $('#benchmark-copy').textContent=explanations[comparisonResult?.reason]||(latest.workers===1?`${seconds(latest.seconds)} on ${latest.contributors?.[0]?.label||'one device'}. Ready for a matching crowd render.`:'Compare completed renders with the same scene, settings, and renderer.');
  }
  $('#export-report').disabled=!state.history.length;
}

function renderConfig(){return {scene:structuredClone(roomScene),width:Number($('#resolution').value),samples:Number($('#samples').value),bounces:4};}
function updateCompareControls() {
  if(joinView)return;
  const ready=state.clients.filter(c=>c.enabled&&c.backend),select=$('#baseline-device');
  if(!ready.some(c=>c.id===baselineDevice))baselineDevice=(ready.find(c=>c.id!==clientId&&c.backend==='webgpu')||ready.find(c=>c.backend==='webgpu')||ready[0])?.id||'';
  const options=ready.map(c=>`<option value="${c.id}"${c.id===baselineDevice?' selected':''}>${esc(c.label)} · ${c.backend==='webgpu'?'GPU':'CPU'}</option>`).join('')||'<option value="">Waiting for devices</option>';
  if(select.innerHTML!==options)select.innerHTML=options;
  const solo=ready.find(c=>c.id===baselineDevice),crowd=ready.filter(c=>c.backend===solo?.backend),running=state.run?.status==='running';
  select.disabled=running||!!comparison||!isHost;
  $('#compare-button').disabled=running||!!comparison||generating||crowd.length<2||!isHost||!connected;
  $('#compare-button').textContent=comparison?(comparison.phase==='solo'?'1 / 2 · Solo render':'2 / 2 · Crowd render'):'Compare 1 vs crowd →';
  $('#compare-hint').textContent=comparison?`Same workload both times. ${comparison.phase==='solo'?'Other devices wait for the crowd run.':'All selected devices are working together.'}`:!isHost?'The room owner controls the comparison.':crowd.length<2?'Connect at least two devices using the same renderer.':`${crowd.length} ${solo.backend==='webgpu'?'GPU':'CPU'} devices ready. Runs once on the selected device, then on the matching crowd. Timings include networking.`;
}
function startComparison() {
  const ready=state.clients.filter(c=>c.enabled&&c.backend),solo=ready.find(c=>c.id===baselineDevice);
  if(!isHost||!solo||state.run?.status==='running')return;
  const crowd=ready.filter(c=>c.backend===solo.backend).map(c=>c.id);if(crowd.length<2)return;
  comparison={phase:'solo',baselineId:solo.id,workerIds:crowd,config:renderConfig(),previousRun:state.run?.id||0,runId:null};
  send({type:'start',...comparison.config,workerIds:[solo.id]});updateCompareControls();
}
function advanceComparison() {
  const c=comparison,run=state.run;if(!c||!run||run.id<=c.previousRun)return;
  if(c.runId===null)c.runId=run.id;
  if(run.id!==c.runId||run.status==='cancelled'){comparison=null;updateCompareControls();return;}
  if(run.status==='running'&&c.phase==='solo'&&!state.clients.some(d=>d.id===c.baselineId&&d.enabled)) {
    comparison=null;send({type:'cancel'});toast('Solo device disconnected or paused. Reconnect it, then start the comparison again.');updateCompareControls();return;
  }
  if(run.status!=='complete')return;
  if(c.phase==='solo') {
    const baseline=state.clients.find(d=>d.id===c.baselineId),ready=state.clients.filter(d=>c.workerIds.includes(d.id)&&d.enabled&&d.backend===baseline?.backend);
    if(!baseline?.enabled||ready.length<2){comparison=null;toast('Solo run saved. Reconnect at least two matching devices to compare.');updateCompareControls();return;}
    c.phase='crowd';c.previousRun=run.id;c.runId=null;
    send({type:'start',...c.config,workerIds:ready.map(d=>d.id)});updateCompareControls();
  } else {comparison=null;updateCompareControls();toast('Comparison complete. The measured result is below the image.');}
}
function downloadJSON(value,name){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function updateNetworkStatus(){const secure=joinURL.startsWith('https:');$('#network-status').textContent=secure?'HTTPS · ready for phone GPUs':'Local Wi-Fi · phones use CPU';$('#network-status').classList.toggle('secure',secure);}
function updateReadiness(){const el=$('#device-readiness');if(!el)return;el.classList.toggle('gpu-ready',contributing&&backend==='webgpu');el.textContent=contributing?(backend==='webgpu'?'GPU ready · your device calculates real image tiles.':!isSecureContext?'CPU fallback · this link needs HTTPS for GPU access.':'CPU fallback · this browser did not provide a WebGPU adapter.'):wantsToContribute&&document.hidden?'Paused while hidden. Return here to resume.':isSecureContext?'Secure connection · your renderer is checked when you contribute.':'Local HTTP connection · CPU fallback is available.';}
async function fetchMetrics() {
  try {const result=await(await fetch(`/api/rooms/${roomId}/metrics`)).json();$('#telemetry-label').textContent=result.source==='postgres'?'TIGER DATA':'LOCAL FALLBACK';if(result.source==='postgres')$('#db-metrics').textContent=`Database query: ${result.workers.reduce((n,w)=>n+w.tiles,0)} completed tiles across ${result.workers.length} device sessions.`;}catch{$('#telemetry-label').textContent='LOCAL FALLBACK';}
}
function drawTile(buffer) {
  if(buffer.byteLength<16||!state?.run)return;
  const header=new DataView(buffer),runId=header.getUint32(0,true),tileId=header.getUint32(4,true);
  if(runId!==currentRunId||receivedTiles.has(tileId))return;
  const size=state.run.settings.width,cols=Math.ceil(size/TILE_SIZE);
  const x=(tileId%cols)*TILE_SIZE,y=Math.floor(tileId/cols)*TILE_SIZE,w=Math.min(TILE_SIZE,size-x),h=Math.min(TILE_SIZE,size-y);
  if(w<=0||h<=0||buffer.byteLength!==16+w*h*4)return;
  const pixels=new Uint8ClampedArray(buffer,16);$('#render-canvas').getContext('2d').putImageData(new ImageData(pixels,w,h),x,y);receivedTiles.add(tileId);
}
function drawOwners(changes) {
  const canvas=$('#owner-canvas');if(!canvas||!state?.run)return;
  const ctx=canvas.getContext('2d'),cols=Math.ceil(canvas.width/TILE_SIZE);
  for(const owner of changes||owners.values()) {const x=owner.tileId%cols*TILE_SIZE,y=Math.floor(owner.tileId/cols)*TILE_SIZE;ctx.fillStyle=owner.color+'24';ctx.fillRect(x,y,TILE_SIZE,TILE_SIZE);ctx.strokeStyle=owner.color+'b0';ctx.lineWidth=1;ctx.strokeRect(x+0.5,y+0.5,TILE_SIZE-1,TILE_SIZE-1);}
}

document.addEventListener('visibilitychange',()=>{
  if(!initialized||!wantsToContribute)return;
  if(document.hidden){send({type:'contribute',enabled:false,reason:'page hidden'});pauseWorker();}
  else beginContribution();
});
window.addEventListener('beforeunload',()=>{wantsToContribute=false;worker?.terminate();ws?.close();});
boot();
