import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateScene } from '../server/gemini.js';
import { PRESETS, MAX_SPHERES, MAX_BOXES } from '../public/scene.js';

const sceneResponse=scene=>Response.json({candidates:[{content:{parts:[{text:JSON.stringify(scene)}]}}]});

test('Gemini adapter extracts final JSON, ignores thought text, and validates geometry',async()=>{
  let request;
  const scene=await generateScene({prompt:'Silver spheres',scene:PRESETS.lunar,apiKey:'test-key',fetchImpl:async(url,options)=>{
    request={url,options,body:JSON.parse(options.body)};
    return Response.json({candidates:[{content:{parts:[{thought:true,text:'Reasoning is not a scene'},{text:JSON.stringify({...PRESETS.lunar,fov:1000})}]}}]});
  }});
  assert.equal(scene.name,'Lunar');assert.equal(scene.fov,75);
  assert.ok(request.url.endsWith(':generateContent'));
  assert.equal(request.options.headers['x-goog-api-key'],'test-key');
  assert.equal(request.body.generationConfig.responseJsonSchema.type,'object');
  assert.equal(JSON.stringify(request.body).includes('test-key'),false);
});

test('Gemini errors stay actionable without exposing the server key or upstream body',async()=>{
  await assert.rejects(()=>generateScene({apiKey:null}),/GEMINI_API_KEY/);
  await assert.rejects(()=>generateScene({prompt:'test',apiKey:'test-key',fetchImpl:async()=>new Response('sensitive upstream text',{status:429})}),/Gemini returned 429/);
  await assert.rejects(()=>generateScene({prompt:'test',apiKey:'test-key',fetchImpl:async()=>Response.json({candidates:[]})}),/did not return a scene/);
  await assert.rejects(()=>generateScene({prompt:'test',apiKey:'test-key',fetchImpl:async()=>sceneResponse({spheres:[]})}),error=>error.code==='GEMINI_INVALID_SCENE');
});

test('a generated desert retains actual terrain and aurora with no compulsory spheres',async()=>{
  let request;
  const candidate={...PRESETS.aurora,name:'Northern desert',camera:[18,4,24],target:[0,1,-10],fov:60};
  const scene=await generateScene({prompt:'a desert under northern lights',scene:PRESETS.orbit,apiKey:'test-key',fetchImpl:async(_url,options)=>{
    request=JSON.parse(options.body);return sceneResponse(candidate);
  }});
  assert.deepEqual(scene.spheres,[]);assert.deepEqual(scene.boxes,[]);
  assert.deepEqual(scene.terrain,candidate.terrain);assert.deepEqual(scene.aurora,candidate.aurora);assert.equal(scene.stars,candidate.stars);
  assert.deepEqual(scene.camera,[18,4,24]);assert.deepEqual(scene.target,[0,1,-10]);
  assert.deepEqual(JSON.parse(request.contents[0].parts[0].text),{brief:'a desert under northern lights'});
  assert.equal(JSON.stringify(request).includes('currentScene'),false);
});

test('city output keeps box dimensions and materials while validation bounds unsafe geometry',async()=>{
  const candidate={...PRESETS.city,name:'Box city',boxes:[
    {center:[-3,2.15,0],size:[2,6,3],color:[0.15,0.3,0.5],metal:0.4,roughness:0.2,emission:[0,0,0]},
    {center:[100,-100,-100],size:[100,-5,2],color:[-1,2,0.4],metal:8,roughness:-3,emission:[12,-4,0]}
  ]};
  const scene=await generateScene({prompt:'a futuristic city at night',apiKey:'test-key',fetchImpl:async()=>sceneResponse(candidate)});
  assert.deepEqual(scene.spheres,[]);assert.equal(scene.boxes.length,2);
  assert.deepEqual(scene.boxes[0],candidate.boxes[0]);
  const bounded=scene.boxes[1];
  assert.deepEqual(bounded.size,[20,0.1,2]);assert.equal(bounded.center[0],40);assert.equal(bounded.center[2],-40);
  assert.ok(bounded.center[1]>=bounded.size[1]/2-0.85);
  assert.deepEqual(bounded.color,[0.01,1,0.4]);assert.equal(bounded.metal,1);assert.equal(bounded.roughness,0);assert.deepEqual(bounded.emission,[8,0,0]);
});

test('compact generation schema admits landscapes while server validation enforces geometry limits',async()=>{
  let request;
  await generateScene({prompt:'a desert',apiKey:'test-key',fetchImpl:async(_url,options)=>{
    request=JSON.parse(options.body);return sceneResponse(PRESETS.aurora);
  }});
  const schema=request.generationConfig.responseJsonSchema,p=schema.properties;
  assert.equal(p.spheres.type,'array');assert.equal(p.boxes.type,'array');
  assert.deepEqual(p.boxes.items.properties.size,{type:'array',items:{type:'number'}});
  // Regression: nested array/numeric bounds previously made the live API reject
  // the schema with INVALID_ARGUMENT (too many constrained-decoder states).
  assert.doesNotMatch(JSON.stringify(schema),/"(?:minItems|maxItems|minimum|maximum)"/);
  assert.equal(p.terrain.properties.height.type,'number');assert.equal(p.terrain.properties.scale.type,'number');
  assert.equal(p.aurora.properties.strength.type,'number');assert.equal(p.stars.type,'number');
  for(const field of ['terrain','aurora','stars','boxes','spheres'])assert.ok(schema.required.includes(field));
  await assert.rejects(()=>generateScene({prompt:'an oversized city',apiKey:'test-key',fetchImpl:async()=>sceneResponse({...PRESETS.city,boxes:Array(MAX_BOXES+1).fill(PRESETS.city.boxes[0])})}),error=>error.code==='GEMINI_INVALID_SCENE');
  await assert.rejects(()=>generateScene({prompt:'a city',apiKey:'test-key',fetchImpl:async()=>sceneResponse({...PRESETS.city,boxes:Array(Math.min(32,MAX_BOXES)+1).fill(PRESETS.city.boxes[0])})}),error=>error.code==='GEMINI_INVALID_SCENE'&&/at most/.test(error.message));
  await assert.rejects(()=>generateScene({prompt:'round sculptures',apiKey:'test-key',fetchImpl:async()=>sceneResponse({...PRESETS.solstice,spheres:Array(Math.min(24,MAX_SPHERES)+1).fill(PRESETS.solstice.spheres[0])})}),error=>error.code==='GEMINI_INVALID_SCENE'&&/at most/.test(error.message));
});

test('Gemini network and malformed-response diagnostics never include upstream details',async()=>{
  const cases=[
    {fetchImpl:async()=>{throw new Error('test-key private connection details');},code:'GEMINI_NETWORK_ERROR'},
    {fetchImpl:async()=>{throw Object.assign(new Error('test-key private timeout'),{name:'TimeoutError'});},code:'GEMINI_TIMEOUT'},
    {fetchImpl:async()=>new Response('test-key private invalid JSON'),code:'GEMINI_INVALID_RESPONSE'},
    {fetchImpl:async()=>Response.json({candidates:[{content:{parts:[{text:'test-key private invalid scene'}]}}]}),code:'GEMINI_INVALID_SCENE'},
    {fetchImpl:async()=>Response.json(null),code:'GEMINI_EMPTY_RESPONSE'},
    {fetchImpl:async()=>Response.json({candidates:[{content:{parts:{text:'test-key'}}}]}),code:'GEMINI_EMPTY_RESPONSE'}
  ];
  for(const {fetchImpl,code} of cases) await assert.rejects(()=>generateScene({prompt:'test',apiKey:'test-key',fetchImpl}),error=>{
    assert.equal(error.code,code);assert.equal(error.message.includes('test-key'),false);assert.equal(error.message.includes('private'),false);return true;
  });
  await assert.rejects(()=>generateScene({prompt:'test',apiKey:'test-key',fetchImpl:async()=>new Response('private',{status:429})}),error=>error.code==='GEMINI_HTTP_ERROR'&&error.status===429);
});

test('service verifier fails truthfully without credentials and saves a sanitized report',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'constellation-service-verifier-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const script=fileURLToPath(new URL('../scripts/verify-services.mjs',import.meta.url));
  const result=spawnSync(process.execPath,[script],{cwd:directory,env:{},encoding:'utf8',timeout:10000});
  assert.equal(result.error,undefined);assert.equal(result.status,1);assert.equal(result.stderr,'');
  const report=JSON.parse(result.stdout);
  assert.equal(report.passed,false);
  assert.deepEqual(report.services,{
    gemini:{status:'missing_configuration',required:'GEMINI_API_KEY'},
    database:{status:'missing_configuration',required:'DATABASE_URL'}
  });
  assert.deepEqual(JSON.parse(await readFile(join(directory,'artifacts','service-verification.json'),'utf8')),report);
  const onlyGemini=spawnSync(process.execPath,[script,'--gemini'],{cwd:directory,env:{},encoding:'utf8',timeout:10000});
  assert.equal(onlyGemini.status,1);assert.deepEqual(Object.keys(JSON.parse(onlyGemini.stdout).services),['gemini']);
  const invalid=spawnSync(process.execPath,[script,'--unknown'],{cwd:directory,env:{},encoding:'utf8',timeout:10000});
  assert.equal(invalid.status,2);assert.match(invalid.stderr,/Service verification could not complete/);
});
