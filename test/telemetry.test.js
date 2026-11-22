import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Telemetry } from '../server/telemetry.js';

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
