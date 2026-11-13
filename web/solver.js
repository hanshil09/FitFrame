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

// ---------- Layout solver ----------
// Used when the plan carries `layout`: where each board sits in the finished product (mm, Y up, front = +Z).
// Boards go straight to those places in step order; hardware goes to the face where two boards meet.
const FACE = { left: [-1, 0, 0], right: [1, 0, 0], top: [0, 1, 0], bottom: [0, -1, 0], front: [0, 0, 1], back: [0, 0, -1] };
const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const axisVec = (a, s = 1) => new THREE.Vector3().setComponent(a, s);

// Turn the part's drawn box (its first copy) so its extents match this copy's, and put it at the copy's centre
function copyMatrix(localBox, copy) {
  const L = localBox.getSize(new THREE.Vector3()).toArray(), lc = localBox.getCenter(new THREE.Vector3());
  const cost = p => p.reduce((sum, j, a) => sum + Math.abs(copy.s[a] - L[j]), 0);
  const p = PERMS.reduce((best, q) => cost(q) < cost(best) ? q : best);     // world axis a shows local axis p[a]
  const cols = [0, 1, 2].map(j => axisVec(p.indexOf(j)));                    // where each local axis points
  const R = new THREE.Matrix4().makeBasis(...cols);
  if (R.determinant() < 0) R.makeBasis(cols[0].negate(), cols[1], cols[2]);  // a box looks the same mirrored
  return new THREE.Matrix4().makeTranslation(...copy.c).multiply(R).multiply(new THREE.Matrix4().makeTranslation(-lc.x, -lc.y, -lc.z));
}

// The axis along which two boxes are furthest apart, and which way `b` lies from `a` on it
function between(a, b) {
  const ca = a.getCenter(new THREE.Vector3()), cb = b.getCenter(new THREE.Vector3());
  let axis = 0, best = -Infinity;
  for (let k = 0; k < 3; k++) {
    const gap = Math.max(b.min.getComponent(k) - a.max.getComponent(k), a.min.getComponent(k) - b.max.getComponent(k));
    if (gap > best) { best = gap; axis = k; }
  }
  return { axis, sign: Math.sign(cb.getComponent(axis) - ca.getComponent(axis)) || 1 };
}

// A face of `box` for hardware to go into: the patch that meets `joined` when given, else the named face
function faceTarget(box, joined, anchorName) {
  let axis, sign;
  if (joined) ({ axis, sign } = between(box, joined));
  else {
    const n = FACE[anchorName] ?? FACE.top;
    axis = n.findIndex(v => v !== 0); sign = n[axis];
  }
  const o = box.getCenter(new THREE.Vector3());
  o.setComponent(axis, (sign > 0 ? box.max : box.min).getComponent(axis));
  const others = [0, 1, 2].filter(k => k !== axis);
  const size = others.map(k => {
    let lo = box.min.getComponent(k), hi = box.max.getComponent(k);
    if (joined) {
      const l2 = Math.max(lo, joined.min.getComponent(k)), h2 = Math.min(hi, joined.max.getComponent(k));
      if (h2 > l2) { lo = l2; hi = h2; o.setComponent(k, (lo + hi) / 2); }
    }
    return hi - lo;
  });
  return { o, n: axisVec(axis, sign), r: 10, face: { u: axisVec(others[0]), v: axisVec(others[1]), size } };
}

// A point on a face from fractions along its longer and shorter sides
function spot(target, [along, across]) {
  const [su, sv] = target.face.size, long = su >= sv;
  const fu = (long ? along : across) - 0.5, fv = (long ? across : along) - 0.5;
  return { ...target, o: target.o.clone().add(target.face.u.clone().multiplyScalar(fu * su)).add(target.face.v.clone().multiplyScalar(fv * sv)) };
}

export function solveLayout(plan, parts) {
  const boxes = new Map();          // key -> { box: Box3 in the finished product, matrix }
  for (const [label, copies] of Object.entries(plan.layout)) {
    if (!parts[label]) continue;
    copies.forEach((c, i) => {
      if (!c) return;
      const box = new THREE.Box3().setFromCenterAndSize(V(c.c), V(c.s));
      boxes.set(`${label}#${i}`, { box, matrix: copyMatrix(parts[label].box, c) });
    });
  }
  const keysOf = label => [...boxes.keys()].filter(k => k.split('#')[0] === label);
  const centre = b => b.getCenter(new THREE.Vector3());
  const nearest = (label, toBox, not) => keysOf(label).filter(k => k !== not)
    .map(k => [k, centre(boxes.get(k).box).distanceTo(centre(toBox))])
    .sort((a, b) => a[1] - b[1])[0]?.[0];
  const shift = v => new THREE.Matrix4().makeTranslation(v.x, v.y, v.z);

  // As in a manual, a board lies on the floor while hardware goes into it, and moves to its finished place
  // when a step joins it to another board. Joined boards rest on the floor as one assembly.
  const finalM = new Map();         // key -> matrix in the finished product's frame
  const boardOf = new Map();        // key -> the board it sits on (a board maps to itself)
  const staged = new Map();         // board -> offset from its finished place to its spot on the floor
  const settled = new Set();        // boards in their finished place
  const riders = new Map();         // board -> hardware keys fitted to it
  const world = new Map(), used = {}, steps = [];
  const whole = new THREE.Box3();
  for (const b of boxes.values()) whole.union(b.box);
  let cursor = whole.min.x, drop = 0, unit = 0, lastBoard = null;
  const rowZ = whole.max.z + 200;

  const snapshot = () => new Map([...world].map(([k, m]) => [k, m.clone()]));
  const offsetOf = board => settled.has(board) ? new THREE.Vector3(0, -drop, 0) : staged.get(board);
  const place = k => shift(offsetOf(boardOf.get(k))).multiply(finalM.get(k));
  const adopt = k => { if (!boardOf.has(k)) { finalM.set(k, boxes.get(k).matrix); boardOf.set(k, k); } };

  const stage = (k, info) => {
    const box = boxes.get(k).box, size = box.getSize(new THREE.Vector3()), c = centre(box);
    staged.set(k, new THREE.Vector3(cursor + size.x / 2 - c.x, size.y / 2 - c.y, rowZ + size.z / 2 - c.z));
    cursor += size.x + 80;
    adopt(k);
    world.set(k, place(k));
    info.places.push(k);
  };

  // list: [{ key, dir }]. A board with `dir` travels in along it; without one it simply appears in place.
  const settle = (list, info, fit) => {
    const fresh = list.filter(e => !settled.has(e.key));
    if (!fresh.length) return false;
    const before = [...settled], oldDrop = drop;
    drop = Math.min(...[...before, ...fresh.map(e => e.key)].map(k => boxes.get(k).box.min.y));
    for (const { key, dir } of fresh) {
      adopt(key);
      const group = [key, ...(riders.get(key) ?? [])];
      const froms = group.map(g => world.get(g)?.clone());
      staged.delete(key);
      settled.add(key);
      const reach = THREE.MathUtils.clamp(Math.max(...boxes.get(key).box.getSize(new THREE.Vector3()).toArray()) * 0.5, 120, 320);
      group.forEach((g, n) => {
        const fin = place(g);
        world.set(g, fin);
        if (!dir && !froms[n]) { info.places.push(g); return; }
        const d = dir ?? axisVec(1);
        info.moves.push({ key: g, unit, from: froms[n] ?? null, start: fin.clone().premultiply(shift(d.clone().multiplyScalar(reach))), final: fin,
          target: { o: new THREE.Vector3().setFromMatrixPosition(fin), n: d, r: 20 }, fit: fit === 'screw' ? 'slide' : fit, marker: false });
      });
      info.focus.push(key);
      unit++;
    }
    if (drop !== oldDrop) {         // the assembly now stands on something new: move what was already built
      for (const g of before.flatMap(b => [b, ...(riders.get(b) ?? [])])) {
        const from = world.get(g).clone(), fin = place(g);
        world.set(g, fin);
        info.moves.push({ key: g, unit: 0, from, start: fin, final: fin, target: { o: new THREE.Vector3(), n: axisVec(1), r: 20 }, fit: 'slide', marker: false });
      }
    }
    return true;
  };

  for (const step of plan.steps) {
    const info = { step, places: [], moves: [], before: snapshot(), skipped: null, focus: [] };
    unit = 0;
    if (step.invalid) { info.skipped = 'flagged by the validator'; info.after = info.before; steps.push(info); continue; }
    const me = ref(step.mate.this), other = ref(step.mate.other), joins = step.mate.joins;

    // boards this step joins, and the boards they are joined to
    const list = [];
    for (const mv of step.moves) {
      if (!plan.layout[mv.part] || !parts[mv.part]) continue;
      for (const i of (mv.instances.length ? mv.instances : [0])) {
        const k = `${mv.part}#${i}`;
        if (!boxes.has(k)) { info.skipped = `no position for ${mv.part} copy ${i}`; continue; }
        const ok = nearest(other.label, boxes.get(k).box, k);
        if (ok && !list.some(e => e.key === ok)) list.push({ key: ok, dir: staged.has(ok) ? axisVec(1) : null });
        const way = ok ? between(boxes.get(ok).box, boxes.get(k).box) : { axis: 1, sign: 1 };
        if (!list.some(e => e.key === k)) list.push({ key: k, dir: axisVec(way.axis, way.sign) });
      }
      lastBoard = mv.part;
    }
    if (list.length && !settle(list, info, step.mate.fit)) info.skipped = 'these parts are already joined';

    // hardware: into a board, on the face where that board meets the one it joins
    for (const mv of step.moves) {
      const P = parts[mv.part];
      if (!P) { info.skipped = `unknown part ${mv.part}`; continue; }
      if (plan.layout[mv.part]) continue;
      const board = [other.label, joins, lastBoard].find(l => l && keysOf(l).length);
      const thisA = P.anchors[me.label === mv.part ? me.anchor : 'tip'] ?? P.anchors.tip ?? Object.values(P.anchors)[0];
      if (!board || !thisA) { info.skipped = `no board to put ${mv.part} into`; continue; }
      const second = [joins, other.label].find(l => l && l !== board && keysOf(l).length);
      const boardKeys = keysOf(board), n = mv.instances.length || 1;
      const copyOf = u => boardKeys[Math.floor(u * boardKeys.length / n)];
      for (let u = 0; u < n; u++) {
        const idx = used[mv.part] = (used[mv.part] ?? -1) + 1;
        if (idx >= P.count) { info.skipped = `the steps use more ${mv.part} than the parts list has`; break; }
        const bk = copyOf(u), b = boxes.get(bk);
        if (!boardOf.has(bk)) stage(bk, info);
        const same = [...Array(n).keys()].filter(x => copyOf(x) === bk);
        const jk = second && nearest(second, b.box, bk);
        const anchor = other.label === board ? other.anchor : 'top';
        const face = faceTarget(b.box, jk && boxes.get(jk).box, anchor), spots = step.mate.spots;
        const inPlace = spots?.length ? spot(face, spots[same.indexOf(u) % spots.length]) : spread(face, same.indexOf(u), same.length);
        const key = `${mv.part}#${idx}`;
        finalM.set(key, mateMatrix(thisA, inPlace));
        boardOf.set(key, bk);
        riders.set(bk, [...(riders.get(bk) ?? []), key]);
        const M = place(key), target = { ...inPlace, o: inPlace.o.clone().add(offsetOf(bk)) };
        world.set(key, M);
        const reach = THREE.MathUtils.clamp((thisA.embed ?? 40) * 1.5, 60, 220);
        info.moves.push({ key, unit, from: null, start: M.clone().premultiply(shift(target.n.clone().multiplyScalar(reach))), final: M, target, fit: step.mate.fit, marker: true });
        info.focus.push(key, bk);
        unit++;
      }
      lastBoard = board;
    }
    info.after = snapshot();
    steps.push(info);
  }

  // Boards the steps never joined still belong in the finished product: bring them in at the end
  const rest = [...boxes.keys()].filter(k => !settled.has(k));
  if (rest.length) {
    const info = { places: [], moves: [], before: snapshot(), skipped: null, focus: [],
      step: { step: 'end', title: `Finished product: ${rest.length} part(s) the steps did not join move into place`, moves: [],
        mate: { type: 'layout', this: 'remaining parts', other: 'finished position' } } };
    unit = 0;
    settle(rest.map(k => ({ key: k, dir: staged.has(k) ? axisVec(1) : null })), info, 'slide');
    info.after = snapshot();
    steps.push(info);
  }
  return steps;
}
