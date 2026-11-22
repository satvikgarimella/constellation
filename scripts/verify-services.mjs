import { randomUUID } from 'node:crypto';
import { mkdir,mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateScene } from '../server/gemini.js';
import { safeDatabaseErrorCode,Telemetry } from '../server/telemetry.js';
import { PRESETS } from '../public/scene.js';

const geminiErrorCodes=new Set(['GEMINI_NOT_CONFIGURED','GEMINI_TIMEOUT','GEMINI_NETWORK_ERROR','GEMINI_HTTP_ERROR','GEMINI_INVALID_RESPONSE','GEMINI_EMPTY_RESPONSE','GEMINI_INVALID_SCENE']);

async function verifyGemini(env) {
  if(!env.GEMINI_API_KEY?.trim()) return {status:'missing_configuration',required:'GEMINI_API_KEY'};
  const model=env.GEMINI_MODEL||'gemini-3.8-flash';
  const modelLabel=/^[a-zA-Z0-9.-]{1,100}$/.test(model)?model:'custom-model';
  const start=performance.now();
  try {
    const scene=await generateScene({
      prompt:'Compose a minimal still life with three spheres: a red diffuse sphere, a blue diffuse sphere, and a small silver sphere, all resting on the ground.',
      scene:PRESETS.lunar,apiKey:env.GEMINI_API_KEY,model
    });
    return {status:'verified',model:modelLabel,durationMs:Math.round(performance.now()-start),sphereCount:scene.spheres.length,check:'Real Gemini response parsed and validated by the application scene adapter.'};
  } catch(error) {
    const result={status:'failed',model:modelLabel,durationMs:Math.round(performance.now()-start),code:geminiErrorCodes.has(error?.code)?error.code:'GEMINI_ERROR'};
    if(Number.isInteger(error?.status)&&error.status>=100&&error.status<=599) result.httpStatus=error.status;
    return result;
  }
}

async function verifyDatabase(env,verificationId) {
  if(!env.DATABASE_URL?.trim()) return {status:'missing_configuration',required:'DATABASE_URL'};
  const roomId=`VERIFY_${verificationId}`;
  const start=performance.now();
  let directory,telemetry;
  try {
    directory=await mkdtemp(join(tmpdir(),'constellation-service-check-'));
    telemetry=new Telemetry({directory,databaseUrl:env.DATABASE_URL});
    await telemetry.initializing;
    if(!telemetry.databaseReady) return {status:'failed',code:telemetry.lastErrorCode||'DATABASE_UNAVAILABLE'};
    telemetry.record({time:new Date().toISOString(),roomId,type:'tile_completed',runId:1,workerId:'service-verifier',durationMs:5,pixels:1024,verification:true,verificationId});
    await telemetry.flush();
    if(!telemetry.databaseReady||telemetry.queue.length) return {status:'failed',code:telemetry.lastErrorCode||'DATABASE_WRITE_FAILED',roomId};
    const metrics=await telemetry.metrics(roomId);
    if(metrics.source!=='postgres') return {status:'failed',code:telemetry.lastErrorCode||'DATABASE_READ_FAILED',roomId};
    const worker=metrics.workers.find(worker=>worker.worker_id==='service-verifier');
    const result=await telemetry.pool.query("SELECT payload FROM render_events WHERE room_id=$1 AND event_type='tile_completed' AND worker_id=$2 ORDER BY time DESC LIMIT 1",[roomId,'service-verifier']);
    const event=result.rows[0]?.payload;
    if(worker?.tiles!==1||worker.pixels!==1024||worker.average_ms!==5||event?.verificationId!==verificationId||event?.verification!==true) {
      return {status:'failed',code:'DATABASE_READBACK_MISMATCH',roomId};
    }
    return {
      status:'verified',durationMs:Math.round(performance.now()-start),storage:'postgresql',timescaleHypertable:telemetry.hypertableReady,
      hostingProvider:'not_verified',roomId,syntheticEventsWritten:1,
      check:'Application telemetry initialization, insert, metrics, and tagged-event readback succeeded against the configured database.',
      note:'The tagged verification row remains in render_events. PostgreSQL connectivity alone does not establish that the hosting provider is Tiger Data.'
    };
  } catch(error) {
    return {status:'failed',code:safeDatabaseErrorCode(error),roomId,durationMs:Math.round(performance.now()-start)};
  } finally {
    if(telemetry) await telemetry.close().catch(()=>{});
    if(directory) await rm(directory,{recursive:true,force:true}).catch(()=>{});
  }
}

export async function verifyServices({args=process.argv.slice(2),env=process.env,outputDirectory=resolve('artifacts')}={}) {
  if(args.some(arg=>!['--gemini','--database'].includes(arg))) {
    throw new Error('Usage: node --env-file-if-exists=.env scripts/verify-services.mjs [--gemini] [--database]');
  }
  const verificationId=randomUUID();
  const report={schemaVersion:1,verificationId,startedAt:new Date().toISOString(),services:{}};
  // These are real service calls. Missing credentials are failures, never a local/mock pass.
  if(!args.length||args.includes('--gemini')) report.services.gemini=await verifyGemini(env);
  if(!args.length||args.includes('--database')) report.services.database=await verifyDatabase(env,verificationId);
  report.finishedAt=new Date().toISOString();
  report.passed=Object.values(report.services).every(service=>service.status==='verified');
  await mkdir(outputDirectory,{recursive:true});
  await writeFile(join(outputDirectory,'service-verification.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report=await verifyServices();
    console.log(JSON.stringify(report,null,2));
    process.exitCode=report.passed?0:1;
  } catch {
    console.error('Service verification could not complete. Use [--gemini] [--database], and ensure artifacts/ is writable.');
    process.exitCode=2;
  }
}
