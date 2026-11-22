import { randomBytes, createHash } from 'node:crypto';
import { PRESETS, validateScene, createTiles } from '../public/scene.js';

const COLORS = ['#e9a66a','#70c9b2','#88aef1','#c7a4e6','#e6cb77','#e78593','#8ed5df','#b4cd86'];
const open = socket => socket.readyState === 1;
const json = (socket, value) => { if(open(socket)) socket.send(JSON.stringify(value)); };

export class Coordinator {
  constructor({ onEvent = () => {}, now = Date.now, leaseMs = 30000 } = {}) {
    this.rooms = new Map(); this.onEvent = onEvent; this.now = now; this.leaseMs = leaseMs;
  }
  createRoom() {
    if(this.rooms.size >= 100) throw new Error('The studio is at capacity. Please try again later.');
    let id;
    do { id=randomBytes(3).toString('hex').toUpperCase(); } while(this.rooms.has(id));
    const room={id, hostToken:randomBytes(24).toString('hex'), clients:new Map(), scene:structuredClone(PRESETS.solstice), run:null, sequence:0, leaseSequence:0, history:[], events:[], createdAt:this.now(), touchedAt:this.now()};
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
    const client={id,socket,label:String(label||'New device').slice(0,40),host:token===room.hostToken,enabled:false,backend:null,job:null,tiles:0,pixels:0,durationMs:0,joinedAt:this.now(),color:COLORS[room.clients.size%COLORS.length]};
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
  start(room,{scene=room.scene,width=512,samples=32,bounces=4}={}) {
    if(room.run?.status==='running') throw new Error('Stop the current render before starting another.');
    if(![256,512,768,1024].includes(width)||![8,16,32,64,128].includes(samples)||![2,3,4,5].includes(bounces)) throw new Error('Unsupported render settings.');
    if(![...room.clients.values()].some(c=>c.enabled)) throw new Error('Connect at least one contributing device first.');
    const normalized=validateScene(scene),settings={width,height:width,samples,bounces};
    room.scene=normalized;
    const tiles=createTiles(width,width);
    // Interleave near and far tiles so the whole image appears early.
    const pending=tiles.map(t=>t.id).sort((a,b)=>((a*137)%tiles.length)-((b*137)%tiles.length));
    const fingerprint=createHash('sha256').update(JSON.stringify({scene:normalized,settings})).digest('hex');
    room.run={id:++room.sequence,status:'running',scene:normalized,settings,tiles,pending,inflight:new Map(),results:new Map(),owners:new Map(),contributions:new Map(),fingerprint,startedAt:this.now(),finishedAt:null,retries:0};
    for(const c of room.clients.values()) {c.job=null;c.tiles=0;c.pixels=0;c.durationMs=0;}
    this.emit(room,'render_started',{runId:room.run.id,settings,scene:normalized.name});
    this.broadcast(room);this.pump(room);
  }
  cancel(room) {
    if(room.run?.status!=='running') return;
    room.run.status='cancelled';room.run.finishedAt=this.now();room.run.inflight.clear();
    for(const c of room.clients.values()) {c.job=null;json(c.socket,{type:'cancel',runId:room.run.id});}
    this.emit(room,'render_cancelled',{runId:room.run.id});this.broadcast(room);
  }
  release(room,client,reason) {
    const run=room.run,job=client.job;
    client.job=null;
    if(!job||run?.status!=='running'||job.runId!==run.id) return;
    const assigned=run.inflight.get(job.id);
    if(assigned?.workerId!==client.id||assigned.lease!==job.lease) return;
    run.inflight.delete(job.id);run.pending.unshift(job.id);run.retries++;
    this.emit(room,'tile_reassigned',{runId:run.id,tileId:job.id,workerId:client.id,reason});
  }
  pump(room) {
    const run=room.run;
    if(run?.status!=='running') return;
    for(const c of room.clients.values()) {
      if(!c.enabled||c.job||!open(c.socket)||!run.pending.length) continue;
      const id=run.pending.shift();
      const job={...run.tiles[id],runId:run.id,lease:++room.leaseSequence};
      c.job=job;
      run.inflight.set(id,{workerId:c.id,lease:job.lease,assignedAt:this.now(),expiresAt:this.now()+this.leaseMs});
      json(c.socket,{type:'job',job,scene:run.scene,settings:run.settings});
    }
  }
  result(room,client,bytes) {
    const data=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
    if(data.byteLength<16) return false;
    const view=new DataView(data.buffer,data.byteOffset,data.byteLength);
    const runId=view.getUint32(0,true),id=view.getUint32(4,true),lease=view.getUint32(8,true),durationMs=view.getFloat32(12,true);
    const run=room.run,assigned=run?.inflight.get(id),tile=run?.tiles[id];
    if(run?.status!=='running'||run.id!==runId||!tile||assigned?.workerId!==client.id||assigned.lease!==lease||client.job?.lease!==lease) return false;
    if(data.byteLength!==16+tile.width*tile.height*4||!Number.isFinite(durationMs)||durationMs<0) return false;
    run.inflight.delete(id);client.job=null;
    const stored=Buffer.from(data);run.results.set(id,stored);
    const pixels=tile.width*tile.height;
    client.tiles++;client.pixels+=pixels;client.durationMs+=durationMs;
    const contribution=run.contributions.get(client.id)||{id:client.id,label:client.label,color:client.color,backend:client.backend,tiles:0};
    contribution.tiles++;run.contributions.set(client.id,contribution);
    this.emit(room,'tile_completed',{runId,tileId:id,workerId:client.id,backend:client.backend,durationMs:Math.round(durationMs),observedMs:this.now()-assigned.assignedAt,pixels,samples:run.settings.samples});
    const owner={tileId:id,workerId:client.id,color:client.color};run.owners.set(id,owner);
    for(const c of room.clients.values()) if(open(c.socket)) {json(c.socket,{type:'tile-owners',runId,owners:[owner]});c.socket.send(stored);}
    if(run.results.size===run.tiles.length) {
      run.status='complete';run.finishedAt=this.now();
      const duration=(run.finishedAt-run.startedAt)/1000;
      const backends=[...new Set([...run.contributions.values()].map(c=>c.backend))].sort().join('+');
      const record={runId:run.id,scene:run.scene.name,fingerprint:run.fingerprint,backends,width:run.settings.width,samples:run.settings.samples,seconds:duration,workers:run.contributions.size,tiles:run.tiles.length,retries:run.retries,finishedAt:run.finishedAt};
      room.history.unshift(record);room.history=room.history.slice(0,20);
      this.emit(room,'render_completed',record);this.broadcast(room);
    } else this.pump(room);
    return true;
  }
  tick() {
    for(const room of this.rooms.values()) {
      const run=room.run;
      if(run?.status==='running') {
        for(const assigned of [...run.inflight.values()]) if(assigned.expiresAt<this.now()) {
          const client=room.clients.get(assigned.workerId);
          if(client) {client.enabled=false;this.release(room,client,'timeout');json(client.socket,{type:'paused',reason:'Your last tile timed out. Rejoin to try again.'});}
        }
        this.pump(room);
      }
      if(!room.clients.size && this.now()-room.touchedAt>4*60*60*1000) this.rooms.delete(room.id);
    }
  }
  state(room) {
    const run=room.run;
    const elapsed=run?Math.max(0,((run.finishedAt||this.now())-run.startedAt)/1000):0;
    const contributors=run?[...run.contributions.values()]:[];
    return {
      roomId:room.id,scene:room.scene,
      clients:[...room.clients.values()].map(c=>({id:c.id,label:c.label,enabled:c.enabled,backend:c.backend,color:c.color,tiles:c.tiles,pixels:c.pixels,computeMs:c.durationMs,busy:!!c.job})),
      run:run?{id:run.id,status:run.status,settings:run.settings,completed:run.results.size,total:run.tiles.length,inflight:run.inflight.size,retries:run.retries,elapsed,tilesPerSecond:elapsed>0?run.results.size/elapsed:0,contributors,fingerprint:run.fingerprint}:null,
      history:room.history,
      events:room.events.filter(e=>e.type!=='tile_completed').slice(0,8)
    };
  }
  broadcast(room) {const state=this.state(room);for(const c of room.clients.values()) json(c.socket,{type:'state',state});}
}
