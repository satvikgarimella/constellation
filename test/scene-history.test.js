import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneHistory } from '../public/scene-history.js';
import { PRESETS } from '../public/scene.js';

test('scene versions undo and redo accepted edits without mutating original inputs',()=>{
  const history=createSceneHistory();
  assert.equal(history.current,null);assert.equal(history.undo(),null);assert.equal(history.redo(),null);
  const original=structuredClone(PRESETS.city);
  const first=history.record(original);
  const sunset=history.record({...first,name:'Sunset city',sun:[1,0.5,0.2]});
  assert.equal(history.size,2);assert.equal(history.canUndo,true);assert.equal(history.canRedo,false);
  assert.equal(history.undo(),first);assert.equal(history.current,first);assert.equal(history.canRedo,true);
  assert.equal(history.redo(),sunset);assert.equal(history.current,sunset);
  assert.equal(sunset.boxes,first.boxes,'Unchanged geometry is shared between versions');
  assert.ok(Object.isFrozen(first));assert.ok(Object.isFrozen(first.boxes[0].center));
  assert.throws(()=>{first.boxes[0].center[0]=999;},TypeError);
  assert.deepEqual(original,PRESETS.city);assert.equal(Object.isFrozen(original),false);
});

test('history drops redo after a new branch, ignores duplicates, and caps retained versions',()=>{
  const history=createSceneHistory({limit:3});
  for(let n=0;n<5;n++)history.record({...PRESETS.lunar,name:`Version ${n}`});
  assert.equal(history.size,3);assert.equal(history.current.name,'Version 4');
  assert.equal(history.undo().name,'Version 3');assert.equal(history.undo().name,'Version 2');assert.equal(history.undo(),null);
  const current=history.current;
  assert.equal(history.record(structuredClone(current)),current);assert.equal(history.canRedo,true);
  const branch=history.record({...current,name:'New branch'});
  assert.equal(history.size,2);assert.equal(history.canRedo,false);assert.equal(history.redo(),null);
  assert.equal(history.current,branch);
  assert.throws(()=>history.record({spheres:[]}),/scene needs/);
  assert.equal(history.current,branch);assert.equal(history.size,2);
  history.clear();assert.equal(history.size,0);assert.equal(history.current,null);assert.equal(history.canUndo,false);
});

test('history validates memory limits',()=>{
  for(const limit of [0,1,101,2.1,Infinity])assert.throws(()=>createSceneHistory({limit}),/limit/);
});

test('mesh vertices are retained once across lighting and material history entries',()=>{
  const history=createSceneHistory();
  const triangles=Array.from({length:3000},()=>[0,0,0,2,0,0,0,2,0]).flat();
  const source={...PRESETS.solstice,spheres:[],boxes:[],mesh:{name:'Design',triangles}};
  const first=history.record(source);
  const lighting=history.record({...first,exposure:2});
  const copper=history.record({...lighting,mesh:{...lighting.mesh,color:[0.8,0.4,0.2]}});
  assert.equal(first.mesh,lighting.mesh);
  assert.notEqual(copper.mesh,lighting.mesh);
  assert.equal(first.mesh.triangles,copper.mesh.triangles);
  assert.equal(Object.isFrozen(first.mesh.triangles),true);
  assert.equal(Object.isFrozen(triangles),false);
  assert.equal(history.undo(),lighting);assert.equal(history.undo(),first);
  assert.equal(first.mesh.color[0],0.64);
});
