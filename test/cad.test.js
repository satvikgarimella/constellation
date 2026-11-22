import test from 'node:test';
import assert from 'node:assert/strict';
import factory from 'occt-import-js';
import { cubeSTEP } from './cad-fixture.mjs';
import { importCAD,meshFromCADResult,validateCADInput } from '../public/cad-import.js';
import { MAX_MODEL_BYTES,MAX_MESH_TRIANGLES } from '../public/mesh.js';

const buffer=text=>new TextEncoder().encode(text).buffer;
const triangleResult=()=>({success:true,meshes:[{attributes:{position:{array:[0,0,0,1,0,0,0,1,0]}},index:{array:[0,1,2]}}]});

test('real OCCT WASM converts the authored solid STEP cube into a normalized surface mesh',async()=>{
  const occt=await factory({print:()=>{},printErr:()=>{}});
  const result=occt.ReadStepFile(new Uint8Array(buffer(cubeSTEP())),{linearUnit:'millimeter',linearDeflectionType:'bounding_box_ratio',linearDeflection:0.01,angularDeflection:0.5});
  const mesh=meshFromCADResult(result,'Design.STEP');
  assert.equal(mesh.name,'Design');assert.equal(mesh.triangles.length/9,12);
  const bounds=[0,1,2].map(axis=>{
    const values=mesh.triangles.filter((_value,index)=>index%3===axis);
    return [Math.min(...values),Math.max(...values)];
  });
  assert.deepEqual(bounds,[[-2,2],[-0.85,3.15],[-2,2]]);
  assert.equal(mesh.metal,0.35);
});

test('STEP preflight rejects oversized, wrong-format, and malformed inputs',()=>{
  assert.doesNotThrow(()=>validateCADInput(buffer(cubeSTEP()),'cube.stp'));
  assert.throws(()=>validateCADInput(new ArrayBuffer(MAX_MODEL_BYTES+1),'cube.step'),/10 MB/);
  assert.throws(()=>validateCADInput(buffer(cubeSTEP()),'cube.sldprt'),/STEP or STL/);
  assert.throws(()=>validateCADInput(buffer('not STEP'),'cube.step'),/not a valid STEP/);
  assert.throws(()=>validateCADInput(new Uint8Array(buffer(cubeSTEP())),'cube.step'),/Choose a STEP/);
});

test('STEP conversion refuses oversized, empty, malformed, or invalid-coordinate output',()=>{
  assert.throws(()=>meshFromCADResult({success:false},'cube.step'),/could not be converted/);
  assert.throws(()=>meshFromCADResult({success:true,meshes:[]},'cube.step'),/could not be converted/);
  const large=triangleResult();large.meshes[0].index.array=Array((MAX_MESH_TRIANGLES+1)*3).fill(0);
  assert.throws(()=>meshFromCADResult(large),/exceeds/);
  const badIndex=triangleResult();badIndex.meshes[0].index.array[2]=4;
  assert.throws(()=>meshFromCADResult(badIndex),/invalid surface index/);
  const badCoordinate=triangleResult();badCoordinate.meshes[0].attributes.position.array[0]=Infinity;
  assert.throws(()=>meshFromCADResult(badCoordinate),/unsupported coordinates/);
  const badTriangle=triangleResult();badTriangle.meshes[0].index.array.pop();
  assert.throws(()=>meshFromCADResult(badTriangle),/invalid surface mesh/);
  const empty=triangleResult();empty.meshes[0].index.array=[];
  assert.throws(()=>meshFromCADResult(empty),/no renderable surfaces/);
});

test('CAD import terminates workers on timeout, failure, and success',async t=>{
  const original=globalThis.Worker,instances=[];
  t.after(()=>{if(original===undefined)delete globalThis.Worker;else globalThis.Worker=original;});
  class TestWorker {
    constructor(){this.terminated=0;instances.push(this);}
    postMessage(message,transfer){this.message=message;this.transfer=transfer;}
    terminate(){this.terminated++;}
  }
  globalThis.Worker=TestWorker;
  await assert.rejects(importCAD(buffer(cubeSTEP()),'cube.step',{timeoutMs:10}),/exceeded/);
  assert.equal(instances[0].terminated,1);
  const failure=importCAD(buffer(cubeSTEP()),'cube.step');
  instances[1].onmessage({data:{ok:false,error:'This STEP model exceeds the triangle limit.'}});
  await assert.rejects(failure,/triangle limit/);assert.equal(instances[1].terminated,1);
  const mesh=meshFromCADResult(triangleResult());
  const success=importCAD(buffer(cubeSTEP()),'cube.step');
  instances[2].onmessage({data:{ok:true,mesh}});
  assert.equal(await success,mesh);assert.equal(instances[2].terminated,1);
  assert.equal(instances[2].transfer[0],instances[2].message.data);
  await assert.rejects(importCAD(buffer(cubeSTEP()),'cube.step',{timeoutMs:31000}),/at most 30/);
  assert.equal(instances.length,3);
});
