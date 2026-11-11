// Mate solver: turns each step's mate into a transform for every moving instance.
// No positions appear in the plan; they all come from anchors.
import * as THREE from 'three';

const V = a => new THREE.Vector3(...a);

function worldAnchor(anchor, matrix) {
  const o = V(anchor.o).applyMatrix4(matrix);
  const n = V(anchor.n).transformDirection(matrix);
  const up = anchor.up ? V(anchor.up).transformDirection(matrix) : null;
  return { o, n, up, depth: anchor.depth, r: anchor.r };
}

// Place `thisA` (local to the moving part) onto `other` (world frame):
// normals opposite, origins coincident, and `up` vectors lined up when both are given.
function mateMatrix(thisA, other) {
  const target = other.n.clone().negate();
  const q = new THREE.Quaternion().setFromUnitVectors(V(thisA.n).normalize(), target);
  if (thisA.up && other.up) {
    const proj = v => v.clone().sub(target.clone().multiplyScalar(v.dot(target))).normalize();
    const u1 = proj(V(thisA.up).applyQuaternion(q)), u2 = proj(other.up);
    q.premultiply(new THREE.Quaternion().setFromUnitVectors(u1, u2));
  }
  const pos = other.o.clone().sub(V(thisA.o).applyQuaternion(q));
  return new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1));
}

const ref = s => { const [label, anchor] = s.split('.'); return { label, anchor }; };

// parts: { [label]: { anchors, count, extent } }
// returns: { final: Map(key -> Matrix4), moves: [[{ key, final, start, target }]] } per step
export function solve(plan, parts) {
  const final = new Map();
  const steps = [];
  const key = (label, i) => `${label}#${i}`;

  for (const step of plan.steps) {
    const info = { places: step.places ?? null, moves: [] };
    if (step.places) final.set(key(step.places, 0), new THREE.Matrix4());   // root sits at the origin

    const m = step.mate, me = ref(m.this), other = ref(m.other);
    for (const mv of step.moves) {
      for (const i of mv.instances) {
        const anchorName = other.anchor.replace('[i]', `[${i}]`);
        const otherKey = key(other.label, 0);
        if (!final.has(otherKey)) throw new Error(`Step ${step.step}: ${other.label} is not placed yet`);
        const oa = parts[other.label].anchors[anchorName];
        const ta = parts[me.label].anchors[me.anchor];
        if (!oa) throw new Error(`Step ${step.step}: unknown anchor ${other.label}.${anchorName}`);
        if (!ta) throw new Error(`Step ${step.step}: unknown anchor ${me.label}.${me.anchor}`);
        const target = worldAnchor(oa, final.get(otherKey));
        const M = mateMatrix(ta, target);

        // Approach path: start offset along the target normal (out of the hole / off the face)
        const depth = m.type === 'pin_in_hole' ? (target.depth ?? 40) * 1.5 : parts[me.label].extent * 0.6;
        const dist = THREE.MathUtils.clamp(depth, 60, 200);
        const start = M.clone().premultiply(new THREE.Matrix4().makeTranslation(target.n.clone().multiplyScalar(dist)));

        final.set(key(me.label, i), M);
        info.moves.push({ key: key(me.label, i), final: M, start, target, fit: m.fit ?? 'slide' });
      }
    }
    steps.push(info);
  }
  return { final, steps };
}
