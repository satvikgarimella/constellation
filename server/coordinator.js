import { randomBytes, createHash } from 'node:crypto';
import { PRESETS, validateScene, createTiles } from '../public/scene.js';

const COLORS = ['#e9a66a','#70c9b2','#88aef1','#c7a4e6','#e6cb77','#e78593','#8ed5df','#b4cd86'];
const MAX_BATCH_SIZE = 4;
const open = socket => socket.readyState === 1;
const json = (socket, value) => { if(open(socket)) socket.send(JSON.stringify(value)); };
const eligible = (run,client) => client.enabled && open(client.socket) && (!run?.workerIds || run.workerIds.includes(client.id));

// A speed comparison is meaningful only when the solo worker also did work in
// the crowd run, and both images used the same algorithm and render workload.
export function benchmark(history) {
  const crowd=history[0];
  if(!crowd) return {eligible:false,reason:'no_completed_runs'};
  const base={crowdRunId:crowd.runId,crowdSeconds:crowd.seconds};
  if(crowd.workers===1) return {...base,eligible:false,reason:'solo_baseline',baselineRunId:crowd.runId,baselineSeconds:crowd.seconds,baselineWorkerId:crowd.contributors[0]?.id};
  const renderers=record=>[...new Set(record.contributors.flatMap(c=>c.backends))];
  const crowdBackends=renderers(crowd);
  if(crowdBackends.length!==1) return {...base,eligible:false,reason:'mixed_backends'};
  const matching=history.slice(1).filter(h=>h.workers===1 && h.fingerprint===crowd.fingerprint);
  if(!matching.length) return {...base,eligible:false,reason:'matching_baseline_needed'};
  const sameBackend=matching.filter(h=>renderers(h).length===1 && renderers(h)[0]===crowdBackends[0]);
  if(!sameBackend.length) return {...base,eligible:false,reason:'backend_mismatch'};
  const baseline=sameBackend.find(h=>crowd.contributors.some(c=>c.id===h.contributors[0].id));
  if(!baseline) return {...base,eligible:false,reason:'baseline_worker_missing'};
  if(baseline.seconds<=0 || crowd.seconds<=0) return {...base,eligible:false,reason:'insufficient_timing'};
  return {...base,eligible:true,reason:'comparable',baselineRunId:baseline.runId,baselineSeconds:baseline.seconds,baselineWorkerId:baseline.contributors[0].id,baselineWorkerLabel:baseline.contributors[0].label,backend:crowdBackends[0],speedup:baseline.seconds/crowd.seconds};
}

export class Coordinator {
  constructor({ onEvent = () => {}, now = Date.now, leaseMs = 30000 } = {}) {
    this.rooms = new Map(); this.onEvent = onEvent; this.now = now; this.leaseMs = leaseMs;
  }
  createRoom() {
    if(this.rooms.size >= 100) throw new Error('The studio is at capacity. Please try again later.');
    let id;
    do { id=randomBytes(3).toString('hex').toUpperCase(); } while(this.rooms.has(id));
    const room={id, hostToken:randomBytes(24).toString('hex'), clients:new Map(), scene:structuredClone(PRESETS.aurora), run:null, sequence:0, leaseSequence:0, history:[], events:[], createdAt:this.now(), touchedAt:this.now()};
    this.rooms.set(id,room);
    return room;
  }
  get(id) {return this.rooms.get(String(id).toUpperCase());}
  emit(room,type,details={}) {
    const event={time:new Date(this.now()).toISOString(),roomId:room.id,type,...details};
    if(type!=='tile_completed') {room.events.unshift(event);room.events.length=Math.min(room.events.length,30);}
    try { this.onEvent(event); } catch { /* Telemetry cannot stop rendering. */ }
    return event;
  }
  connect(room,socket,{token,label}={}) {
    const id=randomBytes(5).toString('hex');
    const client={id,socket,label:String(label||'New device').slice(0,40),host:token===room.hostToken,enabled:false,backend:null,batchSize:1,jobs:new Map(),job:null,tiles:0,pixels:0,durationMs:0,joinedAt:this.now(),color:COLORS[room.clients.size%COLORS.length]};
    room.clients.set(id,client);room.touchedAt=this.now();
    json(socket,{type:'welcome',clientId:id,isHost:client.host,state:this.state(room)});
    if(room.run) {
      json(socket,{type:'tile-owners',runId:room.run.id,owners:[...room.run.owners.values()]});
      for(const result of room.run.results.values()) if(open(socket)) socket.send(result);
    }
    this.broadcast(room);
    return client;
  }
  disconnect(room,client) {
    if(!room.clients.has(client.id)) return;
    this.release(room,client,'disconnected');
    room.clients.delete(client.id);room.touchedAt=this.now();
    if(client.backend) this.emit(room,'device_left',{workerId:client.id,label:client.label});
    this.pump(room);this.broadcast(room);
  }
  message(room,client,msg) {
    if(!msg||typeof msg.type!=='string') return;
    room.touchedAt=this.now();
    if(msg.type==='contribute') {
      client.label=String(msg.label||client.label).slice(0,40);
      if(msg.enabled) {
        if(!['webgpu','cpu'].includes(msg.backend)) throw new Error('Unknown renderer.');
        const was=client.enabled;
        client.batchSize=Number.isFinite(msg.batchSize)&&msg.batchSize>=1?Math.min(MAX_BATCH_SIZE,Math.floor(msg.batchSize)):1;
        client.enabled=true;client.backend=msg.backend;
        if(!was) this.emit(room,'device_joined',{workerId:client.id,label:client.label,backend:client.backend});
      } else { client.enabled=false;this.release(room,client,msg.reason||'paused'); }
      this.pump(room);this.broadcast(room);
    } else if(msg.type==='start') {
      if(!client.host) throw new Error('Only the room owner can start a render.');
      this.start(room,msg);
    } else if(msg.type==='cancel') {
      if(!client.host) throw new Error('Only the room owner can stop a render.');
      this.cancel(room);
    } else if(msg.type==='ping') json(client.socket,{type:'pong'});
  }
  start(room,{scene=room.scene,width=512,samples=32,bounces=4,workerIds=null}={}) {
    if(room.run?.status==='running') throw new Error('Stop the current render before starting another.');
    if(![256,512,768,1024,2048].includes(width)||![8,16,32,64,128,256,512].includes(samples)||![2,3,4,5].includes(bounces)) throw new Error('Unsupported render settings.');
    if(workerIds!==null) {
      if(!Array.isArray(workerIds)||!workerIds.length||workerIds.length>100||workerIds.some(id=>typeof id!=='string'||!room.clients.has(id))) throw new Error('Select at least one connected contributing device.');
      workerIds=[...new Set(workerIds)];
      if(workerIds.some(id=>!eligible(null,room.clients.get(id)))) throw new Error('Every selected device must opt in before starting.');
    }
    const initialWorkers=[...room.clients.values()].filter(c=>eligible({workerIds},c)).map(c=>({id:c.id,label:c.label,backend:c.backend}));
    if(!initialWorkers.length) throw new Error('Connect at least one contributing device first.');
    const normalized=validateScene(scene),settings={width,height:width,samples,bounces};
    room.scene=normalized;
    const tiles=createTiles(width,width);
    // Interleave near and far tiles so the whole image appears early.
    const pending=tiles.map(t=>t.id).sort((a,b)=>((a*137)%tiles.length)-((b*137)%tiles.length));
    const fingerprint=createHash('sha256').update(JSON.stringify({scene:normalized,settings})).digest('hex');
    room.run={id:++room.sequence,status:'running',scene:normalized,settings,workerIds,initialWorkers,tiles,pending,inflight:new Map(),results:new Map(),owners:new Map(),contributions:new Map(),fingerprint,startedAt:this.now(),finishedAt:null,retries:0,retryReasons:{},lastReassignment:null,completedPixels:0};
    for(const c of room.clients.values()) {c.jobs.clear();c.job=null;c.tiles=0;c.pixels=0;c.durationMs=0;}
    this.emit(room,'render_started',{runId:room.run.id,settings,scene:normalized.name,workerIds,initialWorkers});
    this.broadcast(room);this.pump(room);
  }
  cancel(room) {
    if(room.run?.status!=='running') return;
    room.run.status='cancelled';room.run.finishedAt=this.now();room.run.inflight.clear();
    for(const c of room.clients.values()) {c.jobs.clear();c.job=null;json(c.socket,{type:'cancel',runId:room.run.id});}
    this.emit(room,'render_cancelled',{runId:room.run.id});this.broadcast(room);
  }
  release(room,client,reason) {
    const run=room.run,jobs=[...client.jobs.values()];
    client.jobs.clear();client.job=null;
    if(run?.status!=='running') return;
    const detail=String(reason||'paused').slice(0,80);
    const category=['disconnected','timeout','page hidden'].includes(detail)?detail:'paused';
    const released=[];
    for(const job of jobs) {
      const assigned=run.inflight.get(job.id);
      if(job.runId!==run.id||assigned?.workerId!==client.id||assigned.lease!==job.lease) continue;
      run.inflight.delete(job.id);released.push(job.id);run.retries++;
      run.retryReasons[category]=(run.retryReasons[category]||0)+1;
      run.lastReassignment={tileId:job.id,workerId:client.id,label:client.label,reason:detail,time:this.now()};
      this.emit(room,'tile_reassigned',{runId:run.id,tileId:job.id,workerId:client.id,label:client.label,reason:detail});
    }
    run.pending.unshift(...released);
  }
  pump(room) {
    const run=room.run;
    if(run?.status!=='running') return;
    for(const c of room.clients.values()) {
      if(!eligible(run,c)||c.jobs.size||!run.pending.length) continue;
      const jobs=[],assignedAt=this.now();
      while(jobs.length<c.batchSize&&run.pending.length) {
        const id=run.pending.shift();
        const job={...run.tiles[id],runId:run.id,lease:++room.leaseSequence};
        c.jobs.set(id,job);jobs.push(job);
        run.inflight.set(id,{workerId:c.id,lease:job.lease,assignedAt,expiresAt:assignedAt+this.leaseMs});
      }
      c.job=jobs[0];
      json(c.socket,{...(c.batchSize>1?{type:'jobs',jobs}:{type:'job',job:c.job}),scene:run.scene,settings:run.settings});
    }
  }
  result(room,client,bytes) {
    const data=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
    if(data.byteLength<16) return false;
    const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
    const runId=view.getUint32(0,true),id=view.getUint32(4,true),lease=view.getUint32(8,true),durationMs=view.getFloat32(12,true);
    const run=room.run,assigned=run?.inflight.get(id),tile=run?.tiles[id];
    if(run?.status!=='running'||run.id!==runId||!tile||assigned?.workerId!==client.id||assigned.lease!==lease||client.jobs.get(id)?.lease!==lease) return false;
    if(data.byteLength!==16+tile.width*tile.height*4||!Number.isFinite(durationMs)||durationMs<0) return false;
    run.inflight.delete(id);client.jobs.delete(id);client.job=client.jobs.values().next().value??null;
    // Batches render sequentially. Progress renews the remaining leases so the
    // timeout measures a stalled worker, not the total time of all queued tiles.
    for(const job of client.jobs.values()) run.inflight.get(job.id).expiresAt=this.now()+this.leaseMs;
    const stored=Buffer.from(data);run.results.set(id,stored);
    const pixels=tile.width*tile.height;
    run.completedPixels+=pixels;
    client.tiles++;client.pixels+=pixels;client.durationMs+=durationMs;
    const contribution=run.contributions.get(client.id)||{id:client.id,label:client.label,color:client.color,backend:client.backend,backends:[],tiles:0,pixels:0};
    if(!contribution.backends.includes(client.backend)) contribution.backends.push(client.backend);
    contribution.backends.sort();contribution.backend=contribution.backends.join('+');
    contribution.tiles++;contribution.pixels+=pixels;run.contributions.set(client.id,contribution);
    this.emit(room,'tile_completed',{runId,tileId:id,workerId:client.id,backend:client.backend,durationMs:Math.round(durationMs),observedMs:this.now()-assigned.assignedAt,pixels,samples:run.settings.samples});
    const owner={tileId:id,workerId:client.id,color:client.color};run.owners.set(id,owner);
    for(const c of room.clients.values()) if(open(c.socket)) {json(c.socket,{type:'tile-owners',runId,owners:[owner]});c.socket.send(stored);}
    if(run.results.size===run.tiles.length) {
      run.status='complete';run.finishedAt=this.now();
      const duration=(run.finishedAt-run.startedAt)/1000;
      const contributors=[...run.contributions.values()].map(c=>({...c,backends:[...c.backends]}));
      const backends=[...new Set(contributors.flatMap(c=>c.backends))].sort().join('+');
      const pixelSamples=run.completedPixels*run.settings.samples;
      const record={runId:run.id,scene:run.scene.name,fingerprint:run.fingerprint,backends,width:run.settings.width,samples:run.settings.samples,seconds:duration,workers:run.contributions.size,contributors,workerIds:run.workerIds,initialWorkers:run.initialWorkers,tiles:run.tiles.length,completedPixels:run.completedPixels,pixelSamples,pixelSamplesPerSecond:duration>0?pixelSamples/duration:0,retries:run.retries,retryReasons:run.retryReasons,startedAt:run.startedAt,finishedAt:run.finishedAt};
      room.history.unshift(record);room.history=room.history.slice(0,20);
      this.emit(room,'render_completed',record);this.broadcast(room);
    } else this.pump(room);
    return true;
  }
  tick() {
    for(const room of this.rooms.values()) {
      const run=room.run;
      if(run?.status==='running') {
        const expiredWorkers=new Set([...run.inflight.values()].filter(assigned=>assigned.expiresAt<this.now()).map(assigned=>assigned.workerId));
        for(const workerId of expiredWorkers) {
          const client=room.clients.get(workerId);
          if(client) {client.enabled=false;this.release(room,client,'timeout');json(client.socket,{type:'paused',reason:'Your worker stopped completing tiles. Rejoin to try again.'});}
        }
        this.pump(room);
      }
      if(!room.clients.size && this.now()-room.touchedAt>4*60*60*1000) this.rooms.delete(room.id);
    }
  }
  state(room) {
    const run=room.run;
    const elapsed=run?Math.max(0,((run.finishedAt??this.now())-run.startedAt)/1000):0;
    const contributors=run?[...run.contributions.values()]:[];
    const clients=[...room.clients.values()],pixelSamples=run?run.completedPixels*run.settings.samples:0;
    return {
      roomId:room.id,scene:room.scene,scenePending:!!run&&room.scene!==run.scene,
      clients:clients.map(c=>({id:c.id,label:c.label,enabled:c.enabled,backend:c.backend,color:c.color,tiles:c.tiles,pixels:c.pixels,computeMs:c.durationMs,busy:!!c.job,batchSize:c.batchSize,inflight:c.jobs.size,selected:eligible(run,c)})),
      deviceCounts:{connected:clients.length,recruited:clients.filter(c=>c.backend).length,ready:clients.filter(c=>eligible(null,c)).length,eligible:clients.filter(c=>eligible(run,c)).length,contributing:contributors.length},
      run:run?{id:run.id,status:run.status,settings:run.settings,workerIds:run.workerIds,selectionMode:run.workerIds?'selected':'open',initialWorkers:run.initialWorkers,completed:run.results.size,total:run.tiles.length,inflight:run.inflight.size,retries:run.retries,retryReasons:run.retryReasons,lastReassignment:run.lastReassignment,startedAt:run.startedAt,finishedAt:run.finishedAt,completedPixels:run.completedPixels,pixelSamples,pixelSamplesPerSecond:elapsed>0?pixelSamples/elapsed:0,elapsed,tilesPerSecond:elapsed>0?run.results.size/elapsed:0,contributors,fingerprint:run.fingerprint}:null,
      history:room.history,
      benchmark:benchmark(room.history),
      events:room.events.filter(e=>e.type!=='tile_completed').slice(0,8)
    };
  }
  broadcast(room) {const state=this.state(room);for(const c of room.clients.values()) json(c.socket,{type:'state',state});}
}
