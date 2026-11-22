import { parseModel, MAX_MODEL_BYTES, MAX_MESH_TRIANGLES } from './mesh.js';

const fail=message=>{throw new Error(message);};

/** Merge OCCT's already-positioned surfaces into the renderer's single material. */
export function meshFromCADResult(result,filename='model.step') {
  if(result?.success!==true||!Array.isArray(result.meshes)||!result.meshes.length)fail('This STEP file could not be converted to a surface mesh. Export a solid or surface model and try again.');
  let count=0;
  for(const mesh of result.meshes) {
    const positions=mesh?.attributes?.position?.array,indices=mesh?.index?.array;
    if(!Array.isArray(positions)||positions.length%3||!Array.isArray(indices)||indices.length%3)fail('The STEP converter returned an invalid surface mesh.');
    count+=indices.length/3;
    if(count>MAX_MESH_TRIANGLES)fail(`This STEP model exceeds ${MAX_MESH_TRIANGLES.toLocaleString()} triangles. Simplify the model or export a lower-detail STL.`);
  }
  if(!count)fail('This STEP file contains no renderable surfaces. Wire-only CAD files are not supported.');
  const buffer=new ArrayBuffer(84+count*50),view=new DataView(buffer);
  view.setUint32(80,count,true);
  let triangle=0;
  for(const mesh of result.meshes) {
    const positions=mesh.attributes.position.array,indices=mesh.index.array;
    for(let i=0;i<indices.length;i+=3) {
      const offset=84+triangle++*50+12;
      for(let corner=0;corner<3;corner++) {
        const index=indices[i+corner];
        if(!Number.isSafeInteger(index)||index<0||index*3+2>=positions.length)fail('The STEP converter returned an invalid surface index.');
        for(let axis=0;axis<3;axis++) {
          const value=positions[index*3+axis];
          if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>1e12)fail('The STEP model contains unsupported coordinates.');
          view.setFloat32(offset+(corner*3+axis)*4,value,true);
        }
      }
    }
  }
  const stem=String(filename).replace(/\.(?:step|stp)$/i,'').slice(0,60)||'Imported CAD';
  return parseModel(buffer,`${stem}.stl`);
}

export function validateCADInput(data,filename) {
  if(!(data instanceof ArrayBuffer)||!data.byteLength||data.byteLength>MAX_MODEL_BYTES)fail('Choose a STEP file smaller than 10 MB.');
  if(!/\.(step|stp)$/i.test(String(filename)))fail('Supported CAD files: STEP (.step or .stp). Export native CAD designs to STEP or STL first.');
  const header=new TextDecoder().decode(new Uint8Array(data,0,Math.min(256,data.byteLength))).replace(/^\uFEFF/,'').trimStart();
  if(!header.startsWith('ISO-10303-21;'))fail('This file is not a valid STEP document. Export it as STEP (.step or .stp) from your CAD application.');
}

/** Lazy, bounded conversion. Only the host downloads the converter, on demand. */
export function importCAD(data,filename,{timeoutMs=30000}={}) {
  try {
    validateCADInput(data,filename);
    if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>30000)fail('STEP conversion timeout must be at most 30 seconds.');
  }catch(error){return Promise.reject(error);}
  return new Promise((resolve,reject)=>{
    let worker,timer,finished=false;
    const finish=(error,mesh)=>{
      if(finished)return;finished=true;clearTimeout(timer);worker?.terminate();
      if(error)reject(error);else resolve(mesh);
    };
    try {
      worker=new Worker(new URL('./cad-worker.js',import.meta.url));
      timer=setTimeout(()=>finish(new Error('STEP conversion exceeded 30 seconds. Try a simpler model or export it to STL.')),timeoutMs);
      worker.onerror=event=>{event.preventDefault();finish(new Error('The STEP converter could not start. Refresh and try again, or export your model to STL.'));};
      worker.onmessage=event=>{
        const result=event.data;
        if(result?.ok===true&&result.mesh)finish(null,result.mesh);
        else finish(new Error(typeof result?.error==='string'?result.error:'STEP conversion failed. Try exporting the model to STL.'));
      };
      worker.postMessage({data,filename},[data]);
    }catch{finish(new Error('The browser could not start STEP conversion. Try exporting the model to STL.'));}
  });
}
