import bpy, math, os, sys
from mathutils import Vector
out = sys.argv[sys.argv.index("--") + 1]
sc = bpy.context.scene
try: sc.render.engine = "BLENDER_EEVEE_NEXT"
except TypeError: sc.render.engine = "BLENDER_EEVEE"
sc.render.resolution_x, sc.render.resolution_y = 1600, 900
w = bpy.data.worlds.new("w"); sc.world = w; w.use_nodes = True
w.node_tree.nodes["Background"].inputs[1].default_value = 0.6
def cam(name, loc, target, lens=35):
    c = bpy.data.objects.new(name, bpy.data.cameras.new(name)); sc.collection.objects.link(c)
    c.location = loc; c.data.lens = lens
    d = Vector(target) - Vector(loc); c.rotation_euler = d.to_track_quat("-Z", "Y").to_euler(); return c
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN")); sun.data.energy = 3; sun.rotation_euler = (0.7, 0.3, 0.6)
sc.collection.objects.link(sun)
parts = bpy.data.collections["parts"]; room = bpy.data.collections["room"]
# 1) parts lineup: spread roots in a grid for the render
roots = [o for o in parts.objects if o.name.startswith("part_")]
for i, r in enumerate(sorted(roots, key=lambda o: o.name)):
    r.location = ((i % 6) * 1.6 - 4, -(i // 6) * 1.8 + 30, 0)
room.hide_render = True
sc.camera = cam("c1", (0, 22.5, 4.2), (0, 29.2, 0.1), 45)
sc.render.filepath = out + "_parts.png"; bpy.ops.render.render(write_still=True)
room.hide_render = False; parts.hide_render = True
sc.camera = cam("c2", (14, 16, 4), (-4, -2, -2), 22)
sc.render.filepath = out + "_room.png"; bpy.ops.render.render(write_still=True)
