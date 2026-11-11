"""Template catalog shared with the browser's templates.js: names, what they are for,
and the anchors each one exposes. The model may only reference these anchors."""

TEMPLATES = {
    "star_base": {
        "use": "Office-chair base with arms radiating from a centre hub",
        "anchors": ["hub_top", "bore", "socket[i]"],
        "notes": "bore = centre hole for the lift cylinder; socket[i] = hole under arm tip i for caster i",
    },
    "caster": {"use": "Chair wheel with a pin on top", "anchors": ["stem_tip"], "notes": ""},
    "gas_cylinder": {"use": "Chair lift cylinder", "anchors": ["tip", "top"], "notes": "tip = tapered bottom end"},
    "telescoping_cover": {"use": "Plastic cover sleeves that slide over a lift cylinder", "anchors": ["bottom", "top"],
                          "notes": "it slides down over the cylinder and its bottom rests on the base: mate bottom -> star_base hub_top"},
    "chair_seat": {
        "use": "Chair seat cushion",
        "anchors": ["mech_mount", "arm_mount[i]", "bottom", "top", "front", "back", "left", "right"],
        "notes": "mech_mount = underside centre where the mechanism screws on; arm_mount[i] = underside left (0) / right (1) where armrest i screws on",
    },
    "chair_backrest": {
        "use": "Chair backrest (mesh or padded)",
        "anchors": ["support_mount", "back", "front", "bottom", "top", "left", "right"],
        "notes": "support_mount = low on the back where the backrest support bar attaches",
    },
    "backrest_support": {
        "use": "L-shaped bar joining backrest to the seat mechanism",
        "anchors": ["front", "back", "tip", "bottom"],
        "notes": "front = upright face that sits against the backrest; tip = end of the foot that slides into the mechanism",
    },
    "chair_mechanism": {
        "use": "Tilt/height mechanism plate under the seat, with a lever",
        "anchors": ["top", "cylinder_socket", "support_slot", "left", "right", "bottom", "back", "front"],
        "notes": "top screws to seat mech_mount; cylinder_socket receives the lift cylinder top; support_slot receives the backrest support tip",
    },
    "armrest": {
        "use": "Chair armrest that screws under the seat",
        "anchors": ["mount", "bottom", "top"],
        "notes": "mount = top of its mounting plate, mate it to seat arm_mount[i]",
    },
    "panel": {
        "use": "Any flat board, plate, seat, backrest, bracket or block-like part",
        "anchors": ["top", "bottom", "front", "back", "left", "right"],
        "notes": "faces of the part's bounding box",
    },
    "fastener": {"use": "Screw, bolt, pin, dowel", "anchors": ["tip", "head"], "notes": "tip goes into the hole"},
    "unsupported": {
        "use": "Anything that fits no other template (drawn as a box)",
        "anchors": ["top", "bottom", "front", "back", "left", "right"],
        "notes": "",
    },
}


def catalog_text() -> str:
    lines = []
    for name, t in TEMPLATES.items():
        note = f" ({t['notes']})" if t["notes"] else ""
        lines.append(f"- {name}: {t['use']}. Anchors: {', '.join(t['anchors'])}{note}")
    return "\n".join(lines)


def anchor_ok(template: str, anchor: str, arms: int | None = None) -> bool:
    allowed = TEMPLATES.get(template, {}).get("anchors", [])
    if anchor in allowed:
        return True
    # indexed anchors: "socket[i]" in the catalog also allows socket[0], socket[1], ...
    limits = {"socket[": arms or 5, "arm_mount[": 2}
    for prefix, limit in limits.items():
        if anchor.startswith(prefix) and anchor.endswith("]") and f"{prefix}i]" in allowed:
            idx = anchor[len(prefix):-1]
            return idx == "i" or (idx.isdigit() and int(idx) < limit)
    return False
