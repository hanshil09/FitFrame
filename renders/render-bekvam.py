from pathlib import Path
import bpy
from mathutils import Vector
from math import tau

root = Path.cwd()
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(root/'samples/ikea-kits/30178884/model.glb'))
scene = bpy.context.scene
meshes = [o for o in scene.objects if o.type == 'MESH']
def find(prefix):
    return next(o for o in meshes if o.name.startswith(prefix))
moving = find('RIGHT SIDE ASSEMBLY')
fixed = find('LEFT SIDE ASSEMBLY')
outward = (moving.matrix_world.translation - fixed.matrix_world.translation).normalized()
top = find('TOP_72174')
screws = [o for o in meshes if o.name.startswith('105215_')]
closing = [o for o in screws if (o.matrix_world.translation - moving.matrix_world.translation).dot(outward) > -.1]
assert len(closing) == 4
for o in [top, *(o for o in meshes if o.name.startswith('105111_'))]:
    o.hide_render = True
def move(o, shift, start, end, spin=False):
    bpy.context.view_layer.update()
    parent = o.parent.matrix_world.to_3x3() if o.parent else None
    delta = parent.inverted() @ shift if parent else shift
    final = o.location.copy()
    q = o.rotation_quaternion.copy()
    o.location = final + delta
    o.keyframe_insert('location', frame=start)
    o.location = final
    o.keyframe_insert('location', frame=end)
    if spin:
        from mathutils import Quaternion
        o.rotation_mode = 'QUATERNION'
        for frame in range(start,end+1):
            angle = -tau * (end-frame)/(end-start)
            o.rotation_quaternion = q @ Quaternion((0,0,1),angle)
            o.keyframe_insert('rotation_quaternion',frame=frame)
move(moving, outward*.19, 12, 47)
for i,o in enumerate(closing):
    move(o,outward*.27,55+i*8,76+i*8,spin=True)
    o.hide_render=True
    o.keyframe_insert('hide_render',frame=1)
    o.hide_render=False
    o.keyframe_insert('hide_render',frame=55+i*8)
def aim(o,target):
    o.rotation_euler=(Vector(target)-o.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.object.camera_add(location=(1.12,1.34,.82))
cam=bpy.context.object
aim(cam,(0,0,.26))
cam.data.type='ORTHO'
cam.data.ortho_scale=1.03
scene.camera=cam
for location,power,size in [((1,1,2),145,2),((-1,0,1),90,1.5),((0,-1,2),110,1.5)]:
    bpy.ops.object.light_add(type='AREA',location=location)
    light=bpy.context.object
    light.data.energy=power
    light.data.shape='DISK'
    light.data.size=size
    aim(light,(0,0,0))
scene.world=bpy.data.worlds.new('Studio')
scene.world.color=(.28,.28,.28)
scene.render.engine='BLENDER_WORKBENCH'
scene.display.shading.color_type='OBJECT'
scene.display.shading.background_type='WORLD'
scene.world.color=(.83,.88,.90)
for o in meshes:
    o.color=(.32,.22,.14,1)
moving.color=(.10,.49,.48,1)
for o in screws:
    o.color=(.90,.66,.28,1)
scene.display.shading.show_cavity=True
scene.display.shading.cavity_type='BOTH'
scene.render.image_settings.color_mode="RGB"
scene.render.resolution_x=768
scene.render.resolution_y=480
scene.render.resolution_percentage=100
scene.render.fps=24
scene.frame_end=120
scene.render.image_settings.file_format='PNG' if 'preview' in __import__('sys').argv else 'FFMPEG'
scene.render.ffmpeg.format='MPEG4'
scene.render.ffmpeg.codec='H264'
scene.render.filepath=str(root/'renders'/'bekvam-step-4.mp4')
scene.frame_set(1)
bpy.ops.wm.save_as_mainfile(filepath=str(root/'renders'/'bekvam-step-4.blend'))
import sys
if 'preview' in sys.argv:
    for frame in (1,47,110):
        scene.frame_set(frame)
        scene.render.filepath=str(root/'renders'/f'preview-{frame}.png')
        bpy.ops.render.render(write_still=True)
else:
    bpy.ops.render.render(animation=True)


