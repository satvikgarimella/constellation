// Authored for this repository: a one-unit solid cube in STEP AP214 syntax.
// No third-party model data is included.
export function cubeSTEP() {
  const records=[];
  const add=value=>{records.push(`#${records.length+1}=${value};`);return `#${records.length}`;};
  const application=add("APPLICATION_CONTEXT('automotive design')");
  add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${application})`);
  const productContext=add(`PRODUCT_CONTEXT('',${application},'mechanical')`);
  const product=add(`PRODUCT('cube','Constellation test cube','',(${productContext}))`);
  add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part','',(${product}))`);
  const formation=add(`PRODUCT_DEFINITION_FORMATION('','',${product})`);
  const definitionContext=add(`PRODUCT_DEFINITION_CONTEXT('part definition',${application},'design')`);
  const definition=add(`PRODUCT_DEFINITION('design','',${formation},${definitionContext})`);
  const shape=add(`PRODUCT_DEFINITION_SHAPE('','',${definition})`);
  const length=add('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
  const angle=add('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))');
  const solidAngle=add('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())');
  const uncertainty=add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-7),${length},'distance_accuracy_value','')`);
  const context=add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${uncertainty}))GLOBAL_UNIT_ASSIGNED_CONTEXT((${length},${angle},${solidAngle}))REPRESENTATION_CONTEXT('','3D'))`);
  const coordinates=[[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
  const triple=values=>values.map(value=>value.toFixed(1)).join(',');
  const points=coordinates.map(point=>add(`CARTESIAN_POINT('',(${triple(point)}))`));
  const vertices=points.map(point=>add(`VERTEX_POINT('',${point})`));
  const edges=new Map();
  const subtract=(a,b)=>a.map((value,i)=>value-b[i]);
  const direction=value=>add(`DIRECTION('',(${triple(value)}))`);
  const faces=[[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]].map(indices=>{
    const oriented=[];
    for(let i=0;i<4;i++) {
      const a=indices[i],b=indices[(i+1)%4],key=[a,b].sort().join(',');
      if(!edges.has(key)) {
        const vector=add(`VECTOR('',${direction(subtract(coordinates[b],coordinates[a]))},1.0)`);
        const line=add(`LINE('',${points[a]},${vector})`);
        edges.set(key,{a,b,ref:add(`EDGE_CURVE('',${vertices[a]},${vertices[b]},${line},.T.)`)});
      }
      const edge=edges.get(key);
      oriented.push(add(`ORIENTED_EDGE('',*,*,${edge.ref},${edge.a===a?'.T.':'.F.'})`));
    }
    const loop=add(`EDGE_LOOP('',(${oriented.join(',')}))`);
    const bound=add(`FACE_OUTER_BOUND('',${loop},.T.)`);
    const u=subtract(coordinates[indices[1]],coordinates[indices[0]]),v=subtract(coordinates[indices[2]],coordinates[indices[1]]);
    const normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    const placement=add(`AXIS2_PLACEMENT_3D('',${points[indices[0]]},${direction(normal)},${direction(u)})`);
    const plane=add(`PLANE('',${placement})`);
    return add(`ADVANCED_FACE('',(${bound}),${plane},.T.)`);
  });
  const shell=add(`CLOSED_SHELL('',(${faces.join(',')}))`);
  const brep=add(`MANIFOLD_SOLID_BREP('Cube',${shell})`);
  const representation=add(`ADVANCED_BREP_SHAPE_REPRESENTATION('Cube',(${brep}),${context})`);
  add(`SHAPE_DEFINITION_REPRESENTATION(${shape},${representation})`);
  return `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('Constellation authored test cube'),'2;1');\nFILE_NAME('cube.step','2026-01-01T00:00:00',('Constellation'),(''),'Constellation fixture','Constellation','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n${records.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
}
