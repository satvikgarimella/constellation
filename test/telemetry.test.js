import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeDatabaseErrorCode,Telemetry } from '../server/telemetry.js';

test('database outages preserve local telemetry and queued events recover on retry',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'constellation-telemetry-'));
  const pool=new EventEmitter();let failInitialize=true,failInsert=false;const inserts=[];
  pool.query=async (sql,params)=>{
    if(failInitialize){failInitialize=false;throw new Error('offline');}
    if(sql.startsWith('INSERT')){if(failInsert){failInsert=false;throw new Error('interrupted');}inserts.push(params);}
    return {rows:[]};
  };
  pool.end=async()=>{};
  const telemetry=new Telemetry({directory,databaseUrl:'postgres://example',poolFactory:()=>pool});
  t.after(async()=>{await telemetry.close();await rm(directory,{recursive:true,force:true});});
  await telemetry.initializing;assert.equal(telemetry.databaseReady,false);
  const event={time:new Date().toISOString(),roomId:'ABC123',type:'tile_completed',runId:1,workerId:'phone',durationMs:5,pixels:1024};
  telemetry.record(event);assert.equal(telemetry.queue.length,1);
  telemetry.lastInitialize=0;await telemetry.maintain();
  assert.equal(telemetry.databaseReady,true);assert.equal(telemetry.queue.length,0);assert.equal(inserts.length,1);
  telemetry.record({...event,tileId:2});failInsert=true;await telemetry.flush();
  assert.equal(telemetry.databaseReady,false);assert.equal(telemetry.queue.length,1);
  telemetry.lastInitialize=0;await telemetry.maintain();assert.equal(inserts.length,2);
  assert.equal(telemetry.queue.length,0);
  const local=(await readFile(join(directory,'events.jsonl'),'utf8')).trim().split('\n');assert.equal(local.length,2);
});

test('analytics query failures fall back safely and recover after reinitialization',async t=>{
  for(const failingQuery of ['workers','series']) await t.test(failingQuery,async t=>{
    const directory=await mkdtemp(join(tmpdir(),'constellation-telemetry-'));
    const pool=new EventEmitter();let shouldFail=true;
    const workers=[{worker_id:'phone',tiles:2,average_ms:5,pixels:2048}];
    const series=[{bucket:new Date().toISOString(),tiles:2}];
    pool.query=async sql=>{
      const kind=sql.startsWith('SELECT worker_id')?'workers':sql.startsWith('SELECT date_trunc')?'series':null;
      if(kind===failingQuery&&shouldFail) throw Object.assign(new Error('private password and connection details'),{code:'08006'});
      return {rows:kind==='workers'?workers:kind==='series'?series:[]};
    };
    pool.end=async()=>{};
    const telemetry=new Telemetry({directory,databaseUrl:'postgres://example',poolFactory:()=>pool});
    t.after(async()=>{await telemetry.close();await rm(directory,{recursive:true,force:true});});
    await telemetry.initializing;
    const fallback=await telemetry.metrics('ABC123');
    assert.deepEqual(fallback,{source:'local',message:'Database unavailable; telemetry is being saved locally.'});
    assert.equal(telemetry.databaseReady,false);assert.equal(telemetry.lastErrorCode,'08006');
    shouldFail=false;telemetry.lastInitialize=0;await telemetry.maintain();
    assert.equal(telemetry.lastErrorCode,null);
    assert.deepEqual(await telemetry.metrics('ABC123'),{source:'postgres',workers,series});
  });
});

test('plain Postgres stays supported and idle connection errors expose only safe diagnostics',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'constellation-telemetry-'));
  const pool=new EventEmitter();
  pool.query=async sql=>{
    if(sql.includes('create_hypertable')) throw Object.assign(new Error('extension absent'),{code:'42883'});
    return {rows:[]};
  };
  pool.end=async()=>{};
  const telemetry=new Telemetry({directory,databaseUrl:'postgres://example',poolFactory:()=>pool});
  t.after(async()=>{await telemetry.close();await rm(directory,{recursive:true,force:true});});
  await telemetry.initializing;
  assert.equal(telemetry.databaseReady,true);assert.equal(telemetry.hypertableReady,false);
  pool.emit('error',Object.assign(new Error('private server and password'),{code:'ECONNRESET'}));
  assert.equal(telemetry.databaseReady,false);assert.equal(telemetry.lastErrorCode,'ECONNRESET');
  assert.equal(safeDatabaseErrorCode(Object.assign(new Error('private server and password'),{code:'SELF_SIGNED_CERT_IN_CHAIN'})),'SELF_SIGNED_CERT_IN_CHAIN');
  assert.equal(safeDatabaseErrorCode({code:'private server and password'}),'DATABASE_ERROR');
  assert.equal(safeDatabaseErrorCode(new Error('private server and password')),'DATABASE_ERROR');
});
