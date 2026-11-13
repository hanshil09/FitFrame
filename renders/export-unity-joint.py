import bpy
from pathlib import Path
root=Path.cwd()
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(root/'samples/ikea-kits/30178884/model.glb'))
for o in bpy.context.scene.objects:
 if o.type=='MESH' and not o.name.startswith(('LEFT SIDE','FRONT BOTTOM RAIL','105215_05')):
  o.hide_set(True)
bpy.ops.object.select_all(action='DESELECT')
for o in bpy.context.scene.objects:
 if not o.hide_get(): o.select_set(True)
bpy.ops.export_scene.fbx(filepath=str(root/'Assets/Resources/BekvamJoint.fbx'),use_selection=True,add_leaf_bones=False)
