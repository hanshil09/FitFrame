import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';

const $ = id => document.getElementById(id);
const camera = new THREE.PerspectiveCamera(40,1,.001,100);
const views = ['left','right'].map(id => {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xefebe4);
  scene.add(new THREE.HemisphereLight(0xffffff,0x717971,2));
  const light = new THREE.DirectionalLight(0xffffff,2);
  light.position.set(2,4,3);
  scene.add(light);
  const renderer = new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
  $(id).append(renderer.domElement);
  return {scene,renderer,host:$(id)};
});
const controls = new OrbitControls(camera,views[0].renderer.domElement);
const GLOW = new THREE.Color(0xff8a1f);   // the parts being fitted in this step
let glide;                                // camera move towards the parts of the current step
controls.addEventListener('start',() => { glide = undefined; });   // the user's own orbit wins
const loader = new GLTFLoader();
const assemblyCenter = new THREE.Vector3();
let catalog, kit, model, parts, prediction, actions = [], step = 0, started = 0;
let busy = false, playing = false, recording = false, recordFrame, travel, sourceUrl, referenceSource = false;
const interval = 1700;
let extras = [];                         // ids of hardware drawn in because the model leaves it out
const hardwareMeshes = new Map();        // IKEA part number -> real hardware mesh from the server
const HARDWARE_LOOK = {
  screw: {color:0x9aa3ab,metalness:.8,roughness:.35},
  dowel: {color:0xc89b62,metalness:0,roughness:.8},
  cam_nut: {color:0xb9c0c6,metalness:.8,roughness:.3}
};

// Makes a model readable. Some exporters (trimesh) store near-black vertex colours, or none on some
// parts, so boards, holes and steps disappear into each other. Untextured dark parts get a neutral
// grey, small hardware a light metal finish, and every part thin outlines so edges, holes and a
// raised panel stand out. Textured models (the IKEA kits) keep their own look.
const EDGE = new THREE.LineBasicMaterial({color:0x1f2226,transparent:true,opacity:.55});
function finishLook(root) {
  const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()).length();
  root.traverse(node => {
    if (!node.isMesh) return;
    const geometry = node.geometry;
    for (const material of [node.material].flat()) {
      if (material.map) continue;
      const colours = geometry.attributes.color;
      let light = 1;
      if (material.vertexColors && colours) {
        light = 0;
        const step = Math.max(1,Math.floor(colours.count/400));
        let n = 0;
        for (let i = 0; i < colours.count; i += step, n++) light += (colours.getX(i)+colours.getY(i)+colours.getZ(i))/3;
        light /= n;
      }
      geometry.computeBoundingBox();
      const small = geometry.boundingBox.getSize(new THREE.Vector3()).length() < 0.05*size;
      if (small) {
        material.vertexColors = false;
        material.color.set(0xc9ced4);
        material.metalness = .6; material.roughness = .35;
      } else if (light < .25 || (material.vertexColors && !colours) || !material.vertexColors && material.color.getHSL({}).l > .9) {
        material.vertexColors = false;
        material.color.set(0x7d838b);
        material.metalness = .1; material.roughness = .7;
      }
      material.needsUpdate = true;
    }
    const triangles = (geometry.index ? geometry.index.count : geometry.attributes.position.count)/3;
    if (triangles < 20000) node.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry,25),EDGE));
  });
}

// Turns a part about its own long axis through its own centre. Some exporters (trimesh) store every
// part around the model's origin, and turning those about their origin would swing them in a circle.
function spin(part, angle) {
  const {object,localAxis,localCenter} = part;
  const turn = new THREE.Quaternion().setFromAxisAngle(localAxis,angle);
  const shift = localCenter.clone().sub(localCenter.clone().applyQuaternion(turn))
    .multiply(object.scale).applyQuaternion(object.quaternion);
  object.quaternion.multiply(turn);
  object.position.add(shift);
}

function status(message) { $('status').textContent = message; }

// Hardware drawn from a profile when no real IKEA model fits: the same shapes as templates.js,
// in millimetres, tip at the origin, +Z toward the head.
function profileGeometry(kind) {
  const L = kind === 'dowel' ? 30 : kind === 'cam_nut' ? 12 : 40, r = kind === 'dowel' ? 4 : kind === 'cam_nut' ? 7.5 : 2;
  let points;
  if (kind === 'dowel') { const c = Math.min(r*.3,1.5); points = [[0,0],[r-c,0],[r,c],[r,L-c],[r-c,L],[0,L]]; }
  else if (kind === 'cam_nut') points = [[0,0],[r,0],[r,L],[0,L]];
  else { const R = r*1.9, hh = Math.max(2,r*1.2); points = [[0,0],[r*.45,0],[r,Math.min(r*1.4,L*.3)],[r,L],[R,L],[R,L+hh],[0,L+hh]]; }
  const geometry = new THREE.LatheGeometry(points.map(([x,y]) => new THREE.Vector2(x,y)),32);
  geometry.rotateX(Math.PI/2);
  return {geometry,length:L,width:kind === 'dowel' ? 2*r : kind === 'cam_nut' ? 2*r : 3.8*r};
}

// A real IKEA screw, dowel or cam lock taken from a kit whose model includes it.
function libraryGeometry(number) {
  if (!hardwareMeshes.has(number)) {
    hardwareMeshes.set(number,fetch('/api/kits/hardware/' + encodeURIComponent(number)).then(response => {
      if (!response.ok) throw new Error('No hardware model ' + number);
      return response.json();
    }).then(data => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position',new THREE.Float32BufferAttribute(data.positions,3));
      geometry.setIndex(data.indices);
      geometry.computeVertexNormals();
      return {geometry,length:data.length_mm,width:data.width_mm};
    }));
  }
  return hardwareMeshes.get(number);
}

function clearHardware() {
  for (const id of extras) {
    const part = parts?.get(id);
    if (!part) continue;
    part.object.removeFromParent();
    part.object.children[0]?.material?.dispose();
    parts.delete(id);
  }
  extras = [];
}

// Adds the screws, dowels and cam locks the server placed at joints the model leaves bare. They get
// a faint blue glow, since their positions are estimates.
async function addHardware(specs) {
  clearHardware();
  for (const [id,spec] of Object.entries(specs ?? {})) {
    const {geometry,length,width} = spec.number
      ? await libraryGeometry(spec.number).catch(() => profileGeometry(spec.kind))
      : profileGeometry(spec.kind);
    const look = HARDWARE_LOOK[spec.kind] ?? HARDWARE_LOOK.screw;
    const material = new THREE.MeshStandardMaterial({...look,emissive:0x2a6f97,emissiveIntensity:.12});
    material.userData.baseEmissive = material.emissive.clone();
    const mesh = new THREE.Mesh(geometry,material);
    // keep the real part's proportions, but never fatter than the parts it joins allow
    const along = spec.length/length;
    const across = Math.min(along,(spec.width ?? Infinity)/width);
    mesh.scale.set(across,across,along);
    const holder = new THREE.Group();
    holder.add(mesh);
    holder.position.fromArray(spec.position);
    holder.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),new THREE.Vector3(...spec.direction));
    model.add(holder);
    holder.updateMatrixWorld(true);
    parts.set(id,{
      object:holder, position:holder.position.clone(), rotation:holder.quaternion.clone(),
      localAxis:new THREE.Vector3(0,0,1), localCenter:new THREE.Vector3(), slender:true, length:spec.length, centered:false,
      worldPosition:holder.getWorldPosition(new THREE.Vector3()), worldRotation:holder.getWorldQuaternion(new THREE.Quaternion()),
      materials:[material]
    });
    extras.push(id);
  }
}

// A point `t` (0..1) of the way along a list of offsets, by distance travelled. The server sends a
// two-leg path when a part has to lift out of its joint before it can move away without hitting anything.
function alongPath(points, t) {
  const vectors = points.map(point => new THREE.Vector3(...point));
  const lengths = vectors.slice(1).map((vector,i) => vector.distanceTo(vectors[i]));
  let remaining = t*(lengths.reduce((a,b) => a+b,0) || 1);
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i] || i === lengths.length-1) {
      return vectors[i].clone().lerp(vectors[i+1],lengths[i] ? Math.min(1,remaining/lengths[i]) : 1);
    }
    remaining -= lengths[i];
  }
  return vectors.at(-1);
}

function updateControls() {
  const locked = busy || recording;
  for (const element of [$('kit'),$('pdf'),$('scan').querySelector('button')]) element.disabled = locked;
  $('prediction').disabled = locked || !model;
  $('use-pa').disabled = locked || !prediction || !actions.length;
  $('prev').disabled = locked || !actions.length || step === 0;
  $('next').disabled = locked || !actions.length || step === actions.length-1;
  $('play').disabled = $('review').disabled = locked || !actions.length;
  $('export').disabled = locked || !actions.length || !$('review').checked;
  $('play').textContent = playing ? 'Pause' : 'Play all';
}

// Centre the view between the whole product and the parts this step fits, so the move stays in frame
function focusOn(action) {
  const box = new THREE.Box3();
  for (const id of action?.nodes ?? []) {
    const part = parts.get(id);
    if (part) box.expandByPoint(part.worldPosition);
  }
  const to = box.isEmpty() ? assemblyCenter.clone() : box.getCenter(new THREE.Vector3()).lerp(assemblyCenter,.35);
  if (to.distanceTo(controls.target) > 1e-6) glide = {t:0,from:controls.target.clone(),to};
}

function showStep(index) {
  step = index;
  started = performance.now();
  const action = actions[index];
  $('step').textContent = action ? 'Step ' + action.step + ' · ' + action.caption : 'Finished IKEA model';
  if (parts) focusOn(action);
  $('source').hidden = !action;
  if (action) {
    $('page-image').hidden = !referenceSource;
    $('page').hidden = referenceSource;
    if (referenceSource) $('page-image').src = '/api/kits/' + encodeURIComponent(kit.article_number) + '/pages/' + action.page;
    else {
      const url = sourceUrl + '#page=' + action.page;
      if ($('page').src !== url) $('page').src = url;
    }
  }
  if (prediction) {
    const predicted = prediction.steps.find(item => item.step === action?.step);
    const expected = new Set(actions.filter(item => item.step === action?.step).flatMap(item => item.nodes));
    const matched = predicted?.poses.filter(pose => expected.has(pose.node)) ?? [];
    const error = matched.reduce((totals, pose) => {
      const part = parts.get(pose.node);
      totals.mm += part.worldPosition.distanceTo(new THREE.Vector3(...pose.position))*1000;
      totals.degrees += THREE.MathUtils.radToDeg(part.worldRotation.angleTo(new THREE.Quaternion(...pose.quaternion).normalize()));
      return totals;
    }, {mm:0,degrees:0});
    $('comparison').textContent = predicted
      ? predicted.poses.length + ' predicted placements · ' + matched.length + ' of ' + expected.size + ' FitFrame parts also predicted'
        + (matched.length ? ' · Mean difference from IKEA poses: ' + (error.mm/matched.length).toFixed(1)
          + ' mm, ' + (error.degrees/matched.length).toFixed(1) + '°' : '')
      : 'No prediction for this step.';
  }
  updateControls();
}

async function load(item) {
  if (kit?.article_number === item.article_number) return;
  // a new query each load, so a model replaced on the server is never served from the browser's cache
  const asset = await loader.loadAsync('/api/kits/' + item.article_number + '/model?t=' + Date.now());
  const mapped = new Map();
  asset.scene.updateMatrixWorld(true);
  asset.scene.traverse(object => {
    const id = asset.parser.associations.get(object)?.nodes;
    if (id !== undefined && asset.parser.json.nodes[id].mesh !== undefined) {
      const mesh = asset.parser.json.meshes[asset.parser.json.nodes[id].mesh];
      const bounds = new THREE.Box3();
      for (const primitive of mesh.primitives) {
        const accessor = asset.parser.json.accessors[primitive.attributes.POSITION];
        if (accessor.min && accessor.max) {
          bounds.expandByPoint(new THREE.Vector3(...accessor.min));
          bounds.expandByPoint(new THREE.Vector3(...accessor.max));
        }
      }
      const size = bounds.getSize(new THREE.Vector3());
      const longest = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
      const axes = [0,1,2].map(axis => size.getComponent(axis)).sort((a,b) => b-a);
      const axis = new THREE.Vector3().setComponent(longest,
        bounds.min.getComponent(longest) + bounds.max.getComponent(longest) <= 0 ? 1 : -1);
      mapped.set(id,{
        object, position:object.position.clone(), rotation:object.quaternion.clone(),
        localAxis:axis, localCenter:bounds.getCenter(new THREE.Vector3()), slender:axes[0] > 2*axes[1], length:axes[0],
        centered:Math.abs(bounds.min.getComponent(longest)+bounds.max.getComponent(longest)) < axes[0]*.1,
        worldPosition:object.getWorldPosition(new THREE.Vector3()),
        worldRotation:object.getWorldQuaternion(new THREE.Quaternion())
      });
    }
  });
  // A catalog loaded before a model was replaced can hold an old part count; the model itself is the truth.
  if (mapped.size !== item.mesh_nodes) console.warn('Model has ' + mapped.size + ' parts; the catalog listed ' + item.mesh_nodes + '.');
  if (model) {
    model.removeFromParent();
    const resources = new Set();
    model.traverse(node => {
      if (node.geometry) resources.add(node.geometry);
      for (const material of [node.material].flat().filter(Boolean)) {
        resources.add(material);
        for (const value of Object.values(material)) if (value?.isTexture) resources.add(value);
      }
    });
    for (const resource of resources) resource.dispose();
  }
  model = asset.scene;
  model.traverse(node => {
    if (!node.isMesh) return;
    node.material = [node.material].flat().map(material => {
      const own = material.clone();
      own.userData.baseEmissive = (own.emissive ?? new THREE.Color()).clone();
      return own;
    });
    if (node.material.length === 1) node.material = node.material[0];
  });
  finishLook(model);      // after each mesh has its own material copy, so one part's finish stays its own
  for (const part of mapped.values()) {
    part.materials = [];
    part.object.traverse(node => { if (node.isMesh) part.materials.push(...[node.material].flat().filter(m => m.emissive)); });
  }
  parts = mapped;
  extras = [];
  kit = item;
  actions = [];
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  sourceUrl = undefined;
  prediction = undefined;
  views[0].scene.add(model);
  $('right').hidden = $('issues').hidden = true;
  $('review').checked = false;
  $('prediction').value = '';
  $('use-pa').checked = false;
  $('comparison').textContent = 'No Manual-PA run available for this kit.';
  $('kit').value = kit.article_number;
  $('manual').href = '/api/kits/' + kit.article_number + '/manual';
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3()).length();
  bounds.getCenter(assemblyCenter);
  controls.target.copy(assemblyCenter);
  camera.position.copy(controls.target).addScaledVector(new THREE.Vector3(.9,.65,1.2),size);
  camera.near = Math.max(.00001,size/1000);
  camera.far = size*100;
  travel = size*.16;
  controls.update();
  showStep(0);
}

function draw(view) {
  const {clientWidth:width,clientHeight:height} = view.host;
  if (!width || !height) return;
  const canvas = view.renderer.domElement;
  if (canvas.width !== width || canvas.height !== height) view.renderer.setSize(width,height,false);
  camera.aspect = width/height;
  camera.updateProjectionMatrix();
  view.renderer.render(view.scene,camera);
}

function posesThrough(index) {
  const poses = new Map();
  if (index < 0) return poses;
  for (const item of prediction.steps.slice(0,index+1)) {
    for (const pose of item.poses) poses.set(pose.node,pose);
  }
  return poses;
}

function setWorldPose(object, pose) {
  object.position.copy(object.parent.worldToLocal(new THREE.Vector3(...pose.position)));
  object.quaternion.copy(object.parent.getWorldQuaternion(new THREE.Quaternion()).invert())
    .multiply(new THREE.Quaternion(...pose.quaternion).normalize());
}

function tick(now) {
  requestAnimationFrame(tick);
  if (!model) return;
  // a step plays for as long as its manual says (duration_s), otherwise the default
  const span = actions[step]?.duration_s ? actions[step].duration_s*1000 : interval;
  if (playing && now-started >= span) {
    if (step < actions.length-1) showStep(step+1);
    else { playing = false; updateControls(); }
  }
  const progress = Math.min(1,Math.max(0,(now-started)/(span*.75)));
  const action = actions[step];
  const previous = new Set(actions.slice(0,step).flatMap(item => item.nodes));
  const active = new Set(action?.nodes);
  const savedOffsets = new Map();
  for (const earlier of actions.slice(0,step)) {
    for (const id of earlier.nodes) {
      const end = earlier.motions?.[id]?.end ?? earlier.end_offset;
      if (end) savedOffsets.set(id,end);
    }
  }
  // Per-part motions come from the server (worked out from the finished model); a saved plan may
  // instead carry one hand-entered offset for the whole action.
  const keyed = Boolean(action?.motions || action?.start_offset);
  const eased = progress < .5 ? 4*progress**3 : 1-(-2*progress+2)**3/2;
  const predictedStep = prediction?.steps.findIndex(item => item.step === action?.step) ?? -1;
  const compared = prediction ? posesThrough(predictedStep) : new Map();
  const usePrediction = $('use-pa').checked && prediction && action;
  const earlierSteps = new Set(actions.slice(0,step+1).map(item => item.step));
  const playback = new Map();
  if (usePrediction) {
    for (const item of prediction.steps) {
      if (earlierSteps.has(item.step)) for (const pose of item.poses) playback.set(pose.node,pose);
    }
  }
  for (const [id,part] of parts) {
    const {object,position,rotation,localAxis,slender,length,centered} = part;
    object.visible = !action || previous.has(id) || active.has(id);
    object.position.copy(position);
    object.quaternion.copy(rotation);
    const pose = playback.get(id);
    if (pose) setWorldPose(object,pose);
    const isFastener = slender && ['insert','tighten'].includes(action?.motion);
    if (keyed) {
      const move = action.motions?.[id]
        ?? (action.start_offset && {start:action.start_offset,end:action.end_offset,turns:action.turns});
      const offset = active.has(id) && move
        ? (move.path ? alongPath(move.path,eased) : new THREE.Vector3(...move.start).lerp(new THREE.Vector3(...move.end),eased))
        : new THREE.Vector3(...(savedOffsets.get(id) ?? [0,0,0]));
      const world = object.getWorldPosition(new THREE.Vector3()).add(offset);
      object.position.copy(object.parent.worldToLocal(world));
      if (active.has(id) && move?.turns) {
        spin(part,(progress-1)*Math.PI*2*move.turns);
      }
    } else if (active.has(id) && action.entry_target !== undefined) {
      const target = parts.get(action.entry_target).worldPosition;
      const direction = part.worldPosition.clone().sub(target);
      if (action.motion === 'tighten') {
        const shaft = localAxis.clone().applyQuaternion(object.getWorldQuaternion(new THREE.Quaternion()));
        direction.copy(shaft.multiplyScalar(direction.dot(shaft) < 0 ? -1 : 1));
        spin(part,(progress-1)*Math.PI*3);
      }
      const distance = THREE.MathUtils.lerp(action.distance,action.seat_offset ?? 0,progress);
      const position = object.getWorldPosition(new THREE.Vector3()).addScaledVector(direction.normalize(),distance);
      object.position.copy(object.parent.worldToLocal(position));
    } else if (active.has(id) && !previous.has(id)) {
      const world = object.getWorldPosition(new THREE.Vector3());
      const direction = new THREE.Vector3(0,1,0);
      if (isFastener) {
        direction.copy(localAxis).applyQuaternion(object.getWorldQuaternion(new THREE.Quaternion()));
        if (centered && direction.dot(world.clone().sub(assemblyCenter)) < 0) direction.negate();
      } else if (action.motion === 'slide') {
        const delta = world.clone().sub(assemblyCenter);
        const side = Math.abs(delta.x) > Math.abs(delta.z) ? 0 : 2;
        if (Math.abs(delta.getComponent(side)) > .00001) {
          direction.set(0,0,0).setComponent(side,Math.sign(delta.getComponent(side)));
        }
      }
      const distance = isFastener ? Math.min(travel,length*1.35) : travel;
      world.addScaledVector(direction,distance*(1-progress)**2);
      object.position.copy(object.parent.worldToLocal(world));
    }
    if (active.has(id) && action.motion === 'tighten' && isFastener && action.entry_target === undefined && !keyed) {
      spin(part,(progress-1)*Math.PI*2);
    }
  }
  // Glow on the parts being fitted, fading out once they are seated
  const settle = Math.min(1,Math.max(0,(now-started-span*.75)/350));
  for (const [id,part] of parts) {
    const k = action && active.has(id) ? 0.32*(1-settle) : 0;
    for (const material of part.materials) material.emissive.copy(material.userData.baseEmissive).lerp(GLOW,k);
  }
  if (glide) {
    glide.t = Math.min(1,glide.t+(now-(glide.last ?? now))/700);
    glide.last = now;
    const k = glide.t < .5 ? 4*glide.t**3 : 1-(-2*glide.t+2)**3/2;
    const target = glide.from.clone().lerp(glide.to,k);
    camera.position.add(target.clone().sub(controls.target));
    controls.target.copy(target);
    if (glide.t >= 1) glide = undefined;
  }
  draw(views[0]);
  recordFrame?.();
  if (!prediction || !action) return;
  for (const [id,{object}] of parts) {
    const pose = compared.get(id);
    object.visible = Boolean(pose);
    if (pose) setWorldPose(object,pose);
  }
  views[1].scene.add(model);
  draw(views[1]);
  views[0].scene.add(model);
}

requestAnimationFrame(tick);

async function perform(work) {
  busy = true;
  playing = false;
  updateControls();
  try { await work(); } catch (error) { status(error.message); }
  finally { busy = false; updateControls(); }
}

$('scan').onsubmit = event => {
  event.preventDefault();
  perform(async () => {
    status('Reading the PDF and matching its kit…');
    const file = $('pdf').files[0];
    const body = new FormData();
    body.append('file',file);
    const response = await fetch('/api/kits/scan',{method:'POST',body});
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail);
    await load(result.kit);
    await addHardware(result.plan.hardware);
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    sourceUrl = URL.createObjectURL(file);
    referenceSource = false;
    actions = result.plan.actions;
    $('review').checked = false;
    $('issues').textContent = result.plan.unresolved.join('\n');
    $('issues').hidden = !result.plan.unresolved.length;
    showStep(0);
    status(kit.name + ' · ' + kit.manual_id + ' · Review the parts and illustrative motion before export.');
  });
};
$('kit').onchange = () => perform(async () => {
  await load(catalog.find(item => item.article_number === $('kit').value));
  status('Kit loaded. Upload the matching PDF to generate steps.');
});
$('prediction').onchange = async () => {
  try {
    const result = JSON.parse(await $('prediction').files[0].text());
    const vector = (a,n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite);
    if (result.article_number !== kit.article_number || !Array.isArray(result.steps) || !result.steps.length) {
      throw new Error('Choose a prediction export for this kit.');
    }
    const stepIds = new Set();
    for (const entry of result.steps) {
      if (typeof entry.step !== 'string' || stepIds.has(entry.step) || !Array.isArray(entry.poses)) {
        throw new Error('Invalid or duplicate prediction step.');
      }
      stepIds.add(entry.step);
      const ids = new Set();
      for (const pose of entry.poses) {
        if (!parts.has(pose.node) || ids.has(pose.node) || !vector(pose.position,3) ||
            !vector(pose.quaternion,4) || Math.abs(Math.hypot(...pose.quaternion)-1)>.02) {
          throw new Error('Invalid prediction node or pose.');
        }
        ids.add(pose.node);
      }
    }
    prediction = result;
    $('use-pa').checked = false;
    $('review').checked = false;
    $('right').hidden = false;
    showStep(step);
    if (!actions.length) $('comparison').textContent = 'Prediction loaded. Read the manual to synchronize steps.';
  } catch (error) { $('comparison').textContent = error.message; }
};
$('use-pa').onchange = () => {
  $('review').checked = false;
  showStep(step);
  status($('use-pa').checked
    ? 'Playback uses imported positions where available. Remaining parts use IKEA positions. Review before export.'
    : 'Playback uses the original IKEA positions.');
};
$('review').onchange = updateControls;
$('prev').onclick = () => { playing = false; showStep(step-1); };
$('next').onclick = () => { playing = false; showStep(step+1); };
$('play').onclick = () => { playing = !playing; if (playing) showStep(step === actions.length-1 ? 0 : step); updateControls(); };

$('export').onclick = () => {
  const mimeType = window.MediaRecorder && ['video/mp4','video/webm;codecs=vp9','video/webm']
    .find(type => MediaRecorder.isTypeSupported(type));
  if (!mimeType || !HTMLCanvasElement.prototype.captureStream) return status('Video recording is unavailable in this browser.');
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext('2d');
  const stream = canvas.captureStream(30);
  const chunks = [];
  function cleanup() {
    recordFrame = undefined;
    recording = playing = false;
    controls.enabled = true;
    stream.getTracks().forEach(track => track.stop());
    updateControls();
  }
  try {
    const recorder = new MediaRecorder(stream,{mimeType});
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = () => { cleanup(); status('Recording failed.'); };
    recorder.onstop = () => {
      if (!recording) return;
      const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob(chunks,{type:mimeType}));
      link.download = kit.article_number + '-assembly.' + extension;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href),1000);
      cleanup();
      status('Exported ' + extension.toUpperCase() + '.');
    };
    recording = playing = true;
    controls.enabled = false;
    showStep(0);
    recordFrame = () => {
      const frame = views[0].renderer.domElement;
      const scale = Math.min(1280/frame.width,610/frame.height);
      const width = frame.width*scale, height = frame.height*scale;
      context.fillStyle = '#142622';
      context.fillRect(0,0,1280,720);
      context.drawImage(frame,(1280-width)/2,(610-height)/2,width,height);
      context.fillStyle = '#fff';
      context.font = '24px system-ui';
      context.fillText($('step').textContent,32,650,1216);
      context.font = '17px system-ui';
      context.fillText(($('use-pa').checked ? 'Imported poses where available · ' : '') + 'IKEA 3D Assembly Dataset · Inter IKEA Systems B.V. · CC BY-NC-SA 4.0',32,687);
      if (!playing && recorder.state === 'recording') recorder.stop();
    };
    recorder.start();
    status('Recording all steps. Keep this tab visible.');
  } catch (error) { cleanup(); status(error.message); }
};

perform(async () => {
  const response = await fetch('/api/kits');
  if (!response.ok) throw new Error('Could not load the kit catalog.');
  catalog = await response.json();
  for (const item of catalog) $('kit').add(new Option(item.name+' · '+item.article_number,item.article_number));
  const requested = new URLSearchParams(location.search).get('kit');
  const selected = catalog.find(item => item.article_number === requested);
  await load(selected || catalog[0]);
  if (selected) {
    const auto = new URLSearchParams(location.search).has('auto');
    const response = await fetch('/api/kits/' + encodeURIComponent(selected.article_number) + '/reference-plan' + (auto ? '?auto=true' : ''));
    if (response.ok) {
      const result = await response.json();
      actions = result.plan.actions;
      const manual = await fetch('/api/kits/' + encodeURIComponent(selected.article_number) + '/manual');
      if (!manual.ok) throw new Error('Could not load the matching manual.');
      sourceUrl = URL.createObjectURL(await manual.blob());
      referenceSource = true;
      $('issues').textContent = result.plan.unresolved.join('\n');
      $('issues').hidden = !result.plan.unresolved.length;
      showStep(0);
      if (selected.checked_plan && auto) status('Saved BEKVÄM steps with motion computed from the 3D model.');
      else if (selected.checked_plan) status('Saved BEKVÄM walkthrough with individual rail, dowel, and screw actions.');
      else status('Using dataset assembly annotations. Step numbers are dataset stages; compare the displayed manual. Motion is illustrative.');
    } else if (response.status === 404) {
      status('Model loaded. Upload the matching PDF to generate steps with Gemini.');
    } else throw new Error('Could not load the annotated steps for this model.');
  } else status('Kit loaded. Upload the matching PDF to generate steps.');
});
