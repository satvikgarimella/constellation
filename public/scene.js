export const TILE_SIZE = 32;
export const MAX_SPHERES = 64;

// Two non-intersecting orbital paths around a floating chrome core. Each bead
// is real geometry: it casts shadows and appears in other objects' reflections.
const orbitSpheres = [
  { center:[0,1.35,0],radius:1.20,color:[0.91,0.96,1],metal:0.98,roughness:0.025 },
  ...Array.from({length:28},(_,i)=>{
    const a=i/28*Math.PI*2;
    return {center:[2.05*Math.cos(a),1.35+1.67*Math.sin(a),1.18*Math.sin(a)],radius:0.15,
      color:[0.98,0.22+0.13*(Math.sin(a)*0.5+0.5),0.045],metal:0.55,roughness:0.055,
      emission:i%7===0?[1.2,0.18,0.015]:[0.22,0.035,0.004]};
  }),
  ...Array.from({length:22},(_,i)=>{
    const a=(i+0.5)/22*Math.PI*2;
    return {center:[2.65*Math.sin(a),1.35+1.45*Math.cos(a),-2.22*Math.cos(a)],radius:0.12,
      color:[0.075,0.64,0.94],metal:0.72,roughness:0.045,
      emission:i%11===0?[0.025,0.35,1.1]:[0.004,0.07,0.20]};
  }),
  {center:[-2.5,-0.50,1.6],radius:0.35,color:[0.99,0.28,0.07],metal:0.5,roughness:0.07},
  {center:[2.1,-0.37,1.45],radius:0.48,color:[0.10,0.49,0.64],metal:0.91,roughness:0.04},
  {center:[0.15,-0.60,2.55],radius:0.25,color:[0.91,0.86,0.66],metal:0.92,roughness:0.025}
];
export const PRESETS = {
  orbit: {
    name:'Orbit',description:'A chrome core. Fifty orbiting beads. Every reflection traced by your devices.',
    camera:[5.8,3.75,8.6],target:[0,1.15,0],fov:36,
    skyTop:[0.025,0.075,0.20],skyBottom:[0.74,0.83,0.94],
    ground:[0.07,0.10,0.16],groundMetal:0.70,groundRoughness:0.10,
    sun:[1,0.81,0.58],exposure:1.5,spheres:orbitSpheres
  },
  solstice: {
    name: 'Solstice', description: 'Warm light. Cool metal. Shared computation.',
    camera: [5, 3.1, 7.2], target: [0, 0.45, 0], fov: 39,
    skyTop: [0.36, 0.55, 0.82], skyBottom: [0.94, 0.88, 0.76],
    ground: [0.64, 0.58, 0.49], sun: [1, 0.87, 0.67], exposure: 1.35,
    spheres: [
      { center: [-1.38, 0.25, 0], radius: 1.1, color: [0.93, 0.29, 0.08], metal: 0.05, roughness: 0.2 },
      { center: [0.95, 0.55, -0.7], radius: 1.4, color: [0.3, 0.57, 0.85], metal: 0.94, roughness: 0.075 },
      { center: [0.25, -0.31, 1.45], radius: 0.54, color: [0.96, 0.77, 0.32], metal: 0.8, roughness: 0.15 },
      { center: [-2.25, -0.48, 1.6], radius: 0.37, color: [0.26, 0.49, 0.38], metal: 0.1, roughness: 0.35 }
    ]
  },
  lunar: {
    name: 'Lunar', description: 'Silver forms in an otherworldly blue hour.',
    camera: [4.6, 3.2, 7], target: [0, 0.2, 0], fov: 41,
    skyTop: [0.04, 0.08, 0.2], skyBottom: [0.51, 0.63, 0.83],
    ground: [0.24, 0.28, 0.35], sun: [0.7, 0.83, 1], exposure: 1.9,
    spheres: [
      { center: [0, 0.55, 0], radius: 1.4, color: [0.86, 0.89, 0.95], metal: 0.98, roughness: 0.04 },
      { center: [-1.9, -0.12, 0.6], radius: 0.73, color: [0.19, 0.3, 0.72], metal: 0.15, roughness: 0.3 },
      { center: [1.7, -0.35, 1.3], radius: 0.5, color: [0.85, 0.34, 0.15], metal: 0.7, roughness: 0.12 },
      { center: [1.45, -0.55, -1.8], radius: 0.3, color: [0.6, 0.74, 0.9], metal: 0.9, roughness: 0.2 }
    ]
  },
  orchard: {
    name: 'Orchard', description: 'Soft pigments and sunlight, traced one ray at a time.',
    camera: [4, 3.8, 7.4], target: [0, 0.2, 0], fov: 40,
    skyTop: [0.55, 0.77, 0.73], skyBottom: [1, 0.92, 0.73],
    ground: [0.72, 0.73, 0.55], sun: [1, 0.95, 0.8], exposure: 1.3,
    spheres: [
      { center: [-1.25, 0.25, -0.3], radius: 1.1, color: [0.24, 0.51, 0.28], metal: 0, roughness: 0.4 },
      { center: [1.2, 0.05, -0.8], radius: 0.9, color: [0.96, 0.53, 0.14], metal: 0, roughness: 0.5 },
      { center: [0.5, -0.15, 1.3], radius: 0.7, color: [0.78, 0.18, 0.2], metal: 0.1, roughness: 0.3 },
      { center: [-1.5, -0.53, 1.5], radius: 0.32, color: [0.9, 0.83, 0.4], metal: 0.85, roughness: 0.08 }
    ]
  }
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const finite = (v, fallback, lo, hi) => typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
const vec = (v, fallback, lo, hi) => Array.from({ length: 3 }, (_, i) => finite(v?.[i], fallback[i], lo, hi));

export function validateScene(input) {
  const base = PRESETS.solstice;
  if (!input || !Array.isArray(input.spheres) || input.spheres.length < 1 || input.spheres.length > MAX_SPHERES) throw new Error(`A scene needs between 1 and ${MAX_SPHERES} spheres.`);
  const camera = vec(input.camera, base.camera, -15, 15);
  const target = vec(input.target, base.target, -10, 10);
  if (Math.hypot(...camera.map((v, i) => v - target[i])) < 0.1 || Math.hypot(camera[0] - target[0], camera[2] - target[2]) < 0.1) throw new Error('Camera must look toward the scene from an angle.');
  return {
    name: String(input.name || 'Custom scene').slice(0, 60),
    description: String(input.description || 'Your scene, rendered together.').slice(0, 160),
    camera, target, fov: finite(input.fov, 39, 20, 75), exposure: finite(input.exposure, 1.35, 0.4, 3),
    skyTop: vec(input.skyTop, base.skyTop, 0, 1), skyBottom: vec(input.skyBottom, base.skyBottom, 0, 1),
    ground: vec(input.ground, base.ground, 0.01, 1), sun: vec(input.sun, base.sun, 0, 1),
    groundMetal:finite(input.groundMetal,0,0,1),groundRoughness:finite(input.groundRoughness,0.5,0,1),
    spheres: input.spheres.map(s => {
      if(!s||typeof s!=='object') throw new Error('Every sphere must describe a material and position.');
      const radius = finite(s.radius, 0.7, 0.1, 3);
      const center = vec(s.center, [0, 0, 0], -6, 6);
      center[1] = Math.max(center[1], radius - 0.85);
      return { center, radius, color: vec(s.color, [0.6, 0.6, 0.6], 0.01, 1), metal: finite(s.metal, 0, 0, 1), roughness: finite(s.roughness, 0.1, 0, 1),emission:vec(s.emission,[0,0,0],0,8) };
    })
  };
}

export function createTiles(width, height, tileSize = TILE_SIZE) {
  const tiles = [];
  for (let y = 0; y < height; y += tileSize) for (let x = 0; x < width; x += tileSize) {
    tiles.push({ id: tiles.length, x, y, width: Math.min(tileSize, width - x), height: Math.min(tileSize, height - y) });
  }
  return tiles;
}

export function packResult(job, pixels, durationMs) {
  const out = new ArrayBuffer(16 + pixels.byteLength);
  const header = new DataView(out);
  header.setUint32(0, job.runId, true);
  header.setUint32(4, job.id, true);
  header.setUint32(8, job.lease, true);
  header.setFloat32(12, durationMs, true);
  new Uint8Array(out, 16).set(new Uint8Array(pixels.buffer || pixels, pixels.byteOffset || 0, pixels.byteLength));
  return out;
}
