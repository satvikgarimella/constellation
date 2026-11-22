// Run with two volunteers on separate physical devices. This controller never
// renders tiles itself; the participants opt in from their own browsers.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { createTiles } from '../public/scene.js';
import { renderTileCPU } from '../public/raytracer.js';

const base=(process.argv[2]||'http://localhost:3210').replace(/\/$/,'');
const response=await fetch(`${base}/api/rooms`,{method:'POST'});
if(!response.ok) throw new Error(`Could not create test room: HTTP ${response.status}`);
const {roomId,hostToken}=await response.json();
const directory=new URL('../artifacts/',import.meta.url);
await mkdir(directory,{recursive:true});
const report={base,roomId,joinURL:`${base}/join/${roomId}`,startedAt:new Date().toISOString(),
  hardwareNote:'Participants must confirm these are separate physical phones; a WebSocket connection alone cannot prove device identity.',runs:[],comparisons:[]};
await writeFile(new URL('phone-session.json',directory),JSON.stringify(report,null,2));
console.log(`On both phones open ${report.joinURL}, enter distinct device names, and tap Contribute compute. Keep the pages visible.`);
console.log(`View the image: ${base}/r/${roomId}`);
const socket=new WebSocket(`${base.replace(/^http/,'ws')}/ws`);
let state=null,phase='waiting',selected=[],baseline=null,round=0,frames=new Map(),frameRun=null,lastDevices='';
const send=message=>{if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(message));};
const finish=async(status,reason)=>{
  if(phase==='finished')return;
  phase='finished';clearTimeout(timeout);report.status=status;report.reason=reason;report.finishedAt=new Date().toISOString();
  if(state?.run?.status==='running')send({type:'cancel'});
  await writeFile(new URL('phone-test-report.json',directory),JSON.stringify(report,null,2));
  console.log(JSON.stringify({status,reason,comparisons:report.comparisons,report:'artifacts/phone-test-report.json'},null,2));
  if(socket.readyState===WebSocket.OPEN)socket.close();else if(socket.readyState!==WebSocket.CLOSED)socket.terminate();
  if(status!=='passed')process.exitCode=1;
};
const start=(kind,workerIds,settings)=>{
  phase=kind;frames=new Map();frameRun=(state.run?.id||0)+1;
  console.log(`Starting ${kind}${round?` ${round}/3`:''}: ${settings.width} × ${settings.width}, ${settings.samples} samples, ${workerIds.length} participant(s).`);
  send({type:'start',workerIds,...settings});
};
const workload=()=>baseline.backend==='webgpu'?{width:512,samples:32,bounces:4}:{width:256,samples:8,bounces:4};
const advance=async()=>{
  const ready=state.clients.filter(c=>c.enabled);
  const devices=JSON.stringify(ready.map(c=>({id:c.id,label:c.label,backend:c.backend})));
  if(devices!==lastDevices){lastDevices=devices;console.log(`Ready participants: ${devices}`);}
  if(phase==='waiting'){
    if(ready.length<2)return;
    selected=ready.slice(0,2).map(c=>c.id);baseline=ready[0];report.devices=ready.slice(0,2).map(c=>({id:c.id,label:c.label,backend:c.backend}));
    start('quick',selected,{width:256,samples:8,bounces:4});return;
  }
  if(phase==='finished')return;
  if(selected.some(id=>!ready.some(c=>c.id===id)))return finish('interrupted','A participant paused or disconnected. Re-run with both pages kept visible.');
  if(state.run?.status!=='complete'||state.run.id!==frameRun)return;
  const bytes=[...frames.entries()].sort(([a],[b])=>a-b).map(([,v])=>v);
  const imageHash=createHash('sha256').update(Buffer.concat(bytes)).digest('hex');
  const record=state.history.find(h=>h.runId===frameRun);
  let darkest=255,brightest=0;
  for(const buffer of bytes)for(let i=0;i<buffer.length;i++){if(i%4===3)continue;darkest=Math.min(darkest,buffer[i]);brightest=Math.max(brightest,buffer[i]);}
  const runReport={phase,round,...record,receivedTiles:frames.size,imageHash};report.runs.push(runReport);
  console.log(`Completed ${phase}: ${record.seconds.toFixed(3)}s, ${record.tiles} tiles, ${record.workers} contributing participant(s).`);
  if(frames.size!==record.tiles||brightest===darkest)return finish('failed','Missing or blank image data.');
  if(phase==='quick'){
    let difference=0,channels=0;
    for(const tile of createTiles(state.run.settings.width,state.run.settings.height)){
      const expected=renderTileCPU(state.scene,state.run.settings,tile),actual=frames.get(tile.id);
      for(let i=0;i<expected.length;i++){difference+=Math.abs(expected[i]-actual[i]);channels++;}
    }
    runReport.meanAbsolutePixelError=difference/channels;
    if(runReport.meanAbsolutePixelError>=5)return finish('failed','Phone output differs substantially from the CPU reference.');
    if(record.workers!==2)return finish('incomplete','Both participants joined, but only one completed tiles. Increase the workload and retest.');
    if(new Set(report.devices.map(d=>d.backend)).size!==1)return finish('partial','Both phones rendered, but their backends differ. A matched GPU/CPU comparison was not run.');
    round=1;start('solo',[baseline.id],workload());
  }else if(phase==='solo')start('crowd',selected,workload());
  else {
    report.comparisons.push({round,...state.benchmark});
    if(!state.benchmark.eligible)return finish('failed',`Comparison not eligible: ${state.benchmark.reason}`);
    if(round===3)return finish('passed','Two participants completed a shared image and three matched solo/crowd comparisons. Physical device identity is participant-confirmed.');
    round++;start('solo',[baseline.id],workload());
  }
};
const timeout=setTimeout(()=>finish('incomplete','Timed out waiting for participants or completed renders.'),15*60*1000);
socket.on('open',()=>send({type:'hello',roomId,token:hostToken,label:'Phone test controller'}));
socket.on('message',(data,binary)=>{
  if(binary){const runId=data.readUInt32LE(0),tileId=data.readUInt32LE(4);if(runId===frameRun)frames.set(tileId,Buffer.from(data.subarray(16)));return;}
  const message=JSON.parse(data);
  if(message.type==='welcome'||message.type==='state'){state=message.state;advance().catch(error=>finish('failed',error.message));}
  else if(message.type==='error')finish('failed',message.message);
});
socket.on('error',()=>finish('failed','Controller WebSocket failed.'));
socket.on('close',()=>{if(phase!=='finished')finish('interrupted','Controller connection closed.');});
process.on('SIGINT',()=>finish('interrupted','Test stopped.'));
