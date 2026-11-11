// Mate solver: turns each step's mate into transforms. No positions appear in the plan.
// Handles subassemblies: parts joined in earlier steps move together as one group.
import * as THREE from 'three';

const V = a => new THREE.Vector3(...a);
const ref = s => { const i = s.indexOf('.'); return { label: s.slice(0, i), anchor: s.slice(i + 1) }; };

function worldAnchor(anchor, matrix) {
  const tr = v => v && V(v).transformDirection(matrix);
  return {
    o: V(anchor.o).applyMatrix4(matrix), n: tr(anchor.n), up: tr(anchor.up),
    depth: anchor.depth, r: anchor.r,
    face: anchor.face && { u: tr(anchor.face.u), v: tr(anchor.face.v), size: anchor.face.size },
  };
}

// Place `thisA` (local to the moving part) onto `other` (world): normals opposite, origins together,
// `up` vectors lined up when both are given.
function mateMatrix(thisA, other) {
  const target = other.n.clone().negate();
  const q = new THREE.Quaternion().setFromUnitVectors(V(thisA.n).normalize(), target);
  if (thisA.up && other.up) {
    const proj = v => v.clone().sub(target.clone().multiplyScalar(v.dot(target))).normalize();
    q.premultiply(new THREE.Quaternion().setFromUnitVectors(proj(V(thisA.up).applyQuaternion(q)), proj(other.up)));
  }
  const pos = other.o.clone().sub(V(thisA.o).applyQuaternion(q));
  if (thisA.embed && other.depth == null) pos.add(target.clone().multiplyScalar(thisA.embed));  // screw sinks into a face
  return new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1));
}

// Spread several fasteners over one face in a small grid
function spread(target, k, n) {
  if (!target.face || n <= 1) return target;
  const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
  const c = k % cols, r = Math.floor(k / cols);
  const du = (cols === 1 ? 0 : (c / (cols - 1) - 0.5)) * target.face.size[0] * 0.5;
  const dv = (rows === 1 ? 0 : (r / (rows - 1) - 0.5)) * target.face.size[1] * 0.5;
  const off = target.face.u.clone().multiplyScalar(du).add(target.face.v.clone().multiplyScalar(dv));
  // Parts with an "outward" direction (armrests) face away from the centre of the face they share
  const up = target.up ?? (off.lengthSq() > 1 ? off.clone().normalize() : null);
  return { ...target, o: target.o.clone().add(off), up };
}

// parts: { [label]: { anchors, count, box: Box3, extent } }
export function solve(plan, parts) {
  const world = new Map();          // key -> current Matrix4
  const groupOf = new Map();        // key -> Set of keys moving together
  const key = (label, i) => `${label}#${i}`;
  const steps = [];

  const placedBounds = () => {
    const b = new THREE.Box3();
    for (const [k, m] of world) b.union(parts[k.split('#')[0]].box.clone().applyMatrix4(m));
    return b;
  };
  const placeRoot = (k, places) => {
    const label = k.split('#')[0];
    const box = parts[label].box;
    const m = new THREE.Matrix4();
    if (world.size) {
      const b = placedBounds();
      m.makeTranslation(b.max.x + 150 - box.min.x, -box.min.y, 0);   // new subassembly beside the others
    }
    world.set(k, m);
    groupOf.set(k, new Set([k]));
    places.push(k);
  };
  const merge = (a, b) => {
    const ga = groupOf.get(a), gb = groupOf.get(b);
    if (ga === gb) return;
    for (const k of gb) { ga.add(k); groupOf.set(k, ga); }
  };

  for (const step of plan.steps) {
    const info = { step, places: [], moves: [], before: new Map([...world].map(([k, m]) => [k, m.clone()])), skipped: null };
    if (step.invalid) { info.skipped = 'flagged by the validator'; info.after = info.before; steps.push(info); continue; }

    const me = ref(step.mate.this), other = ref(step.mate.other);
    const mv = step.moves.find(m => m.part === me.label) ?? step.moves[0];
    const P = parts[me.label], O = parts[other.label];
    if (!P || !O || !mv) { info.skipped = 'unknown part'; info.after = info.before; steps.push(info); continue; }
    const thisA = P.anchors[me.anchor];
    if (!thisA) { info.skipped = `no anchor ${step.mate.this}`; info.after = info.before; steps.push(info); continue; }

    const instances = mv.instances.length ? mv.instances : [0];
    // "arm_mount[i]" with more copies than mounts (6 screws, 2 armrests): share them out, 3 per mount
    const indexed = other.anchor.endsWith('[i]');
    const base = other.anchor.slice(0, -3);
    const slots = indexed ? Object.keys(O.anchors).filter(n => n.startsWith(base + '[') && n !== other.anchor).length : 1;
    const perSlot = Math.ceil(instances.length / Math.max(1, slots));

    instances.forEach((i, unit) => {
      const slot = indexed ? (slots >= instances.length ? i : Math.floor(unit / perSlot)) : 0;
      const anchorName = indexed ? `${base}[${slot}]` : other.anchor;
      const j = O.count > 1 ? Math.min(i, O.count - 1) : 0;
      const otherKey = key(other.label, j);
      const oa = O.anchors[anchorName];
      if (!oa) { info.skipped = `no anchor ${other.label}.${anchorName}`; return; }
      if (!world.has(otherKey)) placeRoot(otherKey, info.places);

      const shared = indexed ? (slots >= instances.length ? 1 : perSlot) : instances.length;
      const target = spread(worldAnchor(oa, world.get(otherKey)), indexed ? unit % perSlot : unit, shared);
      const M = mateMatrix(thisA, target);
      const dist = THREE.MathUtils.clamp(step.mate.type === 'pin_in_hole' ? (target.depth ?? thisA.embed ?? 40) * 1.5 : P.extent * 0.6, 60, 220);
      const lift = new THREE.Matrix4().makeTranslation(target.n.clone().multiplyScalar(dist));
      const meKey = key(me.label, i);

      if (!world.has(meKey)) {
        world.set(meKey, M);
        groupOf.set(meKey, new Set([meKey]));
        info.moves.push({ key: meKey, unit, from: null, start: M.clone().premultiply(lift), final: M, target, fit: step.mate.fit, marker: true });
      } else if (groupOf.get(meKey) !== groupOf.get(otherKey)) {
        const D = M.clone().multiply(world.get(meKey).clone().invert());   // move the whole subassembly
        for (const k of groupOf.get(meKey)) {
          const from = world.get(k).clone(), fin = from.clone().premultiply(D);
          info.moves.push({ key: k, unit, from, start: fin.clone().premultiply(lift), final: fin, target, fit: step.mate.fit, marker: k === meKey });
          world.set(k, fin);
        }
      } else {
        info.skipped = `${me.label} is already attached to ${other.label}`;
        return;
      }
      merge(otherKey, meKey);
      info.focus = [...groupOf.get(meKey)];   // the subassembly this step works on, for the camera
    });
    info.after = new Map([...world].map(([k, m]) => [k, m.clone()]));
    steps.push(info);
  }
  return steps;
}
