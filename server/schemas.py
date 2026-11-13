"""JSON schemas the model must follow. Decoding is constrained to these shapes,
so the model only ever picks values; it never writes free-form geometry."""
from typing import Literal, Optional
from pydantic import BaseModel, Field

# ---------- Pass 1: page classification ----------
PageType = Literal["parts_list", "steps", "warning", "other"]


class StepRegion(BaseModel):
    step: int = Field(description="Step number as printed, e.g. 1 for 'STEP 1'")
    box_2d: list[int] = Field(description="Box around the whole step panel: [ymin, xmin, ymax, xmax], each 0-1000 relative to the page")


class PageInfo(BaseModel):
    page: int = Field(description="1-based page number, in the order the images were given")
    page_type: PageType = Field(description="Main purpose of the page")
    has_parts_list: bool = Field(description="True if the page lists the main parts with letters")
    has_hardware_list: bool = Field(description="True if the page lists screws/bolts/pins with letters")
    steps: list[StepRegion] = Field(description="Every numbered assembly step drawn on this page; empty if none")


class PagesInfo(BaseModel):
    pages: list[PageInfo] = Field(description="One entry per image, in order")


# ---------- Pass 2: parts and hardware ----------
TemplateName = Literal["star_base", "caster", "gas_cylinder", "telescoping_cover", "chair_seat", "chair_backrest",
                       "backrest_support", "chair_mechanism", "armrest", "panel", "fastener", "unsupported"]


class Size(BaseModel):
    w: float = Field(description="Left-to-right extent in mm, as the part sits in the finished product")
    h: float = Field(description="Bottom-to-top extent in mm")
    d: float = Field(description="Front-to-back extent in mm")


class PartOut(BaseModel):
    label: str = Field(description="Letter/ID exactly as printed, e.g. 'A', 'I-C', '118331'; or P1, P2, ... for a part the manual does not label")
    name: str
    count: int = Field(description="Quantity. A 'Set' counts as 1")
    template: TemplateName
    is_hardware: bool = Field(description="True for screws, bolts, pins, knobs from the hardware list")
    printed_size_mm: Optional[Size] = Field(description="Only if dimensions are printed in the manual, else null")
    approx_size_mm: Optional[Size] = Field(description="Your best estimate of the real-world size from the drawing and common furniture sizes")
    fastener_diameter_mm: Optional[float] = Field(description="For fasteners: diameter, e.g. 6 for M6x25")
    fastener_length_mm: Optional[float] = Field(description="For fasteners: length, e.g. 25 for M6x25")
    hardware_kind: Optional[Literal["screw", "bolt", "dowel", "cam_pin", "cam_nut", "foot", "other"]] = Field(
        description="For hardware: dowel = plain wooden peg; cam_pin = the metal pin a cam lock grips; cam_nut = the round cam lock itself; "
                    "foot = adjustable foot or glide; otherwise screw or bolt. Null for parts that are not hardware")
    arms: Optional[int] = Field(description="For star_base only: number of arms")


class PartsOut(BaseModel):
    product_name: str
    model_number: Optional[str]
    category: str = Field(description="e.g. office_chair, side_table, bookshelf")
    parts: list[PartOut]


# ---------- Layout: where each structural part sits in the finished product ----------
class Placed(BaseModel):
    label: str = Field(description="Part label from the list")
    instance: int = Field(description="Which copy, 0-based. A part with count 4 needs instances 0, 1, 2, 3")
    role: str = Field(description="Short role of this copy, e.g. 'front left leg'")
    cx: float = Field(description="Centre, left-to-right, mm. 0 is the middle of the product")
    cy: float = Field(description="Centre height above the floor, mm")
    cz: float = Field(description="Centre, back-to-front, mm. 0 is the middle; positive is nearer the front")
    w: float = Field(description="Extent of this copy left-to-right, mm, as it sits in the finished product")
    h: float = Field(description="Extent of this copy bottom-to-top, mm")
    d: float = Field(description="Extent of this copy back-to-front, mm")


class LayoutOut(BaseModel):
    placed: list[Placed] = Field(description="One entry per copy of every structural part")


# ---------- Pass 3: one step ----------
MateType = Literal["pin_in_hole", "face_to_face"]
Fit = Literal["press", "slide", "screw"]


class AnchorRef(BaseModel):
    part: str = Field(description="Part label")
    anchor: str = Field(description="Anchor name from that part's template list")


class Move(BaseModel):
    part: str = Field(description="Label of the part that moves")
    instances: list[int] = Field(description="Which copies move, 0-based. Five casters = [0,1,2,3,4]")


class Spot(BaseModel):
    along: float = Field(description="0 to 1 along the longer side of the face (0 = left or back or bottom end)")
    across: float = Field(description="0 to 1 across the shorter side of the face; 0.5 is the middle")


class SubStep(BaseModel):
    title: str = Field(description="Short instruction, e.g. 'Press the 5 casters F into base C'")
    moves: list[Move]
    mate_type: MateType
    this: AnchorRef = Field(description="Anchor on the moving part")
    other: AnchorRef = Field(description="Anchor on the part it attaches to")
    fit: Fit
    spots: Optional[list[Spot]] = Field(description="For a fastener substep: where each fastener goes on the face named in 'other', "
                                                    "for ONE copy of that part (the same pattern repeats on every copy). Null if not a fastener substep")
    joins: Optional[str] = Field(description="For a fastener substep: label of the second part this fastener will hold against "
                                             "'other' (dowels pushed into rail P2 that later join it to leg P1 -> 'P1'). Null if none or unknown")


class StepOut(BaseModel):
    step: int
    substeps: list[SubStep] = Field(description="Actions in the order a person performs them (follow FIRST/THEN/LAST labels and arrows)")


class StepsOnPage(BaseModel):
    steps: list[StepOut] = Field(description="Every numbered step on the page, in step order")
