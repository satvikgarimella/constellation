import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { networkInterfaces } from 'node:os';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { Coordinator } from './coordinator.js';
import { Telemetry } from './telemetry.js';
import { generateScene } from './gemini.js';
import { validateScene } from '../public/scene.js';

const ROOT=fileURLToPath(new URL('../public/',import.meta.url));
const CAD_ROOT=fileURLToPath(new URL('../node_modules/occt-import-js/dist/',import.meta.url));
const CAD_FILES=new Set(['occt-import-js.js','occt-import-js.wasm','license.occt-import-js.txt','license.occt.txt']);
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.wgsl':'text/plain; charset=utf-8','.obj':'text/plain; charset=utf-8','.stl':'application/octet-stream','.step':'text/plain; charset=utf-8','.stp':'text/plain; charset=utf-8','.wasm':'application/wasm','.txt':'text/plain; charset=utf-8'};

export function createApp({port=Number(process.env.PORT)||3210,host=process.env.HOST||'0.0.0.0',dataDir=process.env.DATA_DIR||'./data',databaseUrl=process.env.DATABASE_URL,apiKey=process.env.GEMINI_API_KEY,publicUrl=process.env.PUBLIC_URL||'',leaseMs=30000,sceneGenerator=generateScene}={}) {
  const telemetry=new Telemetry({directory:dataDir,databaseUrl});
  const coordinator=new Coordinator({onEvent:e=>telemetry.record(e),leaseMs});
  const creationLimits=new Map(),aiLimits=new Map();
  let listeningPort=port;
  const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
  const body=async (req,limit=16000)=>{let size=0;const chunks=[];for await(const chunk of req) {size+=chunk.length;if(size>limit) throw new Error('Request too large.');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');};
  const allowedOrigin=req=>!req.headers.origin||req.headers.origin===`http://${req.headers.host}`||req.headers.origin===`https://${req.headers.host}`||(publicUrl&&req.headers.origin===new URL(publicUrl).origin);
  const authorize=(req,room)=>room&&req.headers.authorization===`Bearer ${room.hostToken}`;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'");
    try {
      if(!allowedOrigin(req)) return send(res,403,{error:'Origin not allowed.'});
      const url=new URL(req.url,'http://localhost');
      // Pinned OCCT Embind glue uses generated functions. Permit them only in
      // the disposable CAD worker; the studio and render workers keep strict CSP.
      if(url.pathname==='/cad-worker.js')res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self' 'unsafe-eval'; connect-src 'self'; worker-src 'none'");
      if(url.pathname==='/healthz') return send(res,200,{ok:true});
      if(url.pathname==='/api/config') {
        const addresses=Object.values(networkInterfaces()).flat().filter(n=>n&&n.family==='IPv4'&&!n.internal).map(n=>`http://${n.address}:${listeningPort}`);
        return send(res,200,{gemini:!!apiKey,tigerData:!!databaseUrl,databaseReady:telemetry.databaseReady,publicUrl,lanUrls:publicUrl?[]:addresses});
      }
      if(url.pathname==='/api/rooms' && req.method==='POST') {
        const ip=req.socket.remoteAddress,now=Date.now(),previous=creationLimits.get(ip)||{at:now,count:0};
        if(now-previous.at>60000){previous.at=now;previous.count=0;}
        previous.count++;creationLimits.set(ip,previous);
        if(previous.count>12) return send(res,429,{error:'Too many rooms created. Please wait a minute.'});
        const room=coordinator.createRoom();return send(res,201,{roomId:room.id,hostToken:room.hostToken});
      }
      const apiRoom=url.pathname.match(/^\/api\/rooms\/([A-F0-9]{6})(?:\/(metrics|scene))?$/i);
      if(apiRoom) {
        const room=coordinator.get(apiRoom[1]);if(!room) return send(res,404,{error:'This room has expired or does not exist.'});
        if(!apiRoom[2]&&req.method==='GET') return send(res,200,coordinator.state(room));
        if(apiRoom[2]==='metrics'&&req.method==='GET') return send(res,200,await telemetry.metrics(room.id));
        if(apiRoom[2]==='scene'&&['POST','PUT'].includes(req.method)) {
          if(!authorize(req,room)) return send(res,403,{error:'Only the room owner can change the scene.'});
          if(room.run?.status==='running') return send(res,409,{error:'Finish or stop the current render first.'});
          const input=await body(req,2*1024*1024);
          if(input.revision!==undefined&&input.revision!==room.sceneRevision) return send(res,409,{error:'The scene changed. Refresh your studio before trying again.'});
          if(req.method==='PUT') {
            const scene=validateScene(input.scene);
            coordinator.setScene(room,scene);
            return send(res,200,{scene,revision:room.sceneRevision});
          }
          if(input.mode!==undefined&&!['generate','edit'].includes(input.mode)) return send(res,400,{error:'Choose Generate new or Edit scene.'});
          const last=aiLimits.get(room.id)||0;if(Date.now()-last<5000) return send(res,429,{error:'Please wait a few seconds before generating again.'});
          if(typeof input.prompt!=='string'||input.prompt.trim().length<3||input.prompt.length>600) return send(res,400,{error:'Describe your scene in 3–600 characters.'});
          const revision=room.sceneRevision,sequence=room.sequence;
          aiLimits.set(room.id,Date.now());
          const scene=await sceneGenerator({prompt:input.prompt,currentScene:room.scene,mode:input.mode||'generate',apiKey});
          if(room.run?.status==='running'||sequence!==room.sequence||revision!==room.sceneRevision) return send(res,409,{error:'The scene or render changed while Gemini was working. Your current scene is preserved; try again.'});
          coordinator.setScene(room,scene);return send(res,200,{scene,revision:room.sceneRevision});
        }
        return send(res,405,{error:'Method not allowed.'});
      }
      if(url.pathname==='/api/qr') {
        const roomId=url.searchParams.get('room');if(!coordinator.get(roomId)) return send(res,404,{error:'Room not found.'});
        const base=publicUrl||url.searchParams.get('base')||`http://${req.headers.host}`;
        const parsed=new URL(base);if(!['http:','https:'].includes(parsed.protocol)) return send(res,400,{error:'Invalid URL.'});
        const svg=await QRCode.toString(`${parsed.origin}/join/${roomId.toUpperCase()}`,{type:'svg',margin:1,color:{dark:'#18221f',light:'#ffffff'}});
        res.writeHead(200,{'Content-Type':'image/svg+xml','Cache-Control':'no-store'});return res.end(svg);
      }
      if(req.method!=='GET'&&req.method!=='HEAD') return send(res,405,{error:'Method not allowed.'});
      if(url.pathname.startsWith('/vendor/occt/')) {
        const name=url.pathname.slice('/vendor/occt/'.length);
        if(!CAD_FILES.has(name))return send(res,404,{error:'Not found.'});
        const contents=await readFile(resolve(CAD_ROOT,name));
        res.writeHead(200,{'Content-Type':MIME[extname(name)],'Cache-Control':'public, max-age=86400'});
        return res.end(req.method==='HEAD'?undefined:contents);
      }
      let path=url.pathname;
      if(path==='/'||/^\/(r|join)\/[A-F0-9]{6}$/i.test(path)) path='/index.html';
      const file=resolve(ROOT,'.'+decodeURIComponent(path));
      if(!file.startsWith(ROOT)||!MIME[extname(file)]) return send(res,404,{error:'Not found.'});
      const contents=await readFile(file);
      res.writeHead(200,{'Content-Type':MIME[extname(file)],'Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:contents);
    } catch(error) {if(!res.headersSent) send(res,error.code==='ENOENT'?404:400,{error:error.code==='ENOENT'?'Not found.':error.message});else res.end();}
  });
  const wss=new WebSocketServer({noServer:true,maxPayload:32768});
  server.on('upgrade',(req,socket,head)=>{if(req.url!=='/ws'||!allowedOrigin(req)){socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));});
  wss.on('connection',socket=>{
    let room,client;
    socket.alive=true;socket.on('pong',()=>{socket.alive=true;});
    const timeout=setTimeout(()=>{if(!client) socket.close(1008,'Join a room first.');},5000);timeout.unref();
    socket.on('message',(data,isBinary)=>{
      try {
        if(isBinary){if(room&&client)coordinator.result(room,client,data);return;}
        const msg=JSON.parse(data.toString());
        if(!client) {
          if(msg.type!=='hello'||!(room=coordinator.get(msg.roomId))) {socket.close(1008,'Room not found.');return;}
          if(room.clients.size>=100) {socket.close(1008,'Room is full.');return;}
          client=coordinator.connect(room,socket,msg);clearTimeout(timeout);
        } else coordinator.message(room,client,msg);
      } catch(error) {if(socket.readyState===1) socket.send(JSON.stringify({type:'error',message:error.message}));}
    });
    socket.on('close',()=>{clearTimeout(timeout);if(client)coordinator.disconnect(room,client);});
    socket.on('error',()=>{});
  });
  const timer=setInterval(()=>{coordinator.tick();for(const room of coordinator.rooms.values()) if(room.clients.size) coordinator.broadcast(room);},500);timer.unref();
  const heartbeat=setInterval(()=>{for(const socket of wss.clients){if(!socket.alive){socket.terminate();continue;}socket.alive=false;socket.ping();}},10000);heartbeat.unref();
  return {server,coordinator,telemetry,
    setPublicUrl:value=>{const url=new URL(value);if(url.protocol!=='https:')throw new Error('Public demo URL must use HTTPS.');publicUrl=url.origin;},
    listen:()=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.removeListener('error',reject);listeningPort=server.address().port;resolve(listeningPort);});}),
    close:async()=>{clearInterval(timer);clearInterval(heartbeat);for(const s of wss.clients)s.terminate();await new Promise(r=>server.close(r));await telemetry.close();}
  };
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])) {
  const app=createApp();
  const port=await app.listen();console.log(`Constellation is running at http://localhost:${port}`);
  for(const n of Object.values(networkInterfaces()).flat()) if(n?.family==='IPv4'&&!n.internal) console.log(`Join from your Wi-Fi: http://${n.address}:${port}`);
  console.log(`Gemini: ${process.env.GEMINI_API_KEY?'configured':'not configured'} · Tiger Data: ${process.env.DATABASE_URL?'configured':'local telemetry only'}`);
  process.on('SIGINT',async()=>{await app.close();process.exit(0);});process.on('SIGTERM',async()=>{await app.close();process.exit(0);});
}
