// OCCT's Emscripten distribution uses importScripts, hence a classic worker.
// A separate worker is terminated after every conversion to release WASM memory.
self.onmessage=async event=>{
  try {
    const {meshFromCADResult,validateCADInput}=await import('./cad-import.js');
    const {data,filename}=event.data||{};
    validateCADInput(data,filename);
    importScripts('/vendor/occt/occt-import-js.js');
    const occt=await self.occtimportjs({
      locateFile:path=>`/vendor/occt/${path}`,
      print:()=>{},printErr:()=>{}
    });
    const result=occt.ReadStepFile(new Uint8Array(data),{
      linearUnit:'millimeter',linearDeflectionType:'bounding_box_ratio',linearDeflection:0.01,angularDeflection:0.5
    });
    const mesh=meshFromCADResult(result,filename);
    self.postMessage({ok:true,mesh});
  }catch(error) {
    // Only application-authored validation messages may leave this worker.
    const message=typeof error?.message==='string'&&/^(?:This STEP|The STEP|Choose a STEP|Supported CAD|This file|Use a triangulated|Model |Mesh )/.test(error.message)
      ?error.message:'STEP conversion failed. Export a simpler STEP model or a triangulated STL and try again.';
    self.postMessage({ok:false,error:message});
  }
};
