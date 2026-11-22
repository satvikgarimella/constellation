import { mkdirSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

export class Telemetry {
  constructor({directory='./data',databaseUrl,poolFactory=options=>new pg.Pool(options)}={}) {
    mkdirSync(directory,{recursive:true});this.file=resolve(directory,'events.jsonl');this.pool=null;this.databaseReady=false;this.queue=[];this.flushPromise=null;this.initializing=null;this.closed=false;this.lastInitialize=0;
    if(databaseUrl) {
      this.pool=poolFactory({connectionString:databaseUrl,max:3,connectionTimeoutMillis:5000,query_timeout:8000});
      this.pool.on('error',()=>{this.databaseReady=false;});
      this.timer=setInterval(()=>this.maintain(),2000);this.timer.unref();
      this.maintain();
    }
  }
  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS render_events (time TIMESTAMPTZ NOT NULL, room_id TEXT NOT NULL, event_type TEXT NOT NULL, run_id INTEGER, worker_id TEXT, payload JSONB NOT NULL)`);
    await this.pool.query('CREATE INDEX IF NOT EXISTS render_events_room_time ON render_events (room_id,time DESC)');
    // Compatible with both Tiger Data/Timescale and ordinary Postgres.
    try {await this.pool.query("SELECT create_hypertable('render_events','time',if_not_exists => TRUE, migrate_data => TRUE)");} catch { /* Plain Postgres is supported. */ }
    this.databaseReady=true;
  }
  async maintain() {
    if(this.closed) return;
    if(!this.databaseReady) {
      if(this.initializing||Date.now()-this.lastInitialize<10000) return;
      this.lastInitialize=Date.now();
      this.initializing=this.initialize().catch(()=>{this.databaseReady=false;}).finally(()=>{this.initializing=null;});
      await this.initializing;
    }
    if(!this.closed) await this.flush();
  }
  record(event) {
    appendFileSync(this.file,JSON.stringify(event)+'\n');
    if(this.pool && this.queue.length<10000) this.queue.push(event);
  }
  flush() {
    if(this.flushPromise) return this.flushPromise;
    if(!this.databaseReady||!this.queue.length) return Promise.resolve();
    const events=this.queue.splice(0,500);
    this.flushPromise=(async()=>{
      try {
        const values=[],params=[];
        events.forEach((e,i)=>{const p=i*6;values.push(`($${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6})`);params.push(e.time,e.roomId,e.type,e.runId||null,e.workerId||null,JSON.stringify(e));});
        await this.pool.query(`INSERT INTO render_events (time,room_id,event_type,run_id,worker_id,payload) VALUES ${values.join(',')}`,params);
      } catch {this.queue=[...events,...this.queue].slice(0,10000);this.databaseReady=false;}
      finally {this.flushPromise=null;}
    })();
    return this.flushPromise;
  }
  async metrics(roomId) {
    if(!this.databaseReady) return {source:'local',message:'Connect DATABASE_URL to enable database-backed analytics.'};
    await this.flush();
    if(!this.databaseReady) return {source:'local',message:'Database unavailable; telemetry is being saved locally.'};
    const {rows}=await this.pool.query(`SELECT worker_id, COUNT(*)::int AS tiles, ROUND(AVG((payload->>'durationMs')::numeric),1)::float AS average_ms, SUM((payload->>'pixels')::bigint)::float AS pixels FROM render_events WHERE room_id=$1 AND event_type='tile_completed' GROUP BY worker_id ORDER BY tiles DESC`,[roomId]);
    const series=await this.pool.query(`SELECT date_trunc('second',time) AS bucket, COUNT(*)::int AS tiles FROM render_events WHERE room_id=$1 AND event_type='tile_completed' AND time>NOW()-INTERVAL '10 minutes' GROUP BY 1 ORDER BY 1`,[roomId]);
    return {source:'postgres',workers:rows,series:series.rows};
  }
  async close() {this.closed=true;clearInterval(this.timer);await this.initializing;await this.flush();if(this.pool) await this.pool.end();}
}
