from pathlib import Path
from math import tau
import bpy
from mathutils import Vector, Quaternion

root = Path.cwd()
out = root / 'renders'
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(root/'samples/ikea-kits/30178884/model.glb'))
scene = bpy.context.scene
meshes = [o for o in scene.objects if o.type == 'MESH']
def part(prefix):
    return next(o for o in meshes if o.name.startswith(prefix))

first = part('LEFT SIDE')
second = part('RIGHT SIDE')
axis = (second.matrix_world.translation-first.matrix_world.translation).normalized()
rails = [part(name) for name in ('FRONT BOTTOM','BACK BOTTOM','TOP RAIL_72934','TOP RAIL_72935')]
dowels = [part('Wood dowel_101350_0'+str(i)) for i in (1,2)]
step = part('STEP_72173')
top = part('TOP_72174')
side_screws = sorted((o for o in meshes if o.name.startswith('105215_')),key=lambda o:o.name)
deck_screws = sorted((o for o in meshes if o.name.startswith('105111_')),key=lambda o:o.name)
final = {o:(o.location.copy(),o.rotation_quaternion.copy()) for o in meshes}
scheduled = {first}
for o in meshes:
    o.hide_render = o != first
    o.keyframe_insert('hide_render',frame=1)

def approach(o, shift, frame, length=30, turns=0, stop=None):
    end, rotation = final[o]
    inverse = o.parent.matrix_world.to_3x3().inverted() if o.parent else None
    local = lambda v: inverse @ v if inverse is not None else v
    o.hide_render = False
    o.keyframe_insert('hide_render',frame=frame)
    o.location = end+local(shift)
    o.keyframe_insert('location',frame=frame)
    o.location = end+local(stop) if stop is not None else end
    o.keyframe_insert('location',frame=frame+length)
    if turns:
        o.rotation_mode='QUATERNION'
        for i in range(length+1):
            o.rotation_quaternion=rotation @ Quaternion((0,1,0),tau*turns*i/length)
            o.keyframe_insert('rotation_quaternion',frame=frame+i)
    scheduled.add(o)

def screw_axis(o):
    return o.matrix_world.to_quaternion() @ Vector((0,1,0))

screw_positions = {o:o.matrix_world.translation.copy() for o in side_screws}
def matching_screw(rail):
    point=rail.matrix_world.translation
    candidates=[o for o in side_screws if (screw_positions[o]-point).dot(axis)<0]
    return min(candidates,key=lambda o:((screw_positions[o]-point).cross(axis)).length)

# Show the first frame with its rail ends facing the viewer.
bpy.ops.object.camera_add()
camera=bpy.context.object
camera.data.type='ORTHO'
scene.camera=camera
def camera_at(frame,target,direction,scale):
    camera.location=target+direction
    camera.rotation_euler=(-direction).to_track_quat('-Z','Y').to_euler()
    camera.data.ortho_scale=scale
    camera.keyframe_insert('location',frame=frame)
    camera.keyframe_insert('rotation_euler',frame=frame)
    camera.data.keyframe_insert('ortho_scale',frame=frame)

import json
chapters=[]

cursor=1
def shot(number, caption, target, view, scale, duration=72):
    global cursor
    start=cursor
    end=start+duration-1
    camera_at(start,target,view,scale)
    camera_at(end,target,view,scale)
    chapters.append((start,number,caption))
    scene.timeline_markers.new(f'{number} | {caption}',frame=start)
    cursor=end+1
    return start+12

view=axis*1.32+Vector((-.83,0,.82))
for index,rail in enumerate(rails):
    stage='STEP 1' if index<2 else 'STEP 2'
    target=rail.matrix_world.translation-axis*.10
    start=shot(stage,'Seat the '+('front lower','rear lower','first upper','second upper')[index]+' rail',target,view,.89)
    approach(rail,axis*.16,start)
    screw=matching_screw(rail)
    if index==0: test_screw=screw
    target=screw.matrix_world.translation
    start=shot(stage,'Start the rail screw. Leave the head proud.',target,-axis*1.20+Vector((.44,0,.28)),.42)
    direction=screw_axis(screw)
    approach(screw,direction*.10,start,turns=1.5,stop=direction*.008)

start=shot('STEP 3','Press both dowels into the lower step.',step.matrix_world.translation,view,.81,104)
lift=Vector((0,0,.15))
approach(step,lift,start,length=1,stop=lift)
for i,dowel in enumerate(dowels):
    direction=dowel.matrix_world.to_quaternion() @ Vector((0,1,0))
    if direction.dot(dowel.matrix_world.translation-step.matrix_world.translation)<0:
        direction.negate()
    approach(dowel,lift+direction*.065,start+i*35,length=26,stop=lift)
start=shot('STEP 3','Seat the lower step in the first side frame.',step.matrix_world.translation,view,.89)
approach(step,lift+axis*.035,start)
for dowel in dowels:
    approach(dowel,lift+axis*.035,start)

start=shot('STEP 4','Slide the second side frame onto the rail ends.',Vector((0,0,.24)),view,1.15,96)
approach(second,axis*.19,start,length=48)
for i,screw in enumerate(o for o in side_screws if o not in scheduled):
    target=screw.matrix_world.translation
    start=shot('STEP 4',f'Start screw {i+1} of 4 on the second side.',target,axis*1.2+Vector((.42,0,.31)),.43,62)
    direction=screw_axis(screw)
    approach(screw,direction*.10,start,turns=1.5,stop=direction*.008)

start=shot('STEP 5','Join the top panel to the frame.',Vector((0,0,.28)),view,1.1,105)
# Rotate the camera to the underside to show the same inverted working view as the manual.
camera_at(start+42,Vector((0,0,.28)),axis*.86+Vector((.85,0,-1.0)),1.1)
camera_at(cursor-1,Vector((0,0,.28)),axis*.86+Vector((.85,0,-1.0)),1.1)
approach(top,Vector((0,0,.12)),start+30,length=34)
for i,screw in enumerate(deck_screws):
    start=shot('STEP 5',f'Drive screw {i+1} of 3 from below.',screw.matrix_world.translation,
               axis*.56+Vector((.5,0,-1.1)),.46)
    approach(screw,screw_axis(screw)*.105,start,turns=2)

for i,screw in enumerate(side_screws):
    direction=screw_axis(screw)
    start=shot('STEP 6',f'Fully tighten side screw {i+1} of 8.',screw.matrix_world.translation,
               direction*1.2+Vector((.44,0,.30)),.40,57)
    approach(screw,direction*.008,start,length=24,turns=1)

shot('COMPLETE','All rails, steps and fasteners seated.',Vector((0,0,.26)),view,.92,88)
assert scheduled==set(meshes)
scene.frame_end=cursor-1
if 'check' in __import__('sys').argv:
    scene.frame_start=chapters[1][0]
    scene.frame_end=chapters[2][0]-1
    for frame in range(scene.frame_start,scene.frame_end+1):
        scene.frame_set(frame)
        screw=test_screw
        expected=final[screw][1].normalized() @ Vector((0,1,0))
        actual=screw.rotation_quaternion.normalized() @ Vector((0,1,0))
        assert (expected-actual).length < .0001
    print('Verified the screw shaft stays on axis for the entire shot.')
for o in meshes:
    o.color=(.23,.17,.12,1)
for o in rails:
    o.color=(.48,.31,.16,1)
second.color=(.08,.52,.48,1)
top.color=step.color=(.56,.39,.22,1)
for o in [*side_screws,*deck_screws,*dowels]:
    o.color=(1,.67,.23,1)
scene.world=bpy.data.worlds.new('Studio')
scene.world.color=(.87,.91,.91)
scene.render.engine='BLENDER_WORKBENCH'
shading=scene.display.shading
shading.color_type='OBJECT'
shading.background_type='WORLD'
shading.show_cavity=True
shading.cavity_type='BOTH'
for item in (scene,):
    item.render.resolution_x=1280
    item.render.resolution_y=720
    item.render.resolution_percentage=100
    item.render.fps=24
    item.frame_end=scene.frame_end
# Workbench render for motion and chapter markers in the editable project.
scene.render.image_settings.file_format='FFMPEG'
scene.render.ffmpeg.format='MPEG4'
scene.render.ffmpeg.codec='H264'
scene.render.filepath=str(out/('bekvam-screw-check.mp4' if 'check' in __import__('sys').argv else 'bekvam-outside-in.mp4'))
(out/'bekvam-chapters.json').write_text(json.dumps(chapters), encoding='utf-8')
bpy.context.preferences.filepaths.save_version=0
scene.frame_set(1)
bpy.context.window.scene=scene
bpy.ops.wm.save_as_mainfile(filepath=str(out/('bekvam-screw-check.blend' if 'check' in __import__('sys').argv else 'bekvam-outside-in.blend')))
bpy.ops.render.render(animation=True)




