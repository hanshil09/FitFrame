// Assembly player: plan JSON -> resolver -> geometry worker (templates + manifold-3d) -> mate solver -> animation.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { resolvePlan } from './resolver.js';
import { solve } from './solver.js';

const PLAN_URL = './plans/rta-0097m-step1.json';
const $ = id => document.getElementById(id);

// ---------- Scene (units: mm) ----------
const renderer = new THREE.WebGLRenderer({ canvas: $('c'), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
const BG = new THREE.Color(0xf4f1ec), WHITE = new THREE.Color(0xffffff);
scene.background = BG;
const envMap = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environment = envMap;

const camera = new THREE.PerspectiveCamera(38, 1, 10, 20000);
camera.position.set(800, 620, 960);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 160, 0);
controls.enableDamping = true;

const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(400, 900, 300);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -500, right: 500, top: 500, bottom: -500, far: 3000 });
scene.add(sun);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.ShadowMaterial({ opacity: 0.2 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const grid = new THREE.GridHelper(2000, 20, 0xd8d2c6, 0xe6e1d8);
scene.add(grid);

const rig = new THREE.Group();   // the assembly; lifted while parts go in from below, then set down
scene.add(rig);

const offset = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
const MATERIALS = {
  nylon:  new THREE.MeshStandardMaterial({ color: 0x2a2a2d, roughness: 0.5, ...offset }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x3a3a3e, roughness: 0.85, ...offset }),
  paint:  new THREE.MeshStandardMaterial({ color: 0x1c1c1e, metalness: 0.6, roughness: 0.3, ...offset }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xe6e6e6, metalness: 1, roughness: 0.12, ...offset }),
};
const flatWhite = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, ...offset });
const edgeMat = new THREE.LineBasicMaterial({ color: 0x8a8378, transparent: true, opacity: 0.5 });
const meshes = [];

// ---------- Pipeline ----------
async function load() {
  const plan = await (await fetch(PLAN_URL)).json();
  const resolved = resolvePlan(plan);
  renderPartsPanel(resolved);
  $('stepNo').textContent = 'Building geometry…';

  const worker = new Worker(new URL('./geometry.worker.js', import.meta.url), { type: 'module' });
  const built = await new Promise((res, rej) => {
    worker.onmessage = e => e.data.ok ? res(e.data) : rej(new Error(e.data.error));
    worker.onerror = e => rej(new Error(e.message || 'worker failed to load'));
    worker.postMessage({ parts: resolved.map(p => ({ label: p.label, template: p.template, params: p.params, features: p.features })) });
  });
  $('status').textContent = `Built ${built.parts.length} part templates in ${built.ms.toFixed(0)} ms (manifold-3d, Web Worker)`;

  // Three.js geometry, shared by all instances of a part
  const parts = {};
  for (const bp of built.parts) {
    const spec = resolved.find(p => p.label === bp.label);
    const bodies = bp.bodies.map(b => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(b.position, 3));
      g.setIndex(new THREE.BufferAttribute(b.index, 1));
      const geom = toCreasedNormals(g, THREE.MathUtils.degToRad(35));
      geom.computeBoundingBox();
      return { geom, edges: new THREE.EdgesGeometry(geom, 35), material: MATERIALS[b.material] };
    });
    const box = new THREE.Box3();
    bodies.forEach(b => box.union(b.geom.boundingBox));
    parts[bp.label] = { anchors: bp.anchors, count: spec.count, box, extent: box.max.y - box.min.y, bodies };
  }

  // Instances
  const instances = new Map();
  for (const [label, p] of Object.entries(parts)) {
    for (let i = 0; i < p.count; i++) {
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      for (const b of p.bodies) {
        const m = new THREE.Mesh(b.geom, b.material);
        m.castShadow = m.receiveShadow = true;
        m.userData.mat = b.material;
        m.add(new THREE.LineSegments(b.edges, edgeMat));
        meshes.push(m);
        g.add(m);
      }
      g.visible = false;
      rig.add(g);
      instances.set(`${label}#${i}`, { group: g, label });
    }
  }

  const solved = solve(plan, parts);
  return { plan, timeline: buildTimeline(plan, solved, parts, instances), instances };
}

// ---------- Timeline (derived entirely from the solved mates) ----------
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const seg = (t, a, len) => clamp((t - a) / len);
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeOutBack = t => { const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

function buildTimeline(plan, solved, parts, instances) {
  const minY = (keys, pick) => Math.min(...keys.map(k => {
    const label = instances.get(k).label;
    return parts[label].box.clone().applyMatrix4(pick(k)).min.y;
  }));
  let placed = [];
  return plan.steps.map((step, s) => {
    const info = solved.steps[s];
    const before = [...placed];
    const base = info.places ? [...before, `${info.places}#0`] : before;
    const finalOf = k => solved.final.get(k);
    const groundBefore = -minY(base, finalOf);
    const startMin = Math.min(minY(base, finalOf), ...info.moves.map(m => minY([m.key], () => m.start)));
    const lifted = Math.max(groundBefore, -startMin + 20);
    const after = [...base, ...info.moves.map(m => m.key)];
    const groundAfter = -minY(after, finalOf);

    const intro = info.places ? 0.9 : 0.4;
    const stagger = 0.45;
    const moves = info.moves.map((m, k) => {
      const travel = m.fit === 'press' ? 0.75 : 1.3;
      const t0 = intro + 0.2 + k * stagger;
      const pS = new THREE.Vector3(), pF = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
      m.start.decompose(pS, q, sc);
      m.final.decompose(pF, q, sc);
      return { ...m, t0, t1: t0 + travel, pS, pF, q, marker: makeMarker(m.target) };
    });
    const tEnd = Math.max(...moves.map(m => m.t1));
    placed = after;
    return { step, before, root: info.places ? `${info.places}#0` : null, moves, groundBefore, lifted, groundAfter,
      intro, down: tEnd + 0.15, dur: tEnd + 1.2 };
  });
}

// Pulsing ring at the target hole/face, shown just before the part goes in
function makeMarker(target) {
  const r = (target.r ?? 20) + 4;
  const ring = new THREE.Mesh(new THREE.RingGeometry(r, r + 5, 48),
    new THREE.MeshBasicMaterial({ color: 0xf2a23a, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  const opening = target.o.clone().add(target.n.clone().multiplyScalar((target.depth ?? 0) + 1));
  ring.position.copy(opening);
  ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), target.n);
  ring.visible = false;
  rig.add(ring);
  return ring;
}

let state = null, lineArt = false;
const tmp = new THREE.Matrix4(), one = new THREE.Vector3(1, 1, 1), pos = new THREE.Vector3();

function apply(s, t) {
  const { timeline, instances } = state;
  for (const { group } of instances.values()) group.visible = false;
  const show = (key, m) => { const g = instances.get(key).group; g.matrix.copy(m); g.visible = true; };
  const final = key => state.solvedFinal.get(key);

  timeline.forEach(st => st.moves.forEach(m => { m.marker.visible = false; }));
  const st = timeline[s];
  st.before.forEach(k => show(k, final(k)));

  if (st.root) {
    const drop = (1 - ease(seg(t, 0, 0.8))) * 150;
    show(st.root, tmp.copy(final(st.root)).premultiply(new THREE.Matrix4().makeTranslation(0, drop, 0)));
  }
  for (const m of st.moves) {
    const raw = seg(t, m.t0, m.t1 - m.t0);
    const p = m.fit === 'press' ? easeOutBack(raw) : ease(raw);
    pos.lerpVectors(m.pS, m.pF, p);
    show(m.key, tmp.compose(pos, m.q, one));
    const k = seg(t, m.t0 - 0.45, 0.75);
    m.marker.visible = !lineArt && k > 0 && k < 1;
    m.marker.material.opacity = Math.sin(k * Math.PI) * 0.9;
  }
  rig.position.y = t < st.down
    ? THREE.MathUtils.lerp(st.groundBefore, st.lifted, ease(seg(t, 0.1, Math.max(0.4, st.intro - 0.1))))
    : THREE.MathUtils.lerp(st.lifted, st.groundAfter, ease(seg(t, st.down, 0.6)));
}

function setLineArt(on) {
  lineArt = on;
  scene.background = on ? WHITE : BG;
  scene.environment = on ? null : envMap;
  grid.visible = floor.visible = !on;
  meshes.forEach(m => { m.material = on ? flatWhite : m.userData.mat; });
  edgeMat.color.set(on ? 0x000000 : 0x8a8378);
  edgeMat.opacity = on ? 1 : 0.5;
}

// ---------- UI ----------
function renderPartsPanel(resolved) {
  $('partsSummary').textContent = `Parts and dimensions (${resolved.length})`;
  $('parts').innerHTML = resolved.map(p => {
    const dims = Object.entries(p.params).map(([k, v]) => `<span class="tag ${p.provenance[k]}">${k} ${v}</span>`).join('');
    const feats = p.features.map(f => `<span class="tag ${f.provenance.diameter}">${f.name} ⌀${f.diameter}</span><span class="tag ${f.provenance.depth}">depth ${f.depth}</span>`).join('');
    return `<div class="part"><b>${p.label}</b> ${p.name} ×${p.count} <span class="k">· ${p.template}</span><div class="dims">${dims}${feats}</div></div>`;
  }).join('') + `<div class="dims" style="margin-top:6px"><span class="tag stated">stated</span><span class="tag derived">derived</span><span class="tag estimated">estimated</span></div>`;
}

let step = 0, t = 0, playing = true;
function ui() {
  const st = state.timeline[step].step;
  $('stepNo').textContent = `Step ${st.step} · ${state.timeline.length} parts of Step 1`;
  $('title').textContent = st.title;
  $('mate').textContent = `${st.mate.type} · ${st.mate.this} → ${st.mate.other}${st.mate.fit ? ` (${st.mate.fit})` : ''}`;
  $('badges').innerHTML = `<span class="tag stated">votes ${st.confidence.votes}</span><span class="tag stated">render check: ${st.confidence.render_check}</span><span class="tag estimated">sizes estimated</span>`;
  $('srcLabel').textContent = `Source · ${state.plan.product.model} p.${st.source.page}`;
  [...$('dots').children].forEach((d, i) => d.classList.toggle('on', i <= step));
  $('play').textContent = playing ? 'Pause' : 'Play';
}
const dur = () => state.timeline[step].dur;
function go(s) { step = clamp(s, 0, state.timeline.length - 1); t = 0; playing = true; ui(); }
$('prev').onclick = () => go(step - 1);
$('next').onclick = () => go(step + 1);
$('replay').onclick = () => go(step);
$('play').onclick = () => {
  if (!playing && t >= dur()) {
    if (step === state.timeline.length - 1) return go($('all').checked ? 0 : step);
    if ($('all').checked) return go(step + 1);
    t = 0;
  }
  playing = !playing; ui();
};
$('scrub').oninput = e => { t = e.target.value / 1000 * dur(); playing = false; ui(); };
$('lineart').onchange = e => setLineArt(e.target.checked);
$('showsrc').onchange = e => { $('src').style.display = e.target.checked ? '' : 'none'; };

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (state) {
    if (playing) {
      t += dt;
      if (t >= dur()) {
        if ($('all').checked && step < state.timeline.length - 1) { step++; t = 0; }
        else { t = dur(); playing = false; }
        ui();
      }
    }
    apply(step, t);
    $('scrub').value = Math.round(t / dur() * 1000);
  }
  controls.update();
  renderer.render(scene, camera);
});

load().then(({ plan, timeline, instances }) => {
  state = { plan, timeline, instances, solvedFinal: null };
  // keep the solved final matrices handy for apply()
  state.solvedFinal = new Map();
  timeline.forEach(st => st.moves.forEach(m => state.solvedFinal.set(m.key, m.final)));
  timeline.forEach(st => { if (st.root) state.solvedFinal.set(st.root, new THREE.Matrix4()); });
  timeline.forEach(() => { const d = document.createElement('div'); d.className = 'dot'; $('dots').appendChild(d); });
  ui();
}).catch(err => {
  $('stepNo').textContent = 'Could not build the assembly';
  $('err').textContent = String(err.stack || err);
  console.error(err);
});
