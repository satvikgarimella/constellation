// Bounded, dependency-free mesh import. Models contain one flat-shaded material.
export const MAX_MESH_TRIANGLES = 10000;
export const MAX_MODEL_BYTES = 10 * 1024 * 1024;
const MAX_VERTICES = MAX_MESH_TRIANGLES * 3;
const cache = new WeakMap();
const defaultMaterial = {color:[0.64,0.73,0.82],metal:0.35,roughness:0.25,emission:[0,0,0]};
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const finite = value => typeof value==='number' && Number.isFinite(value);
const fail = message => {throw new Error(message);};

function checkedVertices(values) {
  if(!values.length || values.length%9 || values.length>MAX_MESH_TRIANGLES*9) fail(`Use a triangulated model with 1–${MAX_MESH_TRIANGLES.toLocaleString()} triangles.`);
  if(values.some(value=>!finite(value)||Math.abs(value)>1e12)) fail('Model vertices must be finite numbers within the supported coordinate range.');
  return values;
}

function parseSTL(bytes) {
  if(bytes.byteLength>=84) {
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),count=view.getUint32(80,true);
    if(84+count*50===bytes.byteLength) {
      if(count<1||count>MAX_MESH_TRIANGLES) fail(`STL supports at most ${MAX_MESH_TRIANGLES.toLocaleString()} triangles. Export a lower-detail mesh.`);
      const values=[];
      for(let i=0;i<count;i++) for(let n=0;n<9;n++) values.push(view.getFloat32(84+i*50+12+n*4,true));
      return checkedVertices(values);
    }
  }
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  if(!/^solid(?:\s|$)/i.test(lines[0]||'')||!/^endsolid(?:\s|$)/i.test(lines.at(-1)||'')) fail('Invalid STL. Use a complete ASCII or binary STL file.');
  let at=1;const values=[];
  const numericLine=(prefix,count)=>{
    const parts=(lines[at++]||'').split(/\s+/);
    const names=prefix.split(' ');
    if(parts.length!==names.length+count||names.some((name,i)=>parts[i].toLowerCase()!==name)) fail('Malformed ASCII STL facet.');
    const numbers=parts.slice(names.length).map(Number);
    if(numbers.some(value=>!finite(value))) fail('Invalid number in STL.');
    return numbers;
  };
  while(at<lines.length-1) {
    if(values.length>=MAX_MESH_TRIANGLES*9) fail(`STL supports at most ${MAX_MESH_TRIANGLES.toLocaleString()} triangles. Export a lower-detail mesh.`);
    numericLine('facet normal',3);
    if((lines[at++]||'').toLowerCase()!=='outer loop') fail('Malformed STL loop.');
    for(let v=0;v<3;v++) values.push(...numericLine('vertex',3));
    if((lines[at++]||'').toLowerCase()!=='endloop'||(lines[at++]||'').toLowerCase()!=='endfacet') fail('Incomplete STL facet.');
  }
  if(at!==lines.length-1) fail('Incomplete STL.');
  return checkedVertices(values);
}

function parseOBJ(bytes) {
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),vertices=[],values=[];
  for(const raw of text.split(/\r?\n/)) {
    const line=raw.split('#')[0].trim();if(!line)continue;
    const [type,...parts]=line.split(/\s+/);
    if(type==='v') {
      if(parts.length!==3||vertices.length>=MAX_VERTICES) fail('OBJ supports up to 30,000 three-coordinate vertices.');
      const vertex=parts.map(Number);
      if(vertex.some(value=>!finite(value)||Math.abs(value)>1e12)) fail('OBJ contains an invalid vertex.');
      vertices.push(vertex);
    } else if(type==='f') {
      if(parts.length!==3) fail('OBJ faces must be triangles. Enable triangulation when exporting your model.');
      if(values.length>=MAX_MESH_TRIANGLES*9) fail(`OBJ supports at most ${MAX_MESH_TRIANGLES.toLocaleString()} triangles.`);
      for(const part of parts) {
        if(!/^-?\d+(?:\/-?\d*)?(?:\/-?\d+)?$/.test(part)) fail('OBJ contains an invalid face index.');
        const number=Number(part.split('/')[0]);
        const index=number<0?vertices.length+number:number-1;
        if(!Number.isSafeInteger(number)||number===0||index<0||index>=vertices.length) fail('OBJ face refers to an unavailable vertex.');
        values.push(...vertices[index]);
      }
    } else if(!['vt','vn','o','g','s','usemtl','mtllib'].includes(type)) {
      fail(`Unsupported OBJ element: ${type.slice(0,20)}. Export a triangulated surface mesh.`);
    }
  }
  return checkedVertices(values);
}

export function parseModel(data,filename='model.stl') {
  const bytes=data instanceof Uint8Array?data:new Uint8Array(data);
  if(!bytes.byteLength||bytes.byteLength>MAX_MODEL_BYTES) fail('Choose a model file smaller than 10 MB.');
  const extension=String(filename).toLowerCase().split('.').at(-1);
  if(!['stl','obj'].includes(extension)) fail('Supported models: STL and triangulated OBJ. Export CAD designs to STL first.');
  let values;
  try {values=extension==='stl'?parseSTL(bytes):parseOBJ(bytes);}
  catch(error) {if(error instanceof TypeError)fail('Model is not valid STL or UTF-8 OBJ data.');throw error;}
  const lower=[Infinity,Infinity,Infinity],upper=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i<values.length;i++) {const axis=i%3;lower[axis]=Math.min(lower[axis],values[i]);upper[axis]=Math.max(upper[axis],values[i]);}
  const longest=Math.max(...upper.map((value,i)=>value-lower[i]));
  if(!finite(longest)||longest<1e-9)fail('Model has no measurable size.');
  const scale=4/longest,center=lower.map((value,i)=>(value+upper[i])/2);
  const triangles=values.map((value,i)=>Math.round(((i%3===1?(value-lower[1])*scale-0.85:(value-center[i%3])*scale))*1e6)/1e6);
  return validateMesh({name:String(filename).replace(/\.[^.]+$/,'').slice(0,60)||'Imported model',triangles,...defaultMaterial});
}

export function validateMesh(input) {
  if(input===undefined||input===null)return undefined;
  if(typeof input!=='object'||!Array.isArray(input.triangles))fail('Mesh must contain a flat triangle vertex array.');
  const values=checkedVertices(input.triangles);
  if(values.some(value=>Math.abs(value)>40))fail('Mesh vertices must stay within 40 scene units. Reimport the original file to normalize its size.');
  for(let i=0;i<values.length;i+=9) {
    const a=values.slice(i,i+3),b=values.slice(i+3,i+6),c=values.slice(i+6,i+9),n=cross(sub(b,a),sub(c,a));
    if(dot(n,n)<1e-16)fail('Model contains degenerate triangles. Remove zero-area faces and export again.');
  }
  const scalar=(value,fallback,low,high)=>finite(value)?Math.min(high,Math.max(low,value)):fallback;
  const vector=(value,fallback,low,high)=>fallback.map((v,i)=>scalar(value?.[i],v,low,high));
  return {name:String(input.name||'Imported model').slice(0,60),triangles:values.slice(),
    color:vector(input.color,defaultMaterial.color,0.01,1),metal:scalar(input.metal,0.35,0,1),roughness:scalar(input.roughness,0.25,0,1),emission:vector(input.emission,[0,0,0],0,8)};
}

// A preorder BVH with escape indices has bounded, stack-free traversal on GPU.
// Each leaf holds <=4 triangles. GPU buffers use three aligned vec4s per record.
export function prepareMesh(mesh) {
  if(!mesh)return null;
  if(cache.has(mesh))return cache.get(mesh);
  const triangles=[];
  for(let i=0;i<mesh.triangles.length;i+=9) {
    const a=mesh.triangles.slice(i,i+3),b=mesh.triangles.slice(i+3,i+6),c=mesh.triangles.slice(i+6,i+9);
    triangles.push({a,e1:sub(b,a),e2:sub(c,a),lower:a.map((v,k)=>Math.min(v,b[k],c[k])),upper:a.map((v,k)=>Math.max(v,b[k],c[k])),center:a.map((v,k)=>(v+b[k]+c[k])/3)});
  }
  const nodes=[],ordered=[];
  function build(group) {
    const index=nodes.length,node={lower:[Infinity,Infinity,Infinity],upper:[-Infinity,-Infinity,-Infinity],first:0,count:0,escape:0};nodes.push(node);
    for(const triangle of group)for(let a=0;a<3;a++){node.lower[a]=Math.min(node.lower[a],triangle.lower[a]-1e-4);node.upper[a]=Math.max(node.upper[a],triangle.upper[a]+1e-4);}
    if(group.length<=4){node.first=ordered.length;node.count=group.length;ordered.push(...group);}
    else {
      const extent=node.upper.map((v,i)=>v-node.lower[i]),axis=extent.indexOf(Math.max(...extent));
      group.sort((a,b)=>a.center[axis]-b.center[axis]);const middle=Math.floor(group.length/2);
      build(group.slice(0,middle));build(group.slice(middle));
    }
    node.escape=nodes.length;return index;
  }
  build(triangles);
  const triangleBuffer=new Float32Array(ordered.length*12),nodeBuffer=new ArrayBuffer(nodes.length*48),nodeFloats=new Float32Array(nodeBuffer),nodeUints=new Uint32Array(nodeBuffer);
  ordered.forEach((t,i)=>triangleBuffer.set([...t.a,0,...t.e1,0,...t.e2,0],i*12));
  nodes.forEach((n,i)=>{nodeFloats.set([...n.lower,0,...n.upper,0],i*12);nodeUints.set([n.first,n.count,n.escape,0],i*12+8);});
  const result={nodes,triangles:ordered,triangleBuffer,nodeBuffer};cache.set(mesh,result);return result;
}

function hitBounds(origin,direction,node,maxDistance) {
  let near=0.002,far=maxDistance;
  for(let axis=0;axis<3;axis++) {
    if(Math.abs(direction[axis])<1e-8){if(origin[axis]<node.lower[axis]||origin[axis]>node.upper[axis])return false;continue;}
    const a=(node.lower[axis]-origin[axis])/direction[axis],b=(node.upper[axis]-origin[axis])/direction[axis];
    near=Math.max(near,Math.min(a,b));far=Math.min(far,Math.max(a,b));if(far<near)return false;
  }
  return true;
}

export function intersectMesh(origin,direction,geometry,maxDistance=1e10) {
  if(!geometry)return null;
  let distance=maxDistance,normal=null,index=0;
  while(index<geometry.nodes.length) {
    const node=geometry.nodes[index];
    if(!hitBounds(origin,direction,node,distance)){index=node.escape;continue;}
    if(!node.count){index++;continue;}
    for(let i=node.first;i<node.first+node.count;i++) {
      const t=geometry.triangles[i],p=cross(direction,t.e2),det=dot(t.e1,p);
      if(Math.abs(det)<1e-8)continue;
      const inv=1/det,s=sub(origin,t.a),u=dot(s,p)*inv;if(u<0||u>1)continue;
      const q=cross(s,t.e1),v=dot(direction,q)*inv;if(v<0||u+v>1)continue;
      const hit=dot(t.e2,q)*inv;if(hit<=0.002||hit>=distance)continue;
      const n=cross(t.e1,t.e2),length=Math.hypot(...n),sign=dot(n,direction)>0?-1:1;
      distance=hit;normal=n.map(value=>value/length*sign);
    }
    index=node.escape;
  }
  return normal?{distance,normal}:null;
}
