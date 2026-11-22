import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateScene } from '../server/gemini.js';
import { PRESETS } from '../public/scene.js';

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
  await assert.rejects(()=>generateScene({prompt:'test',apiKey:'test-key',fetchImpl:async()=>Response.json({candidates:[{content:{parts:[{text:'{"spheres":[]}'}]}}]})}),/1 and 64/);
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
