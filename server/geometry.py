"""Geometry of a finished kit: where each part sits, what it touches, and how it moves in.

Every catalog GLB is the assembled product, so the joins are already in the file. This
module reads them with plain geometry, with no model call:

  kit_geometry - each part's world box, long axis, and whether it is a small fastener,
                 plus which parts touch in the finished model
  plan_motions - for each install action, where each new part travels in from, worked out
                 from the parts it touches that are already in place
  check_plan   - flags steps whose new parts touch nothing built so far, and swaps
                 identical parts (the same screw drawn twice) when that fixes it
  describe     - one line per part for the model prompt: kind, size, place, neighbours
"""
import json
import math
import struct
from array import array
from functools import lru_cache
from pathlib import Path

TOUCH = 0.004       # parts closer than this share of the model diagonal touch
FASTENER = 0.2      # slender parts shorter than this share of the diagonal are screws, dowels or bolts
AXES = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]
UP = (0, 1, 0)      # glTF is Y-up


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def scale(a, s):
    return (a[0] * s, a[1] * s, a[2] * s)


def unit(a):
    length = math.sqrt(dot(a, a))
    return scale(a, 1 / length) if length > 1e-12 else (0, 0, 0)


# ---------- reading the GLB ----------

def _read_glb(path):
    data = Path(path).read_bytes()
    doc, binary, offset = None, b"", 12
    while offset + 8 <= len(data):
        length, kind = struct.unpack_from("<II", data, offset)
        chunk = data[offset + 8: offset + 8 + length]
        if kind == 0x4E4F534A:
            doc = json.loads(chunk)
        elif kind == 0x004E4942:
            binary = chunk
        offset += 8 + length
    return doc, binary


def _positions(doc, binary, index):
    accessor = doc["accessors"][index]
    if accessor.get("componentType") != 5126 or accessor.get("type") != "VEC3" or "bufferView" not in accessor:
        return []
    view = doc["bufferViews"][accessor["bufferView"]]
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    stride, count = view.get("byteStride") or 12, accessor["count"]
    if stride == 12:
        values = array("f")
        values.frombytes(binary[start:start + 12 * count])
        return [(values[i], values[i + 1], values[i + 2]) for i in range(0, 3 * count, 3)]
    return [struct.unpack_from("<3f", binary, start + i * stride) for i in range(count)]


def _triangles(doc, binary, primitive, count):
    if primitive.get("mode", 4) != 4:
        return []
    if "indices" not in primitive:
        return [(i, i + 1, i + 2) for i in range(0, count - 2, 3)]
    accessor = doc["accessors"][primitive["indices"]]
    kind = {5121: "B", 5123: "H", 5125: "I"}.get(accessor.get("componentType"))
    if not kind or "bufferView" not in accessor:
        return []
    view = doc["bufferViews"][accessor["bufferView"]]
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    values = array(kind)
    values.frombytes(binary[start:start + values.itemsize * accessor["count"]])
    return [(values[i], values[i + 1], values[i + 2]) for i in range(0, len(values) - 2, 3)]


def _local_transform(node):
    if "matrix" in node:
        m = node["matrix"]
        return [[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[2], m[6], m[10]]], list(m[12:15])
    x, y, z, w = node.get("rotation", (0, 0, 0, 1))
    r = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
         [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
         [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
    s = node.get("scale", (1, 1, 1))
    return [[r[i][j] * s[j] for j in range(3)] for i in range(3)], list(node.get("translation", (0, 0, 0)))


def _compose(parent, child):
    (pr, pt), (cr, ct) = parent, child
    rotation = [[sum(pr[i][k] * cr[k][j] for k in range(3)) for j in range(3)] for i in range(3)]
    translation = [sum(pr[i][k] * ct[k] for k in range(3)) + pt[i] for i in range(3)]
    return rotation, translation


def _part(node_id, name, rotation, translation, local, triangles):
    columns = list(zip(*local))
    low, high = [min(c) for c in columns], [max(c) for c in columns]
    size = [h - l for l, h in zip(low, high)]
    longest = max(range(3), key=lambda i: size[i])
    ordered = sorted(size, reverse=True)
    world = [tuple(sum(rotation[i][k] * v[k] for k in range(3)) + translation[i] for i in range(3)) for v in local]
    wcolumns = list(zip(*world))
    wlow, whigh = tuple(min(c) for c in wcolumns), tuple(max(c) for c in wcolumns)
    axis = unit((rotation[0][longest], rotation[1][longest], rotation[2][longest]))
    # A screw or bolt is wider at its head: compare the cross-section at each end of the long axis.
    band = 0.15 * size[longest]
    others = [i for i in range(3) if i != longest]

    def width(points):
        if not points:
            return 0.0
        return max(max(p[i] for p in points) - min(p[i] for p in points) for i in others)
    near_low = width([v for v in local if v[longest] <= low[longest] + band])
    near_high = width([v for v in local if v[longest] >= high[longest] - band])
    head = 0
    if min(near_low, near_high) > 0:
        ratio = near_high / near_low
        head = 1 if ratio > 1.25 else -1 if ratio < 0.8 else 0
    return {
        "id": node_id, "name": name, "lo": wlow, "hi": whigh,
        "center": tuple((a + b) / 2 for a, b in zip(wlow, whigh)),
        "axis": axis, "length": ordered[0], "slender": ordered[0] > 2 * ordered[1],
        "flat": ordered[2] < 0.25 * ordered[1], "head": head, "sizes": ordered, "vertices": len(local),
        "thin_axis": unit(tuple(rotation[i][size.index(ordered[2])] for i in range(3))),
        "world": world, "triangles": triangles,   # for the collision check (collision.py)
    }


@lru_cache(maxsize=32)
def _load(path, _mtime):
    doc, binary = _read_glb(path)
    parts = {}

    def walk(index, parent):
        node = doc["nodes"][index]
        transform = _compose(parent, _local_transform(node))
        if "mesh" in node:
            local, triangles = [], []
            for primitive in doc["meshes"][node["mesh"]]["primitives"]:
                if "POSITION" not in primitive.get("attributes", {}):
                    continue
                points = _positions(doc, binary, primitive["attributes"]["POSITION"])
                offset = len(local)
                triangles += [(a + offset, b + offset, c + offset)
                              for a, b, c in _triangles(doc, binary, primitive, len(points))
                              if max(a, b, c) < len(points)]
                local += points
            if local:
                parts[index] = _part(index, node.get("name", f"node {index}"), *transform, local, triangles)
        for child in node.get("children", []):
            walk(child, transform)

    identity = ([[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0])
    for root in doc["scenes"][doc.get("scene", 0)]["nodes"]:
        walk(root, identity)
    low = tuple(min(p["lo"][i] for p in parts.values()) for i in range(3))
    high = tuple(max(p["hi"][i] for p in parts.values()) for i in range(3))
    diagonal = math.dist(low, high)
    for part in parts.values():
        part["fastener"] = part["slender"] and part["length"] < FASTENER * diagonal
        step = diagonal * 0.002
        part["shape"] = (part["vertices"], tuple(round(s / step) for s in part["sizes"]))
    tolerance = TOUCH * diagonal
    contacts = {i: set() for i in parts}
    ids = sorted(parts)
    for a_index, a in enumerate(ids):
        for b in ids[a_index + 1:]:
            if all(_depths(parts[a], parts[b])[i] > -tolerance for i in range(3)):
                contacts[a].add(b)
                contacts[b].add(a)
    _screw_heads(parts, contacts, diagonal)
    return {"parts": parts, "contacts": contacts, "lo": low, "hi": high, "diagonal": diagonal,
            "center": tuple((a + b) / 2 for a, b in zip(low, high))}


def _screw_heads(parts, contacts, diagonal):
    """Some models split a screw into a shaft and a separate head. A small part wider than a shaft,
    sitting on one end of it, is that shaft's head: the screw then goes in head-last and turns, and
    the head travels with the shaft (see plan_motions)."""
    for node, part in parts.items():
        if part["fastener"] or max(part["sizes"]) > 0.06 * diagonal:
            continue
        for other in contacts[node]:
            shaft = parts[other]
            if not shaft["fastener"] or shaft.get("cap") is not None:
                continue
            along = dot(sub(part["center"], shaft["center"]), shaft["axis"])
            if abs(along) > 0.3 * shaft["length"] and part["sizes"][0] > 1.3 * shaft["sizes"][1]:
                part["head_of"] = other
                shaft["cap"] = node
                shaft["head"] = 1 if along > 0 else -1
                break


def kit_geometry(model_path):
    path = Path(model_path)
    return _load(str(path), path.stat().st_mtime)


def _depths(a, b):
    return [min(a["hi"][i], b["hi"][i]) - max(a["lo"][i], b["lo"][i]) for i in range(3)]


# ---------- motion ----------

def _penetrates(fastener, other):
    depths = _depths(fastener, other)
    inside = sum(abs(fastener["axis"][i]) * depths[i] for i in range(3))
    return min(depths) > 0 and inside > 0.1 * fastener["length"]


def _joint_axis(part, placed, geometry):
    """A screw or dowel that goes into both parts shows which way their joint faces,
    whether it is fitted before or after them. Bounding boxes alone miss this on angled frames."""
    parts, contacts = geometry["parts"], geometry["contacts"]
    for node in sorted(contacts[part["id"]] & contacts[placed["id"]]):
        fastener = parts[node]
        if fastener["fastener"] and _penetrates(fastener, part) and _penetrates(fastener, placed):
            return fastener["axis"]
    return None


def _constraint(part, placed, geometry):
    """How a placed neighbour limits the way `part` can travel in: ('only', n) = only along n,
    ('face', n) = not into n's opposite, ('both', n) = not along n either way."""
    if not part["fastener"] and not placed["fastener"]:
        axis = _joint_axis(part, placed, geometry)
        if axis:
            side = dot(sub(part["center"], placed["center"]), axis)
            spread = sum(abs(axis[i]) * (part["hi"][i] - part["lo"][i] + placed["hi"][i] - placed["lo"][i]) for i in range(3))
            if abs(side) < 0.05 * spread:
                return ("both", axis)
            return ("face", axis if side > 0 else scale(axis, -1))
    if placed["fastener"]:
        axis = placed["axis"]
        overlap = _depths(part, placed)
        inside = sum(abs(axis[i]) * overlap[i] for i in range(3))
        if inside > 0.1 * placed["length"]:     # the dowel or screw goes into this part
            side = dot(sub(part["center"], placed["center"]), axis)
            return ("only", axis if side >= 0 else scale(axis, -1)) if abs(side) > 1e-9 else ("both", axis)
    depths = _depths(part, placed)
    k = min(range(3), key=lambda i: depths[i])
    normal = tuple(1 if i == k else 0 for i in range(3))
    delta = part["center"][k] - placed["center"][k]
    spread = (part["hi"][k] - part["lo"][k]) + (placed["hi"][k] - placed["lo"][k])
    if abs(delta) < 0.05 * spread:
        return ("both", normal)
    return ("face", normal if delta > 0 else scale(normal, -1))


def _board_directions(part, placed, geometry):
    """Every candidate direction, best first, as (direction, blocked by a neighbour)."""
    if not placed:
        others = [d for d in AXES if d != UP]
        return [(UP, False)] + [(d, False) for d in sorted(others, key=lambda d: -dot(d, unit(sub(part["center"], geometry["center"]))))]
    constraints = [_constraint(part, other, geometry) for other in placed]
    candidates = list(AXES) + [n for kind, n in constraints if kind == "only"] + \
        [scale(n, -1) for kind, n in constraints if kind == "only"]
    outward = unit(sub(part["center"], geometry["center"]))
    scored = []
    for direction in candidates:
        blocked, score = False, 0.0
        for kind, normal in constraints:
            along = dot(direction, normal)
            if kind == "only":
                blocked |= along < 0.7
                score += along
            elif kind == "both":
                blocked |= abs(along) > 0.7
            else:
                blocked |= along < -0.3
                score += max(along, 0)
        score += 0.25 * dot(direction, outward) + (0.3 if direction == UP else 0)
        scored.append((blocked, -score, direction))
    scored.sort(key=lambda item: (item[0], item[1]))
    return [(direction, blocked) for blocked, _, direction in scored]


def _fastener_direction(part, placed, geometry):
    axis = part["axis"]
    if part["head"]:
        return scale(axis, part["head"])       # pull out toward the head
    # A dowel has no head: it comes out of whichever placed part holds more of it.
    weight, centre = 0.0, [0.0, 0.0, 0.0]
    for other in placed:
        depths = _depths(part, other)
        if min(depths) <= 0:
            continue
        volume = depths[0] * depths[1] * depths[2]
        middle = [(max(part["lo"][i], other["lo"][i]) + min(part["hi"][i], other["hi"][i])) / 2 for i in range(3)]
        weight += volume
        centre = [c + volume * m for c, m in zip(centre, middle)]
    reference = tuple(c / weight for c in centre) if weight else geometry["center"]
    side = dot(sub(part["center"], reference), axis)
    return axis if side >= 0 else scale(axis, -1)


def part_motion(geometry, node, installed, drawn=()):
    """Where `node` travels in from, given the parts already built. The path must not pass through
    any built part (see collision.py): first a straight line in the best direction that is clear,
    then a two-leg path (slide out of the joint, then away sideways or upward)."""
    import collision
    part = geometry["parts"][node]
    placed = [geometry["parts"][i] for i in sorted(geometry["contacts"][node] & installed)]
    diagonal = geometry["diagonal"]
    if part["fastener"]:
        first = _fastener_direction(part, placed, geometry)
        # a screw or bolt only goes in head-last; a dowel may go in from either end
        options = [first] if part["head"] else [first, scale(first, -1)]
        loose = set(options)
        turns = 2 if part["head"] else 0
    else:
        ranked = _board_directions(part, placed, geometry)
        # Directions the bounding boxes rule out stay as fallbacks: the collision check below is
        # the better judge, and an enclosed part may only have one of those ways in.
        options = [d for d, blocked in ranked if not blocked] + [d for d, blocked in ranked if blocked]
        loose = {d for d, blocked in ranked if not blocked}
        # Dowels or cam pins fitted for this part: it slides straight onto them, so try that way first.
        pegs = [tuple(spec["direction"]) for _, spec, _ in drawn if node in spec["joins"] and spec.get("peg")]
        for peg in reversed(pegs):
            if peg in options:
                options.remove(peg)
            options.insert(0, peg)
        loose |= set(pegs)
        turns = 0

    def travel(direction):
        if part["fastener"]:
            return 1.2 * part["length"] + 0.02 * diagonal
        extent = sum(abs(direction[i]) * (part["hi"][i] - part["lo"][i]) for i in range(3))
        return 0.18 * diagonal + 0.15 * extent

    cube = collision.size(geometry)

    def allowed(direction):
        axis, sign = collision.axis_of(direction) or (0, 1)
        limits = {p["id"]: collision.depth_into(geometry, node, p["id"], axis, sign) + 1 for p in placed}
        for key, spec, _ in drawn:
            if node in spec["joins"]:
                # hardware in this joint: fine to slide along it, never across it
                parallel = abs(sum(a * b for a, b in zip(direction, spec["direction"]))) > 0.95
                extent = part["hi"][axis] - part["lo"][axis]
                limits[key] = math.ceil((spec["length"] + extent) / cube) + 2 if parallel else 1
            else:
                # hardware buried in a part this one slides along counts as that part
                hosts = [limits[j] for j in spec["joins"] if j in limits]
                if hosts:
                    limits[key] = max(hosts)
        return limits

    obstacles = [(key, cells) for key, _, cells in drawn]

    def motion(path, blocked=False, forced=False):
        return {"start": [round(v, 6) for v in path[0]], "end": [0, 0, 0],
                "path": [[round(v, 6) for v in point] for point in path] if len(path) > 2 else None,
                "turns": turns, "joins": [p["id"] for p in placed], "forced": forced, "blocked": blocked}

    for direction in options:
        if not collision.first_hit(geometry, node, direction, travel(direction), installed, allowed(direction), extra=obstacles):
            return motion([scale(direction, travel(direction)), (0, 0, 0)],
                          forced=not part["fastener"] and direction not in loose)
    # Two legs: out of the joint along `out` (shortest lift that works first), then away along a
    # free axis. Fasteners keep one leg, since a screw can only travel along its own axis.
    outward = unit(sub(part["center"], geometry["center"]))
    for out in ([] if part["fastener"] else options):
        snapped = collision.axis_of(out)
        if not snapped:
            continue
        lifts = sorted({value + 2 for value in allowed(out).values()} | {3})
        for lift in lifts:
            reach = lift * cube
            if reach > travel(out) or collision.first_hit(geometry, node, out, reach, installed, allowed(out), extra=obstacles):
                break
            shift = [0, 0, 0]
            shift[snapped[0]] = snapped[1] * lift
            corner = scale(out, reach)
            away = sorted((d for d in AXES if abs(dot(d, out)) < 0.5),
                          key=lambda d: -(dot(d, UP) * 0.5 + dot(d, outward)))
            for side in away:
                distance = travel(side)
                if not collision.first_hit(geometry, node, side, distance, installed, allowed(side), tuple(shift), obstacles):
                    return motion([tuple(c + s for c, s in zip(corner, scale(side, distance))), corner, (0, 0, 0)],
                                  forced=out not in loose)
    return motion([scale(options[0], travel(options[0])), (0, 0, 0)], blocked=True,
                  forced=not part["fastener"] and options[0] not in loose)


def split_touching(geometry, actions):
    """Parts brought in by one action move at the same time; when two of them touch in the finished
    model they would slide through each other, so each goes in after the parts it touches. The
    action's hardware goes with its last part."""
    result, installed = [], set()
    for action in actions:
        new = [n for n in action["nodes"] if n in geometry["parts"] and n not in installed]
        wave = {}
        parts = geometry["parts"]
        for node in new:
            # a screw's shaft and its separately modelled head are one screw: they go in together
            pair = {parts[node].get("head_of"), parts[node].get("cap")} - {None}
            touching = [wave[m] for m in wave if m in geometry["contacts"][node] and m not in pair]
            together = [wave[m] for m in pair if m in wave]
            wave[node] = together[0] if together else (1 + max(touching) if touching else 0)
        waves = max(wave.values(), default=0) + 1
        if waves == 1:
            result.append(action)
        else:
            others = [n for n in action["nodes"] if n not in wave]
            for index in range(waves):
                part = dict(action, nodes=(others if index == 0 else []) + [n for n in new if wave[n] == index])
                part["hardware"] = action.get("hardware") if index == waves - 1 else []
                result.append(part)
        installed |= set(action["nodes"])
    return result


def parked_groups(geometry, actions):
    """Sub-assemblies: parts the plan lists again later with a placing motion ("fit the side assembly
    onto the frame") were built as a separate unit and only join the rest at that action. Returns
    [(action index where the group joins, set of parts)]. A group takes along the parts fitted in the
    same actions that touch it (a rail built onto its panel). The first parts built are the base."""
    parts, contacts = geometry["parts"], geometry["contacts"]
    first, groups, taken = {}, [], set()
    base = set(actions[0]["nodes"]) if actions else set()
    for index, action in enumerate(actions):
        if action.get("motion") in ("place", "slide"):
            again = {n for n in action["nodes"] if n in first and n in parts and not parts[n]["fastener"]} - taken - base
            if again:
                group = set(again)
                for node in again:
                    group |= {m for m in actions[first[node]]["nodes"] if m in parts and m in contacts[node]}
                group -= taken | base
                if group:
                    groups.append((index, group))
                    taken |= group
        for node in action["nodes"]:
            first.setdefault(node, index)
    return groups


def _park(geometry, group, main, drawn):
    """Where a sub-assembly waits before it joins: off along the clearest axis, far enough out that it
    can then slide in without passing through the rest. Returns (offset, clear)."""
    import collision
    parts = geometry["parts"]
    low = [min(parts[n]["lo"][i] for n in group) for i in range(3)]
    high = [max(parts[n]["hi"][i] for n in group) for i in range(3)]
    centre = tuple((a + b) / 2 for a, b in zip(low, high))
    outward = unit(sub(centre, geometry["center"]))
    order = sorted(AXES, key=lambda d: -(dot(d, outward) + (0.2 if d == UP else 0)))
    for direction in order:
        extent = sum(abs(direction[i]) * (high[i] - low[i]) for i in range(3))
        travel = 0.25 * geometry["diagonal"] + 0.5 * extent
        axis, sign = collision.axis_of(direction)
        clear = True
        for node in group:
            allowed = {m: collision.depth_into(geometry, node, m, axis, sign) + 1 for m in contacts_of(geometry, node) & main}
            for key, spec, _ in drawn:
                hosts = [allowed[j] for j in spec["joins"] if j in allowed]
                if hosts:
                    allowed[key] = max(hosts)
            if collision.first_hit(geometry, node, direction, travel, main, allowed, extra=[(k, c) for k, _, c in drawn]):
                clear = False
                break
        if clear:
            return scale(direction, travel), True
    direction = order[0]
    return scale(direction, 0.25 * geometry["diagonal"]), False


def contacts_of(geometry, node):
    return geometry["contacts"].get(node, set())


PRINTED = {"down": (0, 1, 0), "up": (0, -1, 0), "left": (1, 0, 0), "right": (-1, 0, 0),
           "forward": (0, 0, -1), "back": (0, 0, 1)}     # where a part starts, for each way it travels


def _as_printed(geometry, node, installed, drawn, computed, action):
    """The manual prints how a step animates ("translate-down-rotate"): follow it exactly. The
    collision check still runs, and only flags a printed move that passes through built parts."""
    import collision
    part = geometry["parts"][node]
    if action["direction"] == "none":
        return dict(computed, start=[0, 0, 0], path=None, turns=0, printed=True)
    start = PRINTED[action["direction"]]
    extent = sum(abs(start[i]) * (part["hi"][i] - part["lo"][i]) for i in range(3))
    travel = (1.2 * part["length"] + 0.02 * geometry["diagonal"]) if part["fastener"] else \
        0.18 * geometry["diagonal"] + 0.15 * extent
    axis, sign = collision.axis_of(start)
    placed = geometry["contacts"][node] & installed
    allowed = {n: collision.depth_into(geometry, node, n, axis, sign) + 1 for n in placed}
    for key, spec, _ in drawn:
        hosts = [allowed[j] for j in spec["joins"] if j in allowed]
        if node in spec["joins"] or hosts:
            allowed[key] = max(hosts + [1]) if node not in spec["joins"] else 99
    hit = collision.first_hit(geometry, node, start, travel, installed, allowed, extra=[(k, c) for k, _, c in drawn])
    turns = 2 if action.get("rotate") and part["fastener"] else 0
    return dict(computed, start=[round(c * travel, 6) for c in start], end=[0, 0, 0], path=None,
                turns=turns, blocked=bool(hit), printed=True)


def plan_motions(geometry, actions, hardware=None):
    """Per-part motions for each action, in order. A part named again later (tightened) spins in place.
    `hardware` is the drawn hardware by id (hardware.py): once in place it blocks later parts too."""
    import collision
    hardware = hardware or {}
    cells = {key: collision.hardware_cells(geometry, spec) for key, spec in hardware.items()}
    groups = parked_groups(geometry, actions)
    joins_at = {node: index for index, group in groups for node in group}
    group_of = {node: index for index, group in groups for node in group}
    # drawn hardware inside one sub-assembly waits with it
    for key, spec in hardware.items():
        owners = {group_of.get(n) for n in spec["joins"]}
        if len(owners) == 1 and None not in owners:
            group_of[key] = owners.pop()
    installed, shown, result = set(), [], []
    for index, action in enumerate(actions):
        motions = {}
        away = {n for n, at in group_of.items() if at > index}          # parked right now
        for node in action["nodes"]:
            if node in hardware:
                motions[node] = dict(hardware[node]["motion"], joins=hardware[node]["joins"], forced=False, blocked=False)
                continue
            if node not in geometry["parts"]:
                continue
            if node in installed:
                part = geometry["parts"][node]
                motions[node] = {"start": [0, 0, 0], "end": [0, 0, 0], "turns": 1 if part["fastener"] and part["head"] else 0,
                                 "joins": [], "forced": False}
                continue
            # a part of a parked sub-assembly is built against that sub-assembly only; anything else
            # against the main build, without the parked groups
            if node in away:
                world = {n for n in installed if group_of.get(n) == group_of[node]}
            else:
                world = installed - away
            drawn = [(key, hardware[key], cells[key]) for key in shown if (key in away) == (node in away)
                     and (node not in away or group_of.get(key) == group_of[node])]
            motions[node] = part_motion(geometry, node, world, drawn)
            if action.get("direction"):
                motions[node] = _as_printed(geometry, node, world, drawn, motions[node], action)
        # a screw head modelled as its own part rides along with its shaft
        for node in list(motions):
            shaft = geometry["parts"].get(node, {}).get("head_of") if not isinstance(node, str) else None
            if shaft in motions and node not in installed and shaft not in installed:
                motions[node] = dict(motions[shaft], turns=0, joins=[shaft])
        installed |= {n for n in action["nodes"] if n in geometry["parts"]}
        shown += [n for n in action["nodes"] if n in hardware]
        result.append(motions)
    # Park each sub-assembly, then bring it in as one piece at the action where it joins.
    for at, group in groups:
        members = {n for n, owner in group_of.items() if owner == at}
        built_before = set().union(*[set(a["nodes"]) for a in actions[:at]]) if at else set()
        main = {n for n in built_before if n in geometry["parts"] and group_of.get(n, -1) <= at and n not in members}
        main = {n for n in main if group_of.get(n) is None or group_of[n] < at}
        drawn = [(k, hardware[k], cells[k]) for k in shown if k in built_before and group_of.get(k, -1) < at and k not in members]
        offset, clear = _park(geometry, members & set(geometry["parts"]), main, drawn)
        for earlier, motions in zip(actions[:at], result[:at]):
            for node, move in motions.items():
                if node in members:
                    move["start"] = [round(a + b, 6) for a, b in zip(move["start"], offset)]
                    move["end"] = [round(a + b, 6) for a, b in zip(move["end"], offset)]
                    if move.get("path"):
                        move["path"] = [[round(a + b, 6) for a, b in zip(point, offset)] for point in move["path"]]
        joining = [n for n in members if n in built_before]
        actions[at]["nodes"] = list(dict.fromkeys(list(actions[at]["nodes"]) + joining))
        for node in joining:
            result[at][node] = {"start": [round(c, 6) for c in offset], "end": [0, 0, 0], "turns": 0,
                                "joins": [], "forced": False, "blocked": not clear, "assembly": True}
    return result


# ---------- checking a step mapping ----------

def _fits(geometry, node, installed, same_step):
    if not installed:
        return True
    return bool(geometry["contacts"].get(node, set()) & (installed | (same_step - {node})))


def check_plan(geometry, actions):
    """Returns (actions, notes). New parts must touch something built already or in the same step.
    When a part fails and an identical part not yet used would fit, the two are swapped."""
    actions = [dict(action, nodes=list(action["nodes"])) for action in actions]
    parts, notes, installed = geometry["parts"], [], set()
    for index, action in enumerate(actions):
        new = [n for n in action["nodes"] if n not in installed]
        for node in new:
            if node not in parts or _fits(geometry, node, installed, set(action["nodes"])):
                continue
            used = installed | set(action["nodes"])
            twins = [m for m in parts if m not in used and parts[m]["shape"] == parts[node]["shape"]
                     and _fits(geometry, m, installed, set(action["nodes"]) - {node} | {m})]
            if twins:
                twin = twins[0]
                for later in actions[index:]:
                    later["nodes"] = [twin if n == node else node if n == twin else n for n in later["nodes"]]
                    for item in later.get("hardware") or []:
                        item["between"] = [twin if n == node else node if n == twin else n for n in item["between"]]
                notes.append(f"Step {action['step']}: used {parts[twin]['name']} instead of the identical "
                             f"{parts[node]['name']}, which does not touch anything built yet.")
            else:
                notes.append(f"Step {action['step']}: {parts[node]['name']} does not touch anything built "
                             f"so far. Check this mapping.")
        installed |= set(action["nodes"])
    return actions, notes


# ---------- describing parts for the model ----------

def describe(geometry):
    parts, low, high = geometry["parts"], geometry["lo"], geometry["hi"]
    words = [("left", "centre", "right"), ("bottom", "middle", "top"), ("back", "middle", "front")]
    by_shape = {}
    for node, part in parts.items():
        by_shape.setdefault(part["shape"], []).append(node)
    lines = {}
    for node, part in parts.items():
        place = []
        for i in (1, 0, 2):
            span = high[i] - low[i] or 1
            place.append(words[i][min(2, int(3 * (part["center"][i] - low[i]) / span))])
        if part["fastener"]:
            kind = "small fastener (screw, bolt or dowel)" + (" with a head" if part["head"] else "")
        elif part["slender"]:
            kind = "vertical leg/post" if abs(part["axis"][1]) > 0.7 else "horizontal rail/bar"
        elif part["flat"]:
            kind = "horizontal board" if abs(part["thin_axis"][1]) > 0.7 else "vertical panel"
        else:
            kind = "block/frame"
        size = round(100 * part["length"] / geometry["diagonal"])
        twins = [str(n) for n in by_shape[part["shape"]] if n != node]
        line = f"{part['name']} | {kind}, {size}% of the overall size, at {' '.join(place)}"
        line += "; touches " + (", ".join(map(str, sorted(geometry["contacts"][node]))) or "nothing")
        if twins:
            line += "; identical to " + ", ".join(twins)
        lines[node] = line
    return lines
