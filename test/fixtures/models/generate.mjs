// Original deterministic validation geometry, dedicated to the public domain
// under CC0-1.0. Re-run this file to reproduce the STL and OBJ fixtures.
import {writeFile} from 'node:fs/promises';
const root=new URL('./',import.meta.url);
const triangles=[];
const point=(r,y,a)=>[r*Math.cos(a),y,r*Math.sin(a)];
const add=(a,b,c)=>triangles.push(...a,...b,...c);
const gearN=80;
const outer=i=>[1.55,1.85,1.85,1.55][i%4];
for(let i=0;i<gearN;i++){
  const a=i/gearN*2*Math.PI,b=(i+1)/gearN*2*Math.PI;
  const ob=point(outer(i),-.3,a),on=point(outer((i+1)%gearN),-.3,b);
  const ot=point(outer(i),.3,a),ont=point(outer((i+1)%gearN),.3,b);
  const ib=point(.62,-.3,a),inb=point(.62,-.3,b),it=point(.62,.3,a),int=point(.62,.3,b);
  for(const [x,y,z,w]of [[ob,on,ont,ot],[ib,it,int,inb],[ot,ont,int,it],[ob,ib,inb,on]]){add(x,y,z);add(x,z,w);}
}
const gear=new ArrayBuffer(84+triangles.length/9*50),view=new DataView(gear);
new Uint8Array(gear,0,80).set(new TextEncoder().encode('Constellation original hollow gear; CC0-1.0'));
view.setUint32(80,triangles.length/9,true);
for(let i=0;i<triangles.length/9;i++)for(let n=0;n<9;n++)view.setFloat32(84+i*50+12+n*4,triangles[i*9+n],true);
await writeFile(new URL('hollow-gear.stl',root),Buffer.from(gear));
const vertices=[],faces=[],segments=48;
const profile=[[0,.65],[.25,.7],[.65,1.05],[1.1,1.3],[1.55,1.2],[2,.8],[2.45,.5],[2.8,.58],[3.1,.8]];
function ring(r,y){const ids=[];for(let i=0;i<segments;i++){ids.push(vertices.length+1);vertices.push(point(r,y,i/segments*2*Math.PI));}return ids;}
const outside=profile.map(([y,r])=>ring(r,y));
const inside=profile.map(([y,r],i)=>ring(r-.16,i===0?.16:y));
function quad(a,b,c,d){faces.push([a,b,c],[a,c,d]);}
for(let j=0;j<profile.length-1;j++)for(let i=0;i<segments;i++){const n=(i+1)%segments;quad(outside[j][i],outside[j][n],outside[j+1][n],outside[j+1][i]);quad(inside[j][i],inside[j+1][i],inside[j+1][n],inside[j][n]);}
for(let i=0;i<segments;i++){const n=(i+1)%segments,j=profile.length-1;quad(outside[j][i],outside[j][n],inside[j][n],inside[j][i]);}
const bottom=vertices.length+1;vertices.push([0,0,0]);const innerBottom=vertices.length+1;vertices.push([0,.16,0]);
for(let i=0;i<segments;i++){const n=(i+1)%segments;faces.push([bottom,outside[0][n],outside[0][i]],[innerBottom,inside[0][i],inside[0][n]]);}
const obj=['# Constellation original hollow lathed vase. CC0-1.0.','# Triangulated OBJ; smooth shape is represented by flat-shaded facets.',...vertices.map(v=>'v '+v.map(x=>x.toFixed(8)).join(' ')),...faces.map(v=>'f '+v.join(' '))].join('\n')+'\n';
await writeFile(new URL('hollow-vase.obj',root),obj);
console.log(JSON.stringify({gearTriangles:triangles.length/9,vaseTriangles:faces.length}));
