import { PRESETS, TILE_SIZE, packResult } from './scene.js';

const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const logo=`<svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M20 4v32M4 20h32M8.7 8.7l22.6 22.6M8.7 31.3L31.3 8.7" stroke="currentColor" stroke-width="2.4"/><circle cx="20" cy="20" r="5.5" fill="var(--bg)" stroke="currentColor" stroke-width="2.4"/></svg>`;
const arrow='<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5" stroke="currentColor" stroke-width="1.5"/></svg>';
let roomId,token,state,config,ws,clientId,isHost=false,worker=null,backend=null,contributing=false,wantsToContribute=false,currentJob=null,connected=false,currentRunId=null,roomScene=null,selectedPreset='solstice',joinURL='',reconnectTimer,toastTimer,wakeLock=null,initialized=false;
let chart=[],lastChartTime=0,owners=new Map(),receivedTiles=new Set(),metricsFetchedAt=0;
const joinView=location.pathname.startsWith('/join/');
const forceCPU=new URLSearchParams(location.search).get('cpu')==='1';
let deviceName=localStorage.getItem('constellation-device')||(/iPhone/.test(navigator.userAgent)?'iPhone':/iPad/.test(navigator.userAgent)?'iPad':/Android/.test(navigator.userAgent)?'Android phone':/Mac/.test(navigator.userAgent)?'Mac browser':'Browser device');

function toast(message) {$('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),4500);}
function send(message) {if(ws?.readyState===WebSocket.OPEN) ws.send(JSON.stringify(message));}
const seconds=n=>n<60?`${n.toFixed(1)}s`:`${Math.floor(n/60)}m ${Math.floor(n%60)}s`;
const format=n=>new Intl.NumberFormat('en',{maximumFractionDigits:1}).format(n);

function studioMarkup() {
  return `<header class="topbar"><a class="brand" href="/">${logo}<span>constellation<span class="brand-dot">.</span></span></a><div class="topbar-right"><span id="connection" class="connection"><i></i>Connecting</span><button class="button secondary compact" id="share-button">Invite devices ${arrow}</button></div></header>
  <main class="studio"><section class="intro"><div><div class="eyebrow"><span class="tiny-star">✳</span> A BROWSER-POWERED RENDER STUDIO</div><h1>Every device. <span>Part of the picture.</span></h1></div><div class="room-tag">YOUR CONSTELLATION <strong id="room-code"></strong></div></section>
  <section class="stats" aria-label="Live render statistics"><div><span class="stat-label">Contributing devices</span><strong id="stat-devices">0 <small>online</small></strong></div><div><span class="stat-label">Tiles rendered</span><strong id="stat-tiles">0 <small>/ —</small></strong></div><div><span class="stat-label">Render throughput</span><strong id="stat-rate">— <small>tiles / sec</small></strong></div><div><span class="stat-label">Elapsed time</span><strong id="stat-time">—</strong></div></section>
  <section class="workbench"><aside class="scene-panel panel"><div class="panel-heading"><span class="section-number">01</span><h2>The scene</h2></div><p class="muted small">Choose a world to render together.</p><div class="presets">${Object.entries(PRESETS).map(([id,s])=>`<button class="preset ${id==='solstice'?'selected':''}" data-preset="${id}"><span class="preset-art ${id}"><i></i><i></i><i></i></span><span><strong>${s.name}</strong><small>${id==='solstice'?'Warm & reflective':id==='lunar'?'Cool & cinematic':'Soft & sunlit'}</small></span><span class="selection-dot"></span></button>`).join('')}</div>
  <div class="divider"></div><div class="label-row"><label for="prompt">Imagine something else</label><span class="tag" id="gemini-tag">GEMINI</span></div><textarea id="prompt" rows="3" maxlength="600" placeholder="Chrome spheres in a desert at sunset…"></textarea><button class="button secondary wide" id="generate-button">Generate scene <span>✧</span></button><p class="hint" id="gemini-hint">Checking scene generation…</p>
  <div class="divider"></div><div class="setting-grid"><label>Resolution<select id="resolution"><option value="256">256 × 256</option><option value="512" selected>512 × 512</option><option value="768">768 × 768</option><option value="1024">1024 × 1024</option></select></label><label>Quality<select id="samples"><option value="8">8 samples</option><option value="16">16 samples</option><option value="32" selected>32 samples</option><option value="64">64 samples</option><option value="128">128 samples</option></select></label></div>
  <button class="button primary wide render-button" id="render-button" disabled>Start render ${arrow}</button><button class="button danger wide hidden" id="stop-button">Stop render</button><p id="render-hint" class="hint centered">Connect a contributing device to begin.</p></aside>
  <section class="render-panel panel"><div class="render-heading"><div><span class="live-dot" id="render-dot"></span><h2 id="scene-name">Solstice</h2><span class="tag" id="render-status">READY</span></div><button class="icon-button" id="download-button" title="Download rendered image" aria-label="Download rendered image" disabled><svg viewBox="0 0 20 20" fill="none"><path d="M10 3v9m-3-3 3 3 3-3M4 13v4h12v-4" stroke="currentColor" stroke-width="1.5"/></svg></button></div>
  <div class="canvas-wrap"><canvas id="render-canvas" width="512" height="512" aria-label="Distributed rendered image"></canvas><canvas id="owner-canvas" width="512" height="512" aria-hidden="true"></canvas><div class="canvas-empty" id="canvas-empty"><div class="orbital"><span></span><span></span><i></i><b></b><em></em></div><h3>A shared effort.<br>A clearer picture.</h3><p>Your image will appear here as devices<br>finish their part of the render.</p><button class="button secondary" id="empty-contribute">Use this device ${arrow}</button></div><div class="canvas-caption"><span id="canvas-details">PATH TRACED · 32 × 32 TILES</span><span id="canvas-percent">0%</span></div></div>
  <div class="progress-track"><div id="progress-bar"></div></div><div class="render-footer"><label class="toggle-label"><input type="checkbox" id="show-owners"><span class="toggle"></span>Contribution map</label><span id="render-footer-status">Waiting for the first device</span></div>
  <div class="benchmark"><span class="benchmark-icon">↗</span><div><strong id="benchmark-title">Make the speedup measurable.</strong><p id="benchmark-copy">Finish a solo run, then repeat with more devices at the same settings.</p></div></div></section>
  <aside class="devices-panel panel"><div class="panel-heading"><span class="section-number">02</span><h2>The constellation</h2><span class="count-pill" id="device-count">0</span></div><p class="muted small">A little power from everyone.</p>
  <div class="local-device"><div class="label-row"><label for="device-name">This device</label><span class="tag" id="backend-tag">STANDBY</span></div><input id="device-name" maxlength="40" value="${esc(deviceName)}" aria-label="Device name"><button class="button primary wide" id="contribute-button">Contribute compute <span>+</span></button><p class="hint" id="contribute-hint">Opt in to render. You can pause anytime.</p></div>
  <div class="devices-list" id="devices-list"><div class="empty-devices"><span>◎</span><p>No contributors yet.<br>Invite someone to get started.</p></div></div>
  <button class="invite-card" id="qr-card"><img id="qr-image" alt="Scan to join this render room"><div><strong>Better, together.</strong><p>Scan to contribute<br>from another device.</p><span>Share room ↗</span></div></button>
  <div class="activity"><div class="label-row"><h3>Live activity</h3><span class="small muted" id="telemetry-label">LOCAL</span></div><svg class="sparkline" viewBox="0 0 240 56" preserveAspectRatio="none" aria-label="Average tile throughput over time"><path d="M0 53H240" stroke="#30382f"/><polyline id="sparkline" points="0,53 240,53" fill="none" stroke="#b7d1ae" stroke-width="2"/></svg><p class="hint">Run average · tiles per second</p><div id="activity-log"></div><div id="db-metrics" class="hint"></div></div></aside></section>
  <footer class="footer"><span><i></i> Real work. Real devices. One shared image.</span><span>WebGPU when available · CPU fallback · <a href="https://github.com" id="about-link">How it works ↗</a></span></footer></main>
  <dialog id="share-dialog"><button class="dialog-close" aria-label="Close invite dialog">×</button><div class="eyebrow">GROW YOUR CONSTELLATION</div><h2>Bring another device.</h2><p>Open this link or scan the code, then tap<br><strong>Contribute compute</strong> on the joining device.</p><img id="dialog-qr" alt="QR code to join"><div class="share-url"><input id="share-url" readonly aria-label="Join URL"><button class="button primary compact" id="copy-button">Copy</button></div><p class="hint" id="share-note"></p></dialog>
  <dialog id="about-dialog"><button class="dialog-close" aria-label="Close explanation">×</button><div class="eyebrow">SMALL TILES. SHARED COMPUTE.</div><h2>Your browser is a renderer.</h2><p>Every contributing device receives the scene and a small tile to calculate. It traces rays locally and sends the finished pixels back. Faster devices pick up more work.</p><p>When a device leaves, its unfinished tile returns to the queue. The server assembles the image; it does not render it.</p><p>Throughput is measured from completed tiles and elapsed time. CPU and WebGPU renderers are identified on each device. Benchmarks compare completed runs with the same scene, quality, resolution, and renderer type.</p><p class="hint">This prototype trusts participating devices' pixel results. It is not a verified marketplace for untrusted computation.</p></dialog>`;
}

function joinMarkup() {
  return `<header class="topbar"><a class="brand" href="/">${logo}<span>constellation<span class="brand-dot">.</span></span></a><span id="connection" class="connection"><i></i>Connecting</span></header><main class="join-page"><div class="eyebrow">YOU'RE PART OF THE PICTURE</div><h1>Small contribution.<br><span>Shared creation.</span></h1><p class="join-intro">Lend this device a little computing power.<br>Help room <strong id="room-code"></strong> render something together.</p><div class="join-orbit">${logo}<span id="backend-tag" class="tag">STANDBY</span></div><div class="join-controls"><label for="device-name">Give your device a name</label><input id="device-name" maxlength="40" value="${esc(deviceName)}"><button class="button primary wide" id="contribute-button">Contribute compute <span>+</span></button><p id="contribute-hint" class="hint centered">Uses this device's processor while the page is visible.<br>Pause anytime. Keep this page open while contributing.</p></div><div class="join-stats"><div><strong id="my-tiles">0</strong><span>your tiles</span></div><div><strong id="join-progress">0%</strong><span>image complete</span></div><div><strong id="stat-devices">0</strong><span>devices together</span></div></div><div class="join-preview"><canvas id="render-canvas" width="512" height="512" aria-label="The shared image"></canvas><div id="canvas-empty"><p>Waiting for the host to start a render.</p></div></div><a id="view-studio" class="text-link">Watch the full studio ${arrow}</a></main>`;
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
    state=await response.json();roomScene=state.scene;
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
      $('#gemini-hint').textContent=config.gemini?'Describe a composition. Gemini creates a scene from supported shapes.':'AI scene creation is not connected. All three presets are ready to render.';
      $('#gemini-tag').classList.toggle('inactive',!config.gemini);
      $('#telemetry-label').textContent=config.tigerData?(config.databaseReady?'TIGER DATA':'CONNECTING'):'LOCAL';
    }
    update(state);
  } catch(error) {$('#app').innerHTML=`<div class="fatal">${logo}<h1>Couldn't open the studio.</h1><p>${esc(error.message)}</p><a class="button primary" href="/">Start a new studio</a></div>`;}
}

function connect() {
  ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws`);ws.binaryType='arraybuffer';
  ws.onopen=()=>send({type:'hello',roomId,token,label:deviceName});
  ws.onmessage=({data})=>{
    if(typeof data!=='string'){drawTile(data);return;}
    const msg=JSON.parse(data);
    if(msg.type==='welcome') {
      clientId=msg.clientId;isHost=msg.isHost;connected=true;connectionUI();
      // Reset tile cache on reconnect; the server replays the current image.
      currentRunId=null;update(msg.state);
      if(wantsToContribute&&!document.hidden) beginContribution();
    } else if(msg.type==='state')update(msg.state);
    else if(msg.type==='job') {
      if(!contributing||!worker){send({type:'contribute',enabled:false});return;}
      currentJob=msg.job;worker.postMessage({type:'render',job:msg.job,scene:msg.scene,settings:msg.settings});
    } else if(msg.type==='cancel') {currentJob=null;restartWorker();}
    else if(msg.type==='tile-owners'&&msg.runId===currentRunId){for(const owner of msg.owners)owners.set(owner.tileId,owner);drawOwners();}
    else if(msg.type==='paused'){stopContribution();toast(msg.reason);}
    else if(msg.type==='error')toast(msg.message);
  };
  ws.onclose=event=>{
    connected=false;connectionUI();pauseWorker();
    if(event.code===1008){toast(event.reason||'Room unavailable.');return;}
    clearTimeout(reconnectTimer);reconnectTimer=setTimeout(connect,1500);
  };
  ws.onerror=()=>{};
}
function connectionUI() {const el=$('#connection');if(!el)return;el.innerHTML=`<i></i>${connected?'Live connection':'Reconnecting…'}`;el.classList.toggle('online',connected);}

async function beginContribution() {
  if(worker||!connected)return;
  wantsToContribute=true;
  deviceName=$('#device-name').value.trim().slice(0,40)||'Browser device';localStorage.setItem('constellation-device',deviceName);
  $('#contribute-button').disabled=true;$('#contribute-button').textContent='Preparing renderer…';
  worker=new Worker('/render-worker.js',{type:'module'});
  worker.onmessage=({data})=>{
    if(data.type==='ready') {
      if(!wantsToContribute)return;
      backend=data.backend;contributing=true;
      send({type:'contribute',enabled:true,backend,label:deviceName});contributionUI();
      if(navigator.wakeLock&&!document.hidden) navigator.wakeLock.request('screen').then(lock=>{wakeLock=lock;}).catch(()=>{});
    } else if(data.type==='result') {
      if(contributing&&currentJob?.lease===data.job.lease&&ws.readyState===WebSocket.OPEN) ws.send(packResult(data.job,data.pixels,data.durationMs));
      currentJob=null;
    } else if(data.type==='backend') {backend=data.backend;send({type:'contribute',enabled:true,backend,label:deviceName});contributionUI();toast(data.reason);}
    else if(data.type==='notice') console.info(data.message);
    else if(data.type==='error') {toast(data.message);stopContribution();}
  };
  worker.onerror=event=>{toast(`Renderer stopped: ${event.message}`);stopContribution();};
  worker.postMessage({type:'init',forceCPU});
}
function pauseWorker(){worker?.terminate();worker=null;contributing=false;currentJob=null;wakeLock?.release().catch(()=>{});wakeLock=null;contributionUI();}
function stopContribution(){wantsToContribute=false;send({type:'contribute',enabled:false,reason:'paused'});pauseWorker();}
function restartWorker(){const wanted=wantsToContribute;pauseWorker();if(wanted&&!document.hidden)beginContribution();}
function contributionUI() {
  const button=$('#contribute-button');if(!button)return;
  button.disabled=!connected;button.innerHTML=contributing?'Pause contribution <span>Ⅱ</span>':'Contribute compute <span>+</span>';
  button.classList.toggle('is-contributing',contributing);
  $('#backend-tag').textContent=contributing?(backend==='webgpu'?'WEBGPU':'CPU WORKER'):'STANDBY';
  $('#backend-tag').classList.toggle('active',contributing);
  $('#contribute-hint').textContent=contributing?`${backend==='webgpu'?'GPU':'CPU'} rendering is active. Keep this page visible. Pause anytime.`:wantsToContribute&&document.hidden?'Paused while this page is hidden. Return to resume.':'Opt in to render. You can pause anytime.';
  $('#empty-contribute')?.classList.toggle('hidden',contributing);
}

function bindEvents() {
  $('#contribute-button').onclick=()=>contributing||worker?stopContribution():beginContribution();
  if(joinView)return;
  $('#empty-contribute').onclick=beginContribution;
  for(const el of document.querySelectorAll('[data-preset]')) el.onclick=()=>{
    if(state.run?.status==='running'||!isHost)return;
    selectedPreset=el.dataset.preset;roomScene=structuredClone(PRESETS[selectedPreset]);
    document.querySelectorAll('[data-preset]').forEach(b=>b.classList.toggle('selected',b===el));
    $('#scene-name').textContent=roomScene.name;
  };
  $('#render-button').onclick=()=>{
    if(!isHost)return;
    send({type:'start',scene:roomScene,width:Number($('#resolution').value),samples:Number($('#samples').value),bounces:4});
  };
  $('#stop-button').onclick=()=>send({type:'cancel'});
  $('#show-owners').onchange=()=>$('#owner-canvas').classList.toggle('visible',$('#show-owners').checked);
  $('#download-button').onclick=()=>{const a=document.createElement('a');a.download=`constellation-${roomId}-${currentRunId}.png`;a.href=$('#render-canvas').toDataURL('image/png');a.click();};
  $('#share-button').onclick=$('#qr-card').onclick=()=>$('#share-dialog').showModal();
  document.querySelectorAll('.dialog-close').forEach(b=>b.onclick=()=>b.closest('dialog').close());
  document.querySelectorAll('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d)d.close();}));
  $('#copy-button').onclick=async()=>{try{await navigator.clipboard.writeText(joinURL);toast('Join link copied.');}catch{$('#share-url').select();document.execCommand('copy');toast('Join link copied.');}};
  $('#about-link').onclick=e=>{e.preventDefault();$('#about-dialog').showModal();};
  $('#generate-button').onclick=async()=>{
    const prompt=$('#prompt').value.trim();if(prompt.length<3){toast('Describe the scene you want to create.');return;}
    const button=$('#generate-button');button.disabled=true;button.textContent='Imagining your scene…';
    try {
      const response=await fetch(`/api/rooms/${roomId}/scene`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({prompt})});
      const result=await response.json();if(!response.ok)throw new Error(result.error);
      roomScene=result.scene;selectedPreset=null;document.querySelectorAll('[data-preset]').forEach(b=>b.classList.remove('selected'));$('#scene-name').textContent=roomScene.name;toast('Scene created. Start a render to see it.');
    } catch(error){toast(error.message);}finally{button.disabled=!config.gemini||state.run?.status==='running';button.innerHTML='Generate scene <span>✧</span>';}
  };
}

function update(next) {
  state=next;const run=state.run;
  const active=state.clients.filter(c=>c.enabled),running=run?.status==='running';
  const percent=run?Math.round(run.completed/run.total*100):0;
  if(run&&run.id!==currentRunId) {
    currentRunId=run.id;receivedTiles.clear();owners.clear();chart=[];lastChartTime=0;
    const canvas=$('#render-canvas');canvas.width=run.settings.width;canvas.height=run.settings.height;
    if($('#owner-canvas')){$('#owner-canvas').width=canvas.width;$('#owner-canvas').height=canvas.height;}
    $('#canvas-empty').classList.add('hidden');roomScene=state.scene;
  }
  if(joinView) {
    $('#stat-devices').textContent=active.length;$('#join-progress').textContent=`${percent}%`;
    $('#my-tiles').textContent=state.clients.find(c=>c.id===clientId)?.tiles||0;
    return;
  }
  $('#stat-devices').innerHTML=`${active.length} <small>online</small>`;
  $('#stat-tiles').innerHTML=`${run?format(run.completed):0} <small>/ ${run?format(run.total):'—'}</small>`;
  $('#stat-rate').innerHTML=`${run?run.tilesPerSecond.toFixed(1):'—'} <small>tiles / sec</small>`;
  $('#stat-time').textContent=run?seconds(run.elapsed):'—';
  $('#scene-name').textContent=roomScene?.name||state.scene.name;
  $('#render-status').textContent=running?'RENDERING':run?.status==='complete'?'COMPLETE':run?.status==='cancelled'?'STOPPED':'READY';
  $('#render-status').classList.toggle('active',running);$('#render-dot').classList.toggle('active',running);
  $('#canvas-percent').textContent=`${percent}%`;$('#progress-bar').style.width=`${percent}%`;
  $('#canvas-details').textContent=run?`${run.settings.width} × ${run.settings.height} · ${run.settings.samples} SAMPLES · ${run.settings.bounces} BOUNCES`:'PATH TRACED · 32 × 32 TILES';
  $('#render-button').disabled=running||!active.length||!isHost||!connected;
  $('#render-button').classList.toggle('hidden',running);$('#stop-button').classList.toggle('hidden',!running||!isHost);
  $('#render-hint').textContent=!isHost?'Only the room owner can start a render.':running?'Each device receives one tile at a time.':!active.length?'Connect a contributing device to begin.':'All connected devices will share the work.';
  $('#resolution').disabled=$('#samples').disabled=running||!isHost;
  $('#generate-button').disabled=!config.gemini||running||!isHost;
  document.querySelectorAll('[data-preset]').forEach(b=>b.disabled=running||!isHost);
  $('#download-button').disabled=!run?.completed;
  $('#render-footer-status').textContent=running?`${run.inflight} tiles in flight · ${run.retries} reassigned`:run?.status==='complete'?`Completed by ${run.contributors.length} device${run.contributors.length===1?'':'s'}`:run?.status==='cancelled'?'Render stopped — partial image available':'Waiting for the first device';
  $('#device-count').textContent=active.length;
  const devices=state.clients.filter(c=>c.backend);
  $('#devices-list').innerHTML=devices.length?devices.map(c=>`<div class="device-row"><span class="device-icon" style="--device-color:${c.color}"><svg viewBox="0 0 24 24" fill="none"><rect x="6" y="3" width="12" height="18" rx="3" stroke="currentColor" stroke-width="1.5"/><path d="M10 17h4" stroke="currentColor" stroke-width="1.5"/></svg></span><div class="device-info"><strong>${esc(c.label)}${c.id===clientId?'<small>YOU</small>':''}</strong><span>${c.backend==='webgpu'?'WebGPU':'CPU'} · ${c.enabled?(c.busy?'Rendering':'Ready'):'Paused'}</span></div><div class="device-tiles">${c.tiles}<small>tiles</small></div><i class="node-dot ${c.enabled?'active':''}"></i></div>`).join(''):'<div class="empty-devices"><span>◎</span><p>No contributors yet.<br>Invite someone to get started.</p></div>';
  if(run&&run.elapsed-lastChartTime>0.45&&running) {
    lastChartTime=run.elapsed;chart.push(run.tilesPerSecond);if(chart.length>90)chart.shift();
    const max=Math.max(1,...chart);$('#sparkline').setAttribute('points',chart.map((v,i)=>`${i/Math.max(1,chart.length-1)*240},${52-v/max*46}`).join(' '));
  }
  $('#activity-log').innerHTML=state.events.slice(0,4).map(e=>`<div class="event-row"><i></i><span>${esc(eventLabel(e))}</span><time>${new Date(e.time).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time></div>`).join('')||'<p class="hint">Connections and completed runs appear here.</p>';
  updateBenchmark();
  if(config.tigerData&&Date.now()-metricsFetchedAt>5000) {metricsFetchedAt=Date.now();fetchMetrics();}
}
function eventLabel(e) {
  return ({device_joined:`${e.label} joined`,device_left:`${e.label} disconnected`,render_started:`Started ${e.scene}`,render_completed:`Render complete · ${e.workers} devices`,render_cancelled:'Render stopped',tile_reassigned:`Tile ${e.tileId} returned to queue`})[e.type]||e.type;
}
function updateBenchmark() {
  const latest=state.history[0];if(!latest)return;
  const baseline=state.history.find(h=>h.runId!==latest.runId&&h.workers===1&&h.fingerprint===latest.fingerprint&&h.backends===latest.backends);
  if(latest.workers>1&&baseline&&latest.seconds>0) {
    const ratio=baseline.seconds/latest.seconds;
    $('#benchmark-title').textContent=`${ratio.toFixed(2)}× solo throughput · ${latest.workers} contributors`;
    $('#benchmark-copy').textContent=`${seconds(baseline.seconds)} solo → ${seconds(latest.seconds)} together. Same scene, samples, resolution, and renderer type.`;
  } else {
    $('#benchmark-title').textContent=latest.workers===1?'Solo baseline recorded.':'A matching solo baseline is needed.';
    $('#benchmark-copy').textContent=latest.workers===1?`${seconds(latest.seconds)} on one ${latest.backends==='webgpu'?'WebGPU':'CPU'} device. Invite more devices and repeat these settings.`:'Complete one run with one device using the same scene, quality, resolution, and renderer type.';
  }
}
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
function drawOwners() {
  const canvas=$('#owner-canvas');if(!canvas||!state?.run)return;
  const ctx=canvas.getContext('2d'),cols=Math.ceil(canvas.width/TILE_SIZE);ctx.clearRect(0,0,canvas.width,canvas.height);
  for(const owner of owners.values()) {const x=owner.tileId%cols*TILE_SIZE,y=Math.floor(owner.tileId/cols)*TILE_SIZE;ctx.fillStyle=owner.color+'24';ctx.fillRect(x,y,TILE_SIZE,TILE_SIZE);ctx.strokeStyle=owner.color+'b0';ctx.lineWidth=1;ctx.strokeRect(x+0.5,y+0.5,TILE_SIZE-1,TILE_SIZE-1);}
}

document.addEventListener('visibilitychange',()=>{
  if(!initialized||!wantsToContribute)return;
  if(document.hidden){send({type:'contribute',enabled:false,reason:'page hidden'});pauseWorker();}
  else beginContribution();
});
window.addEventListener('beforeunload',()=>{wantsToContribute=false;worker?.terminate();ws?.close();});
boot();
