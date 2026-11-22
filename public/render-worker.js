import { cameraBasis, renderTileCPU } from './raytracer.js';

let gpu=null,backend='cpu';
async function initialize(forceCPU=false) {
  if(!forceCPU && navigator.gpu) {
    try {
      const adapter=await navigator.gpu.requestAdapter();
      if(!adapter) throw new Error('No GPU adapter available');
      const device=await adapter.requestDevice();
      const code=await (await fetch('/trace.wgsl')).text();
      device.pushErrorScope('validation');
      const module=device.createShaderModule({code});
      const info=await module.getCompilationInfo();
      const errors=info.messages.filter(m=>m.type==='error');
      if(errors.length) throw new Error(errors.map(e=>e.message).join('; '));
      const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
      const error=await device.popErrorScope();if(error) throw new Error(error.message);
      const uniform=device.createBuffer({size:176,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      const spheres=device.createBuffer({size:12*48,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
      const output=device.createBuffer({size:4096,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
      const readback=device.createBuffer({size:4096,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
      const bindGroup=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}},{binding:1,resource:{buffer:spheres}},{binding:2,resource:{buffer:output}}]});
      gpu={device,pipeline,uniform,spheres,output,readback,bindGroup};backend='webgpu';
      device.lost.then(()=>{gpu=null;backend='cpu';self.postMessage({type:'backend',backend,reason:'GPU unavailable; continuing on CPU.'});});
    } catch(error) {self.postMessage({type:'notice',message:`WebGPU unavailable: ${error.message}. Using the CPU renderer.`});}
  }
  self.postMessage({type:'ready',backend});
}

async function renderGPU(scene,settings,tile) {
  const g=gpu,{device}=g;
  const buffer=new ArrayBuffer(176),floats=new Float32Array(buffer),uints=new Uint32Array(buffer);
  const {forward,right,up}=cameraBasis(scene);
  [scene.camera,right,up,forward,scene.skyTop,scene.skyBottom,scene.ground,scene.sun].forEach((v,i)=>floats.set([...v,0],i*4));
  floats.set([settings.width,settings.height,settings.samples,settings.bounces],32);
  uints.set([tile.x,tile.y,tile.width,tile.height],36);
  floats.set([scene.spheres.length,scene.exposure,Math.tan(scene.fov*Math.PI/360),0],40);
  const objects=new Float32Array(12*12);
  scene.spheres.forEach((s,i)=>{objects.set([...s.center,s.radius,...s.color,s.metal,s.roughness,0,0,0],i*12);});
  device.queue.writeBuffer(g.uniform,0,buffer);device.queue.writeBuffer(g.spheres,0,objects);
  const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
  pass.setPipeline(g.pipeline);pass.setBindGroup(0,g.bindGroup);pass.dispatchWorkgroups(Math.ceil(tile.width/8),Math.ceil(tile.height/8));pass.end();
  const size=tile.width*tile.height*4;
  encoder.copyBufferToBuffer(g.output,0,g.readback,0,size);device.queue.submit([encoder.finish()]);
  await g.readback.mapAsync(GPUMapMode.READ,0,size);
  const result=new Uint8ClampedArray(g.readback.getMappedRange(0,size).slice(0));g.readback.unmap();return result;
}

self.onmessage=async ({data})=>{
  if(data.type==='init') {await initialize(data.forceCPU);return;}
  if(data.type!=='render') return;
  const started=performance.now();
  try {
    let pixels;
    if(gpu) {
      try {pixels=await renderGPU(data.scene,data.settings,data.job);}
      catch(error) {gpu=null;backend='cpu';self.postMessage({type:'backend',backend,reason:'GPU render failed; continuing on CPU.'});pixels=renderTileCPU(data.scene,data.settings,data.job);}
    } else pixels=renderTileCPU(data.scene,data.settings,data.job);
    self.postMessage({type:'result',job:data.job,pixels,durationMs:performance.now()-started,backend},[pixels.buffer]);
  } catch(error) {self.postMessage({type:'error',message:error.message});}
};
