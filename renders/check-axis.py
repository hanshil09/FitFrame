import bpy
from mathutils import Vector
for o in bpy.context.scene.objects:
 if o.type=='MESH' and o.name.startswith(('105215','105111')):
  print(o.name,[tuple(round(x,4) for x in v) for v in (Vector(map(min,zip(*o.bound_box))),Vector(map(max,zip(*o.bound_box))))])
