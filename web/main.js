// App: scan screen -> server extraction (progress) -> player.
// Player pipeline: plan JSON -> resolver -> geometry worker (templates + manifold-3d) -> mate solver -> animation.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { resolvePlan } from './resolver.js';
import { solve, solveLayout } from './solver.js';

const $ = id => document.getElementById(id);
const show = id => document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === id));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ===================== Scan + progress =====================
fetch('/api/health').then(r => r.json()).then(h => {
  $('health').textContent = `Ready · ${h.model}`;
  $('health').classList.add('ok');
}).catch(() => {
  $('health').textContent = 'Server not reachable';
  $('health').classList.add('bad');
});
$('files').onchange = () => {
  const n = $('files').files.length;
  $('fileLabel').textContent = !n ? 'Choose a PDF or take photos' : n === 1 ? $('files').files[0].name : `${n} pages selected`;
  $('fileHint').textContent = n ? 'Tap to choose different files' : 'or drop it here · parts list first, then the steps in order';
  $('drop').classList.toggle('has', n > 0);
  $('go').disabled = !n;
};
$('go').onclick = async () => {
  if ($('files').files.length === 1) {
    const match = new FormData();
    match.append('file', $('files').files[0]);
    try {
      const response = await fetch('/api/kits/match', { method: 'POST', body: match });
      if (!response.ok) throw new Error('Could not check the kit catalog.');
      const result = await response.json();
      if (result.article_number) {
        location.href = `/kits.html?kit=${encodeURIComponent(result.article_number)}`;
        return;
      }
    } catch (error) { $('scanErr').textContent = error.message; return; }
  }
  const fd = new FormData();
  for (const f of $('files').files) fd.append('files', f);
  startJob(fetch(`/api/jobs?fresh=${$('fresh').checked}`, { method: 'POST', body: fd }));
};
$('sample').onclick = () => startJob(fetch(`/api/sample?fresh=${$('fresh').checked}`, { method: 'POST' }));
$('back1').onclick = () => { location.hash = ''; show('scan'); };
$('newScan').onclick = () => { location.hash = ''; location.reload(); };

async function startJob(req) {
  $('scanErr').textContent = '';
  try {
    const r = await req;
    if (!r.ok) throw new Error(await r.text());
    const { id } = await r.json();
    location.hash = `job=${id}`;
    watchJob(id);
  } catch (e) { $('scanErr').textContent = String(e.message || e); }
}

async function watchJob(id) {
  show('progress');
  $('progErr').textContent = '';
  $('spin').style.display = $('progBar').style.display = '';
  $('progTitle').textContent = 'Reading the manual…';
  for (;;) {
    let job;
    try { job = await (await fetch(`/api/jobs/${id}`)).json(); }
    catch { await sleep(1500); continue; }
    if (job.detail) { $('progErr').textContent = 'This scan is no longer on the server.'; $('spin').style.display = $('progBar').style.display = 'none'; return; }
    $('log').innerHTML = job.log.map(l => `<div>${l.t.toFixed(1).padStart(5)}s  ${esc(l.msg)}</div>`).join('');
    if (job.status === 'done') { startPlayer(job.plan, id); return; }
    if (job.status === 'error') {
      $('spin').style.display = $('progBar').style.display = 'none';
      $('progTitle').textContent = 'Could not read the manual';
      $('progErr').textContent = job.error;
      return;
    }
    await sleep(1000);
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ===================== 3D scene (units: mm) =====================
const renderer = new THREE.WebGLRenderer({ canvas: $('c'), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
const BG = new THREE.Color(0xf4f1ec), WHITE = new THREE.Color(0xffffff);
scene.background = BG;
const envMap = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environment = envMap;
const camera = new THREE.PerspectiveCamera(38, 1, 10, 50000);
camera.position.set(800, 620, 960);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 160, 0);
controls.enableDamping = true;
controls.addEventListener('start', () => { camMove = null; });   // the user's own orbit wins
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(400, 900, 300);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
scene.add(sun, sun.target);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000), new THREE.ShadowMaterial({ opacity: 0.2 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
const grid = new THREE.GridHelper(4000, 40, 0xd8d2c6, 0xe6e1d8);
scene.add(floor, grid);
const rig = new THREE.Group();
scene.add(rig);

const offset = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
const MATERIALS = {
  nylon:  new THREE.MeshStandardMaterial({ color: 0x2a2a2d, roughness: 0.5, ...offset }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x3a3a3e, roughness: 0.85, ...offset }),
  paint:  new THREE.MeshStandardMaterial({ color: 0x1c1c1e, metalness: 0.6, roughness: 0.3, ...offset }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xe6e6e6, metalness: 1, roughness: 0.12, ...offset }),
  wood:   new THREE.MeshStandardMaterial({ color: 0xc8a26a, roughness: 0.8, ...offset }),
  panel:  new THREE.MeshStandardMaterial({ color: 0x4a4a50, roughness: 0.6, ...offset }),
  fabric: new THREE.MeshStandardMaterial({ color: 0x33353a, roughness: 0.95, ...offset }),
  mesh:   new THREE.MeshStandardMaterial({ color: 0x1f2024, roughness: 0.8, transparent: true, opacity: 0.85, side: THREE.DoubleSide, ...offset }),
  unsupported: new THREE.MeshStandardMaterial({ color: 0xd9822b, roughness: 0.7, transparent: true, opacity: 0.55, ...offset }),
};
const GLOW = new THREE.Color(0xff8a1f);   // the part being fitted
const flatWhite = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, ...offset });
const edgeMat = new THREE.LineBasicMaterial({ color: 0x8a8378, transparent: true, opacity: 0.5 });
const meshes = [];

// ===================== Build the assembly from a plan =====================
async function startPlayer(plan, jobId) {
  show('player');
  resize();
  const resolved = resolvePlan(plan);
  renderPartsPanel(resolved, plan.issues ?? []);

  const worker = new Worker(new URL('./geometry.worker.js', import.meta.url), { type: 'module' });
  const built = await new Promise((res, rej) => {
    worker.onmessage = e => e.data.ok ? res(e.data) : rej(new Error(e.data.error));
    worker.onerror = e => rej(new Error(e.message || 'geometry worker failed to load'));
    worker.postMessage({ parts: resolved.map(p => ({ label: p.label, template: p.template, kind: p.kind, params: p.params, features: p.features })) });
  }).catch(err => { $('stepNo').textContent = 'Could not build geometry'; $('status').innerHTML = `<span class="err">${esc(err.message)}</span>`; throw err; });
  const usage = plan.usage ? ` · ${plan.usage.calls} model calls` : '';
  $('status').textContent = `${plan.product?.name ?? ''} · built ${built.parts.length} parts in ${built.ms.toFixed(0)} ms${usage}`;

  const parts = {};
  for (const bp of built.parts) {
    const spec = resolved.find(p => p.label === bp.label);
    const bodies = bp.bodies.map(b => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(b.position, 3));
      g.setIndex(new THREE.BufferAttribute(b.index, 1));
      const geom = toCreasedNormals(g, THREE.MathUtils.degToRad(35));
      geom.computeBoundingBox();
      return { geom, edges: new THREE.EdgesGeometry(geom, 35), material: MATERIALS[b.material] ?? MATERIALS.panel };
    });
    const box = new THREE.Box3();
    bodies.forEach(b => box.union(b.geom.boundingBox));
    parts[bp.label] = { anchors: bp.anchors, count: spec.count, box, extent: box.max.y - box.min.y, bodies, failed: bp.failed };
  }

  const instances = new Map();
  for (const [label, p] of Object.entries(parts)) {
    for (let i = 0; i < p.count; i++) {
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      for (const b of p.bodies) {
        const mat = b.material.clone();        // per instance, so one copy can glow on its own
        mat.emissive = GLOW;
        mat.emissiveIntensity = 0;
        const m = new THREE.Mesh(b.geom, mat);
        m.castShadow = m.receiveShadow = true;
        m.userData.mat = mat;
        m.add(new THREE.LineSegments(b.edges, edgeMat));
        meshes.push(m);
        g.add(m);
      }
      g.visible = false;
      rig.add(g);
      instances.set(`${label}#${i}`, { group: g, label });
    }
  }

  const solved = plan.layout ? solveLayout(plan, parts) : solve(plan, parts);
  const timeline = buildTimeline(solved, parts);
  state = { plan, timeline, instances, jobId, parts, pageImgs: {} };
  frameCamera(solved, parts);
  const first = viewFor([...solved[0].after], parts, timeline[0].groundAfter);
  if (first) { controls.target.copy(first.target); camera.position.copy(first.pos); }
  timeline.forEach(() => { const d = document.createElement('div'); d.className = 'dot'; $('dots').appendChild(d); });
  go(0);
}

// Camera view that fits a set of placed parts. `ground` is the rig's lift for that state.
function viewFor(entries, parts, ground) {
  const b = new THREE.Box3();
  for (const [k, m] of entries) b.union(parts[k.split('#')[0]].box.clone().applyMatrix4(m));
  if (b.isEmpty()) return null;
  b.translate(new THREE.Vector3(0, ground, 0));
  const size = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
  const r = Math.max(size.x, size.y, size.z, 350);
  const dist = (r * 0.62) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.max(1, 0.9 / camera.aspect);
  const dir = new THREE.Vector3(0.62, 0.42, 0.66).normalize();
  return { target: c, pos: c.clone().add(dir.multiplyScalar(dist)), r };
}

function frameCamera(solved, parts) {
  const last = solved[solved.length - 1];
  const v = last && viewFor(last.after, parts, 0);
  if (!v) return;
  const r = v.r * 1.5;
  Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, far: r * 6 });
  sun.position.set(v.target.x + r * 0.6, r * 2, v.target.z + r * 0.4);
  sun.target.position.copy(v.target);
  sun.shadow.camera.updateProjectionMatrix();
}

// Glide the camera to frame the parts this step works on (keeps the user's orbit angle)
let camMove = null;
function focusStep(i) {
  const st = state.timeline[i];
  const keys = new Set([...(st.info.focus ?? []), ...st.moves.map(m => m.key), ...st.placed.map(([k]) => k)]);
  const entries = [...st.info.after].filter(([k]) => keys.has(k));
  const v = viewFor(entries.length ? entries : [...st.info.after], state.parts, st.groundAfter);
  if (!v) return;
  const dist = v.pos.distanceTo(v.target);
  // Look from the side the part comes in from, across its path, so the move is never hidden behind
  // what it joins. Start from the current view so the camera turns as little as it can.
  const offsetDir = camera.position.clone().sub(controls.target).normalize();
  const main = st.moves.reduce((best, m) => (!best || m.S.p.distanceTo(m.F.p) > best.S.p.distanceTo(best.F.p) ? m : best), null);
  const from = main && main.S.p.clone().sub(main.F.p);
  if (from && from.length() > 1) {
    from.normalize();
    const across = offsetDir.clone().addScaledVector(from, -offsetDir.dot(from));
    if (across.lengthSq() < 1e-4) across.set(1, 0, 0);
    offsetDir.copy(across.normalize().multiplyScalar(0.8).addScaledVector(from, 0.6));
  }
  offsetDir.y = clamp(offsetDir.y, 0.25, 0.7);   // never level with the floor or straight down
  offsetDir.normalize();
  camMove = { t: 0, fromT: controls.target.clone(), toT: v.target, fromP: camera.position.clone(), toP: v.target.clone().add(offsetDir.multiplyScalar(dist)) };
}

// ===================== Timeline (derived from the solved mates) =====================
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const seg = (t, a, len) => clamp((t - a) / len);
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeOutBack = t => { const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
const decompose = m => { const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(); m.decompose(p, q, s); return { p, q }; };

function buildTimeline(solved, parts) {
  const minY = entries => {
    let y = Infinity;
    for (const [k, m] of entries) y = Math.min(y, parts[k.split('#')[0]].box.clone().applyMatrix4(m).min.y);
    return y === Infinity ? 0 : y;
  };
  return solved.map(info => {
    const moving = new Set(info.moves.map(m => m.key));
    const shownBefore = [...info.before].filter(([k]) => !moving.has(k));
    const placed = info.places.map(k => [k, info.after.get(k)]);
    const base = [...shownBefore, ...placed];
    const groundBefore = -minY([...info.before, ...placed]);
    const startMin = Math.min(minY(base), ...info.moves.map(m => minY([[m.key, m.start]])));
    const lifted = Math.max(groundBefore, -startMin + 20);
    const groundAfter = -minY(info.after);
    const intro = info.places.length ? 0.9 : 0.4;
    const units = [...new Set(info.moves.map(m => m.unit))];
    const stagger = units.length > 6 ? 0.25 : 0.45;
    const moves = info.moves.map(m => {
      const travel = m.from ? 1.8 : m.fit === 'press' ? 0.75 : m.fit === 'screw' ? 1.2 : 1.3;
      const t0 = intro + 0.2 + units.indexOf(m.unit) * stagger;
      const mv = { ...m, t0, t1: t0 + travel, A: m.from && decompose(m.from), S: decompose(m.start), F: decompose(m.final),
        marker: m.marker ? makeMarker(m.target) : null };
      mv.ghost = makeGhost(parts[m.key.split('#')[0]], m.final);
      mv.path = makePath([mv.A?.p, mv.S.p, mv.F.p].filter(Boolean));
      return mv;
    });
    const tEnd = moves.length ? Math.max(...moves.map(m => m.t1)) : intro + 0.6;
    return { info, step: info.step, shownBefore, placed, moves, groundBefore, lifted, groundAfter, intro,
      down: tEnd + 0.15, dur: tEnd + 1.2 };
  });
}

// Faint copy of a part at the place it is about to go
function makeGhost(part, matrix) {
  const material = new THREE.MeshBasicMaterial({ color: 0xff8a1f, transparent: true, opacity: 0, depthWrite: false });
  const g = new THREE.Group();
  for (const b of part.bodies) g.add(new THREE.Mesh(b.geom, material));
  g.matrixAutoUpdate = false;
  g.matrix.copy(matrix);
  g.visible = false;
  g.userData.material = material;
  rig.add(g);
  return g;
}

// Dashed guide along the route a part travels (lift-off, then the final approach)
function makePath(points) {
  if (points.length < 2 || points[0].distanceTo(points[points.length - 1]) < 15) return null;
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineDashedMaterial({ color: 0xd9822b, dashSize: 14, gapSize: 9, transparent: true, opacity: 0, depthWrite: false }));
  line.computeLineDistances();
  line.visible = false;
  line.renderOrder = 2;
  rig.add(line);
  return line;
}

function makeMarker(target) {
  const r = Math.min((target.r ?? 20) + 4, 80);
  const ring = new THREE.Mesh(new THREE.RingGeometry(r, r + 5, 48),
    new THREE.MeshBasicMaterial({ color: 0xf2a23a, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  ring.position.copy(target.o.clone().add(target.n.clone().multiplyScalar((target.depth ?? 0) + 1)));
  ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), target.n);
  ring.visible = false;
  rig.add(ring);
  return ring;
}

let state = null, lineArt = false;
const tmp = new THREE.Matrix4(), one = new THREE.Vector3(1, 1, 1), pos = new THREE.Vector3(), quat = new THREE.Quaternion();
const spinQ = new THREE.Quaternion();

function apply(s, t) {
  const { timeline, instances } = state;
  for (const { group } of instances.values()) group.visible = false;
  for (const mesh of meshes) mesh.userData.mat.emissiveIntensity = 0;
  timeline.forEach(st => st.moves.forEach(m => {
    if (m.marker) m.marker.visible = false;
    m.ghost.visible = false;
    if (m.path) m.path.visible = false;
  }));
  const glow = (key, k) => { if (k > 0) for (const mesh of instances.get(key).group.children) mesh.userData.mat.emissiveIntensity = 0.3 * k; };
  const showKey = (key, m) => { const g = instances.get(key).group; g.matrix.copy(m); g.visible = true; };
  const st = timeline[s];

  st.shownBefore.forEach(([k, m]) => showKey(k, m));
  const drop = (1 - ease(seg(t, 0, 0.8))) * 150;
  st.placed.forEach(([k, m]) => {
    showKey(k, tmp.copy(m).premultiply(new THREE.Matrix4().makeTranslation(0, drop, 0)));
    glow(k, 1 - seg(t, 0.6, 0.6));
  });

  for (const m of st.moves) {
    const raw = seg(t, m.t0, m.t1 - m.t0);
    if (m.A) {   // a finished subassembly: lift off, travel, then seat
      if (raw < 0.45) { const p = ease(raw / 0.45); pos.lerpVectors(m.A.p, m.S.p, p); quat.slerpQuaternions(m.A.q, m.S.q, p); }
      else { const p = ease((raw - 0.45) / 0.55); pos.lerpVectors(m.S.p, m.F.p, p); quat.copy(m.F.q); }
    } else {
      const p = m.fit === 'press' ? easeOutBack(raw) : ease(raw);
      pos.lerpVectors(m.S.p, m.F.p, p);
      quat.copy(m.F.q);
      if (m.fit === 'screw') quat.premultiply(spinQ.setFromAxisAngle(m.target.n, (1 - p) * Math.PI * 6));
    }
    showKey(m.key, tmp.compose(pos, quat, one));
    // glow from just before it moves until a moment after it is seated
    glow(m.key, Math.min(seg(t, m.t0 - 0.35, 0.35), 1 - seg(t, m.t1 + 0.25, 0.6)));
    // ghost at the destination fades in first, then fades as the part arrives
    const appear = seg(t, m.t0 - 0.6, 0.45), arrive = seg(t, m.t1 - 0.35, 0.35);
    m.ghost.visible = !lineArt && appear > 0 && arrive < 1;
    m.ghost.userData.material.opacity = 0.28 * appear * (1 - arrive);
    if (m.path) {
      m.path.visible = appear > 0 && arrive < 1;
      m.path.material.opacity = 0.85 * appear * (1 - arrive);
      m.path.material.color.set(lineArt ? 0x000000 : 0xd9822b);
    }
    if (m.marker) {
      const k = seg(t, m.t0 - 0.45, 0.75), seat = seg(t, m.t1 - 0.05, 0.45);
      if (k < 1) {          // pulse on the target before the part arrives
        m.marker.visible = !lineArt && k > 0;
        m.marker.material.opacity = Math.sin(k * Math.PI) * 0.9;
        m.marker.scale.setScalar(1);
      } else {              // a ring that spreads out as it seats
        m.marker.visible = !lineArt && seat > 0 && seat < 1;
        m.marker.material.opacity = (1 - seat) * 0.8;
        m.marker.scale.setScalar(1 + seat * 1.2);
      }
    }
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

// ===================== Panels =====================
function renderPartsPanel(resolved, issues) {
  $('partsSummary').textContent = `Parts and dimensions (${resolved.length})`;
  $('parts').innerHTML = resolved.map(p => {
    const dims = Object.entries(p.params).map(([k, v]) => `<span class="tag ${p.provenance[k]}">${esc(k)} ${+(+v).toFixed(1)}</span>`).join('');
    const unsup = p.template === 'unsupported' ? '<span class="tag warn">Unsupported shape</span>' : '';
    return `<div class="part"><b>${esc(p.label)}</b> ${esc(p.name)} ×${p.count} <span class="k">· ${esc(p.template)}</span> ${unsup}<div class="dims">${dims}</div></div>`;
  }).join('') + '<div class="dims" style="margin-top:6px"><span class="tag stated">stated</span><span class="tag derived">derived</span><span class="tag estimated">estimated</span></div>';
  $('issuesSummary').textContent = `Checks (${issues.length} issue${issues.length === 1 ? '' : 's'})`;
  $('issues').innerHTML = issues.length
    ? issues.map(i => `<div class="issue">${i.step ? `Step ${esc(i.step)}: ` : ''}${esc(i.msg)}</div>`).join('')
    : '<div class="k">No problems found by the validator.</div>';
}

async function showSource(step) {
  const src = step.source;
  if (!src) return;
  const url = `/api/jobs/${state.jobId}/pages/${src.page}.png`;
  let img = state.pageImgs[url];
  if (!img) {
    img = state.pageImgs[url] = new Image();
    img.src = url;
  }
  if (!img.complete) await new Promise(r => { img.onload = img.onerror = r; });
  const cv = $('srcCanvas'), ctx = cv.getContext('2d');
  const [y0, x0, y1, x1] = (src.box_2d?.length === 4 ? src.box_2d : [0, 0, 1000, 1000]).map(v => clamp(v / 1000));
  const sx = x0 * img.naturalWidth, sy = y0 * img.naturalHeight;
  const sw = Math.max(10, (x1 - x0) * img.naturalWidth), sh = Math.max(10, (y1 - y0) * img.naturalHeight);
  cv.width = 520; cv.height = Math.round(520 * sh / sw);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
  $('srcLabel').textContent = `Source · page ${src.page}`;
}

// ===================== Player controls =====================
let step = 0, t = 0, playing = true;
function ui() {
  const st = state.timeline[step], s = st.step;
  $('stepNo').textContent = `Step ${s.step} · ${step + 1} of ${state.timeline.length}`;
  $('title').textContent = s.title;
  $('mate').textContent = `${s.mate.type} · ${s.mate.this} → ${s.mate.other}${s.mate.fit ? ` (${s.mate.fit})` : ''}`;
  const votes = s.confidence?.votes ?? '';
  const [a, b] = votes.split('/').map(Number);
  $('badges').innerHTML = !votes ? '' : `<span class="tag ${a === b ? 'stated' : a > b / 2 ? 'estimated' : 'warn'}">votes ${esc(votes)}</span>`;
  const notes = state.plan.issues?.filter(i => i.step === s.step) ?? [];
  if (st.info.skipped) notes.unshift({ msg: `Not animated: ${st.info.skipped}` });
  $('stepIssues').innerHTML = notes.map(i => `<div class="issue">${esc(i.msg)}</div>`).join('');
  [...$('dots').children].forEach((d, i) => d.classList.toggle('on', i <= step));
  $('play').textContent = playing ? 'Pause' : 'Play';
}
const dur = () => state.timeline[step].dur;
function go(s) {
  step = clamp(s, 0, state.timeline.length - 1); t = 0; playing = true; ui();
  showSource(state.timeline[step].step);
  focusStep(step);
}
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
  const dt = Math.min(clock.getDelta(), 0.25);   // keep real-time pacing even when frames are slow
  if (!state || !$('player').classList.contains('on')) return;
  if (playing) {
    t += dt;
    if (t >= dur()) {
      if ($('all').checked && step < state.timeline.length - 1) { go(step + 1); }
      else { t = dur(); playing = false; ui(); }
    }
  }
  apply(step, t);
  $('scrub').value = Math.round(t / dur() * 1000);
  if (camMove) {
    camMove.t = Math.min(1, camMove.t + dt / 1.1);
    const k = ease(camMove.t);
    controls.target.lerpVectors(camMove.fromT, camMove.toT, k);
    camera.position.lerpVectors(camMove.fromP, camMove.toP, k);
    if (camMove.t >= 1) camMove = null;
  }
  controls.update();
  renderer.render(scene, camera);
});

// Resume a scan from the URL (#job=...) after a reload
const m = location.hash.match(/job=([\w-]+)/);
if (m) watchJob(m[1]);
