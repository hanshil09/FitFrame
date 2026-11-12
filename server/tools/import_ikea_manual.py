"""Add kits from the IKEA-Manual dataset (Wang et al., NeurIPS 2022) to samples/ikea-kits.

Download and unzip https://download.cs.stanford.edu/viscam/ikea_manual/dataset.zip, then run:
    .venv/bin/python server/tools/import_ikea_manual.py <unzipped dir> Bench/hemnes Chair/stig ...

Each kit's per-part OBJs become one GLB with a mesh node per part (centred on the part, so the
player can move it), the manual PDF is copied, and the dataset's own step annotations are kept
in steps.json. Models are normalised to about 1 unit across, not real metres.
"""
import json
import re
import shutil
import struct
import sys
from pathlib import Path

import pypdfium2 as pdfium

OUT = Path(__file__).resolve().parents[2] / "samples" / "ikea-kits"
# Light, distinct tints so neighbouring parts read as separate pieces
PALETTE = [(0.82, 0.68, 0.50), (0.70, 0.55, 0.38), (0.88, 0.80, 0.66), (0.60, 0.47, 0.33),
           (0.77, 0.62, 0.45), (0.92, 0.86, 0.75)]


def read_obj(path):
    verts, norms, index, out_p, out_n, tris = [], [], {}, [], [], []
    for line in path.read_text(errors="ignore").splitlines():
        head, _, rest = line.partition(" ")
        if head == "v":
            verts.append(tuple(map(float, rest.split()[:3])))
        elif head == "vn":
            norms.append(tuple(map(float, rest.split()[:3])))
        elif head == "f":
            corners = []
            for token in rest.split():
                fields = token.split("/")
                vi = int(fields[0])
                ni = int(fields[2]) if len(fields) > 2 and fields[2] else 0
                vi = vi - 1 if vi > 0 else len(verts) + vi
                ni = (ni - 1 if ni > 0 else len(norms) + ni) if ni else -1
                key = (vi, ni)
                if key not in index:
                    index[key] = len(out_p)
                    out_p.append(verts[vi])
                    out_n.append(norms[ni] if ni >= 0 else (0.0, 1.0, 0.0))
                corners.append(index[key])
            tris += [(corners[0], corners[i], corners[i + 1]) for i in range(1, len(corners) - 1)]
    return out_p, out_n, tris


def describe(parts, equivalent):
    """Plain-language part names from geometry, so the model has evidence to match manual drawings."""
    boxes = [([min(p[k] for p in ps) for k in range(3)], [max(p[k] for p in ps) for k in range(3)]) for ps, _, _ in parts]
    lo = [min(b[0][k] for b in boxes) for k in range(3)]
    hi = [max(b[1][k] for b in boxes) for k in range(3)]
    span = [h - l or 1 for l, h in zip(lo, hi)]
    names = []
    for i, (a, b) in enumerate(boxes):
        size = [y - x for x, y in zip(a, b)]
        L, M, S = sorted(size, reverse=True)
        axis = size.index(L)
        if L < 0.12 * max(span):
            shape = "small fitting"
        elif M < 0.25 * L:
            shape = "vertical leg/post" if axis == 1 else "horizontal rail/bar"
        elif S < 0.2 * M:
            shape = "vertical panel" if size[1] > 0.5 * M else "horizontal board/top"
        else:
            shape = "frame/block"
        centre = [((x + y) / 2 - l) / s for x, y, l, s in zip(a, b, lo, span)]
        where = [("bottom", "middle", "top")[min(2, int(centre[1] * 3))],
                 ("left", "centre", "right")[min(2, int(centre[0] * 3))],
                 ("back", "middle", "front")[min(2, int(centre[2] * 3))]]
        text = f"part {i:02d}: {shape}, {round(100 * L / max(span))}% of the overall size, at {' '.join(where)}"
        twins = sorted(int(p) for p in equivalent.get(str(i), []) if p.isdigit() and int(p) != i)
        if twins:
            text += ", same shape as part " + ", ".join(f"{p:02d}" for p in twins)
        names.append(text)
    return names


def write_glb(parts, path, names):
    blob, views, accessors, meshes, nodes, materials = bytearray(), [], [], [], [], []

    def add(data, target, comp, kind, count, extra=None):
        while len(blob) % 4:
            blob.append(0)
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data), "target": target})
        blob.extend(data)
        accessors.append({"bufferView": len(views) - 1, "componentType": comp, "count": count, "type": kind, **(extra or {})})
        return len(accessors) - 1

    for i, (positions, normals, tris) in enumerate(parts):
        lo = [min(p[k] for p in positions) for k in range(3)]
        hi = [max(p[k] for p in positions) for k in range(3)]
        centre = [(a + b) / 2 for a, b in zip(lo, hi)]
        local = [tuple(p[k] - centre[k] for k in range(3)) for p in positions]
        pos = add(b"".join(struct.pack("<3f", *p) for p in local), 34962, 5126, "VEC3", len(local),
                  {"min": [a - c for a, c in zip(lo, centre)], "max": [b - c for b, c in zip(hi, centre)]})
        nrm = add(b"".join(struct.pack("<3f", *n) for n in normals), 34962, 5126, "VEC3", len(normals))
        idx = add(b"".join(struct.pack("<3I", *t) for t in tris), 34963, 5125, "SCALAR", len(tris) * 3)
        materials.append({"name": f"part {i:02d}", "pbrMetallicRoughness": {
            "baseColorFactor": [*PALETTE[i % len(PALETTE)], 1], "metallicFactor": 0, "roughnessFactor": 0.75},
            "doubleSided": True})
        meshes.append({"primitives": [{"attributes": {"POSITION": pos, "NORMAL": nrm}, "indices": idx, "material": i}]})
        nodes.append({"name": names[i], "mesh": i, "translation": centre})

    doc = {"asset": {"version": "2.0", "generator": "import_ikea_manual.py"},
           "scene": 0, "scenes": [{"nodes": list(range(len(nodes)))}], "nodes": nodes, "meshes": meshes,
           "materials": materials, "accessors": accessors, "bufferViews": views,
           "buffers": [{"byteLength": len(blob)}]}
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    blob += b"\0" * (-len(blob) % 4)
    total = 12 + 8 + len(js) + 8 + len(blob)
    path.write_bytes(struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(js), 0x4E4F534A) + js
                     + struct.pack("<II", len(blob), 0x004E4942) + bytes(blob))


def manual_id(pdf):
    doc = pdfium.PdfDocument(str(pdf))
    for i in reversed(range(len(doc))):
        found = re.findall(r"AA-\d{5,8}-\d+", doc[i].get_textpage().get_text_range())
        if found:
            return found[-1]
    raise ValueError(f"no AA- document number in {pdf}")


def main(root, wanted):
    root = Path(root)
    data = {(e["category"], e["name"]): e for e in json.loads((root / "main_data.json").read_text())}
    catalog_path = OUT / "catalog.json"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    for item in wanted:
        category, name = item.split("/")
        entry = data[(category, name)]
        pdfs = sorted((root / "pdfs" / category / name).glob("*.pdf"))
        if len(pdfs) != 1:
            print(f"skip {item}: {len(pdfs)} PDFs")
            continue
        key = f"im-{category}-{name}".lower().replace("_", "-")
        label = f"{name.split('_')[0].upper()} {category.lower()}"
        objs = sorted((root / "parts" / category / name).glob("*.obj"))
        assert len(objs) == entry["parts_ct"], item
        folder = OUT / key
        folder.mkdir(parents=True, exist_ok=True)
        meshes = [read_obj(o) for o in objs]
        write_glb(meshes, folder / "model.glb", describe(meshes, entry["geometric_equivalence_relation"]))
        shutil.copyfile(pdfs[0], folder / "manual.pdf")
        steps = [{"step": s["step_id"] + 1, "page": s["page_id"], "parts": s["parts"],
                  "connections": s["connections"]} for s in entry["steps"]]
        (folder / "steps.json").write_text(json.dumps({"assembly_tree": entry["assembly_tree"], "steps": steps}, indent=1))
        record = {"article_number": key, "name": label, "manual_id": manual_id(pdfs[0]),
                  "model": f"{key}/model.glb", "manual": f"{key}/manual.pdf", "mesh_nodes": len(objs),
                  "source_url": "https://cs.stanford.edu/~rcwang/projects/ikea_manual",
                  "model_license": "IKEA-Manual research dataset (no licence stated)",
                  "reference_steps": f"{key}/steps.json"}
        catalog = [k for k in catalog if k["article_number"] != key] + [record]
        print(f"added {key}: {len(objs)} parts, {len(steps)} steps, {record['manual_id']}")
    catalog_path.write_text(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
