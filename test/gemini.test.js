import test from 'node:test';
import assert from 'node:assert/strict';
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
