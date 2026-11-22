struct Params {
  origin: vec4<f32>, right: vec4<f32>, up: vec4<f32>, forward: vec4<f32>,
  skyTop: vec4<f32>, skyBottom: vec4<f32>, ground: vec4<f32>, sun: vec4<f32>,
  settings: vec4<f32>, tile: vec4<u32>, misc: vec4<f32>, groundSurface: vec4<f32>,
  terrainSky: vec4<f32>, auroraColor: vec4<f32>, meshColorMetal: vec4<f32>, meshSurface: vec4<f32>
}
// surface.x is roughness; surface.yzw holds emission RGB.
struct Sphere { centerRadius: vec4<f32>, colorMetal: vec4<f32>, surface: vec4<f32> }
// Sizes are uploaded as half extents. Each box occupies four aligned vec4s.
struct Box { center: vec4<f32>, halfSize: vec4<f32>, colorMetal: vec4<f32>, surface: vec4<f32> }
struct Triangle { a:vec4<f32>, e1:vec4<f32>, e2:vec4<f32> }
struct MeshNode { lower:vec4<f32>, upper:vec4<f32>, links:vec4<u32> }
struct Hit { distance: f32, normal: vec3<f32>, color: vec3<f32>, metal: f32, roughness: f32, emission: vec3<f32>, found: bool }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage,read> spheres: array<Sphere>;
@group(0) @binding(2) var<storage,read_write> pixels: array<u32>;
@group(0) @binding(3) var<storage,read> boxes: array<Box>;
@group(0) @binding(4) var<storage,read> triangles: array<Triangle>;
@group(0) @binding(5) var<storage,read> meshNodes: array<MeshNode>;
var<private> seed: u32;
fn rand() -> f32 {
  seed=seed^(seed<<13u); seed=seed^(seed>>17u); seed=seed^(seed<<5u);
  return f32(seed)/4294967296.0;
}
fn randomUnit() -> vec3<f32> {
  let z=2.0*rand()-1.0;let a=rand()*6.28318530718;let r=sqrt(max(0.0,1.0-z*z));
  return vec3<f32>(r*cos(a),z,r*sin(a));
}
fn emptyHit() -> Hit {
  return Hit(1e10,vec3<f32>(0.0),vec3<f32>(0.0),0.0,0.5,vec3<f32>(0.0),false);
}
fn hitMeshBounds(origin:vec3<f32>,direction:vec3<f32>,node:MeshNode,maxDistance:f32) -> bool {
  var near=0.002;var far=maxDistance;
  for(var axis=0u;axis<3u;axis++) {
    if(abs(direction[axis])<0.00000001) {
      if(origin[axis]<node.lower[axis] || origin[axis]>node.upper[axis]) {return false;}
      continue;
    }
    let a=(node.lower[axis]-origin[axis])/direction[axis];let b=(node.upper[axis]-origin[axis])/direction[axis];
    near=max(near,min(a,b));far=min(far,max(a,b));if(far<near){return false;}
  }
  return true;
}
fn intersectMesh(origin:vec3<f32>,direction:vec3<f32>,maxDistance:f32) -> Hit {
  var h=emptyHit();h.distance=maxDistance;var index=0u;
  // Escape indices skip whole branches without a per-ray stack.
  while(index<u32(p.misc.w)) {
    let node=meshNodes[index];
    if(!hitMeshBounds(origin,direction,node,h.distance)){index=node.links.z;continue;}
    if(node.links.y==0u){index++;continue;}
    for(var i=node.links.x;i<node.links.x+node.links.y;i++) {
      let t=triangles[i];let determinantVector=cross(direction,t.e2.xyz);let det=dot(t.e1.xyz,determinantVector);
      if(abs(det)<0.00000001){continue;}
      let inv=1.0/det;let s=origin-t.a.xyz;let u=dot(s,determinantVector)*inv;
      if(u<0.0 || u>1.0){continue;}
      let q=cross(s,t.e1.xyz);let v=dot(direction,q)*inv;
      if(v<0.0 || u+v>1.0){continue;}
      let distance=dot(t.e2.xyz,q)*inv;
      if(distance<=0.002 || distance>=h.distance){continue;}
      var normal=normalize(cross(t.e1.xyz,t.e2.xyz));
      if(dot(normal,direction)>0.0){normal=-normal;}
      h=Hit(distance,normal,p.meshColorMetal.xyz,p.meshColorMetal.w,p.meshSurface.x,p.meshSurface.yzw,true);
    }
    index=node.links.z;
  }
  return h;
}
fn intersectBox(origin:vec3<f32>,direction:vec3<f32>,b:Box) -> Hit {
  var near=-1e10;var far=1e10;
  var nearNormal=vec3<f32>(0.0);var farNormal=vec3<f32>(0.0);
  let lower=b.center.xyz-b.halfSize.xyz;let upper=b.center.xyz+b.halfSize.xyz;
  for(var axis=0u;axis<3u;axis++) {
    if(abs(direction[axis])<0.00000001) {
      if(origin[axis]<lower[axis] || origin[axis]>upper[axis]) {return emptyHit();}
      continue;
    }
    let a=(lower[axis]-origin[axis])/direction[axis];
    let z=(upper[axis]-origin[axis])/direction[axis];
    let entry=min(a,z);let leave=max(a,z);
    var n=vec3<f32>(0.0);n[axis]=select(1.0,-1.0,direction[axis]>0.0);
    if(entry>near) {near=entry;nearNormal=n;}
    if(leave<far) {far=leave;farNormal=-n;}
    if(far<near) {return emptyHit();}
  }
  var t=near;var normal=nearNormal;
  if(t<=0.002) {t=far;normal=farNormal;}
  if(t<=0.002) {return emptyHit();}
  return Hit(t,normal,b.colorMetal.xyz,b.colorMetal.w,b.surface.x,b.surface.yzw,true);
}
fn terrainHeight(x:f32,z:f32) -> f32 {
  let height=p.terrainSky.x;let scale=p.terrainSky.y;
  let q=scale*x+0.7*sin(0.35*scale*z);
  let r=0.55*scale*z+0.25*scale*x;
  return -0.85+height*(0.5+0.3*sin(q)+0.2*sin(r));
}
fn terrainGradient(x:f32,z:f32) -> vec2<f32> {
  let height=p.terrainSky.x;let scale=p.terrainSky.y;
  let q=scale*x+0.7*sin(0.35*scale*z);
  let r=0.55*scale*z+0.25*scale*x;
  let dx=height*scale*(0.3*cos(q)+0.05*cos(r));
  let dz=height*scale*(0.0735*cos(q)*cos(0.35*scale*z)+0.11*cos(r));
  return vec2<f32>(dx,dz);
}
fn intersectTerrain(origin:vec3<f32>,direction:vec3<f32>,maxDistance:f32) -> Hit {
  let height=p.terrainSky.x;let scale=p.terrainSky.y;
  var t=0.002;var end=min(120.0,maxDistance);
  if(abs(direction.y)<0.00000001) {
    if(origin.y < -0.85 || origin.y > -0.85+height) {return emptyHit();}
  } else {
    let a=(-0.85-origin.y)/direction.y;let b=(-0.85+height-origin.y)/direction.y;
    t=max(t,min(a,b));end=min(end,max(a,b));
  }
  if(end<t) {return emptyHit();}
  // A directional curvature bound avoids tiny steps near tangent dune crests.
  // The positive root of the conservative quadratic bounds the next surface.
  let ax=abs(direction.x);let az=abs(direction.z);
  let qRate=ax+0.245*az;let rRate=0.25*ax+0.55*az;
  let curvature=height*scale*scale*(0.3*qRate*qRate+0.025725*az*az+0.2*rRate*rRate);
  for(var step=0u;step<96u;step++) {
    if(t>end) {break;}
    let point=origin+direction*t;let delta=point.y-terrainHeight(point.x,point.z);
    let gradient=terrainGradient(point.x,point.z);
    if(abs(delta)<0.002) {
      return Hit(t,normalize(vec3<f32>(-gradient.x,1.0,-gradient.y)),p.ground.xyz,p.groundSurface.x,p.groundSurface.y,vec3<f32>(0.0),true);
    }
    let gap=abs(delta);
    let rate=(direction.y-gradient.x*direction.x-gradient.y*direction.z)*select(1.0,-1.0,delta<0.0);
    var safeStep=0.0;
    if(curvature<0.00000001) {safeStep=gap/max(0.00000001,abs(rate));}
    else {
      let root=sqrt(rate*rate+2.0*curvature*gap);
      if(rate<0.0) {safeStep=2.0*gap/(root-rate);}
      else {safeStep=(rate+root)/curvature;}
    }
    t+=max(0.001,safeStep*0.9);
  }
  return emptyHit();
}
fn skyRadiance(direction:vec3<f32>) -> vec3<f32> {
  let blend=clamp(direction.y*0.5+0.5,0.0,1.0);
  var color=mix(p.skyBottom.xyz,p.skyTop.xyz,blend);
  if(direction.y<=0.0 || (p.terrainSky.z<=0.0 && p.terrainSky.w<=0.0)) {return color;}
  let az=atan2(direction.z,direction.x);let el=asin(clamp(direction.y,0.0,1.0));
  if(p.terrainSky.z>0.0) {
    let center=0.22+0.075*sin(2.0*az+0.7)+0.035*sin(5.0*az-1.4);
    let rise=el-center;
    let warp=az+0.12*sin(3.0*az)+0.035*sin(11.0*az);
    let phase=47.0*warp+6.0*sin(7.0*warp)+8.0*rise+4.0*sin(13.0*warp+5.0*rise);
    let strand=0.5+0.5*sin(phase);
    let filament=strand*strand*strand*(0.45+0.55*(0.5+0.5*sin(19.0*warp-4.0*rise)));
    let envelope=0.6+0.4*(0.5+0.5*sin(4.0*az+1.7*sin(2.0*az)));
    let primaryOffset=rise/0.035;
    let primary=envelope*(0.40*exp(-primaryOffset*primaryOffset)+0.32*filament*exp(-max(rise,0.0)/0.18)*smoothstep(-0.02,0.035,rise)*(1.0-smoothstep(0.35,0.55,rise)));
    let secondCenter=center+0.14+0.035*sin(3.0*az-1.2);
    let offset=(el-secondCenter)/0.055;
    let secondary=0.35*exp(-offset*offset)*(0.55+0.45*filament);
    color+=p.terrainSky.z*(p.auroraColor.xyz*primary+vec3<f32>(0.48,0.08,0.8)*secondary);
  }
  if(p.terrainSky.w>0.0) {
    let u=(az+3.141592653589793)*256.0;let v=el*256.0;
    var hash=u32(floor(u))*374761393u+u32(floor(v))*668265263u;
    hash=(hash^(hash>>13u))*1274126177u;hash=hash^(hash>>16u);
    if((hash&1023u)==0u) {
      let fx=fract(u)-0.5;let fy=fract(v)-0.5;
      let brightness=p.terrainSky.w*(0.6+f32((hash>>10u)&255u)/255.0*2.4)*exp(-(fx*fx+fy*fy)*48.0);
      color+=brightness*vec3<f32>(1.0,0.93,0.82);
    }
  }
  return color;
}
fn intersect(origin:vec3<f32>,direction:vec3<f32>) -> Hit {
  var h=emptyHit();
  if(p.terrainSky.x<=0.0 && abs(direction.y)>0.000001) {
    let t=(-0.85-origin.y)/direction.y;
    if(t>0.002) {h=Hit(t,vec3<f32>(0.0,1.0,0.0),p.ground.xyz,p.groundSurface.x,p.groundSurface.y,vec3<f32>(0.0),true);}
  }
  for(var i=0u;i<u32(p.misc.x);i++) {
    let s=spheres[i];let oc=origin-s.centerRadius.xyz;let b=dot(oc,direction);
    let discriminant=b*b-dot(oc,oc)+s.centerRadius.w*s.centerRadius.w;
    if(discriminant>=0.0) {
      var t=-b-sqrt(discriminant);if(t<0.002) {t=-b+sqrt(discriminant);}
      if(t>0.002 && t<h.distance) {
        h=Hit(t,normalize(origin+direction*t-s.centerRadius.xyz),s.colorMetal.xyz,s.colorMetal.w,s.surface.x,s.surface.yzw,true);
      }
    }
  }
  for(var i=0u;i<u32(p.groundSurface.w);i++) {
    let boxHit=intersectBox(origin,direction,boxes[i]);
    if(boxHit.found && boxHit.distance<h.distance) {h=boxHit;}
  }
  if(p.misc.w>0.0) {
    let meshHit=intersectMesh(origin,direction,h.distance);
    if(meshHit.found && meshHit.distance<h.distance){h=meshHit;}
  }
  if(p.terrainSky.x>0.0) {
    let terrainHit=intersectTerrain(origin,direction,h.distance);
    if(terrainHit.found && terrainHit.distance<h.distance) {h=terrainHit;}
  }
  return h;
}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) gid:vec3<u32>) {
  if(gid.x>=p.tile.z || gid.y>=p.tile.w) {return;}
  let x=p.tile.x+gid.x;let y=p.tile.y+gid.y;
  seed=(y*u32(p.settings.x)+x+1u)*747796405u+2891336453u;if(seed==0u) {seed=1u;}
  var sum=vec3<f32>(0.0);
  for(var sample=0u;sample<u32(p.settings.z);sample++) {
    let u=((f32(x)+rand())/p.settings.x*2.0-1.0)*p.misc.z*p.settings.x/p.settings.y;
    let v=(1.0-(f32(y)+rand())/p.settings.y*2.0)*p.misc.z;
    var direction=normalize(p.forward.xyz+p.right.xyz*u+p.up.xyz*v);
    var origin=p.origin.xyz;var throughput=vec3<f32>(1.0);
    for(var bounce=0u;bounce<u32(p.settings.w);bounce++) {
      let h=intersect(origin,direction);
      if(!h.found) {
        sum+=throughput*skyRadiance(direction);break;
      }
      sum+=throughput*h.emission;
      origin=origin+direction*h.distance+h.normal*0.003;
      let light=normalize(normalize(vec3<f32>(-0.6,0.9,0.4))+randomUnit()*0.075);
      let cosine=max(0.0,dot(h.normal,light));
      if(cosine>0.0 && !intersect(origin,light).found) {
        sum+=throughput*h.color*(1.0-h.metal)*p.sun.xyz*cosine*1.6;
      }
      if(rand()<h.metal) {direction=normalize(reflect(direction,h.normal)+randomUnit()*h.roughness);}
      else {direction=normalize(h.normal+randomUnit());}
      if(dot(direction,h.normal)<=0.0) {break;}
      throughput*=h.color*0.83;
    }
  }
  let mapped=pow(vec3<f32>(1.0)-exp(-sum/p.settings.z*p.misc.y),vec3<f32>(1.0/2.2));
  pixels[gid.y*p.tile.z+gid.x]=pack4x8unorm(vec4<f32>(mapped,1.0));
}
