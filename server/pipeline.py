"""Extraction pipeline: pages -> classify -> parts -> steps (3-run vote) -> plan -> validator."""
import io
import json
import string
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

from PIL import Image, ImageOps

from catalog import TEMPLATES, anchor_ok, catalog_text
from schemas import PageInfo, PagesInfo, PartsOut, StepOut, StepsOnPage

LONG_EDGE = 1600


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

PARTS_PROMPT = """These pages are the parts list and hardware list of a furniture assembly manual.
List EVERY lettered part and every lettered hardware item exactly once.
Choose the template that best fits each part from this list:
{catalog}
Rules:
- Use 'fastener' for screws, bolts and pins; read diameter and length from labels like M6x25 (6 mm x 25 mm).
- Prefer a specific template (chair_seat, chair_backrest, backrest_support, chair_mechanism, armrest, ...) when one fits.
- Use 'panel' for boards, brackets, covers and plates that no specific template describes.
- Give printed_size_mm only when dimensions are actually printed. Always give approx_size_mm as your best real-world estimate.
- A quantity printed as 'Set' or '1 Set' means count 1."""

STEP_PROMPT = """This page of the {product} assembly manual shows steps {steps}. Extract each of these steps.
Parts in this product:
{parts}
Templates and the anchors you may use:
{catalog}
Rules:
- Split the step into substeps in the order a person does them. Follow FIRST / THEN / LAST labels and the arrows.
- In each substep, 'moves' lists the part(s) that move; 'this' is the anchor on the moving part; 'other' is the anchor on the part it attaches to.
- Every part label and anchor must come from the lists above. Write 'socket[i]' or 'arm_mount[i]' to mean one per moving copy.
- Prefer the named anchors (mech_mount, support_slot, cylinder_socket, ...) over plain faces when they describe the joint.
- instances are 0-based copy numbers. Moving all 5 casters is instances [0,1,2,3,4].
- Fasteners: one substep per fastener type, this = fastener 'tip', other = the face or hole it goes into.
- fit: 'press' for push/snap fits, 'screw' for screws and bolts, otherwise 'slide'."""


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

    # Pass 2: parts list from the pages that carry parts/hardware lists
    part_pages = [pages[i] for i, inf in enumerate(infos) if inf.has_parts_list or inf.has_hardware_list or inf.page_type == "parts_list"]
    if not part_pages:
        part_pages = pages[:1]
    parts_out: PartsOut = provider.generate(part_pages, PARTS_PROMPT.format(catalog=catalog_text()), PartsOut)
    log(f"Parts: {len(parts_out.parts)} found ({parts_out.product_name})")

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
    parts_summary = "\n".join(f"- {p.label}: {p.name} (template {p.template}, x{p.count})" for p in parts_out.parts)

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

    plan = build_plan(parts_out, infos, step_jobs, step_results, votes)
    issues = validate(plan)
    plan["issues"] = issues
    log(f"Validator: {len(issues)} issue(s)")
    return plan, pages


def _canon(step: StepOut) -> str:
    """Compare runs on what matters (parts, anchors, order), not on wording."""
    return json.dumps([[sorted((m.part, tuple(m.instances)) for m in s.moves), s.mate_type,
                        s.this.part, s.this.anchor, s.other.part, s.other.anchor] for s in step.substeps])


# ---------- Plan assembly ----------
def build_plan(parts_out: PartsOut, infos, step_jobs, step_results, votes) -> dict:
    parts = []
    for p in parts_out.parts:
        params, prov = {}, {}
        size = p.printed_size_mm or p.approx_size_mm
        if p.template in ("panel", "unsupported") and size:
            params.update(w=size.w, h=size.h, d=size.d)
            src = "stated" if p.printed_size_mm else "estimated"
            prov.update(w=src, h=src, d=src)
        if p.template == "fastener":
            if p.fastener_diameter_mm:
                params["diameter"], prov["diameter"] = p.fastener_diameter_mm, "stated"
            if p.fastener_length_mm:
                params["length"], prov["length"] = p.fastener_length_mm, "stated"
        if p.template == "star_base" and p.arms:
            params["arms"], prov["arms"] = p.arms, "stated"
        parts.append({"label": p.label, "name": p.name, "count": max(1, p.count), "template": p.template,
                      "is_hardware": p.is_hardware, "params": params, "provenance": prov, "features": []})

    steps = []
    for step_no, pi, out, n in sorted(step_results, key=lambda r: r[0]):
        box = next(j[2] for j in step_jobs if j[0] == step_no)
        for k, s in enumerate(out.substeps):
            sid = f"{step_no}{string.ascii_lowercase[k]}" if len(out.substeps) > 1 else str(step_no)
            steps.append({
                "step": sid, "title": s.title,
                "moves": [{"part": m.part, "instances": m.instances} for m in s.moves],
                "mate": {"type": s.mate_type, "this": f"{s.this.part}.{s.this.anchor}",
                         "other": f"{s.other.part}.{s.other.anchor}", "fit": s.fit},
                "source": {"page": pi + 1, "box_2d": box},
                "confidence": {"votes": f"{n}/{votes}"},
            })
    return {
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
