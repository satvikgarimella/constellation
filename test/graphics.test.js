import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, validateScene, createTiles } from '../public/scene.js';
import { renderTileCPU } from '../public/raytracer.js';

test('Orbit has bounded, non-intersecting geometry and real reflected/emissive materials',()=>{
  const scene=validateScene(PRESETS.orbit);
  assert.equal(scene.spheres.length,54);
  assert.ok(scene.groundMetal>0);
  assert.ok(scene.spheres.some(s=>s.emission.some(v=>v>0)));
  for(let i=0;i<scene.spheres.length;i++)for(let j=i+1;j<scene.spheres.length;j++) {
    const a=scene.spheres[i],b=scene.spheres[j];
    const separation=Math.hypot(...a.center.map((v,k)=>v-b.center[k]));
    assert.ok(separation>=a.radius+b.radius-0.001,`Spheres ${i} and ${j} overlap`);
  }
});

test('Orbit produces the same image regardless of the order or boundaries of distributed tiles',()=>{
  const scene=validateScene(PRESETS.orbit),settings={width:41,height:37,samples:8,bounces:4};
  const image=renderTileCPU(scene,settings,{x:0,y:0,width:41,height:37});
  const assembled=new Uint8ClampedArray(image.length);
  for(const tile of createTiles(41,37,13).reverse()) {
    const pixels=renderTileCPU(scene,settings,tile);
    for(let row=0;row<tile.height;row++)assembled.set(pixels.subarray(row*tile.width*4,(row+1)*tile.width*4),((tile.y+row)*settings.width+tile.x)*4);
  }
  assert.deepEqual(assembled,image);
  assert.ok(new Set(image).size>150);
});

test('new material fields are bounded and old scenes retain their original material defaults',()=>{
  const old=validateScene(PRESETS.solstice);
  assert.equal(old.groundMetal,0);assert.equal(old.groundRoughness,0.5);
  assert.ok(old.spheres.every(s=>s.emission.every(v=>v===0)));
  const input=structuredClone(PRESETS.solstice);input.groundMetal=99;input.groundRoughness=-1;
  input.spheres[0].emission=[-1,100,NaN];
  const bounded=validateScene(input);
  assert.equal(bounded.groundMetal,1);assert.equal(bounded.groundRoughness,0);
  assert.deepEqual(bounded.spheres[0].emission,[0,8,0]);
});
