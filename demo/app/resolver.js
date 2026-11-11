// Dimension resolver: fills every template parameter from the best available source
// and records where each value came from (stated / derived / estimated / user).
// All values are millimetres unless noted.

export const PRIORS = {
  star_base:         { arms: 5, reach: 280, arm_w_root: 68, arm_w_tip: 40, arm_h: 30, arm_z: 10,
                       hub_d: 100, hub_h: 70, socket_d: 38, socket_h: 45, socket_z: -1 },
  caster:            { wheel_d: 50, wheel_w: 10, housing_w: 22, offset: 10, stem_d: 11, stem_len: 22 },
  gas_cylinder:      { body_d: 50, body_len: 268, taper_len: 60, rod_d: 28, rod_len: 58 },
  telescoping_cover: { lower_d: 70, lower_h: 120, upper_d: 60, upper_h: 104, wall: 4, top_hole_d: 32 },
};

const isRef = v => typeof v === 'string' && v.startsWith('=');

export function resolvePlan(plan, userValues = {}) {
  // Pass 1: template params (user > stated in manual > category prior)
  const parts = plan.parts.map(p => {
    const prior = PRIORS[p.template];
    if (!prior) throw new Error(`No template "${p.template}" for part ${p.label}`);
    const params = {}, provenance = {};
    for (const [k, def] of Object.entries(prior)) {
      const user = userValues[p.label]?.[k];
      if (user != null) { params[k] = user; provenance[k] = 'user'; }
      else if (p.params?.[k] != null && !isRef(p.params[k])) { params[k] = p.params[k]; provenance[k] = p.provenance?.[k] ?? 'stated'; }
      else { params[k] = def; provenance[k] = 'estimated'; }
    }
    return { ...p, params, provenance, features: (p.features ?? []).map(f => ({ ...f })) };
  });

  // Pass 2: equations between parts, e.g. "=F.stem_len" (socket depth must match the caster stem)
  const byLabel = Object.fromEntries(parts.map(p => [p.label, p]));
  for (const p of parts) {
    for (const f of p.features) {
      f.provenance = {};
      for (const key of ['diameter', 'depth']) {
        const v = f[key];
        if (isRef(v)) {
          const [label, param] = v.slice(1).split('.');
          const src = byLabel[label];
          if (!src || src.params[param] == null) throw new Error(`Bad reference ${v} in ${p.label}.${f.name}`);
          f[key] = src.params[param];
          f.provenance[key] = 'derived';
        } else {
          f.provenance[key] = 'stated';
        }
      }
    }
  }
  return parts;
}
