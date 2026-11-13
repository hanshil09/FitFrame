// Dimension resolver: fills every template parameter from the best available source
// and records where each value came from (user > stated > derived > estimated). Units: mm.

export const PRIORS = {
  star_base:         { arms: 5, reach: 280, arm_w_root: 68, arm_w_tip: 40, arm_h: 30, arm_z: 10,
                       hub_d: 100, hub_h: 70, socket_d: 38, socket_h: 45, socket_z: -1 },
  caster:            { wheel_d: 50, wheel_w: 10, housing_w: 22, offset: 10, stem_d: 11, stem_len: 22 },
  gas_cylinder:      { body_d: 50, body_len: 268, taper_len: 60, rod_d: 28, rod_len: 58 },
  telescoping_cover: { lower_d: 70, lower_h: 120, upper_d: 60, upper_h: 104, wall: 4, top_hole_d: 32 },
  chair_seat:        { w: 480, d: 460, h: 85 },
  chair_backrest:    { w: 440, h: 500, t: 28 },
  backrest_support:  { width: 60, height: 320, reach: 270 },
  chair_mechanism:   { w: 200, d: 250 },
  armrest:           { reach: 150, height: 210, pad_len: 250 },
  panel:             { w: 400, h: 30, d: 400 },
  unsupported:       { w: 200, h: 200, d: 200 },
  fastener:          { diameter: 6, length: 25 },
};

// Cuts a template gets when the plan lists none (so its anchors exist). "=X.param" values
// are equations against another part of the given template, resolved below.
const DEFAULT_FEATURES = {
  star_base: [
    { type: 'hole', name: 'bore',   at: 'hub_top_centre',  diameter: '=gas_cylinder.body_d', depth: 60, fallback: { diameter: 50 } },
    { type: 'hole', name: 'socket', at: 'arm_tips_bottom', diameter: '=caster.stem_d', depth: '=caster.stem_len', fallback: { diameter: 11, depth: 22 } },
  ],
};

// Which hardware shape to draw, from the part's name when the plan does not say
function hardwareKind(name = '') {
  const n = name.toLowerCase();
  if (/dowel|peg/.test(n)) return 'dowel';
  if (/foot|feet|glide|level/.test(n)) return 'foot';
  if (/cam/.test(n)) return /pin|bolt|screw|stud|dowel/.test(n) ? 'cam_pin' : 'cam_nut';
  if (/connecting bolt/.test(n)) return 'cam_pin';
  return 'screw';
}

const isRef = v => typeof v === 'string' && v.startsWith('=');
const clampDim = v => Math.min(3000, Math.max(2, Number(v) || 0));

export function resolvePlan(plan, userValues = {}) {
  const parts = plan.parts.map(p => {
    const prior = PRIORS[p.template] ?? PRIORS.unsupported;
    const template = PRIORS[p.template] ? p.template : 'unsupported';
    const params = {}, provenance = {};
    for (const [k, def] of Object.entries(prior)) {
      const user = userValues[p.label]?.[k];
      const given = p.params?.[k];
      if (user != null) { params[k] = user; provenance[k] = 'user'; }
      else if (given != null && !isRef(given)) { params[k] = given; provenance[k] = p.provenance?.[k] ?? 'stated'; }
      else { params[k] = def; provenance[k] = 'estimated'; }
    }
    if (template === 'panel' || template === 'unsupported') for (const k of ['w', 'h', 'd']) params[k] = clampDim(params[k]);
    const fromPlan = !!p.features?.length;
    const features = (fromPlan ? p.features : DEFAULT_FEATURES[template] ?? []).map(f => ({ ...f, fromPlan }));
    const kind = template === 'fastener' ? (p.kind ?? hardwareKind(p.name)) : undefined;
    return { ...p, template, kind, params, provenance, features };
  });

  // Equations between parts: "=F.stem_len" (by label) or "=caster.stem_len" (by template)
  const find = key => parts.find(p => p.label === key) ?? parts.find(p => p.template === key);
  for (const p of parts) {
    for (const f of p.features) {
      f.provenance = {};
      for (const key of ['diameter', 'depth']) {
        const v = f[key];
        if (isRef(v)) {
          const [who, param] = v.slice(1).split('.');
          const src = find(who);
          if (src && src.params[param] != null) { f[key] = src.params[param]; f.provenance[key] = 'derived'; }
          else { f[key] = f.fallback?.[key] ?? 20; f.provenance[key] = 'estimated'; }
        } else {
          f.provenance[key] = f.fromPlan ? 'stated' : 'estimated';
        }
      }
    }
  }
  return parts;
}
