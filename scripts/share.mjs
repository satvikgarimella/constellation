import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createApp } from '../server/index.js';

// This process owns both the app and its temporary public tunnel. Ctrl-C stops both.
const localBinary=resolve('.tools/cloudflared');
const binary=process.env.CLOUDFLARED_BIN||await access(localBinary).then(()=>localBinary,()=> 'cloudflared');
const app=createApp();
let tunnel,stopping=false,publicUrl='';
async function stop(code=0) {
  if(stopping)return;stopping=true;
  tunnel?.kill('SIGTERM');
  await app.close().catch(()=>{});
  process.exitCode=code;
}
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
try {
  const port=await app.listen();
  console.log(`Local studio: http://localhost:${port}`);
  await mkdir('./data',{recursive:true});
  // An explicit empty config avoids reading a user's existing named-tunnel configuration.
  const config=resolve('./data/quick-tunnel.yml');await writeFile(config,'{}\n');
  tunnel=spawn(binary,['tunnel','--config',config,'--no-autoupdate','--url',`http://127.0.0.1:${port}`,'--metrics','127.0.0.1:0','--protocol','http2'],{stdio:['ignore','pipe','pipe']});
  let pending='';
  const onLog=chunk=>{
    const text=chunk.toString();process.stdout.write(text);pending=(pending+text).slice(-16000);
    const match=pending.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/);
    if(match&&!publicUrl){publicUrl=match[0];app.setPublicUrl(publicUrl);console.log(`\nPublic studio: ${publicUrl}\nOpen this HTTPS link to create your host room, then share its QR code.\nThis link lasts while this process runs.\n`);writeFile('./data/demo-url.json',JSON.stringify({url:publicUrl,port,startedAt:new Date().toISOString()},null,2)).catch(()=>{});}
  };
  tunnel.stdout.on('data',onLog);tunnel.stderr.on('data',onLog);
  tunnel.on('error',error=>{console.error(`Could not start cloudflared: ${error.message}. Install it or set CLOUDFLARED_BIN.`);stop(1);});
  tunnel.on('exit',code=>{if(!stopping){console.error(`Tunnel stopped (${code}). Restart the share command to get a new link.`);stop(code||1);}});
} catch(error) {console.error(error.message);await stop(1);}
