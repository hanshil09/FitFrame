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
    w: float = Field(description="Width in mm")
    h: float = Field(description="Height in mm")
    d: float = Field(description="Depth in mm")


class PartOut(BaseModel):
    label: str = Field(description="Letter/ID exactly as printed, e.g. 'A', 'I-C', 'M'")
    name: str
    count: int = Field(description="Quantity. A 'Set' counts as 1")
    template: TemplateName
    is_hardware: bool = Field(description="True for screws, bolts, pins, knobs from the hardware list")
    printed_size_mm: Optional[Size] = Field(description="Only if dimensions are printed in the manual, else null")
    approx_size_mm: Optional[Size] = Field(description="Your best estimate of the real-world size from the drawing and common furniture sizes")
    fastener_diameter_mm: Optional[float] = Field(description="For fasteners: diameter, e.g. 6 for M6x25")
    fastener_length_mm: Optional[float] = Field(description="For fasteners: length, e.g. 25 for M6x25")
    arms: Optional[int] = Field(description="For star_base only: number of arms")


class PartsOut(BaseModel):
    product_name: str
    model_number: Optional[str]
    category: str = Field(description="e.g. office_chair, side_table, bookshelf")
    parts: list[PartOut]


# ---------- Pass 3: one step ----------
MateType = Literal["pin_in_hole", "face_to_face"]
Fit = Literal["press", "slide", "screw"]


class AnchorRef(BaseModel):
    part: str = Field(description="Part label")
    anchor: str = Field(description="Anchor name from that part's template list")


class Move(BaseModel):
    part: str = Field(description="Label of the part that moves")
    instances: list[int] = Field(description="Which copies move, 0-based. Five casters = [0,1,2,3,4]")


class SubStep(BaseModel):
    title: str = Field(description="Short instruction, e.g. 'Press the 5 casters F into base C'")
    moves: list[Move]
    mate_type: MateType
    this: AnchorRef = Field(description="Anchor on the moving part")
    other: AnchorRef = Field(description="Anchor on the part it attaches to")
    fit: Fit


class StepOut(BaseModel):
    step: int
    substeps: list[SubStep] = Field(description="Actions in the order a person performs them (follow FIRST/THEN/LAST labels and arrows)")


class StepsOnPage(BaseModel):
    steps: list[StepOut] = Field(description="Every numbered step on the page, in step order")
