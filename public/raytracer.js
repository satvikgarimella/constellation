import { intersectBox, intersectTerrain, environmentRadiance } from './procedural.js';
import { prepareMesh, intersectMesh } from './mesh.js';

const add = (a,b) => [a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const sub = (a,b) => [a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const mul = (a,s) => [a[0]*s,a[1]*s,a[2]*s];
const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const norm = a => mul(a,1/Math.max(1e-8,Math.hypot(...a)));
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const reflect = (d,n) => sub(d,mul(n,2*dot(d,n)));

export function cameraBasis(scene) {
  const forward = norm(sub(scene.target,scene.camera));
  const right = norm(cross(forward,[0,1,0]));
  return { forward, right, up: cross(right,forward) };
}

function hitScene(origin, direction, scene, maxDistance = 1e10, geometry = null) {
  let distance = maxDistance, material = null, normal;
  if (!(scene.terrain?.height>0) && Math.abs(direction[1]) > 1e-6) {
    const t = (-0.85-origin[1])/direction[1];
    if(t > 0.002 && t < distance) {
      distance=t; normal=[0,1,0];
      material={color:scene.ground,metal:scene.groundMetal??0,roughness:scene.groundRoughness??0.5};
    }
  }
  for(const sphere of scene.spheres) {
    const oc=sub(origin,sphere.center), b=dot(oc,direction);
    const discriminant=b*b-dot(oc,oc)+sphere.radius*sphere.radius;
    if(discriminant<0) continue;
    let t=-b-Math.sqrt(discriminant);
    if(t<0.002) t=-b+Math.sqrt(discriminant);
    if(t>0.002 && t<distance) {distance=t;material=sphere;normal=norm(sub(add(origin,mul(direction,t)),sphere.center));}
  }
  for(const box of scene.boxes||[]) {
    const hit=intersectBox(origin,direction,box,distance);
    if(hit) {distance=hit.distance;material=box;normal=hit.normal;}
  }
  if(geometry) {
    const hit=intersectMesh(origin,direction,geometry,distance);
    if(hit){distance=hit.distance;normal=hit.normal;material=scene.mesh;}
  }
  if(scene.terrain?.height>0) {
    const hit=intersectTerrain(origin,direction,scene.terrain,distance);
    if(hit&&hit.distance<distance) {
      distance=hit.distance;normal=hit.normal;
      material={color:scene.ground,metal:scene.groundMetal??0,roughness:scene.groundRoughness??0.5};
    }
  }
  return material ? { distance, material, normal } : null;
}

export function renderTileCPU(scene, settings, tile) {
  const geometry=prepareMesh(scene.mesh);
  const pixels = new Uint8ClampedArray(tile.width*tile.height*4);
  const {forward,right,up}=cameraBasis(scene);
  const scale=Math.tan(scene.fov*Math.PI/360),aspect=settings.width/settings.height;
  let seed=1;
  const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
  const unit=()=>{const z=2*random()-1,a=random()*Math.PI*2,r=Math.sqrt(Math.max(0,1-z*z));return [r*Math.cos(a),z,r*Math.sin(a)];};
  const sunDirection=norm([-0.6,0.9,0.4]);
  for(let py=0;py<tile.height;py++) for(let px=0;px<tile.width;px++) {
    const x=tile.x+px,y=tile.y+py;
    seed=((Math.imul(y*settings.width+x+1,747796405)+2891336453)>>>0)||1;
    const sum=[0,0,0];
    for(let sample=0;sample<settings.samples;sample++) {
      const u=((x+random())/settings.width*2-1)*scale*aspect;
      const v=(1-(y+random())/settings.height*2)*scale;
      let direction=norm(add(forward,add(mul(right,u),mul(up,v)))),origin=scene.camera;
      const throughput=[1,1,1];
      for(let bounce=0;bounce<settings.bounces;bounce++) {
        const hit=hitScene(origin,direction,scene,1e10,geometry);
        if(!hit) {
          const environment=environmentRadiance(direction,scene);
          for(let c=0;c<3;c++) sum[c]+=throughput[c]*environment[c];
          break;
        }
        const n=hit.normal,mat=hit.material;
        // Emissive material contributes radiance when the path reaches it,
        // including indirect paths through reflected geometry.
        if(mat.emission)for(let c=0;c<3;c++)sum[c]+=throughput[c]*mat.emission[c];
        origin=add(add(origin,mul(direction,hit.distance)),mul(n,0.003));
        const light=norm(add(sunDirection,mul(unit(),0.075)));
        const cosine=Math.max(0,dot(n,light));
        if(cosine>0 && !hitScene(origin,light,scene,1e10,geometry)) for(let c=0;c<3;c++) sum[c]+=throughput[c]*mat.color[c]*(1-mat.metal)*scene.sun[c]*cosine*1.6;
        if(random()<mat.metal) direction=norm(add(reflect(direction,n),mul(unit(),mat.roughness)));
        else direction=norm(add(n,unit()));
        if(dot(direction,n)<=0) break;
        for(let c=0;c<3;c++) throughput[c]*=mat.color[c]*0.83;
      }
    }
    const offset=(py*tile.width+px)*4;
    for(let c=0;c<3;c++) pixels[offset+c]=Math.round(Math.pow(1-Math.exp(-sum[c]/settings.samples*scene.exposure),1/2.2)*255);
    pixels[offset+3]=255;
  }
  return pixels;
}
