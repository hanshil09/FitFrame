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

// Generic box-shaped parts: seats, backrests, boards, brackets. Origin = centre of the bottom face.
function block(w, p, material) {
  const { Manifold } = w;
  const W = p.w, D = p.d, H = p.h;
  const solid = Manifold.cube([W, D, H]).translate([-W / 2, -D / 2, 0]);
  const r = Math.min(W, D, H) / 4;
  return {
    bodies: [{ name: 'body', material, solid }],
    sites: {},
    // `face` = the face's extent along two in-plane axes, so several fasteners can be spread across it
    anchors: {
      top:    { o: [0, 0, H], n: [0, 0, 1], r, face: { u: [1, 0, 0], v: [0, 1, 0], size: [W, D] } },
      bottom: { o: [0, 0, 0], n: [0, 0, -1], r, face: { u: [1, 0, 0], v: [0, 1, 0], size: [W, D] } },
      front:  { o: [0, -D / 2, H / 2], n: [0, -1, 0], r, face: { u: [1, 0, 0], v: [0, 0, 1], size: [W, H] } },
      back:   { o: [0, D / 2, H / 2], n: [0, 1, 0], r, face: { u: [1, 0, 0], v: [0, 0, 1], size: [W, H] } },
      left:   { o: [-W / 2, 0, H / 2], n: [-1, 0, 0], r, face: { u: [0, 1, 0], v: [0, 0, 1], size: [D, H] } },
      right:  { o: [W / 2, 0, H / 2], n: [1, 0, 0], r, face: { u: [0, 1, 0], v: [0, 0, 1], size: [D, H] } },
    },
  };
}
TEMPLATES.panel = (w, p) => block(w, p, 'panel');
TEMPLATES.unsupported = (w, p) => block(w, p, 'unsupported');

// Hardware, drawn by kind from diameter and length. Origin = the tip that goes in first; the axis is +Z.
TEMPLATES.fastener = (w, p, spec = {}) => {
  const { CrossSection, Manifold } = w;
  const r = p.diameter / 2, L = p.length;
  const lathe = pts => new CrossSection([pts]).revolve(32);
  const make = (solid, material, embed, top) => ({
    bodies: [{ name: 'body', material, solid }],
    sites: {},
    anchors: { tip: { o: [0, 0, 0], n: [0, 0, -1], embed }, head: { o: [0, 0, top], n: [0, 0, 1] } },
  });
  switch (spec.kind) {
    case 'dowel': {            // plain wooden peg, half of it goes in
      const c = Math.min(r * 0.3, 1.5);
      return make(lathe([[0, 0], [r - c, 0], [r, c], [r, L - c], [r - c, L], [0, L]]), 'wood', L * 0.5, L);
    }
    case 'cam_pin': {          // threaded end, collar, thin neck, round head that the cam lock grips
      const a = L * 0.38, b = L * 0.46, h = L * 0.84;
      return make(lathe([[0, 0], [r * 0.5, 0], [r, r * 0.8], [r, a], [r * 1.45, a], [r * 1.45, b], [r * 0.6, b],
        [r * 0.6, h], [r * 1.05, h + r * 0.4], [r * 1.05, L - r * 0.3], [r * 0.7, L], [0, L]]), 'chrome', a, L);
    }
    case 'cam_nut': {          // round cam lock with a screwdriver slot, sits flush in its hole
      const slot = Manifold.cube([r * 1.4, r * 0.3, L * 0.35]).translate([-r * 0.7, -r * 0.15, L * 0.66]);
      return make(Manifold.cylinder(L, r, r, 32).subtract(slot), 'chrome', L * 0.98, L);
    }
    case 'foot': {             // threaded stem with a wide pad
      const R = Math.max(r * 2.4, 11), pad = 7;
      return make(lathe([[0, 0], [r, 0], [r, L], [R, L], [R, L + pad], [0, L + pad]]), 'nylon', L, L + pad);
    }
    default: {                 // screw or bolt
      const R = r * 1.9, hh = Math.max(2, p.diameter * 0.6);
      return make(lathe([[0, 0], [r * 0.45, 0], [r, Math.min(r * 1.4, L * 0.3)], [r, L], [R, L], [R, L + hh], [0, L + hh]]),
        'chrome', L * 0.85, L + hh);
    }
  }
};

// ---------- Chair parts ----------
// Convention (Z up): chair front = -Y, back = +Y, right = +X.
const box = (w, x0, x1, y0, y1, z0, z1) => w.Manifold.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0]);

// The six bounding-box faces, so generic anchors (top, back, ...) always resolve
function faces(x0, x1, y0, y1, z0, z1) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2, W = x1 - x0, D = y1 - y0, H = z1 - z0;
  const r = Math.min(W, D, H) / 4;
  const fXY = { u: [1, 0, 0], v: [0, 1, 0], size: [W, D] }, fXZ = { u: [1, 0, 0], v: [0, 0, 1], size: [W, H] }, fYZ = { u: [0, 1, 0], v: [0, 0, 1], size: [D, H] };
  return {
    top:    { o: [cx, cy, z1], n: [0, 0, 1], r, face: fXY },
    bottom: { o: [cx, cy, z0], n: [0, 0, -1], r, face: fXY },
    front:  { o: [cx, y0, cz], n: [0, -1, 0], r, face: fXZ },
    back:   { o: [cx, y1, cz], n: [0, 1, 0], r, face: fXZ },
    left:   { o: [x0, cy, cz], n: [-1, 0, 0], r, face: fYZ },
    right:  { o: [x1, cy, cz], n: [1, 0, 0], r, face: fYZ },
  };
}

// Rounded rectangle in the XY plane, centred
const roundRect = (w, W, D, r) => w.CrossSection.square([W - 2 * r, D - 2 * r], true).offset(r, 'Round', 2, 24);

// Seat cushion on a thin shell. Origin = centre of the underside.
TEMPLATES.chair_seat = (w, p) => {
  const shell = roundRect(w, p.w, p.d, 60).extrude(12);
  const cushion = roundRect(w, p.w - 16, p.d - 16, 55).extrude(p.h - 12).translate([0, 0, 12]);
  return {
    bodies: [{ name: 'shell', material: 'nylon', solid: shell }, { name: 'cushion', material: 'fabric', solid: cushion }],
    sites: {},
    anchors: {
      ...faces(-p.w / 2, p.w / 2, -p.d / 2, p.d / 2, 0, p.h),
      mech_mount: { o: [0, 20, 0], n: [0, 0, -1], r: 60, face: { u: [1, 0, 0], v: [0, 1, 0], size: [150, 150] } },
      'arm_mount[0]': { o: [-p.w / 2 + 70, 0, 0], n: [0, 0, -1], up: [-1, 0, 0], r: 40, face: { u: [0, 1, 0], v: [1, 0, 0], size: [180, 50] } },
      'arm_mount[1]': { o: [p.w / 2 - 70, 0, 0], n: [0, 0, -1], up: [1, 0, 0], r: 40, face: { u: [0, 1, 0], v: [1, 0, 0], size: [180, 50] } },
    },
  };
};

// Mesh backrest standing upright: a frame with a thinner mesh panel inside. Origin = bottom centre.
TEMPLATES.chair_backrest = (w, p) => {
  const outline = roundRect(w, p.w, p.h, 90);
  const frame = outline.subtract(roundRect(w, p.w - 50, p.h - 50, 70)).extrude(p.t).rotate([90, 0, 0]).translate([0, p.t / 2, p.h / 2]);
  const mesh = roundRect(w, p.w - 40, p.h - 40, 72).extrude(5).rotate([90, 0, 0]).translate([0, 2.5, p.h / 2]);
  return {
    bodies: [{ name: 'frame', material: 'nylon', solid: frame }, { name: 'mesh', material: 'mesh', solid: mesh }],
    sites: {},
    anchors: {
      ...faces(-p.w / 2, p.w / 2, -p.t / 2, p.t / 2, 0, p.h),
      // where the support bar bolts on: low on the back, facing backwards
      back: { o: [0, p.t / 2, p.h * 0.3], n: [0, 1, 0], up: [0, 0, 1], r: 40, face: { u: [1, 0, 0], v: [0, 0, 1], size: [70, 140] } },
      support_mount: { o: [0, p.t / 2, p.h * 0.3], n: [0, 1, 0], up: [0, 0, 1], r: 40, face: { u: [1, 0, 0], v: [0, 0, 1], size: [70, 140] } },
    },
  };
};

// L-shaped steel bar: an upright that holds the backrest and a foot that slides into the mechanism.
// Origin = the bend. The foot runs forward (-Y) to its tip.
TEMPLATES.backrest_support = (w, p) => {
  const bw = p.width, t = 10;
  const upright = box(w, -bw / 2, bw / 2, 0, t, 0, p.height);
  const foot = box(w, -bw / 2 + 5, bw / 2 - 5, -p.reach, t, 0, t + 4);
  return {
    bodies: [{ name: 'bar', material: 'paint', solid: Manifold_union(w, [upright, foot]) }],
    sites: {},
    anchors: {
      ...faces(-bw / 2, bw / 2, -p.reach, t, 0, p.height),
      // face that sits against the backrest
      front: { o: [0, 0, p.height * 0.75], n: [0, -1, 0], up: [0, 0, 1], r: 30, face: { u: [1, 0, 0], v: [0, 0, 1], size: [bw * 0.6, 120] } },
      back: { o: [0, t, p.height * 0.75], n: [0, 1, 0], up: [0, 0, 1], r: 30, face: { u: [1, 0, 0], v: [0, 0, 1], size: [bw * 0.6, 120] } },
      // the foot tip goes forward into the mechanism
      bottom: { o: [0, -p.reach, (t + 4) / 2], n: [0, -1, 0], up: [0, 0, 1], r: 25 },
      tip: { o: [0, -p.reach, (t + 4) / 2], n: [0, -1, 0], up: [0, 0, 1], r: 25 },
    },
  };
};
const Manifold_union = (w, list) => w.Manifold.union(list);

// Tilt mechanism: a top plate under the seat, a body below with the cylinder socket, and a lever.
// Origin = centre of the top plate's top face.
TEMPLATES.chair_mechanism = (w, p) => {
  const plate = box(w, -p.w / 2, p.w / 2, -p.d / 2, p.d / 2, -8, 0);
  const body = box(w, -60, 60, -80, 80, -70, -8);
  const socket = w.Manifold.cylinder(22, 26, 26, 32).translate([0, 0, -92]);
  const lever = box(w, 60, 190, -10, 10, -40, -30);
  const paddle = w.Manifold.cylinder(16, 22, 22, 24).rotate([0, 90, 0]).translate([190, 0, -35]);
  const shell = w.Manifold.union([plate, body, socket]).subtract(
    box(w, -14, 14, 40, 81, -48, -26));                                  // slot for the backrest support foot
  return {
    bodies: [{ name: 'body', material: 'paint', solid: shell }, { name: 'lever', material: 'nylon', solid: w.Manifold.union([lever, paddle]) }],
    sites: {},
    anchors: {
      ...faces(-p.w / 2, p.w / 2, -p.d / 2, p.d / 2, -92, 0),
      top: { o: [0, 0, 0], n: [0, 0, 1], r: 60, face: { u: [1, 0, 0], v: [0, 1, 0], size: [p.w * 0.7, p.d * 0.7] } },
      // the cylinder rod enters 45 mm from below
      bottom: { o: [0, 0, -92 + 45], n: [0, 0, -1], r: 26, depth: 45 },
      cylinder_socket: { o: [0, 0, -92 + 45], n: [0, 0, -1], r: 26, depth: 45 },
      // the backrest support foot slides into the slot at the back
      back: { o: [0, 40, -37], n: [0, 1, 0], up: [0, 0, 1], r: 18, depth: 40 },
      support_slot: { o: [0, 40, -37], n: [0, 1, 0], up: [0, 0, 1], r: 18, depth: 40 },
      left: { o: [-60, 50, -37], n: [-1, 0, 0], r: 12, depth: 20 },
      right: { o: [60, -40, -40], n: [1, 0, 0], r: 12, depth: 10 },
    },
  };
};

// Armrest: a plate that screws under the seat, an upright outside the seat edge, and a pad.
// Origin = top of the mounting plate. Local +X points outward, away from the seat.
TEMPLATES.armrest = (w, p) => {
  const plate = box(w, -35, p.reach, -110, 110, -10, 0);
  const post = box(w, p.reach - 25, p.reach, -25, 25, -10, p.height);
  const pad = roundRect(w, 60, p.pad_len, 25).extrude(22).translate([p.reach - 12, 0, p.height]);
  return {
    bodies: [{ name: 'frame', material: 'nylon', solid: w.Manifold.union([plate, post]) }, { name: 'pad', material: 'rubber', solid: pad }],
    sites: {},
    anchors: {
      ...faces(-35, p.reach + 18, -p.pad_len / 2, p.pad_len / 2, -10, p.height + 22),
      top: { o: [0, 0, 0], n: [0, 0, 1], up: [1, 0, 0], r: 35, face: { u: [0, 1, 0], v: [1, 0, 0], size: [180, 50] } },
      mount: { o: [0, 0, 0], n: [0, 0, 1], up: [1, 0, 0], r: 35, face: { u: [0, 1, 0], v: [1, 0, 0], size: [180, 50] } },
      bottom: { o: [0, 0, -10], n: [0, 0, -1], r: 35, face: { u: [0, 1, 0], v: [1, 0, 0], size: [180, 50] } },
    },
  };
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
  const part = tpl(w, spec.params, spec);
  for (const f of spec.features ?? []) applyFeature(w, part, f);
  return part;
}
