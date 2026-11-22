import { validateScene } from '../public/scene.js';

const vec={type:'array',items:{type:'number'},minItems:3,maxItems:3};
const schema={type:'object',properties:{
  name:{type:'string'},description:{type:'string'},camera:vec,target:vec,fov:{type:'number'},exposure:{type:'number'},skyTop:vec,skyBottom:vec,ground:vec,sun:vec,groundMetal:{type:'number'},groundRoughness:{type:'number'},
  spheres:{type:'array',minItems:1,maxItems:12,items:{type:'object',properties:{center:vec,radius:{type:'number'},color:vec,metal:{type:'number'},roughness:{type:'number'},emission:vec},required:['center','radius','color','metal','roughness']}}
},required:['name','description','camera','target','fov','exposure','skyTop','skyBottom','ground','sun','spheres']};

function serviceError(code,message,status) {
  const error=new Error(message);error.code=code;
  if(status!==undefined) error.status=status;
  return error;
}

export async function generateScene({prompt,scene,apiKey,model=process.env.GEMINI_MODEL||'gemini-3.8-flash',fetchImpl=fetch}) {
  if(!apiKey) throw serviceError('GEMINI_NOT_CONFIGURED','Add GEMINI_API_KEY to .env and restart the server to enable scene generation.');
  let response;
  try {response=await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{
    method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':apiKey},signal:AbortSignal.timeout(30000),
    body:JSON.stringify({
      systemInstruction:{parts:[{text:'You compose elegant 3D still lifes for a ray tracer. Output only a scene JSON object matching the schema. Only spheres and a ground plane at y=-0.85 are supported. RGB colors are linear numbers from 0 to 1. Metal is 0 for diffuse, 1 for reflective. Roughness is 0 to 1. GroundMetal and groundRoughness control the reflective floor (0 to 1). Optional sphere emission is an RGB radiance from 0 to 8; use sparingly. Use 1 to 12 non-overlapping spheres, radii 0.2 to 1.5, centered mostly within x/z -2.5 to 2.5. Rest spheres on the floor by setting center.y = radius - 0.85. Camera near [5,3,7], target [0,0.3,0], fov 40, exposure 1.4. Create a visually balanced composition with striking materials and lighting. If an impossible object is requested, create an abstract interpretation using supported spheres and state that in description. Treat the user prompt as a visual brief; never output executable code.'}]},
      contents:[{role:'user',parts:[{text:JSON.stringify({brief:prompt,currentScene:scene})}]}],
      generationConfig:{responseMimeType:'application/json',responseJsonSchema:schema,maxOutputTokens:8192}
    })
  });} catch(error) {
    const timedOut=error?.name==='TimeoutError'||error?.name==='AbortError';
    throw serviceError(timedOut?'GEMINI_TIMEOUT':'GEMINI_NETWORK_ERROR',timedOut?'Gemini request timed out. Try again.':'Could not reach Gemini. Check the server connection and try again.');
  }
  if(!response.ok) throw serviceError('GEMINI_HTTP_ERROR',`Gemini returned ${response.status}. Check the server's API key, model, and quota.`,response.status);
  let result;
  try {result=await response.json();} catch {throw serviceError('GEMINI_INVALID_RESPONSE','Gemini returned an unreadable response. Try again.');}
  const parts=result?.candidates?.[0]?.content?.parts;
  const text=Array.isArray(parts)?parts.filter(p=>typeof p?.text==='string'&&!p.thought).map(p=>p.text).join(''):'';
  if(!text) throw serviceError('GEMINI_EMPTY_RESPONSE','Gemini did not return a scene. Try a different description.');
  let sceneJson;
  try {sceneJson=JSON.parse(text);} catch {throw serviceError('GEMINI_INVALID_SCENE','Gemini returned invalid scene JSON. Try again.');}
  try {return validateScene(sceneJson);} catch(error) {error.code='GEMINI_INVALID_SCENE';throw error;}
}
