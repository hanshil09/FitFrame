"""Keeps parts from passing through each other while they move into place.

Each part's surface is turned into small cubes (voxels) once per kit. A part's path is clear
when, as it travels in, its cubes never land on the cubes of a part already built, with one
exception: it may run into the parts it joins (a screw into its rail, a rail onto its dowels),
but only over the last stretch where it actually goes into them.

Paths are checked along the world axes, which is how flat-pack furniture goes together; a
direction more than ~18 degrees off every axis is not checked.
"""
import math
from bisect import bisect_left

RESOLUTION = 200     # cubes across the model's diagonal


def size(geometry):
    return geometry["diagonal"] / RESOLUTION


def _voxelize(world, triangles, r):
    """Surface cubes of one part: each triangle is rasterised on the plane it faces most."""
    cells = set()
    for ia, ib, ic in triangles:
        a, b, c = world[ia], world[ib], world[ic]
        if max(abs(a[i] - b[i]) + abs(a[i] - c[i]) for i in range(3)) < r:
            for point in (a, b, c):     # a triangle smaller than a cube: its corners are enough
                cells.add((math.floor(point[0] / r), math.floor(point[1] / r), math.floor(point[2] / r)))
            continue
        e1 = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
        e2 = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
        n = (e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0])
        k = max(range(3), key=lambda i: abs(n[i]))
        if abs(n[k]) < 1e-18:
            continue
        u, v = (k + 1) % 3, (k + 2) % 3
        pts = [(p[u], p[v]) for p in (a, b, c)]
        umin, umax = math.floor(min(p[0] for p in pts) / r), math.floor(max(p[0] for p in pts) / r)
        vmin, vmax = math.floor(min(p[1] for p in pts) / r), math.floor(max(p[1] for p in pts) / r)
        # edge functions of the projected triangle, so a cell counts if its centre is within half a
        # cell's diagonal of the triangle
        edges = []
        for (x0, y0), (x1, y1) in ((pts[0], pts[1]), (pts[1], pts[2]), (pts[2], pts[0])):
            ex, ey = x1 - x0, y1 - y0
            length = math.hypot(ex, ey) or 1e-18
            edges.append((x0, y0, ex / length, ey / length))
        orientation = 1 if (pts[1][0] - pts[0][0]) * (pts[2][1] - pts[0][1]) - \
            (pts[1][1] - pts[0][1]) * (pts[2][0] - pts[0][0]) >= 0 else -1
        margin = 0.71 * r
        slope_u, slope_v = n[u] / n[k], n[v] / n[k]
        spread = (abs(slope_u) + abs(slope_v)) * r / 2
        for i in range(umin, umax + 1):
            cu = (i + 0.5) * r
            for j in range(vmin, vmax + 1):
                cv = (j + 0.5) * r
                if any(orientation * (ex * (cv - y0) - ey * (cu - x0)) < -margin for x0, y0, ex, ey in edges):
                    continue
                depth = a[k] - slope_u * (cu - a[u]) - slope_v * (cv - a[v])
                for w in range(math.floor((depth - spread) / r), math.floor((depth + spread) / r) + 1):
                    cell = [0, 0, 0]
                    cell[k], cell[u], cell[v] = w, i, j
                    cells.add(tuple(cell))
    return cells


def voxels(geometry, node):
    cache = geometry.setdefault("_voxels", {})
    if node not in cache:
        part = geometry["parts"][node]
        cache[node] = _voxelize(part["world"], part["triangles"], size(geometry))
    return cache[node]


def _columns(cells, axis):
    """Cells grouped into lines along `axis`: {(other two coords): sorted coords along axis}."""
    u, v = (axis + 1) % 3, (axis + 2) % 3
    columns = {}
    for cell in cells:
        columns.setdefault((cell[u], cell[v]), []).append(cell[axis])
    for line in columns.values():
        line.sort()
    return columns


def _obstacles(geometry, axis):
    cache = geometry.setdefault("_obstacles", {})
    if axis not in cache:
        u, v = (axis + 1) % 3, (axis + 2) % 3
        columns = {}
        for node in geometry["parts"]:
            for cell in voxels(geometry, node):
                columns.setdefault((cell[u], cell[v]), []).append((cell[axis], node))
        for line in columns.values():
            line.sort()
        cache[axis] = columns
    return cache[axis]


def axis_of(direction):
    """(axis, sign) when the direction is within ~18 degrees of a world axis, else None."""
    axis = max(range(3), key=lambda i: abs(direction[i]))
    length = math.sqrt(sum(c * c for c in direction)) or 1
    if abs(direction[axis]) / length < 0.95:
        return None
    return axis, 1 if direction[axis] > 0 else -1


def _pierces(rod, board, axis):
    """A rod, post or leg running along `axis` straight through a board: it goes through a hole there,
    even when the model leaves the hole out."""
    if not rod["slender"] or abs(rod["axis"][axis]) < 0.95:
        return False
    slack = 0.1 * rod["sizes"][1]
    inside = all(board["lo"][i] - slack <= rod["lo"][i] and rod["hi"][i] <= board["hi"][i] + slack
                 for i in range(3) if i != axis)
    beyond = rod["lo"][axis] < board["lo"][axis] or rod["hi"][axis] > board["hi"][axis]
    return inside and beyond


def depth_into(geometry, node, other, axis, sign=1):
    """How many cubes `node` may travel along `axis` (direction `sign`) while still touching a part
    it joins: until it has fully left that part along the way out (a screw slides the whole length
    of its hole), but no further than its own length plus how deep it sits in the part."""
    a, b = geometry["parts"][node], geometry["parts"][other]
    overlaps = [max(0.0, min(a["hi"][i], b["hi"][i]) - max(a["lo"][i], b["lo"][i])) for i in range(3)]
    overlap = overlaps[axis]
    # Two boards meeting face to face: moving straight off the face, only that thin contact is shared.
    # Sliding along the face, or a screw or dowel in its hole, keeps touching until it is clear.
    clear = max(0.0, (b["hi"][axis] - a["lo"][axis]) if sign > 0 else (a["hi"][axis] - b["lo"][axis]))
    if not (a["fastener"] or b["fastener"] or _pierces(a, b, axis) or _pierces(b, a, axis)):
        if axis == min(range(3), key=lambda i: overlaps[i]):
            return math.ceil(overlap / size(geometry))
        return math.ceil(clear / size(geometry))          # sliding along the face, however long it is
    own = a["hi"][axis] - a["lo"][axis]
    return math.ceil(min(clear, own + overlap) / size(geometry))


def hardware_cells(geometry, spec):
    """Cubes along a drawn screw or dowel, from its tip to its head."""
    r = size(geometry)
    k = next(i for i in range(3) if spec["direction"][i])
    steps = max(1, math.ceil(2 * spec["length"] / r))
    cells = set()
    for i in range(steps + 1):
        point = list(spec["position"])
        point[k] += spec["direction"][k] * spec["length"] * i / steps
        cells.add(tuple(math.floor(c / r) for c in point))
    return cells


def first_hit(geometry, node, direction, distance, visible, allowed, shift=(0, 0, 0), extra=()):
    """Moves `node` (already offset by `shift` cubes) along `direction` for `distance`. Returns the
    first built part it runs into as (part, cubes travelled), or None when the way is clear.
    `allowed` maps a part to how many cubes `node` may travel while still touching it. `extra` is
    drawn hardware already in place, as (id, cubes) pairs: it blocks the way like any part."""
    snapped = axis_of(direction)
    if snapped is None:
        return None
    axis, sign = snapped
    steps = max(1, math.ceil(distance / size(geometry)))
    cells = voxels(geometry, node) if not isinstance(node, str) else set()
    if any(shift):
        cells = {(c[0] + shift[0], c[1] + shift[1], c[2] + shift[2]) for c in cells}
    moving = _columns(cells, axis)
    obstacles = _obstacles(geometry, axis)
    if extra:
        u, v = (axis + 1) % 3, (axis + 2) % 3
        drawn = {}
        for key, hardware in extra:
            for cell in hardware:
                drawn.setdefault((cell[u], cell[v]), []).append((cell[axis], key))
        merged = {}
        for column in set(drawn) & set(moving):
            merged[column] = sorted(obstacles.get(column, []) + drawn[column], key=lambda e: (e[0], str(e[1])))
        visible = set(visible) | {key for key, _ in extra}
    else:
        merged = {}
    for key, line in moving.items():
        entries = merged.get(key) or obstacles.get(key)
        if not entries:
            continue
        low, high = (line[0] + 1, line[-1] + steps) if sign > 0 else (line[0] - steps, line[-1] - 1)
        i = bisect_left([e[0] for e in entries], low)
        while i < len(entries) and entries[i][0] <= high:
            z, other = entries[i]
            i += 1
            if other not in visible or other == node:
                continue
            free = allowed.get(other, 1)       # one cube of slack for neighbouring surfaces
            # a cell of `node` at w lands on z after travelling sign*(z - w) cubes
            lo_w, hi_w = (z - steps, z - free - 1) if sign > 0 else (z + free + 1, z + steps)
            j = bisect_left(line, lo_w)
            if j < len(line) and line[j] <= hi_w:
                return other, abs(z - line[j])
    return None
