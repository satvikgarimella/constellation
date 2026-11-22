import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, MAX_SPHERES, validateScene, createTiles, packResult } from '../public/scene.js';
import { renderTileCPU } from '../public/raytracer.js';

test('independent tiles reconstruct exactly the same image as a full CPU render',()=>{
  const scene=validateScene(PRESETS.solstice),settings={width:39,height:35,samples:8,bounces:3};
  const whole=renderTileCPU(scene,settings,{x:0,y:0,width:39,height:35});
  const assembled=new Uint8ClampedArray(whole.length),tiles=createTiles(39,35,16);
  for(const tile of tiles.reverse()) {
    const pixels=renderTileCPU(scene,settings,tile);
    for(let row=0;row<tile.height;row++) assembled.set(pixels.subarray(row*tile.width*4,(row+1)*tile.width*4),((tile.y+row)*settings.width+tile.x)*4);
  }
  assert.deepEqual(assembled,whole);
  assert.ok(new Set(whole).size>100,'render contains a varied image');
  assert.ok(whole.filter((_,i)=>i%4===3).every(alpha=>alpha===255));
});

test('scene validation bounds workload and rejects invalid camera geometry',()=>{
  assert.throws(()=>validateScene({...PRESETS.solstice,spheres:Array(MAX_SPHERES+1).fill(PRESETS.solstice.spheres[0])}),/up to 64/);
  assert.throws(()=>validateScene({...PRESETS.solstice,camera:[0,1,0],target:[0,0,0]}),/angle/);
  const scene=validateScene({...PRESETS.solstice,exposure:Infinity,fov:900,spheres:[{radius:100,center:[0,-20,0],color:[-1,2,NaN]}]});
  assert.equal(scene.fov,75);assert.equal(scene.spheres[0].radius,3);
  assert.equal(scene.spheres[0].center[1],2.15);
  assert.deepEqual(scene.spheres[0].color,[0.01,1,0.6]);
});

test('binary result protocol preserves the exact typed-array slice and job identity',()=>{
  const raw=new Uint8Array([11,22,33,44,55,66]);
  const frame=packResult({runId:2,id:3,lease:4},raw.subarray(1,5),12.5);
  const view=new DataView(frame);
  assert.equal(view.getUint32(0,true),2);assert.equal(view.getUint32(4,true),3);assert.equal(view.getUint32(8,true),4);
  assert.equal(view.getFloat32(12,true),12.5);assert.deepEqual([...new Uint8Array(frame,16)],[22,33,44,55]);
});
