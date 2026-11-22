struct Params {
  origin: vec4<f32>, right: vec4<f32>, up: vec4<f32>, forward: vec4<f32>,
  skyTop: vec4<f32>, skyBottom: vec4<f32>, ground: vec4<f32>, sun: vec4<f32>,
  settings: vec4<f32>, tile: vec4<u32>, misc: vec4<f32>
}
struct Sphere { centerRadius: vec4<f32>, colorMetal: vec4<f32>, surface: vec4<f32> }
struct Hit { distance: f32, normal: vec3<f32>, color: vec3<f32>, metal: f32, roughness: f32, found: bool }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage,read> spheres: array<Sphere>;
@group(0) @binding(2) var<storage,read_write> pixels: array<u32>;
var<private> seed: u32;
fn rand() -> f32 {
  seed=seed^(seed<<13u); seed=seed^(seed>>17u); seed=seed^(seed<<5u);
  return f32(seed)/4294967296.0;
}
fn randomUnit() -> vec3<f32> {
  let z=2.0*rand()-1.0;let a=rand()*6.28318530718;let r=sqrt(max(0.0,1.0-z*z));
  return vec3<f32>(r*cos(a),z,r*sin(a));
}
fn intersect(origin:vec3<f32>,direction:vec3<f32>) -> Hit {
  var h=Hit(1e10,vec3<f32>(0.0),vec3<f32>(0.0),0.0,0.5,false);
  if(abs(direction.y)>0.000001) {
    let t=(-0.85-origin.y)/direction.y;
    if(t>0.002) {h=Hit(t,vec3<f32>(0.0,1.0,0.0),p.ground.xyz,0.0,0.5,true);}
  }
  for(var i=0u;i<u32(p.misc.x);i++) {
    let s=spheres[i];let oc=origin-s.centerRadius.xyz;let b=dot(oc,direction);
    let discriminant=b*b-dot(oc,oc)+s.centerRadius.w*s.centerRadius.w;
    if(discriminant>=0.0) {
      var t=-b-sqrt(discriminant);if(t<0.002) {t=-b+sqrt(discriminant);}
      if(t>0.002 && t<h.distance) {
        h=Hit(t,normalize(origin+direction*t-s.centerRadius.xyz),s.colorMetal.xyz,s.colorMetal.w,s.surface.x,true);
      }
    }
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
        let t=clamp(direction.y*0.5+0.5,0.0,1.0);
        sum+=throughput*mix(p.skyBottom.xyz,p.skyTop.xyz,t);break;
      }
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
