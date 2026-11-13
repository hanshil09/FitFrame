import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';

const $ = id => document.getElementById(id);
const camera = new THREE.PerspectiveCamera(40,1,.001,100);
const views = ['left','right'].map(id => {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xeaf0e9);
  scene.add(new THREE.HemisphereLight(0xffffff,0x717971,2));
  const light = new THREE.DirectionalLight(0xffffff,2);
  light.position.set(2,4,3);
  scene.add(light);
  const renderer = new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
  $(id).append(renderer.domElement);
  return {scene,renderer,host:$(id)};
});
const controls = new OrbitControls(camera,views[0].renderer.domElement);
const loader = new GLTFLoader();
const assemblyCenter = new THREE.Vector3();
let catalog, kit, model, parts, prediction, actions = [], step = 0, started = 0;
let busy = false, playing = false, recording = false, recordFrame, travel, sourceUrl, referenceSource = false;
const interval = 1700;

function status(message) { $('status').textContent = message; }

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

function showStep(index) {
  step = index;
  started = performance.now();
  const action = actions[index];
  $('step').textContent = action ? 'Step ' + action.step + ' · ' + action.caption : 'Finished IKEA model';
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
  const asset = await loader.loadAsync('/api/kits/' + item.article_number + '/model');
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
        localAxis:axis, slender:axes[0] > 2*axes[1], length:axes[0],
        centered:Math.abs(bounds.min.getComponent(longest)+bounds.max.getComponent(longest)) < axes[0]*.1,
        worldPosition:object.getWorldPosition(new THREE.Vector3()),
        worldRotation:object.getWorldQuaternion(new THREE.Quaternion())
      });
    }
  });
  if (mapped.size !== item.mesh_nodes) throw new Error('Model nodes differ from the catalog.');
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
  parts = mapped;
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
  if (playing && now-started >= interval) {
    if (step < actions.length-1) showStep(step+1);
    else { playing = false; updateControls(); }
  }
  const progress = Math.min(1,Math.max(0,(now-started)/(interval*.75)));
  const action = actions[step];
  const previous = new Set(actions.slice(0,step).flatMap(item => item.nodes));
  const active = new Set(action?.nodes);
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
    if (active.has(id) && !previous.has(id)) {
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
    if (active.has(id) && action.motion === 'tighten' && isFastener) {
      object.rotateOnAxis(localAxis,(progress-1)*Math.PI*2);
    }
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
    const response = await fetch('/api/kits/' + encodeURIComponent(selected.article_number) + '/reference-plan');
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
      status('Using dataset assembly annotations. Step numbers are dataset stages; compare the displayed manual. Motion is illustrative.');
    } else if (response.status === 404) {
      status('Model loaded. Upload the matching PDF to generate steps with Gemini.');
    } else throw new Error('Could not load the annotated steps for this model.');
  } else status('Kit loaded. Upload the matching PDF to generate steps.');
});
