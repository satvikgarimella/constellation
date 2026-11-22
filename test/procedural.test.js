import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, MAX_SPHERES, MAX_BOXES, validateScene, createTiles } from '../public/scene.js';
import { renderTileCPU } from '../public/raytracer.js';
import { TERRAIN_FLOOR, terrainHeight, terrainGradient, intersectTerrain, intersectBox, environmentRadiance } from '../public/procedural.js';

const normalize=v=>{const length=Math.hypot(...v);return v.map(c=>c/length);};
const near=(actual,expected,tolerance=1e-12)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} differs from ${expected} by more than ${tolerance}`);
const box={center:[1,2,3],size:[4,6,8]};

test('axis-aligned box faces have exact distances and outward normals for parallel-axis rays',()=>{
  const cases=[
    {origin:[-5,2,3],direction:[1,0,0],normal:[-1,0,0]},
    {origin:[7,2,3],direction:[-1,0,0],normal:[1,0,0]},
    {origin:[1,-5,3],direction:[0,1,0],normal:[0,-1,0]},
    {origin:[1,9,3],direction:[0,-1,0],normal:[0,1,0]},
    {origin:[1,2,-5],direction:[0,0,1],normal:[0,0,-1]},
    {origin:[1,2,11],direction:[0,0,-1],normal:[0,0,1]}
  ];
  for(const {origin,direction,normal} of cases) {
    assert.deepEqual(intersectBox(origin,direction,box),{distance:4,normal});
    assert.equal(intersectBox(origin,direction,box,3.9),null,'a farther box must not replace a nearer hit');
  }
  assert.equal(intersectBox([3.1,2,-5],[0,0,1],box),null,'a ray parallel to an outside slab misses');
  assert.equal(intersectBox([1,5.1,-5],[0,0,1],box),null);
  assert.deepEqual(intersectBox([3,2,-5],[0,0,1],box),{distance:4,normal:[0,0,-1]},'a ray on a slab boundary remains valid');
});

test('rays starting inside a box hit the exit face rather than a negative entry',()=>{
  for(let axis=0;axis<3;axis++) for(const sign of [-1,1]) {
    const direction=[0,0,0];direction[axis]=sign;
    assert.deepEqual(intersectBox(box.center,direction,box),{distance:box.size[axis]/2,normal:direction});
  }
  const unitBox={center:[0,0,0],size:[2,2,2]},direction=normalize([1,1,1]);
  const corner=intersectBox([-2,-2,-2],direction,unitBox);
  near(corner.distance,Math.sqrt(3));assert.deepEqual(corner.normal,[-1,0,0],'edge ties choose a deterministic face');
  assert.equal(intersectBox([1,0,0],[1,0,0],unitBox),null,'a ray leaving an exact boundary has no positive box hit');
});

test('terrain stays finite within its height and slope bounds, with an analytic gradient',()=>{
  for(const height of [0,0.1,1.65,3]) for(const scale of [0.08,0.29,1]) {
    const terrain={height,scale};
    for(const x of [-1000,-40,-3,0,2,40,1000]) for(const z of [-1000,-17,0,9,1000]) {
      const y=terrainHeight(x,z,terrain),gradient=terrainGradient(x,z,terrain);
      assert.ok(Number.isFinite(y));assert.ok(gradient.every(Number.isFinite));
      assert.ok(y>=TERRAIN_FLOOR-1e-12&&y<=TERRAIN_FLOOR+height+1e-12);
      assert.ok(Math.hypot(...gradient)<=0.4*height*scale+1e-12);
      if(height===0){assert.equal(y,TERRAIN_FLOOR);assert.ok(gradient.every(v=>Math.abs(v)===0));}
      const step=1e-5;
      near(gradient[0],(terrainHeight(x+step,z,terrain)-terrainHeight(x-step,z,terrain))/(2*step),5e-8);
      near(gradient[1],(terrainHeight(x,z+step,terrain)-terrainHeight(x,z-step,terrain))/(2*step),5e-8);
    }
  }
});

test('terrain intersections lie on the heightfield and upward rays avoid self-shadow',()=>{
  for(const terrain of [{height:1.65,scale:0.29},{height:3,scale:1},{height:0.1,scale:0.08}]) {
    for(const [x,z] of [[0,0],[2,-4],[-8,11]]) {
      const surface=terrainHeight(x,z,terrain),origin=[x,surface+10,z];
      const hit=intersectTerrain(origin,[0,-1,0],terrain);
      assert.ok(hit,'a vertical ray through the heightfield must hit');
      near(hit.distance,10,0.0021);
      near(origin[1]-hit.distance,surface,0.0021);near(Math.hypot(...hit.normal),1);
      const [dx,dz]=terrainGradient(x,z,terrain),normal=normalize([-dx,1,-dz]);
      hit.normal.forEach((component,i)=>near(component,normal[i]));
      assert.equal(intersectTerrain(origin,[0,-1,0],terrain,9),null);
      assert.equal(intersectTerrain([x,surface+0.003,z],[0,1,0],terrain),null,'an upward ray from above the surface must not hit itself');
    }
    const origin=[0,8,10],direction=normalize([-0.15,-0.65,-1]);
    const hit=intersectTerrain(origin,direction,terrain);assert.ok(hit);
    const point=origin.map((component,i)=>component+direction[i]*hit.distance);
    near(point[1],terrainHeight(point[0],point[2],terrain),0.0021);
  }
  assert.equal(intersectTerrain([0,3,0],[0,-1,0],{height:0,scale:1}),null,'flat ground uses the legacy plane intersection');
  assert.equal(intersectTerrain([0,10,0],[1,0,0],{height:3,scale:1}),null,'a parallel ray above the terrain envelope misses');
});

test('scene validation accepts object-free dunes and box cities without injecting spheres',()=>{
  const dunes=validateScene(PRESETS.aurora),city=validateScene(PRESETS.city);
  assert.deepEqual(dunes.spheres,[]);assert.deepEqual(dunes.boxes,[]);assert.ok(dunes.terrain.height>0);
  assert.deepEqual(city.spheres,[]);assert.equal(city.boxes.length,PRESETS.city.boxes.length);assert.equal(city.terrain.height,0);
  assert.throws(()=>validateScene({...PRESETS.aurora,terrain:{height:0,scale:0.4}}),/spheres, boxes, or terrain/);
  assert.throws(()=>validateScene({...PRESETS.city,boxes:Array(MAX_BOXES+1).fill(PRESETS.city.boxes[0])}),/boxes/);
  assert.throws(()=>validateScene({...PRESETS.solstice,spheres:Array(MAX_SPHERES).fill(PRESETS.solstice.spheres[0]),boxes:[PRESETS.city.boxes[0]]}),/objects in total/);
  const bounded=validateScene({...PRESETS.aurora,terrain:{height:999,scale:-2},aurora:{strength:99,color:[-1,Infinity,2]},stars:NaN,camera:[99,-99,NaN],target:[-999,999,Infinity]});
  assert.deepEqual(bounded.terrain,{height:3,scale:0.08});assert.equal(bounded.aurora.strength,3);
  assert.deepEqual(bounded.aurora.color,[0,1,1]);assert.equal(bounded.stars,0);
  assert.deepEqual(bounded.camera,[60,-60,PRESETS.solstice.camera[2]]);assert.deepEqual(bounded.target,[-40,40,PRESETS.solstice.target[2]]);
  const defaults=validateScene({...PRESETS.city,terrain:{height:NaN,scale:Infinity},aurora:{strength:NaN},stars:Infinity});
  assert.deepEqual(defaults.terrain,{height:0,scale:0.4});assert.equal(defaults.aurora.strength,0);assert.equal(defaults.stars,0);
});

test('grazing primary rays do not fall through dunes when the bounded march crosses a near-tangent crest',()=>{
  // Captured from the 320px Aurora Desert frame: the old slope-only march
  // exhausted its 96 steps on these rays and exposed blue sky through sand.
  const origin=[12,3.6,18],terrain={height:2.8,scale:0.48};
  const directions=[
    [0.005414963929303273,-0.1512833980741651,-0.9884755999177612],
    [0.008236426843783692,-0.1511219332574081,-0.9884808154746305],
    [0.11551320372142695,-0.10703771005761364,-0.9875219634983491]
  ];
  for(const direction of directions) {
    const hit=intersectTerrain(origin,direction,terrain);
    assert.ok(hit,'a visible dune must not become a hole when the marching budget is reached');
    const point=origin.map((v,i)=>v+direction[i]*hit.distance);
    assert.ok(hit.distance>0&&hit.distance<=120);
    near(point[1],terrainHeight(point[0],point[2],terrain),0.0021);
    near(Math.hypot(...hit.normal),1);
  }
});

test('disabled sky effects preserve the exact gradient; aurora and stars add deterministic radiance',()=>{
  const base={skyBottom:[0.25,0.5,0.75],skyTop:[0.75,0.25,0],aurora:{strength:0,color:[0.1,1,0.5]},stars:0};
  assert.deepEqual(environmentRadiance([0,1,0],base),base.skyTop);
  assert.deepEqual(environmentRadiance([0,-1,0],base),base.skyBottom);
  assert.deepEqual(environmentRadiance([0,0,1],base),[0.5,0.375,0.375]);
  const aurora={...base,aurora:{strength:1.8,color:[0.1,1,0.5]}},direction=[Math.cos(0.25),Math.sin(0.25),0];
  const plain=environmentRadiance(direction,base),lit=environmentRadiance(direction,aurora);
  assert.ok(lit[1]-plain[1]>0.1,'an aurora adds visible radiance near its sky ribbon');
  assert.deepEqual(environmentRadiance(direction,aurora),lit);
  assert.deepEqual(environmentRadiance([0,-1,0],{...aurora,stars:1}),base.skyBottom);
  const starScene={...base,stars:1};let starDirection;
  // Search a fixed grid of sky directions without duplicating the star hash.
  for(let elevation=32;elevation<=160&&!starDirection;elevation+=16) for(let azimuth=0;azimuth<1608;azimuth++) {
    const az=(azimuth+0.5)/256-Math.PI,el=(elevation+0.5)/256;
    const d=[Math.cos(az)*Math.cos(el),Math.sin(el),Math.sin(az)*Math.cos(el)];
    if(environmentRadiance(d,starScene)[0]-environmentRadiance(d,base)[0]>0.1){starDirection=d;break;}
  }
  assert.ok(starDirection,'the procedural sky must contain stars at fixed directions');
  const star=environmentRadiance(starDirection,starScene);
  assert.ok(star.every(Number.isFinite));assert.deepEqual(environmentRadiance(starDirection,starScene),star);
});

for(const name of ['aurora','city'])test(`${name} tiles exactly reconstruct a whole CPU render in a different completion order`,()=>{
  const scene=validateScene(PRESETS[name]),settings={width:31,height:23,samples:8,bounces:3};
  const whole=renderTileCPU(scene,settings,{x:0,y:0,width:settings.width,height:settings.height});
  const assembled=new Uint8ClampedArray(whole.length);
  for(const tile of createTiles(settings.width,settings.height,9).reverse()) {
    const pixels=renderTileCPU(scene,settings,tile);
    for(let row=0;row<tile.height;row++)assembled.set(pixels.subarray(row*tile.width*4,(row+1)*tile.width*4),((tile.y+row)*settings.width+tile.x)*4);
  }
  assert.deepEqual(assembled,whole);
  assert.ok(whole.some((value,index)=>index%4!==3&&value>0));
  assert.ok(whole.every((value,index)=>index%4!==3||value===255));
});
