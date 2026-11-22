import test from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../server/coordinator.js';
import { PRESETS, packResult, validateScene } from '../public/scene.js';
import { createScalingBenchmark, planScalingBenchmark, summarizeScalingRuns, median, MAX_BENCHMARK_WORKERS } from '../public/benchmark.js';

const worker = (id, backend = 'webgpu', enabled = true) => ({id,label:`Device ${id}`,backend,enabled});
const config = () => ({scene:validateScene(PRESETS.solstice),width:256,samples:8,bounces:4});

test('scaling plan freezes nested matching cohorts, bounds participants, and rotates three trial rounds', () => {
  const clients = [worker('cpu','cpu'),worker('paused','webgpu',false),...Array.from({length:12},(_,i)=>worker(String(i)))];
  const plan = planScalingBenchmark(clients, '5');
  assert.equal(plan.workers[0].id, '5');
  assert.equal(plan.workers.length, MAX_BENCHMARK_WORKERS);
  assert.equal(plan.excludedMatching, 4);
  assert.ok(plan.workers.every(item => item.backend === 'webgpu' && item.id !== 'paused'));
  assert.deepEqual(plan.cohorts.map(item => item.count), [1,2,4,8]);
  for (const cohort of plan.cohorts) assert.deepEqual(cohort.workerIds, plan.workers.slice(0,cohort.count).map(item => item.id));
  assert.equal(plan.steps.length, 16);
  assert.equal(plan.steps.filter(step => step.warmup).length, 4);
  assert.deepEqual(plan.steps.filter(step => !step.warmup && step.trial === 1).map(step => step.count),[1,2,4,8]);
  assert.deepEqual(plan.steps.filter(step => !step.warmup && step.trial === 2).map(step => step.count),[2,4,8,1]);
  assert.deepEqual(plan.steps.filter(step => !step.warmup && step.trial === 3).map(step => step.count),[4,8,1,2]);
  clients[7].label='Changed later';assert.equal(plan.workers[0].label,'Device 5');
});

test('small groups include the full cohort once, and CPU baselines do not recruit GPU devices', () => {
  assert.deepEqual(planScalingBenchmark([worker('a'),worker('b'),worker('c')], 'a').cohorts.map(item=>item.count),[1,2,3]);
  const cpu = planScalingBenchmark([worker('a','cpu'),worker('b'),worker('c','cpu')], 'a');
  assert.deepEqual(cpu.workers.map(item=>item.id),['a','c']);
  assert.throws(()=>planScalingBenchmark([worker('a'),worker('b','cpu')],'a'),/two devices/);
  assert.throws(()=>planScalingBenchmark([worker('a'),worker('b')],'missing'),/solo device/);
});

test('medians exclude warmups and expose slower crowd measurements and variation', () => {
  const cohorts=[{count:1,workerIds:['a']},{count:2,workerIds:['a','b']}];
  const runs=[{count:1,seconds:1000,warmup:true},...[10,12,11].map(seconds=>({count:1,seconds,warmup:false})),
    {count:2,seconds:0.001,warmup:true},...[20,30,22].map(seconds=>({count:2,seconds,warmup:false}))];
  const summaries=summarizeScalingRuns(runs,cohorts);
  assert.equal(summaries[0].medianSeconds,11);assert.equal(summaries[1].medianSeconds,22);
  assert.equal(summaries[1].speedup,0.5);assert.equal(summaries[1].minSeconds,20);assert.equal(summaries[1].maxSeconds,30);
  assert.ok(summaries.every(item=>item.trials===3&&item.complete));
  assert.equal(median([4,1,3,2]),2.5);
  assert.throws(()=>median([1,NaN]),/positive finite/);assert.throws(()=>median([0]),/positive finite/);
});

function harness(count=4) {
  let time=1000;const commands=[],changes=[];
  const coordinator=new Coordinator({now:()=>time}), room=coordinator.createRoom();
  const socket=()=>({readyState:1,send(){}});
  const host=coordinator.connect(room,socket(),{token:room.hostToken,label:'Controller'});
  const workers=Array.from({length:count},(_,i)=>coordinator.connect(room,socket(),{label:`GPU ${i+1}`}));
  for(const client of workers)coordinator.message(room,client,{type:'contribute',enabled:true,backend:'webgpu',batchSize:4});
  const controller=createScalingBenchmark({now:()=>time,onChange:value=>changes.push(value),send:message=>{commands.push(structuredClone(message));coordinator.message(room,host,message);}});
  const state=()=>coordinator.state(room);
  const start=()=>controller.start({state:state(),baselineId:workers[0].id,config:config()});
  const finishRun=()=>{
    const id=room.run.id;
    while(room.run.status==='running'&&room.run.id===id) {
      for(const client of workers) {
        const job=client.jobs.values().next().value;
        if(job){time+=10;coordinator.result(room,client,packResult(job,new Uint8Array(job.width*job.height*4),10));}
      }
    }
    controller.update(state());
  };
  return {coordinator,room,host,workers,controller,commands,changes,state,start,finishRun,advance:ms=>{time+=ms;}};
}

test('controller completes real coordinator run sequencing and exports all trials with fixed workload', () => {
  const h=harness();h.start();
  let iterations=0;
  while(h.controller.active&&iterations++<20){h.controller.update(h.state());h.finishRun();}
  const result=h.controller.snapshot(),report=h.controller.report();
  assert.equal(result.status,'complete');assert.equal(result.runs.length,12);
  assert.equal(h.commands.filter(command=>command.type==='start').length,12);
  assert.equal(h.commands.filter(command=>command.type==='cancel').length,0);
  assert.ok(result.summaries.every(summary=>summary.complete&&summary.trials===3));
  assert.equal(new Set(result.runs.map(run=>run.fingerprint)).size,1);
  assert.deepEqual(result.summaries.map(summary=>summary.count),[1,2,4]);
  assert.ok(result.runs.every(run=>run.contributors.length===run.count&&run.contributors.every(item=>item.tiles>0)));
  assert.equal(report.schemaVersion,1);assert.match(report.method.hardware,/not proof/);
  assert.equal(report.settings.width,256);assert.equal(report.sceneName,PRESETS.solstice.name);
  assert.doesNotMatch(JSON.stringify(report),/hostToken/);
  assert.doesNotThrow(()=>JSON.parse(JSON.stringify(report)));
  const commands=h.commands.length;h.controller.update(h.state());assert.equal(h.commands.length,commands,'Repeated final states cannot start more work');
});

test('later participants remain outside the frozen benchmark cohorts', () => {
  const h=harness(2);h.start();
  const extra=h.coordinator.connect(h.room,{readyState:1,send(){}},{label:'Late GPU'});
  h.coordinator.message(h.room,extra,{type:'contribute',enabled:true,backend:'webgpu'});
  h.controller.update(h.state());
  assert.equal(h.controller.active,true);assert.equal(extra.job,null);
  h.finishRun();assert.ok(h.commands.filter(command=>command.type==='start').every(command=>!command.workerIds.includes(extra.id)));
});

test('paused or disconnected selected workers cancel even if currently waiting for another cohort', () => {
  for(const mode of ['pause','disconnect','backend']) {
    const h=harness();h.start();h.controller.update(h.state());
    const client=h.workers[3];
    if(mode==='pause')h.coordinator.message(h.room,client,{type:'contribute',enabled:false});
    if(mode==='disconnect')h.coordinator.disconnect(h.room,client);
    if(mode==='backend')h.coordinator.message(h.room,client,{type:'contribute',enabled:true,backend:'cpu'});
    h.controller.update(h.state());
    assert.equal(h.controller.active,false);assert.equal(h.controller.snapshot().status,'cancelled');
    assert.match(h.controller.snapshot().reason,/selected device/);assert.equal(h.commands.at(-1).type,'cancel');
    assert.equal(h.room.run.status,'cancelled');
  }
});

test('workload, cohort, and fingerprint changes cannot become scaling measurements', () => {
  const mutations=[
    state=>{state.run.settings.samples=64;},
    state=>{state.scene.skyTop=[1,0,0];},
    state=>{state.run.workerIds=[state.clients[0].id];},
    state=>{state.run.initialWorkers[0].backend='cpu';},
    state=>{state.run.retries=1;},
    state=>{state.run.id+=1;},
  ];
  for(const mutate of mutations){
    const h=harness(2);h.start();const state=structuredClone(h.state());mutate(state);h.controller.update(state);
    assert.equal(h.controller.snapshot().status,'cancelled');assert.equal(h.controller.snapshot().runs.length,0);
  }
  const h=harness(2);h.start();h.controller.update(h.state());h.finishRun();
  const state=structuredClone(h.state());state.run.fingerprint='different';h.controller.update(state);
  assert.equal(h.controller.snapshot().status,'cancelled');assert.match(h.controller.snapshot().reason,/workload changed/);
});

test('manual cancellation preserves finished trials and stops the active server render', () => {
  const h=harness(2);h.start();h.finishRun();h.finishRun();h.finishRun();
  assert.equal(h.controller.snapshot().runs.filter(run=>!run.warmup).length,1);
  h.controller.cancel();assert.equal(h.room.run.status,'cancelled');
  assert.equal(h.controller.report().status,'cancelled');assert.equal(h.controller.report().runs.length,3);
  assert.ok(h.controller.report().summaries.some(summary=>summary.trials===1&&!summary.complete));
  const commands=h.commands.length;h.controller.cancel();assert.equal(h.commands.length,commands);
});

test('a start that never receives server confirmation times out without inventing a result', () => {
  let time=0;const messages=[],state={roomId:'ABCDEF',run:null,clients:[worker('a'),worker('b')],history:[]};
  const controller=createScalingBenchmark({now:()=>time,send:message=>messages.push(message)});
  controller.start({state,baselineId:'a',config:config()});time=16000;controller.update(state);
  assert.equal(controller.snapshot().status,'cancelled');assert.match(controller.snapshot().reason,/did not start/);
  assert.equal(controller.report().runs.length,0);assert.equal(messages.at(-1).type,'cancel');
});
