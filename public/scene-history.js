import { validateScene } from './scene.js';

// Validated scenes are immutable snapshots. Reuse equal subtrees (especially an
// imported mesh's triangles) rather than retaining a copy on every light edit.
function shareAndFreeze(previous,next) {
  if(next===null||typeof next!=='object')return next;
  const array=Array.isArray(next);
  const compatible=previous!==null&&typeof previous==='object'&&Array.isArray(previous)===array;
  const keys=Object.keys(next);
  let same=compatible&&Object.keys(previous).length===keys.length;
  for(const key of keys) {
    next[key]=shareAndFreeze(compatible?previous[key]:undefined,next[key]);
    if(!compatible||next[key]!==previous[key])same=false;
  }
  return same?previous:Object.freeze(next);
}

/** A bounded, immutable undo/redo history. Record only accepted server scenes. */
export function createSceneHistory({limit=20}={}) {
  if(!Number.isInteger(limit)||limit<2||limit>100)throw new Error('Scene history limit must be between 2 and 100.');
  let snapshots=[],cursor=-1;
  return {
    get current(){return snapshots[cursor]??null;},
    get canUndo(){return cursor>0;},
    get canRedo(){return cursor>=0&&cursor<snapshots.length-1;},
    get size(){return snapshots.length;},
    get index(){return cursor;},
    record(scene) {
      const snapshot=shareAndFreeze(snapshots[cursor],validateScene(scene));
      if(snapshot===snapshots[cursor])return snapshot;
      snapshots=snapshots.slice(0,cursor+1);
      snapshots.push(snapshot);
      if(snapshots.length>limit)snapshots.shift();
      cursor=snapshots.length-1;
      return snapshot;
    },
    undo(){return cursor>0?snapshots[--cursor]:null;},
    redo(){return cursor>=0&&cursor<snapshots.length-1?snapshots[++cursor]:null;},
    clear(){snapshots=[];cursor=-1;}
  };
}
