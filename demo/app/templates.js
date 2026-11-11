// Part templates. Each one is a small function: numbers in -> solid + named anchors out.
// Built with manifold-3d (CSG) inside the geometry worker. Units: mm. Axes here: Z up
// (manifold's convention); the worker converts everything to Three.js Y-up afterwards.
//
// A template returns:
//   bodies:  [{ name, material, solid }]   solids with a material tag (nylon, chrome, ...)
//   sites:   { name: [{ o, n, up? }] }     places where the feature list may cut (o = point on surface, n = outward normal)
//   anchors: { name: { o, n, up? } }       named frames the mate solver uses

const D2R = Math.PI / 180;

export const TEMPLATES = {
  star_base(w, p) {
    const { Manifold, CrossSection } = w;
    const pieces = [], tips = [];
    const tipR = p.arm_w_tip / 2;
    for (let i = 0; i < p.arms; i++) {
      const deg = 90 + i * 360 / p.arms;
      const c = Math.cos(deg * D2R), s = Math.sin(deg * D2R);
      const outline = new CrossSection([[[0, -p.arm_w_root / 2], [p.reach, -tipR], [p.reach, tipR], [0, p.arm_w_root / 2]]])
        .add(CrossSection.circle(tipR, 40).translate([p.reach, 0]));
      pieces.push(outline.extrude(p.arm_h).translate([0, 0, p.arm_z]).rotate([0, 0, deg]));
      const sx = c * p.reach, sy = s * p.reach;
      pieces.push(Manifold.cylinder(p.socket_h, p.socket_d / 2, p.socket_d / 2, 40).translate([sx, sy, p.socket_z]));
      tips.push({ o: [sx, sy, p.socket_z], n: [0, 0, -1], up: [c, s, 0] });
    }
    pieces.push(Manifold.cylinder(p.hub_h, p.hub_d * 0.55, p.hub_d / 2, 64));
    return {
      bodies: [{ name: 'shell', material: 'nylon', solid: Manifold.union(pieces) }],
      sites: { hub_top_centre: [{ o: [0, 0, p.hub_h], n: [0, 0, 1] }], arm_tips_bottom: tips },
      anchors: { hub_top: { o: [0, 0, p.hub_h], n: [0, 0, 1], r: p.hub_d / 2 } },
    };
  },

  caster(w, p) {
    const { Manifold } = w;
    const r = p.wheel_d / 2, hr = r * 1.16;
    const keepTop = Manifold.cube([400, 400, 400]).translate([-200, -200, r]);
    const housing = Manifold.cylinder(p.housing_w, hr, hr, 48, true).rotate([0, 90, 0])
      .translate([0, -p.offset, r]).intersect(keepTop);
    const dx = p.housing_w / 2 + p.wheel_w / 2 + 0.5;
    const wheels = Manifold.union([-dx, dx].map(x =>
      Manifold.cylinder(p.wheel_w, r, r, 48, true).rotate([0, 90, 0]).translate([x, -p.offset, r])));
    const plateZ = r + hr - 2;
    const metal = Manifold.union([
      Manifold.cylinder(5, 13, 13, 32).translate([0, 0, plateZ]),
      Manifold.cylinder(p.stem_len, p.stem_d / 2, p.stem_d / 2, 24).translate([0, 0, plateZ + 5]),
    ]);
    const top = plateZ + 5 + p.stem_len;
    return {
      bodies: [
        { name: 'housing', material: 'nylon', solid: housing },
        { name: 'wheels', material: 'rubber', solid: wheels },
        { name: 'stem', material: 'chrome', solid: metal },
      ],
      sites: {},
      anchors: { stem_tip: { o: [0, 0, top], n: [0, 0, 1], up: [0, -1, 0] } },
    };
  },

  gas_cylinder(w, p) {
    const { CrossSection } = w;
    const R = p.body_d / 2, L = p.body_len, rr = p.rod_d / 2;
    // Profiles are (radius, height) outlines spun around the axis
    const body = new CrossSection([[[0, 0], [R - 3, 0], [R - 0.5, p.taper_len], [R, p.taper_len + 3],
      [R, L - 8], [R - 3, L - 2], [rr + 0.5, L], [0, L]]]).revolve(64);
    const rod = new CrossSection([[[0, L], [rr, L], [rr, L + p.rod_len], [rr - 5, L + p.rod_len + 4],
      [4.5, L + p.rod_len + 5], [4.5, L + p.rod_len + 16], [0, L + p.rod_len + 16]]]).revolve(48);
    return {
      bodies: [{ name: 'body', material: 'paint', solid: body }, { name: 'rod', material: 'chrome', solid: rod }],
      sites: {},
      anchors: { tip: { o: [0, 0, 0], n: [0, 0, -1] }, top: { o: [0, 0, L + p.rod_len + 16], n: [0, 0, 1] } },
    };
  },

  telescoping_cover(w, p) {
    const { CrossSection } = w;
    const Ro = p.lower_d / 2, Ru = p.upper_d / 2, t = p.wall, H1 = p.lower_h, H2 = H1 + p.upper_h, rh = p.top_hole_d / 2;
    // Hollow profile: up the outside, across the top lip, back down the inside
    const shell = new CrossSection([[[Ro - t, 0], [Ro, 0], [Ro, H1 - 5], [Ro - 2, H1], [Ru, H1 + 2], [Ru, H2],
      [rh + 1.5, H2 + 4], [rh, H2 + 4], [rh, H2], [Ru - t, H2 - 2], [Ru - t, H1 + 4], [Ro - t, H1]]]).revolve(64);
    return {
      bodies: [{ name: 'shell', material: 'nylon', solid: shell }],
      sites: {},
      anchors: { bottom: { o: [0, 0, 0], n: [0, 0, -1], r: Ro }, top: { o: [0, 0, H2 + 4], n: [0, 0, 1] } },
    };
  },
};

// Feature list executor: the model describes cuts as data; this code performs them.
function applyFeature(w, part, f) {
  const sites = part.sites[f.at];
  if (!sites) throw new Error(`Unknown site "${f.at}"`);
  const body = part.bodies[0];
  if (f.type !== 'hole') throw new Error(`Unsupported feature "${f.type}"`);
  const cutters = sites.map((s, k) => {
    const [ox, oy, oz] = s.o, n = s.n;
    // Cylinder runs along local +Z; build a frame whose Z axis points into the part (-n)
    const wz = [-n[0], -n[1], -n[2]];
    const ref = Math.abs(wz[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const ux = norm(cross(ref, wz)), vy = cross(wz, ux);
    const start = [ox + n[0], oy + n[1], oz + n[2]];   // begin 1 mm outside the surface
    const m = [...ux, 0, ...vy, 0, ...wz, 0, ...start, 1];
    const anchor = { o: [ox - n[0] * f.depth, oy - n[1] * f.depth, oz - n[2] * f.depth], n, up: s.up, depth: f.depth, r: f.diameter / 2 };
    part.anchors[sites.length > 1 ? `${f.name}[${k}]` : f.name] = anchor;
    return w.Manifold.cylinder(f.depth + 1, f.diameter / 2, f.diameter / 2, 32).transform(m);
  });
  body.solid = body.solid.subtract(w.Manifold.union(cutters));
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = v => { const l = Math.hypot(...v); return v.map(x => x / l); };

export function buildPart(w, spec) {
  const tpl = TEMPLATES[spec.template];
  if (!tpl) throw new Error(`No template "${spec.template}"`);
  const part = tpl(w, spec.params);
  for (const f of spec.features ?? []) applyFeature(w, part, f);
  return part;
}
