import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateScene, applySceneEdit } from '../server/gemini.js';
import { PRESETS, MAX_SPHERES, MAX_BOXES, validateScene } from '../public/scene.js';

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

test('editing keeps all existing geometry and sends current scene context',async()=>{
  let request;
  const current=validateScene(PRESETS.orbit),before=structuredClone(current);
  const patch={changes:{skyTop:[0.4,0.12,0.08],skyBottom:[0.9,0.45,0.2],sun:[1,0.6,0.3],exposure:1.4,camera:[4,3,6]},materials:[]};
  const edited=await generateScene({prompt:'Keep the sculpture, make it sunset, and move closer',currentScene:current,mode:'edit',apiKey:'test-key',fetchImpl:async(_url,options)=>{
    request=JSON.parse(options.body);return sceneResponse(patch);
  }});
  assert.ok(current.spheres.length>24,'Existing presets can exceed the new-generation limit');
  assert.deepEqual(edited.spheres,current.spheres);assert.deepEqual(edited.boxes,current.boxes);assert.deepEqual(edited.terrain,current.terrain);
  assert.deepEqual(edited.camera,patch.changes.camera);assert.deepEqual(edited.skyTop,patch.changes.skyTop);
  assert.deepEqual(current,before,'Editing must not mutate the original scene');
  const context=JSON.parse(request.contents[0].parts[0].text);
  assert.equal(context.currentScene.spheres.length,current.spheres.length);
  assert.match(request.systemInstruction.parts[0].text,/geometry is locked/);
  const schema=request.generationConfig.responseJsonSchema;
  assert.deepEqual(schema.required,['changes','materials']);
  assert.equal(schema.properties.changes.properties.spheres,undefined);
  assert.doesNotMatch(JSON.stringify(schema),/"(?:minItems|maxItems|minimum|maximum)"/);
});

test('material edits preserve every box position and dimension in a large city',()=>{
  const current=validateScene(PRESETS.city);
  const edited=applySceneEdit(current,{changes:{name:'Sunset city'},materials:[{kind:'box',index:3,color:[0.9,0.6,0.2],roughness:0.6}]});
  assert.ok(current.boxes.length>32);
  assert.equal(edited.boxes.length,current.boxes.length);
  for(let i=0;i<current.boxes.length;i++) {
    assert.deepEqual(edited.boxes[i].center,current.boxes[i].center);
    assert.deepEqual(edited.boxes[i].size,current.boxes[i].size);
    if(i!==3)assert.deepEqual(edited.boxes[i],current.boxes[i]);
  }
  assert.deepEqual(edited.boxes[3].color,[0.9,0.6,0.2]);assert.equal(edited.boxes[3].roughness,0.6);
});

test('unsupported, malformed, prototype, and out-of-range edit patches are rejected',()=>{
  const current=validateScene(PRESETS.city),original=structuredClone(current);
  const invalid=[
    {changes:{spheres:[]},materials:[]},
    {changes:{terrain:{height:3}},materials:[]},
    {changes:{camera:[0,0]},materials:[]},
    {changes:{camera:[Infinity,0,1]},materials:[]},
    {changes:{camera:[0,0,0],target:[0,0,0]},materials:[]},
    {changes:{camera:[80,2,3]},materials:[]},
    {changes:{exposure:100},materials:[]},
    {changes:{aurora:{strength:1,untrusted:1}},materials:[]},
    {changes:{name:''},materials:[]},
    {changes:{},materials:[{kind:'box',index:0,center:[0,2,0]}]},
    {changes:{},materials:[{kind:'box',index:0}]},
    {changes:{},materials:[{kind:'box',index:-1,color:[1,1,1]}]},
    {changes:{},materials:[{kind:'box',index:99,color:[1,1,1]}]},
    {changes:{},materials:[{kind:'box',index:0,color:[0,0,0]}]},
    {changes:{},materials:[{kind:'box',index:0,color:[1,1,1]},{kind:'box',index:0,metal:1}]},
    {changes:{},materials:[{kind:'mesh',index:0,metal:1}]},
    {changes:{},materials:[],unexpected:true},
    JSON.parse('{"changes":{"__proto__":{"polluted":true}},"materials":[]}'),
    JSON.parse('{"changes":{},"materials":[{"kind":"box","index":0,"constructor":{}}]}'),
    {changes:Object.create({exposure:2}),materials:[]}
  ];
  for(const patch of invalid)assert.throws(()=>applySceneEdit(current,patch),error=>error.code==='GEMINI_INVALID_EDIT');
  assert.deepEqual(current,original);assert.equal({}.polluted,undefined);
});

test('edit preflight rejects missing scene and invalid mode before contacting Gemini',async()=>{
  const fetchImpl=async()=>{throw new Error('The upstream must not be called');};
  await assert.rejects(()=>generateScene({prompt:'sunset',mode:'edit',apiKey:'test-key',fetchImpl}),error=>error.code==='GEMINI_INVALID_EDIT');
  await assert.rejects(()=>generateScene({prompt:'sunset',mode:'unknown',apiKey:'test-key',fetchImpl}),error=>error.code==='GEMINI_INVALID_MODE');
});

test('mesh editing keeps uploaded vertices private and preserves them while changing material',async()=>{
  const current=validateScene({...PRESETS.solstice,spheres:[],boxes:[],mesh:{name:'Uploaded design',triangles:[0,0,0,2,0,0,0,2,0],color:[0.6,0.7,0.8],metal:0.35,roughness:0.25,emission:[0,0,0]}});
  const before=structuredClone(current);
  let context;
  const edited=await generateScene({prompt:'Make my model copper and move the camera closer',currentScene:current,mode:'edit',apiKey:'test-key',fetchImpl:async(_url,options)=>{
    const request=JSON.parse(options.body);context=JSON.parse(request.contents[0].parts[0].text).currentScene;
    assert.equal(JSON.stringify(request).includes('"triangles"'),false);
    return sceneResponse({changes:{camera:[4,2,5]},materials:[{kind:'mesh',index:0,color:[0.8,0.4,0.2],metal:0.95}]});
  }});
  assert.equal(context.mesh.triangleCount,1);assert.equal(context.mesh.name,'Uploaded design');
  assert.equal(Object.hasOwn(context.mesh,'triangles'),false);assert.equal(Object.hasOwn(context.mesh,'material'),false);
  assert.deepEqual(edited.mesh.triangles,current.mesh.triangles);assert.deepEqual(edited.mesh.color,[0.8,0.4,0.2]);assert.equal(edited.mesh.metal,0.95);
  assert.deepEqual(edited.mesh.roughness,current.mesh.roughness);assert.deepEqual(current,before);
  assert.throws(()=>applySceneEdit(current,{changes:{},materials:[{kind:'mesh',index:0,triangles:[0,0,0]}]}),error=>error.code==='GEMINI_INVALID_EDIT');
  assert.throws(()=>applySceneEdit(current,{changes:{},materials:[{kind:'mesh',index:1,metal:0.5}]}),error=>error.code==='GEMINI_INVALID_EDIT');
});
