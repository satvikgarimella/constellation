import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseModel,validateMesh,prepareMesh,intersectMesh,MAX_MESH_TRIANGLES,MAX_MODEL_BYTES} from '../public/mesh.js';
import {sceneForMesh,validateScene,createTiles} from '../public/scene.js';
import {renderTileCPU} from '../public/raytracer.js';

const bytes=text=>new TextEncoder().encode(text);
const triangle=[0,0,0,2,0,0,0,2,0];
const ascii=`solid triangle\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 2 0 0\nvertex 0 2 0\nendloop\nendfacet\nendsolid triangle\n`;
const obj='v 0 0 0\nv 2 0 0\nv 0 2 0\nf -3/1/1 -2/2/1 -1/3/1\n';

test('ASCII STL and triangulated OBJ import the same normalized geometry',()=>{
  const stl=parseModel(bytes(ascii),'triangle.stl'),mesh=parseModel(bytes(obj),'triangle.obj');
  assert.deepEqual(stl,mesh);assert.equal(stl.triangles.length,9);
  assert.equal(Math.min(...stl.triangles.filter((_,i)=>i%3===1)),-0.85);
  assert.equal(Math.max(...stl.triangles.filter((_,i)=>i%3===0))-Math.min(...stl.triangles.filter((_,i)=>i%3===0)),4);
  assert.ok(sceneForMesh(stl).mesh);assert.deepEqual(validateScene(sceneForMesh(stl)),sceneForMesh(stl));
});

test('binary STL with an ASCII-looking header is detected by record length',()=>{
  const binary=new Uint8Array(134);binary.set(bytes('solid binary is not ASCII'));
  const view=new DataView(binary.buffer);view.setUint32(80,1,true);
  triangle.forEach((value,i)=>view.setFloat32(96+i*4,value,true));
  assert.deepEqual(parseModel(binary,'triangle.stl'),parseModel(bytes(ascii),'triangle.stl'));
});

test('bad, excessive, non-triangulated and non-finite inputs fail before rendering',()=>{
  assert.throws(()=>parseModel(bytes(obj),'model.step'),/Supported models/);
  assert.throws(()=>parseModel(new Uint8Array(MAX_MODEL_BYTES+1),'model.stl'),/10 MB/);
  assert.throws(()=>parseModel(bytes(ascii.replace('endfacet','')),'bad.stl'),/Incomplete/);
  assert.throws(()=>parseModel(bytes(obj.replace('f -3/1/1 -2/2/1 -1/3/1','f 1 2 3 1')),'bad.obj'),/triangles/);
  assert.throws(()=>parseModel(bytes(obj.replace('f -3/1/1 -2/2/1 -1/3/1','f 1 2 7')),'bad.obj'),/unavailable/);
  assert.throws(()=>parseModel(bytes(obj.replace('v 0 2 0','v NaN 2 0')),'bad.obj'),/invalid vertex/);
  assert.throws(()=>validateMesh({triangles:[0,0,0,1,1,1,2,2,2]}),/degenerate/);
  assert.throws(()=>validateMesh({triangles:[...triangle.slice(0,8),Infinity]}),/finite/);
  assert.throws(()=>validateMesh({triangles:Array((MAX_MESH_TRIANGLES+1)*9).fill(0)}),/triangulated/);
  const excessive=new Uint8Array(84+(MAX_MESH_TRIANGLES+1)*50);
  new DataView(excessive.buffer).setUint32(80,MAX_MESH_TRIANGLES+1,true);
  assert.throws(()=>parseModel(excessive,'oversized.stl'),/at most/);
});

test('BVH finds nearest surfaces, handles parallel rays and faces both directions',()=>{
  const triangles=[];
  for(let z=0;z<12;z++)triangles.push(-1,-1,z,1,-1,z,0,1,z);
  const mesh=validateMesh({triangles}),geometry=prepareMesh(mesh);
  assert.equal(prepareMesh(mesh),geometry,'one immutable mesh reuses its acceleration structure');
  assert.ok(geometry.nodes.length>1);assert.equal(geometry.nodes[0].escape,geometry.nodes.length);
  assert.deepEqual(intersectMesh([0,0,15],[0,0,-1],geometry),{distance:4,normal:[0,0,1]});
  assert.deepEqual(intersectMesh([0,0,-4],[0,0,1],geometry),{distance:4,normal:[-0,-0,-1]});
  assert.equal(intersectMesh([4,0,15],[0,0,-1],geometry),null);
  assert.equal(intersectMesh([0,0,15],[0,0,-1],geometry,3),null);
  assert.ok(geometry.nodes.every((n,i)=>n.escape>i&&n.escape<=geometry.nodes.length&&n.count<=4));
});

test('maximum-size mesh stays within transport and GPU acceleration bounds',()=>{
  const triangles=[];
  for(let i=0;i<MAX_MESH_TRIANGLES;i++) {
    const x=(i%100)/25-2,y=Math.floor(i/100)/25;
    triangles.push(x,y,0,x+0.025,y,0,x,y+0.025,0);
  }
  const mesh=validateMesh({triangles}),geometry=prepareMesh(mesh);
  assert.ok(Buffer.byteLength(JSON.stringify(sceneForMesh(mesh)))<2*1024*1024);
  assert.equal(geometry.triangleBuffer.length,MAX_MESH_TRIANGLES*12);
  assert.ok(geometry.nodes.length<MAX_MESH_TRIANGLES*2);
  assert.equal(geometry.nodes.filter(node=>node.count).reduce((sum,node)=>sum+node.count,0),MAX_MESH_TRIANGLES);
  assert.ok(intersectMesh([-1.99,0.01,2],[0,0,-1],geometry));
});

test('sample chair renders actual geometry consistently across independent tiles',async()=>{
  const source=await readFile(new URL('../public/models/demo-chair.obj',import.meta.url));
  const mesh=parseModel(source,'Chair.obj'),scene=sceneForMesh(mesh);
  assert.equal(mesh.triangles.length/9,120);
  const settings={width:32,height:32,samples:4,bounces:3},tile={x:0,y:0,width:32,height:32};
  const full=renderTileCPU(scene,settings,tile),background=renderTileCPU({...scene,mesh:undefined},settings,tile);
  assert.ok(full.some((value,i)=>value!==background[i]),'mesh affects visible pixels');
  const assembled=new Uint8ClampedArray(full.length);
  for(const part of createTiles(32,32,8).reverse()) {
    const pixels=renderTileCPU(scene,settings,part);
    for(let y=0;y<part.height;y++)assembled.set(pixels.subarray(y*part.width*4,(y+1)*part.width*4),((part.y+y)*32+part.x)*4);
  }
  assert.deepEqual(assembled,full);
  assert.ok(new Set(full).size>100);
});
