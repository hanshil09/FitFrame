// Geometry worker: runs manifold-3d (WASM) off the main thread so cuts never block rendering.
// In:  { parts: [resolved part specs] }
// Out: { ok, parts: [{ label, bodies: [{ name, material, position, index }], anchors }], ms }
import Module from 'https://cdn.jsdelivr.net/npm/manifold-3d@3.3.2/manifold.js';
import { buildPart } from './templates.js';

const ready = Module({ locateFile: () => 'https://cdn.jsdelivr.net/npm/manifold-3d@3.3.2/manifold.wasm' })
  .then(w => { w.setup(); return w; });

// manifold is Z-up, Three.js is Y-up: (x, y, z) -> (x, z, -y)  (a pure rotation, so winding is kept)
const yUp = v => v && [v[0], v[2], -v[1]];

onmessage = async e => {
  try {
    const w = await ready;
    const t0 = performance.now();
    const out = [], transfer = [];
    for (const spec of e.data.parts) {
      const built = buildPart(w, spec);
      const bodies = built.bodies.map(b => {
        const mesh = b.solid.getMesh();
        const np = mesh.numProp, vp = mesh.vertProperties, nv = vp.length / np;
        const position = new Float32Array(nv * 3);
        for (let i = 0; i < nv; i++) {
          position[i * 3] = vp[i * np];
          position[i * 3 + 1] = vp[i * np + 2];
          position[i * 3 + 2] = -vp[i * np + 1];
        }
        const index = new Uint32Array(mesh.triVerts);
        transfer.push(position.buffer, index.buffer);
        b.solid.delete();
        return { name: b.name, material: b.material, position, index };
      });
      const anchors = {};
      for (const [k, a] of Object.entries(built.anchors)) anchors[k] = { ...a, o: yUp(a.o), n: yUp(a.n), up: yUp(a.up) };
      out.push({ label: spec.label, bodies, anchors });
    }
    postMessage({ ok: true, parts: out, ms: performance.now() - t0 }, transfer);
  } catch (err) {
    postMessage({ ok: false, error: String(err?.stack || err) });
  }
};
