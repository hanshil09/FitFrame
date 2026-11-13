"""Extraction pipeline: pages -> classify -> parts -> steps (3-run vote) -> plan -> validator."""
import io
import json
import string
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

from PIL import Image, ImageOps

from catalog import TEMPLATES, anchor_ok, catalog_text
from schemas import LayoutOut, PageInfo, PagesInfo, PartsOut, StepOut, StepsOnPage

LONG_EDGE = 1600
MAX_PART_PAGES = 16      # pages sent to the parts pass
MAX_LAYOUT_PAGES = 12
TOUCH_MM = 15            # boxes closer than this count as touching
VERSION = "5"            # bump when prompts change, so cached plans from older prompts are not reused


# ---------- Page preparation ----------
def prepare_pages(files: list[tuple[str, bytes]]) -> list[bytes]:
    """PDFs are rendered page by page; photos are rotated upright and resized. Returns PNG bytes."""
    pages = []
    for name, data in files:
        if name.lower().endswith(".pdf") or data[:4] == b"%PDF":
            import pypdfium2 as pdfium
            pdf = pdfium.PdfDocument(data)
            for i in range(len(pdf)):
                page = pdf[i]
                w, h = page.get_size()
                img = page.render(scale=LONG_EDGE / max(w, h)).to_pil().convert("RGB")
                pages.append(_png(img))
        else:
            img = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
            img.thumbnail((LONG_EDGE, LONG_EDGE))
            pages.append(_png(img))
    return pages


def _png(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


# ---------- Prompts ----------
CLASSIFY_PROMPT = """These images are the pages of a furniture assembly manual, in order (page 1 is the first image).
For each page: classify it and find every numbered assembly step drawn on it.
For each step give a tight box around the whole step panel (including its drawings and labels)."""

PARTS_PROMPT = """These pages are from a furniture assembly manual: the parts and hardware lists first, then the step drawings.
List EVERY part and every hardware item exactly once.
Labels:
- Use the label printed in the manual (a letter like 'A' or a number like '118331') whenever one is printed.
- Many manuals only number the hardware and print no labels for the boards, panels, legs and rails. For each such
  structural part you can see in the step drawings, invent a label P1, P2, P3, ... and name it by its role and position
  in the finished product (e.g. 'left side panel', 'top board', 'front rail'). Identical parts share one label with a count.
Choose the template that best fits each part from this list:
{catalog}
Rules:
- Sizes describe the part as it sits in the finished product: w = left to right, h = bottom to top, d = front to back.
- Use 'fastener' for screws, bolts and pins; read diameter and length from labels like M6x25 (6 mm x 25 mm).
- Prefer a specific template (chair_seat, chair_backrest, backrest_support, chair_mechanism, armrest, ...) when one fits.
- Use 'panel' for boards, brackets, covers and plates that no specific template describes.
- Give printed_size_mm only when dimensions are actually printed. Always give approx_size_mm as your best real-world estimate.
- A quantity printed as 'Set' or '1 Set' means count 1."""

LAYOUT_PROMPT = """These pages are from the {product} assembly manual. Work out what the finished product looks like
(the last steps and the cover show it) and say where every structural part sits in it.
Structural parts:
{parts}
Coordinates, in mm: x runs left to right with 0 at the middle of the product; y is height above the floor;
z runs back to front with 0 at the middle and positive nearer the front.
Rules:
- Give one entry for every copy of every part (a part with x4 needs instances 0, 1, 2 and 3).
- Each entry is that copy's centre and its extent along x, y and z as it sits in the finished product.
  A leg standing upright is tall in y; a rail running front to back is long in z.
- Parts that are joined must touch face to face. Parts must not overlap and must not float in the air.
- Whatever stands on the floor has its underside at y = 0.
- Use the symmetry of the product: matching parts mirror each other about x = 0 or z = 0.
- Keep each copy's three extents the same as the part's size, re-ordered if that copy is turned."""

STEP_PROMPT = """This page of the {product} assembly manual shows steps {steps}. Extract each of these steps.
Parts in this product:
{parts}
Templates and the anchors you may use:
{catalog}
Rules:
- Split the step into substeps in the order a person does them. Follow FIRST / THEN / LAST labels and the arrows.
- In each substep, 'moves' lists the part(s) that move; 'this' is the anchor on the moving part; 'other' is the anchor on the part it attaches to.
- Every part label and anchor must come from the lists above. Write 'socket[i]' or 'arm_mount[i]' to mean one per moving copy.
- A part label is the text before the colon in the parts list (e.g. 'P2' or '118331'), never a template name like 'panel'.
  Match each drawn board to its label by its name, position and size.
- When one board joins another, the board being added is in 'moves' and the mate uses the two faces that touch
  (e.g. a rail between two sides: this = the rail's 'left', other = the side panel's 'right').
- Prefer the named anchors (mech_mount, support_slot, cylinder_socket, ...) over plain faces when they describe the joint.
- instances are 0-based copy numbers. Moving all 5 casters is instances [0,1,2,3,4].
- Fasteners: one substep per fastener type and per face, this = fastener 'tip', other = the face or hole it goes into.
  When the same fastener goes into two faces of a part (two pins in the top of each rail and two in its side),
  write two substeps, one for each face. Count the fasteners drawn going into that face on all copies.
- spots: for a fastener substep, where the fasteners sit on that face of one copy, read from the drawing
  (two pins near the ends of a rail's top: along 0.1 and 0.9, across 0.5).
- fit: 'press' for push/snap fits, 'screw' for screws and bolts, otherwise 'slide'.
- joins: for dowels, cam locks and screws that hold two parts together, the label of the second part."""


# ---------- Passes ----------
def run(provider, files, log: Callable[[str], None], votes: int = 1) -> tuple[dict, list[bytes]]:
    pages = prepare_pages(files)
    log(f"Prepared {len(pages)} page(s)")

    # Pass 1: classify all pages in one call (batches of 8 pages for long manuals)
    infos: list[PageInfo] = []
    for b in range(0, len(pages), 8):
        batch = pages[b:b + 8]
        got = provider.generate(batch, CLASSIFY_PROMPT, PagesInfo).pages
        by_page = {p.page: p for p in got}
        for k in range(len(batch)):
            infos.append(by_page.get(k + 1) or (got[k] if k < len(got) else
                         PageInfo(page=k + 1, page_type="other", has_parts_list=False, has_hardware_list=False, steps=[])))
    for i, info in enumerate(infos):
        steps = ", ".join(str(s.step) for s in info.steps) or "none"
        log(f"Page {i + 1}: {info.page_type}; steps {steps}")

    # Pass 2: parts list from the pages that carry parts/hardware lists, followed by the step pages
    # so parts the manual never labels (IKEA boards and rails) can be found in the drawings
    listed = [i for i, inf in enumerate(infos) if inf.has_parts_list or inf.has_hardware_list or inf.page_type == "parts_list"] or [0]
    drawn = [i for i, inf in enumerate(infos) if inf.steps and i not in listed]
    part_pages = [pages[i] for i in (listed + drawn)[:MAX_PART_PAGES]]
    parts_out: PartsOut = provider.generate(part_pages, PARTS_PROMPT.format(catalog=catalog_text()), PartsOut)
    log(f"Parts: {len(parts_out.parts)} found ({parts_out.product_name})")

    # Layout pass: when every structural part is a plain board, ask where each one sits in the finished product.
    # The player then moves parts into those places instead of chaining face-to-face mates.
    layout, layout_problems = None, []
    structural = [p for p in parts_out.parts if not p.is_hardware and p.template != "fastener"]
    if structural and all(p.template in ("panel", "unsupported") for p in structural):
        step_idx = [i for i, inf in enumerate(infos) if inf.steps]
        shown = [pages[i] for i in sorted(set([0] + step_idx[-(MAX_LAYOUT_PAGES - 1):]))]
        prompt = LAYOUT_PROMPT.format(product=parts_out.product_name, parts="\n".join(_part_line(p) for p in structural))
        layout, layout_problems = check_layout(provider.generate(shown, prompt, LayoutOut), structural)
        if layout_problems:   # one retry with the problems spelled out
            log(f"Layout: {len(layout_problems)} problem(s), asking again")
            retry = prompt + "\nA previous answer had these problems; fix them:\n" + "\n".join(f"- {m}" for m in layout_problems[:12])
            again, problems = check_layout(provider.generate(shown, retry, LayoutOut), structural)
            if len(problems) < len(layout_problems):
                layout, layout_problems = again, problems
        copies = [c for cs in layout.values() for c in cs]
        log(f"Layout: {sum(c is not None for c in copies)} of {len(copies)} part(s) placed, {len(layout_problems)} problem(s)")
        if any(c is None for c in copies):   # a partial layout cannot be played; use the step-by-step mates
            layout, layout_problems = None, ["the model could not place every part, so positions come from the step mates"]

    # Pass 3: one call per step, `votes` runs each, majority wins
    step_jobs = []
    seen = set()
    for pi, inf in enumerate(infos):
        for region in inf.steps:
            if region.step in seen:
                continue
            seen.add(region.step)
            step_jobs.append((region.step, pi, region.box_2d))
    step_jobs.sort()
    parts_summary = "\n".join(_part_line(p) for p in parts_out.parts)

    # One call per page covers all its steps; `votes` repeats it and each step takes its majority answer
    def do_page(pi):
        nums = sorted(j[0] for j in step_jobs if j[1] == pi)
        prompt = STEP_PROMPT.format(product=parts_out.product_name, steps=", ".join(map(str, nums)),
                                    parts=parts_summary, catalog=catalog_text())
        runs = [provider.generate([pages[pi]], prompt, StepsOnPage, temperature=0.7 if votes > 1 else 0.2) for _ in range(votes)]
        results = []
        for num in nums:
            cands = [s for r in runs for s in r.steps if s.step == num]
            if not cands:
                log(f"Step {num}: model returned nothing")
                continue
            keys = [_canon(c) for c in cands]
            best, n = Counter(keys).most_common(1)[0]
            chosen = cands[keys.index(best)]
            log(f"Step {num}: {len(chosen.substeps)} substep(s), votes {n}/{votes}")
            results.append((num, pi, chosen, n))
        return results

    step_pages = sorted({j[1] for j in step_jobs})
    with ThreadPoolExecutor(max_workers=2) as ex:
        step_results = [r for page in ex.map(do_page, step_pages) for r in page]

    plan = build_plan(parts_out, infos, step_jobs, step_results, votes, layout)
    issues = validate(plan) + [{"step": None, "level": "warn", "msg": f"layout: {m}"} for m in layout_problems]
    plan["issues"] = issues
    log(f"Validator: {len(issues)} issue(s)")
    return plan, pages


def _part_line(p) -> str:
    size = p.printed_size_mm or p.approx_size_mm
    dims = f", about {size.w:.0f} wide x {size.h:.0f} high x {size.d:.0f} deep mm" if size and not p.is_hardware else ""
    return f"- {p.label}: {p.name} (template {p.template}, x{p.count}{dims})"


# ---------- Layout checks ----------
def check_layout(out: LayoutOut, structural) -> tuple[dict, list[str]]:
    """Returns ({label: [copy or None, ...]}, problems). A copy is {"c": centre, "s": size, "role": text},
    shifted so the product stands on the floor and is centred on x = z = 0."""
    counts = {p.label: max(1, p.count) for p in structural}
    layout = {label: [None] * n for label, n in counts.items()}
    problems = []
    # Weaker models answer with the part's name instead of its label, or number copies from 1
    by_name = {p.label.strip().lower(): p.label for p in structural}
    for p in structural:
        by_name.setdefault(p.name.strip().lower(), p.label)
    for e in out.placed:
        label = by_name.get(e.label.split(":")[0].strip().lower())
        if not label or min(e.w, e.h, e.d) <= 0:
            continue
        slots = layout[label]
        free = [i for i, c in enumerate(slots) if c is None]
        if free:
            slot = e.instance if e.instance in free else free[0]
            slots[slot] = {"c": [e.cx, e.cy, e.cz], "s": [e.w, e.h, e.d], "role": e.role}
    copies = [(f"{label} copy {i}", c) for label, cs in layout.items() for i, c in enumerate(cs) if c]
    for label, cs in layout.items():
        missing = [i for i, c in enumerate(cs) if c is None]
        if missing:
            problems.append(f"{label} has no position for instance(s) {missing}")
    if not copies:
        return layout, problems
    lo = [min(c["c"][k] - c["s"][k] / 2 for _, c in copies) for k in range(3)]
    hi = [max(c["c"][k] + c["s"][k] / 2 for _, c in copies) for k in range(3)]
    shift = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2]
    for _, c in copies:
        c["c"] = [round(c["c"][k] - shift[k], 1) for k in range(3)]

    def gap(a, b):   # per-axis distance between two boxes; negative = overlapping on that axis
        return [abs(a["c"][k] - b["c"][k]) - (a["s"][k] + b["s"][k]) / 2 for k in range(3)]

    for name, a in copies:
        on_floor = a["c"][1] - a["s"][1] / 2 <= TOUCH_MM
        if not on_floor and not any(max(gap(a, b)) <= TOUCH_MM for other, b in copies if other != name):
            problems.append(f"{name} ({a['role']}) floats: it touches neither the floor nor another part")
    for i, (n1, a) in enumerate(copies):
        for n2, b in copies[i + 1:]:
            g = gap(a, b)
            if max(g) < 0:
                shared = -g[0] * g[1] * g[2]
                if shared > 0.5 * min(a["s"][0] * a["s"][1] * a["s"][2], b["s"][0] * b["s"][1] * b["s"][2]):
                    problems.append(f"{n1} and {n2} overlap heavily")
    return layout, problems


def _canon(step: StepOut) -> str:
    """Compare runs on what matters (parts, anchors, order), not on wording."""
    return json.dumps([[sorted((m.part, tuple(m.instances)) for m in s.moves), s.mate_type,
                        s.this.part, s.this.anchor, s.other.part, s.other.anchor] for s in step.substeps])


# ---------- Plan assembly ----------
def build_plan(parts_out: PartsOut, infos, step_jobs, step_results, votes, layout=None) -> dict:
    parts = []
    for p in parts_out.parts:
        params, prov = {}, {}
        size = p.printed_size_mm or p.approx_size_mm
        if p.template in ("panel", "unsupported") and size:
            params.update(w=size.w, h=size.h, d=size.d)
            src = "stated" if p.printed_size_mm else "estimated"
            prov.update(w=src, h=src, d=src)
        first = next((c for c in (layout or {}).get(p.label, []) if c), None)
        if first:   # the drawn box is the first copy as it sits in the finished product; other copies are turned to fit
            params.update(w=first["s"][0], h=first["s"][1], d=first["s"][2])
            prov.update(w="estimated", h="estimated", d="estimated")
        if p.template == "fastener":
            if p.fastener_diameter_mm:
                params["diameter"], prov["diameter"] = p.fastener_diameter_mm, "stated"
            if p.fastener_length_mm:
                params["length"], prov["length"] = p.fastener_length_mm, "stated"
        if p.template == "star_base" and p.arms:
            params["arms"], prov["arms"] = p.arms, "stated"
        parts.append({"label": p.label, "name": p.name, "count": max(1, p.count), "template": p.template,
                      "is_hardware": p.is_hardware, "kind": p.hardware_kind if p.template == "fastener" else None, "params": params, "provenance": prov, "features": []})

    steps = []
    for step_no, pi, out, n in sorted(step_results, key=lambda r: r[0]):
        box = next(j[2] for j in step_jobs if j[0] == step_no)
        for k, s in enumerate(out.substeps):
            sid = f"{step_no}{string.ascii_lowercase[k]}" if len(out.substeps) > 1 else str(step_no)
            steps.append({
                "step": sid, "title": s.title,
                "moves": [{"part": m.part, "instances": m.instances} for m in s.moves],
                "mate": {"type": s.mate_type, "this": f"{s.this.part}.{s.this.anchor}",
                         "other": f"{s.other.part}.{s.other.anchor}", "fit": s.fit, "joins": s.joins,
                         "spots": [[min(1, max(0, p.along)), min(1, max(0, p.across))] for p in s.spots] if s.spots else None},
                "source": {"page": pi + 1, "box_2d": box},
                "confidence": {"votes": f"{n}/{votes}"},
            })
    return {
        **({"layout": layout} if layout else {}),
        "schema": "build-plan/0.1",
        "product": {"name": parts_out.product_name, "model": parts_out.model_number or "", "category": parts_out.category},
        "pages": [{"n": i + 1, "type": inf.page_type} for i, inf in enumerate(infos)],
        "parts": parts,
        "steps": steps,
    }


# ---------- Validator ----------
def validate(plan: dict) -> list[dict]:
    issues = []
    parts = {p["label"]: p for p in plan["parts"]}
    used = Counter()
    for st in plan["steps"]:
        sid = st["step"]
        for side in ("this", "other"):
            label, _, anchor = st["mate"][side].partition(".")
            p = parts.get(label)
            if not p:
                issues.append({"step": sid, "level": "error", "msg": f"unknown part {label}"})
                st["invalid"] = True
                continue
            if not anchor_ok(p["template"], anchor, p["params"].get("arms")):
                issues.append({"step": sid, "level": "error", "msg": f"{label} ({p['template']}) has no anchor '{anchor}'"})
                st["invalid"] = True
        for mv in st["moves"]:
            p = parts.get(mv["part"])
            if not p:
                issues.append({"step": sid, "level": "error", "msg": f"unknown part {mv['part']}"})
                st["invalid"] = True
                continue
            bad = [i for i in mv["instances"] if i < 0 or i >= p["count"]]
            if bad:
                issues.append({"step": sid, "level": "error", "msg": f"{mv['part']} has {p['count']} copies; step uses copy {bad}"})
                mv["instances"] = [i for i in mv["instances"] if 0 <= i < p["count"]]
            used[mv["part"]] += len(mv["instances"])
        if st["mate"].get("joins") not in parts:
            st["mate"]["joins"] = None
        if st["mate"]["this"].split(".")[0] not in {m["part"] for m in st["moves"]}:
            issues.append({"step": sid, "level": "warn", "msg": "mate's moving anchor is not on a moving part"})
        if st["confidence"]["votes"].split("/")[0] == "1" and not st["confidence"]["votes"].endswith("/1"):
            issues.append({"step": sid, "level": "warn", "msg": "runs disagreed; check this step"})
    for label, p in parts.items():
        if p["is_hardware"] and used[label] not in (0, p["count"]):
            issues.append({"step": None, "level": "warn", "msg": f"{label}: steps use {used[label]} but the list says {p['count']}"})
        if used[label] == 0 and not any(st["mate"]["other"].startswith(label + ".") for st in plan["steps"]):
            issues.append({"step": None, "level": "warn", "msg": f"{label} ({p['name']}) is never used"})
    return issues
