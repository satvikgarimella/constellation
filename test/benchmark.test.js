import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmark } from '../server/coordinator.js';

const worker=(id,backends=['webgpu'])=>({id,label:`Device ${id}`,backend:backends.join('+'),backends,tiles:32,pixels:32768});
const run=(runId,contributors,overrides={})=>({runId,workers:contributors.length,contributors,seconds:10,fingerprint:'same-image',...overrides});

test('benchmark only matches equal work, a uniform backend, and the baseline worker in the crowd',()=>{
  const solo=run(1,[worker('a')]);
  const crowd=run(2,[worker('a'),worker('b')],{seconds:5});
  assert.equal(benchmark([crowd,solo]).speedup,2);
  assert.equal(benchmark([{...crowd,seconds:20},solo]).speedup,0.5,'slower crowd runs must be shown honestly');
  assert.equal(benchmark([{...crowd,fingerprint:'different-quality'},solo]).reason,'matching_baseline_needed');
  assert.equal(benchmark([run(2,[worker('a',['cpu']),worker('b',['cpu'])]),solo]).reason,'backend_mismatch');
  assert.equal(benchmark([run(2,[worker('a',['webgpu','cpu']),worker('b')]),solo]).reason,'mixed_backends');
  assert.equal(benchmark([run(2,[worker('b'),worker('c')]),solo]).reason,'baseline_worker_missing');
  assert.equal(benchmark([crowd,{...solo,seconds:0}]).reason,'insufficient_timing');
});

test('benchmark finds the newest compatible baseline rather than an unrelated recent run',()=>{
  const crowd=run(4,[worker('a'),worker('b')]);
  const result=benchmark([crowd,run(3,[worker('c')]),run(2,[worker('a')],{seconds:20}),run(1,[worker('a')],{seconds:100})]);
  assert.equal(result.baselineRunId,2);assert.equal(result.speedup,2);
});
