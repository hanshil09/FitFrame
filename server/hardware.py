"""Hardware the 3D model leaves out: screws, dowels and cam locks the manual shows.

Most catalog models are just the boards. The model reads the hardware for each step from the manual
(kind, IKEA part number, length, how many, which two parts it joins); this module puts each piece
where those two parts meet in the finished model, and picks what it looks like:

  exact    - a real IKEA hardware model with the same part number, from a kit that has one
  similar  - a real IKEA hardware model of the same kind, the closest in length
  drawn    - drawn from a profile (same shapes as web/templates.js) when no real model fits

Positions are estimates: the joint and the count come from the manual, the spacing does not.
"""
import json
import re
from functools import lru_cache
from pathlib import Path

from geometry import kit_geometry

ROOT = Path(__file__).resolve().parent.parent / "samples" / "ikea-kits"
KINDS = {"screw": "screw", "bolt": "screw", "cam_pin": "screw", "dowel": "dowel", "cam_nut": "cam_nut"}
BEFORE = {"dowel", "cam_pin"}       # fitted into the part already built, before the next part goes on
TYPICAL_MM = {"screw": 40, "dowel": 30, "cam_nut": 15}


def _classify(part):
    if part["slender"]:
        return "screw" if part["head"] else "dowel"
    big, middle, small = part["sizes"]
    return "cam_nut" if big < 1.3 * middle and small < 0.8 * middle else "other"


def _canonical(part):
    """The part's mesh in millimetres with the tip at the origin and the axis along +Z toward the head."""
    if part["slender"]:
        z = tuple(c * (part["head"] or 1) for c in part["axis"])
    else:
        z = part["thin_axis"]
    helper = (1, 0, 0) if abs(z[0]) < 0.9 else (0, 1, 0)
    x = (helper[1] * z[2] - helper[2] * z[1], helper[2] * z[0] - helper[0] * z[2], helper[0] * z[1] - helper[1] * z[0])
    norm = sum(c * c for c in x) ** 0.5
    x = tuple(c / norm for c in x)
    y = (z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0])
    centre = part["center"]
    local = [tuple(sum((p[i] - centre[i]) * axis[i] for i in range(3)) * 1000 for axis in (x, y, z)) for p in part["world"]]
    lowest = min(p[2] for p in local)
    positions = [round(v, 2) for p in local for v in (p[0], p[1], p[2] - lowest)]
    return positions, [i for triangle in part["triangles"] for i in triangle]


@lru_cache(maxsize=1)
def library():
    """Real hardware from the kits whose models include it (IKEA 3D Assembly kits, in metres)."""
    entries = {}
    for kit in json.loads((ROOT / "catalog.json").read_text(encoding="utf-8")):
        if not kit["article_number"].isdigit():
            continue
        geometry = kit_geometry(ROOT / kit["model"])
        for part in geometry["parts"].values():
            match = re.match(r"(\d{6,8})", part["name"])
            if not match or match.group(1) in entries:
                continue
            if not (part["fastener"] or max(part["sizes"]) < 0.12 * geometry["diagonal"]):
                continue
            kind = _classify(part)
            if kind == "other":
                continue
            entries[match.group(1)] = {"number": match.group(1), "kind": kind, "kit": kit["name"],
                                       "length_mm": round(part["length"] * 1000 if part["slender"] else part["sizes"][2] * 1000, 1),
                                       "width_mm": round(part["sizes"][1] * 1000, 1), "_part": part}
    return entries


def mesh(number):
    entry = library().get(number)
    if not entry:
        return None
    positions, indices = _canonical(entry["_part"])
    return {"number": number, "kind": entry["kind"], "length_mm": entry["length_mm"], "width_mm": entry["width_mm"],
            "positions": positions, "indices": indices}


def index():
    return {n: {k: v for k, v in e.items() if not k.startswith("_")} for n, e in library().items()}


def _look(item):
    """(source, library number or None, kind) for one hardware item from the manual."""
    kind = KINDS.get(item["kind"], "screw")
    number = re.sub(r"\D", "", item.get("number") or "")
    entries = library()
    if number in entries:
        return "exact", number, entries[number]["kind"]
    same = [e for e in entries.values() if e["kind"] == kind]
    if same:
        wanted = item.get("length_mm") or TYPICAL_MM[kind]
        best = min(same, key=lambda e: abs(e["length_mm"] - wanted))
        return "similar", best["number"], kind
    return "drawn", None, kind


def _joint(geometry, a, b):
    """Where parts a and b meet: the axis across the joint and the part a fastener goes through."""
    pa, pb = geometry["parts"][a], geometry["parts"][b]
    tolerance = 0.004 * geometry["diagonal"]
    overlaps = [min(pa["hi"][i], pb["hi"][i]) - max(pa["lo"][i], pb["lo"][i]) for i in range(3)]
    if min(overlaps) < -tolerance:
        return None
    k = min(range(3), key=lambda i: overlaps[i])
    # the fastener goes through the thinner part across the joint (the panel) into the other one
    through, other = (pa, pb) if (pa["hi"][k] - pa["lo"][k]) <= (pb["hi"][k] - pb["lo"][k]) else (pb, pa)
    inward = 1 if other["center"][k] > through["center"][k] else -1
    face = [max(pa["lo"][i], pb["lo"][i]) for i in range(3)], [min(pa["hi"][i], pb["hi"][i]) for i in range(3)]
    return {"axis": k, "inward": inward, "through": through, "other": other, "face": face}


def _contact(geometry, a, b):
    """Cubes of `a` that touch `b`: where the two surfaces actually meet. Bounding boxes are not enough
    for tube frames, whose boxes are mostly empty space."""
    import collision
    near = collision.voxels(geometry, b)
    cells = collision.voxels(geometry, a)
    steps = [(x, y, z) for x in (-1, 0, 1) for y in (-1, 0, 1) for z in (-1, 0, 1)]
    return [c for c in cells if any((c[0] + x, c[1] + y, c[2] + z) in near for x, y, z in steps)]


def _spots(geometry, joint, count):
    """`count` places spread along where the two parts touch, each as (point, outer face along the
    joint axis, interface along the joint axis). The point's coordinate along the axis is unused."""
    import collision
    r = collision.size(geometry)
    k, inward = joint["axis"], joint["inward"]
    through, other = joint["through"], joint["other"]
    touching = _contact(geometry, through["id"], other["id"])
    low, high = joint["face"]
    u, v = [i for i in range(3) if i != k]
    if high[v] - low[v] > high[u] - low[u]:
        u, v = v, u
    if not touching:      # fall back to the bounding boxes
        spots = []
        for i in range(count):
            share = 0.5 if count == 1 else 0.2 + 0.6 * i / (count - 1)
            point = [0.0, 0.0, 0.0]
            point[u] = low[u] + share * (high[u] - low[u])
            point[v] = (low[v] + high[v]) / 2
            outer = through["lo"][k] if inward > 0 else through["hi"][k]
            interface = through["hi"][k] if inward > 0 else through["lo"][k]
            spots.append((point, outer, interface))
        return spots
    touching.sort(key=lambda c: (c[u], c[v]))
    column = {}
    for cell in collision.voxels(geometry, through["id"]):
        column.setdefault((cell[u], cell[v]), []).append(cell[k])
    across = {}
    for cell in touching:
        across.setdefault(cell[u], []).append(cell[v])
    spots = []
    for i in range(count):
        share = 0.5 if count == 1 else 0.15 + 0.7 * i / (count - 1)
        cell = touching[min(len(touching) - 1, int(share * len(touching)))]
        # centred across the contact, the way holes are drilled mid-thickness
        middle = (min(across[cell[u]]) + max(across[cell[u]])) // 2
        cell = next((c for c in touching if c[u] == cell[u] and c[v] == middle), cell)
        point = [0.0, 0.0, 0.0]
        point[u], point[v] = (cell[u] + 0.5) * r, (cell[v] + 0.5) * r
        depths = column.get((cell[u], cell[v]), [cell[k]])
        # the outside face of the part the fastener goes through, on the side away from the other part
        outer = (min(depths) if inward > 0 else max(depths) + 1) * r
        interface = (cell[k] + (1 if inward > 0 else 0)) * r
        spots.append((point, outer, interface))
    return spots


PEGS = {"dowel", "cam_pin"}


def unsandwich(geometry, actions):
    """A board that slides onto pegs cannot go in between two parts that both hold pegs pointing at it.
    When the plan has that, the second part is fitted right after the board instead, onto pegs in the
    board, the way such panels are actually put together. Returns (actions, notes)."""
    actions = [dict(a, nodes=list(a["nodes"]), hardware=[dict(h) for h in a.get("hardware") or []]) for a in actions]
    notes, built, index = [], set(), 0
    while index < len(actions):
        action = actions[index]
        for board in [n for n in action["nodes"] if n in geometry["parts"] and n not in built]:
            if geometry["parts"][board]["fastener"]:
                continue
            sides = {}
            for item in [h for a in actions[:index + 1] for h in a["hardware"]]:
                if item["kind"] in PEGS and board in item["between"]:
                    other = next((n for n in item["between"] if n != board), None)
                    joint = _joint(geometry, board, other) if other in built else None
                    if joint:
                        side = (joint["axis"], 1 if geometry["parts"][other]["center"][joint["axis"]] > geometry["parts"][board]["center"][joint["axis"]] else -1)
                        sides.setdefault(side, []).append(other)
            trapped = [(axis, sign) for axis, sign in sides if (axis, -sign) in sides]
            if not trapped:
                continue
            later = sorted(set(sides[trapped[0]]))
            for a in actions[:index + 1]:
                a["nodes"] = [n for n in a["nodes"] if n not in later]
            moved = [h for a in actions[:index + 1] for h in a["hardware"] if set(h["between"]) & set(later)]
            for a in actions[:index + 1]:
                a["hardware"] = [h for h in a["hardware"] if not set(h["between"]) & set(later)]
            actions.insert(index + 1, dict(action, nodes=later, hardware=moved, motion="slide",
                                           caption=f"Fit the next part onto the pegs ({action['caption']})"[:220]))
            names = ", ".join(geometry["parts"][n]["name"].split(":")[0] for n in later)
            notes.append(f"Step {action['step']}: {names} moved after {geometry['parts'][board]['name'].split(':')[0]}, "
                         "which could not slide in between two sets of pegs.")
        built |= set(action["nodes"])
        index += 1
    return [a for a in actions if a["nodes"] or a["hardware"]], notes


def _way_in_clear(geometry, spec, travel, present):
    """True when a drawn piece can travel in along its axis without passing through any part in
    `present` other than the two it joins."""
    import collision
    cells = collision.hardware_cells(geometry, spec)
    k = next(i for i in range(3) if spec["direction"][i])
    sign = spec["direction"][k]
    steps = int(travel / collision.size(geometry)) + 1
    for node in present - set(spec["joins"]):
        solid = collision.voxels(geometry, node)
        for c in cells:
            for s in range(0, steps + 1):
                moved = list(c)
                moved[k] += sign * s
                if tuple(moved) in solid:
                    return False
    return True


def _flipped(joint):
    """The same joint, with the fastener going in from the other part's side."""
    return dict(joint, through=joint["other"], other=joint["through"], inward=-joint["inward"])


def _wait_for_parts(actions, notes, geometry=None):
    """Moves each hardware item to the action where the later of its two parts goes in, so hardware
    never sits in empty space waiting for a part. Items whose parts never appear are dropped."""
    first = {}
    for index, action in enumerate(actions):
        for node in action["nodes"]:
            first.setdefault(node, index)
    moved = [dict(a, hardware=[]) for a in actions]
    joins_at = {node: at for at, group in (_groups(geometry, actions) if geometry else []) for node in group}
    for index, action in enumerate(actions):
        for item in action.get("hardware") or []:
            if not all(n in first for n in item.get("between", [])):
                notes.append(f"Step {action['step']}: {item['kind']}s join a part that is never fitted, so they were not drawn.")
                continue
            target = max([index] + [first[n] for n in item["between"]])
            owners = {joins_at.get(n) for n in item["between"]}
            if len(owners) > 1:                 # one side is a sub-assembly built apart: wait until it joins
                target = max([target] + [at for at in owners if at is not None])
            moved[target]["hardware"].append(item)
    return moved


def _groups(geometry, actions):
    from geometry import parked_groups
    return parked_groups(geometry, actions)


def add_hardware(geometry, actions, metres):
    """Turns each action's `hardware` list into drawn parts and install actions. Returns
    (actions, hardware by id, notes). `metres` says the model is in real units, so printed
    lengths can be used; otherwise lengths follow the joint (models scaled to about one unit)."""
    parts, diagonal = geometry["parts"], geometry["diagonal"]
    result, hardware, notes, built, counter = [], {}, [], set(), 0
    actions = _wait_for_parts(actions, notes, geometry)
    for action in actions:
        before, after = [], []
        for item in action.get("hardware") or []:
            between = [n for n in item.get("between", []) if n in parts]
            if len(set(between)) != 2:
                continue
            a, b = between
            if any(parts[n]["fastener"] or parts[n].get("head_of") is not None for n in (a, b)):
                continue                      # one side is itself a screw or dowel in the model
            real = [n for n in geometry["contacts"][a] & geometry["contacts"][b] if parts[n]["fastener"]]
            if real:
                continue                      # the model already has this hardware
            joint = _joint(geometry, a, b)
            if joint and kind_of(item) != "dowel":
                joint = [joint, _flipped(joint)]
            elif joint:
                joint = [joint]
            if not joint:
                notes.append(f"Step {action['step']}: {parts[a]['name']} and {parts[b]['name']} do not touch, "
                             f"so their {item['kind']}s were not drawn.")
                continue
            source, number, kind = _look(item)
            fitted_before = item["kind"] in BEFORE and (a in built or b in built)
            present = built | (set() if fitted_before else set(action["nodes"]))
            count = max(1, min(int(item.get("count") or 1), 12))
            placed = []
            for side in joint:
                placed = [p for p in _pieces(geometry, side, item, kind, metres, built, fitted_before, count)
                          if _way_in_clear(geometry, dict(p, joins=[a, b]), 1.2 * p["length"] + 0.02 * diagonal, present)]
                if len(placed) == count:
                    break
            if len(placed) < count:
                notes.append(f"Step {action['step']}: {count - len(placed)} of {count} {item['kind']}s between "
                             f"{parts[a]['name'].split(':')[0]} and {parts[b]['name'].split(':')[0]} were left out: "
                             "no way in that misses the other parts.")
            for piece in placed:
                travel = 1.2 * piece["length"] + 0.02 * diagonal
                counter += 1
                key = f"h{counter}"
                hardware[key] = dict(piece, source=source, number=number, joins=[a, b],
                                     label=item.get("number") or item["kind"], peg=fitted_before,
                                     motion={"start": [round(c * travel, 6) for c in piece["direction"]],
                                             "end": [0, 0, 0], "turns": 0 if kind == "dowel" else 2})
                (before if fitted_before else after).append(key)
        if before:
            result.append(_install(action, before, hardware, "Insert"))
        result.append(action)
        if after:
            result.append(_install(action, after, hardware, "Fasten with"))
        built |= set(action["nodes"])
    if hardware:
        notes.append("Hardware positions are estimated: the manual gives the joint and count, not the exact holes.")
    return result, hardware, notes


def kind_of(item):
    return KINDS.get(item["kind"], "screw")


def _pieces(geometry, joint, item, kind, metres, built, fitted_before, count):
    """Where each piece of one hardware item goes on one side of a joint: tip, direction, size."""
    k, inward = joint["axis"], joint["inward"]
    through, other = joint["through"], joint["other"]
    thickness = through["hi"][k] - through["lo"][k]
    room = thickness + (other["hi"][k] - other["lo"][k])
    # the thinner of the two parts (a panel's thickness, a tube's diameter) sets how big hardware can be
    thin = min(through["sizes"][2], other["sizes"][2], thickness)
    printed = (item.get("length_mm") or 0) / 1000 if metres else 0
    pieces = []
    for spot, outer, interface in _spots(geometry, joint, count):
        local = max(abs(interface - outer), 0.3 * thin)      # how thick the through part is right here
        if kind == "dowel":
            length = min(printed or 2.2 * thin, 0.9 * room)
            width = 0.45 * thin
            host = through if through["id"] in built or not fitted_before else other
            # tip inside the part already built, the free end sticking out toward the next part
            out = 1 if (host is through) == (inward > 0) else -1
            tip = interface - out * length / 2
        else:
            length = min(printed or (local + 1.5 * thin), 0.95 * room)
            width = 0.35 * thin
            if kind == "cam_nut":
                length, width = min(length, 0.6 * local), 0.85 * thin
            out = -inward                      # head on the outside face of the part it goes through
            tip = outer + inward * length
        position = list(spot)
        position[k] = tip
        direction = [0, 0, 0]
        direction[k] = out
        pieces.append({"kind": kind, "length": round(length, 6), "width": round(width, 6),
                       "position": [round(c, 6) for c in position], "direction": direction})
    return pieces


def _install(action, keys, hardware, verb):
    counts = {}
    for key in keys:
        spec = hardware[key]
        counts[spec["label"]] = counts.get(spec["label"], 0) + 1
    words = ", ".join(f"{n} × {label}" for label, n in counts.items())
    return {"step": action["step"], "page": action["page"], "caption": f"{verb} {words} (estimated positions)"[:220],
            "nodes": keys, "motion": "tighten" if verb != "Insert" else "insert"}
