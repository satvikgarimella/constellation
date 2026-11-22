// These analytic functions are mirrored in trace.wgsl. Keep constants, hash
// arithmetic, and intersection tolerances in sync with the GPU implementation.
export const TERRAIN_FLOOR=-0.85;
export const TERRAIN_FAR=120;
export const TERRAIN_STEPS=96;
const HIT_EPSILON=0.002;
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const smoothstep=(lo,hi,v)=>{const t=clamp((v-lo)/(hi-lo),0,1);return t*t*(3-2*t);};

export function terrainHeight(x,z,terrain) {
  const h=terrain?.height||0,s=terrain?.scale??0.3;
  if(h<=0) return TERRAIN_FLOOR;
  const q=s*x+0.7*Math.sin(0.35*s*z),r=0.55*s*z+0.25*s*x;
  return TERRAIN_FLOOR+h*(0.5+0.3*Math.sin(q)+0.2*Math.sin(r));
}

export function terrainGradient(x,z,terrain) {
  const h=terrain?.height||0,s=terrain?.scale??0.3;
  const q=s*x+0.7*Math.sin(0.35*s*z),r=0.55*s*z+0.25*s*x;
  return [h*s*(0.3*Math.cos(q)+0.05*Math.cos(r)),h*s*(0.0735*Math.cos(q)*Math.cos(0.35*s*z)+0.11*Math.cos(r))];
}

export function intersectTerrain(origin,direction,terrain,maxDistance=1e10) {
  const h=terrain?.height||0,s=terrain?.scale??0.3;
  if(h<=0) return null;
  let near=HIT_EPSILON,far=Math.min(TERRAIN_FAR,maxDistance);
  if(Math.abs(direction[1])<1e-8) {
    if(origin[1]<TERRAIN_FLOOR||origin[1]>TERRAIN_FLOOR+h) return null;
  } else {
    const a=(TERRAIN_FLOOR-origin[1])/direction[1],b=(TERRAIN_FLOOR+h-origin[1])/direction[1];
    near=Math.max(near,Math.min(a,b));far=Math.min(far,Math.max(a,b));
  }
  if(near>far) return null;
  // A global slope bound takes tiny steps past almost-tangent dune crests.
  // Bound the directional second derivative instead. The quadratic lower
  // bound g + rate*t - curvature*t²/2 stays positive before its positive
  // root, so a 90% step reaches the next possible surface conservatively.
  const ax=Math.abs(direction[0]),az=Math.abs(direction[2]);
  const qRate=ax+0.245*az,rRate=0.25*ax+0.55*az;
  const curvature=h*s*s*(0.3*qRate*qRate+0.025725*az*az+0.2*rRate*rRate);
  let distance=near;
  for(let step=0;step<TERRAIN_STEPS&&distance<=far;step++) {
    const x=origin[0]+direction[0]*distance,y=origin[1]+direction[1]*distance,z=origin[2]+direction[2]*distance;
    const delta=y-terrainHeight(x,z,terrain);
    const [dx,dz]=terrainGradient(x,z,terrain);
    if(Math.abs(delta)<HIT_EPSILON) {
      const inverseLength=1/Math.hypot(dx,1,dz);
      return {distance,normal:[-dx*inverseLength,inverseLength,-dz*inverseLength]};
    }
    const gap=Math.abs(delta),rate=(direction[1]-dx*direction[0]-dz*direction[2])*(delta<0?-1:1);
    let safeStep;
    if(curvature<1e-8) safeStep=gap/Math.max(1e-8,Math.abs(rate));
    else {
      const root=Math.sqrt(rate*rate+2*curvature*gap);
      // Use equivalent forms on each side of zero to avoid cancellation.
      safeStep=rate<0?2*gap/(root-rate):(rate+root)/curvature;
    }
    distance+=Math.max(0.001,safeStep*0.9);
  }
  return null;
}

export function intersectBox(origin,direction,box,maxDistance=1e10) {
  let near=-1e10,far=1e10,nearAxis=0,farAxis=0,nearSign=-1,farSign=1;
  for(let axis=0;axis<3;axis++) {
    const lo=box.center[axis]-box.size[axis]*0.5,hi=box.center[axis]+box.size[axis]*0.5,d=direction[axis];
    if(Math.abs(d)<1e-8) {
      if(origin[axis]<lo||origin[axis]>hi) return null;
      continue;
    }
    const a=(lo-origin[axis])/d,b=(hi-origin[axis])/d,entry=Math.min(a,b),exit=Math.max(a,b),sign=d>0?-1:1;
    // Strict comparisons choose the first axis for an exact edge/corner tie.
    if(entry>near) {near=entry;nearAxis=axis;nearSign=sign;}
    if(exit<far) {far=exit;farAxis=axis;farSign=-sign;}
    if(far<near) return null;
  }
  const outside=near>HIT_EPSILON,distance=outside?near:far;
  if(distance<=HIT_EPSILON||distance>=maxDistance) return null;
  const normal=[0,0,0];normal[outside?nearAxis:farAxis]=outside?nearSign:farSign;
  return {distance,normal};
}

export function environmentRadiance(direction,scene) {
  const t=clamp(direction[1]*0.5+0.5,0,1);
  const radiance=[0,1,2].map(c=>scene.skyBottom[c]*(1-t)+scene.skyTop[c]*t);
  const strength=scene.aurora?.strength||0,stars=scene.stars||0;
  if(direction[1]<=0||(!strength&&!stars)) return radiance;
  const az=Math.atan2(direction[2],direction[0]),el=Math.asin(clamp(direction[1],0,1));
  if(strength>0) {
    const color=scene.aurora?.color||[0.1,0.9,0.65];
    const center=0.22+0.075*Math.sin(2*az+0.7)+0.035*Math.sin(5*az-1.4),rise=el-center;
    // Warp the strand positions and tilt them with elevation so the curtain
    // has uneven folds rather than repeating vertical stripes.
    const warp=az+0.12*Math.sin(3*az)+0.035*Math.sin(11*az);
    const phase=47*warp+6*Math.sin(7*warp)+8*rise+4*Math.sin(13*warp+5*rise);
    const strand=0.5+0.5*Math.sin(phase);
    const filament=strand*strand*strand*(0.45+0.55*(0.5+0.5*Math.sin(19*warp-4*rise)));
    const envelope=0.6+0.4*(0.5+0.5*Math.sin(4*az+1.7*Math.sin(2*az)));
    const primaryOffset=rise/0.035;
    const primary=envelope*(0.40*Math.exp(-primaryOffset*primaryOffset)+0.32*filament*Math.exp(-Math.max(rise,0)/0.18)*smoothstep(-0.02,0.035,rise)*(1-smoothstep(0.35,0.55,rise)));
    const secondCenter=center+0.14+0.035*Math.sin(3*az-1.2),secondaryOffset=(el-secondCenter)/0.055;
    const secondary=0.35*Math.exp(-secondaryOffset*secondaryOffset)*(0.55+0.45*filament),violet=[0.48,0.08,0.8];
    for(let c=0;c<3;c++) radiance[c]+=strength*(color[c]*primary+violet[c]*secondary);
  }
  if(stars>0) {
    const u=(az+Math.PI)*256,v=el*256,ix=Math.floor(u),iy=Math.floor(v);
    let hash=(Math.imul(ix,374761393)+Math.imul(iy,668265263))>>>0;
    hash=Math.imul(hash^(hash>>>13),1274126177)>>>0;
    hash=(hash^(hash>>>16))>>>0;
    if((hash&1023)===0) {
      const x=u-ix-0.5,y=v-iy-0.5;
      const brightness=stars*(0.6+((hash>>>10)&255)/255*2.4)*Math.exp(-(x*x+y*y)*48);
      radiance[0]+=brightness;radiance[1]+=brightness*0.93;radiance[2]+=brightness*0.82;
    }
  }
  return radiance;
}
