import bpy
from mathutils import Vector
s=bpy.context.scene
for o in s.objects:
 if o.type!='MESH' or not o.name.startswith(('105215','105111')): continue
 s.frame_set(s.frame_end)
 p=o.matrix_world.translation.copy()
 d=o.matrix_world.to_quaternion() @ Vector((0,1,0))
 s.frame_set(1)
 q=o.matrix_world.translation.copy()
 delta=q-p
 print(o.name,tuple(round(x,3) for x in p),tuple(round(x,3) for x in d),round(delta.dot(d),3))
 assert delta.dot(d)>0 and delta.cross(d).length<.0001
