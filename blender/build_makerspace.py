"""Build the Virtual Makerspace room + detailed module parts and export GLBs.

Run:  blender -b -P blender/build_makerspace.py
Outputs: public/models/makerspace_room.glb, public/models/makerspace_parts.glb,
         blender/makerspace.blend

All helper coordinates are in three.js space (x right, y up, z toward camera);
t2b() converts to Blender Z-up. Part origins match the procedural components
in src/desktop/scene.ts (leads at x = +/- leadSeparation/2, tips at y = -0.34),
so snapping keeps working. Room scale: 1 unit ~= 0.165 m (bench = 11 units).
"""
import math
import os

import bmesh
import bpy
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEX = os.path.join(ROOT, "blender", "tex")
OUT = os.path.join(ROOT, "public", "models")
os.makedirs(OUT, exist_ok=True)

PITCH = 0.24
FLOOR_Y = -5.6  # bench top at y=0, 0.92 m high
M = 1 / 0.165  # metres -> units


def t2b(x, y, z):
    return Vector((x, -z, y))


# ---------------------------------------------------------------- reset
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def collection(name):
    col = bpy.data.collections.new(name)
    scene.collection.children.link(col)
    return col


# ---------------------------------------------------------------- materials
_mats = {}


def mat(name, color, rough=0.5, metal=0.0, emit=None, emit_strength=0.0, alpha=1.0,
        transmission=0.0, ior=1.45, coat=0.0):
    if name in _mats:
        return _mats[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    c = color if len(color) == 4 else (*color, 1.0)
    bsdf.inputs["Base Color"].default_value = c
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    bsdf.inputs["IOR"].default_value = ior
    if transmission:
        bsdf.inputs["Transmission Weight"].default_value = transmission
    if coat:
        bsdf.inputs["Coat Weight"].default_value = coat
    if emit:
        bsdf.inputs["Emission Color"].default_value = (*emit, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emit_strength
    if alpha < 1:
        bsdf.inputs["Alpha"].default_value = alpha
        m.blend_method = "BLEND"
    _mats[name] = m
    return m


def tex_mat(name, stem, scale=1.0, tint=None, rough_mul=1.0):
    """PBR material from Poly Haven 1k maps; UV scale baked via mapping node."""
    if name in _mats:
        return _mats[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")

    def img(suffix, colorspace):
        path = os.path.join(TEX, f"{stem}_{suffix}_1k.jpg")
        node = nt.nodes.new("ShaderNodeTexImage")
        node.image = bpy.data.images.load(path, check_existing=True)
        node.image.colorspace_settings.name = colorspace
        return node

    diff = img("diff", "sRGB")
    nt.links.new(diff.outputs["Color"], bsdf.inputs["Base Color"])
    rough = img("rough", "Non-Color")
    nt.links.new(rough.outputs["Color"], bsdf.inputs["Roughness"])
    nor = img("nor_gl", "Non-Color")
    nmap = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(nor.outputs["Color"], nmap.inputs["Color"])
    nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    m["uv_scale"] = scale
    _mats[name] = m
    return m


# common palette
STEEL = mat("steel_brushed", (0.62, 0.64, 0.66), 0.32, 1.0)
DARK_STEEL = mat("steel_powder_black", (0.035, 0.037, 0.04), 0.55, 0.3)
TIN = mat("tinned_lead", (0.78, 0.79, 0.8), 0.22, 1.0)
GOLD = mat("gold_plating", (0.86, 0.66, 0.3), 0.25, 1.0)
COPPER = mat("copper", (0.72, 0.4, 0.22), 0.3, 1.0)
BLACK_PLASTIC = mat("plastic_black", (0.018, 0.018, 0.02), 0.42)
WHITE_PLASTIC = mat("plastic_white", (0.86, 0.86, 0.84), 0.38)
GREY_PLASTIC = mat("plastic_grey", (0.3, 0.32, 0.34), 0.45)
RUBBER = mat("rubber_black", (0.02, 0.02, 0.02), 0.85)
PCB_GREEN = mat("pcb_soldermask_green", (0.03, 0.2, 0.1), 0.35, coat=0.6)
PCB_BLUE = mat("pcb_soldermask_blue", (0.02, 0.12, 0.4), 0.35, coat=0.6)
PCB_TEAL = mat("pcb_soldermask_teal", (0.0, 0.32, 0.36), 0.35, coat=0.6)
PCB_BLACK = mat("pcb_soldermask_black", (0.012, 0.014, 0.016), 0.3, coat=0.6)
SILK = mat("silkscreen_white", (0.9, 0.9, 0.88), 0.6)
IC = mat("ic_epoxy", (0.03, 0.03, 0.035), 0.5)


# ---------------------------------------------------------------- primitives
def _finish(obj, name, material, parent, col, bevel=0.0, segments=2, smooth=False):
    obj.name = name
    if material:
        obj.data.materials.append(material)
    if parent:
        obj.parent = parent
    for c in obj.users_collection:
        c.objects.unlink(obj)
    col.objects.link(obj)
    if bevel:
        mod = obj.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = segments
        mod.limit_method = "ANGLE"
        obj.modifiers.new("wn", "WEIGHTED_NORMAL").keep_sharp = True
    if smooth:
        for p in obj.data.polygons:
            p.use_smooth = True
    return obj


def box(name, c, s, material, parent=None, col=None, bevel=0.0, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=t2b(*c))
    o = bpy.context.active_object
    o.scale = (s[0], s[2], s[1])
    o.rotation_euler = (rot[0], -rot[2], rot[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return _finish(o, name, material, parent, col, bevel)


def cyl(name, c, r, h, material, parent=None, col=None, axis="y", verts=24, r2=None,
        bevel=0.0, smooth=True, rot_extra=0.0):
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=h, location=t2b(*c))
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r2, depth=h, location=t2b(*c))
    o = bpy.context.active_object
    # blender cylinders are along Z == three y
    if axis == "x":
        o.rotation_euler = (0, math.pi / 2, rot_extra)
    elif axis == "z":
        o.rotation_euler = (math.pi / 2, 0, rot_extra)
    else:
        o.rotation_euler = (0, 0, rot_extra)
    o = _finish(o, name, material, parent, col, bevel, smooth=smooth)
    _flat_caps(o)
    return o


def _flat_caps(o):
    # keep caps flat-shaded when smoothing cylinders
    for p in o.data.polygons:
        if len(p.vertices) > 4:
            p.use_smooth = False


def sphere(name, c, r, material, parent=None, col=None, scale=(1, 1, 1), seg=24):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=seg // 2, radius=r, location=t2b(*c))
    o = bpy.context.active_object
    o.scale = (scale[0], scale[2], scale[1])
    return _finish(o, name, material, parent, col, smooth=True)


def torus(name, c, R, r, material, parent=None, col=None, axis="y", seg=32):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, major_segments=seg,
                                     minor_segments=10, location=t2b(*c))
    o = bpy.context.active_object
    if axis == "x":
        o.rotation_euler = (0, math.pi / 2, 0)
    elif axis == "z":
        o.rotation_euler = (math.pi / 2, 0, 0)
    return _finish(o, name, material, parent, col, smooth=True)


def lathe(name, profile, c, material, parent=None, col=None, axis="y", steps=32):
    """profile: [(radius, height)] in three units around local axis."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    rings = []
    for i in range(steps):
        a = 2 * math.pi * i / steps
        ring = []
        for r, h in profile:
            ring.append(bm.verts.new((r * math.cos(a), r * math.sin(a), h)))
        rings.append(ring)
    for i in range(steps):
        a, b = rings[i], rings[(i + 1) % steps]
        for j in range(len(profile) - 1):
            bm.faces.new((a[j], b[j], b[j + 1], a[j + 1]))
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    col.objects.link(o)
    o.location = t2b(*c)
    if axis == "x":
        o.rotation_euler = (0, math.pi / 2, 0)
    elif axis == "z":
        o.rotation_euler = (math.pi / 2, 0, 0)
    for p in me.polygons:
        p.use_smooth = True
    me.materials.append(material)
    if parent:
        o.parent = parent
    return o


def tube(name, pts, r, material, parent=None, col=None, res=10):
    """Polyline tube through three-space points (bevelled curve -> mesh)."""
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = r
    cu.bevel_resolution = 3
    cu.resolution_u = res
    sp = cu.splines.new("BEZIER")
    sp.bezier_points.add(len(pts) - 1)
    for bp, p in zip(sp.bezier_points, pts):
        bp.co = t2b(*p)
        bp.handle_left_type = bp.handle_right_type = "AUTO"
    cu.use_fill_caps = True
    o = bpy.data.objects.new(name, cu)
    col.objects.link(o)
    o.data.materials.append(material)
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.convert(target="MESH")
    o = bpy.context.active_object
    if parent:
        o.parent = parent
    return o


def empty(name, c, col, parent=None):
    e = bpy.data.objects.new(name, None)
    e.location = t2b(*c)
    col.objects.link(e)
    if parent:
        e.parent = parent
    return e


def lead(name, x, parent, col, top=0.1, bottom=-0.34, r=0.022):
    return cyl(name, (x, (top + bottom) / 2, 0), r, top - bottom, TIN, parent, col, verts=10)


# ================================================================ PARTS
parts = collection("parts")


def part_root(pid, slot):
    # parts are laid out along x in the .blend for inspection; the app resets
    # each part's position to 0 so only its local frame matters.
    return empty(f"part_{pid}", (0, 0, 0), parts)


def led(pid, slot, rgb):
    root = part_root(pid, slot)
    ox = 0.0
    at = lambda x, y, z: (x, y, z)
    epoxy = mat(f"LED_glow_{pid}", rgb, 0.08, 0.0, emit=rgb, emit_strength=0.0,
                transmission=0.85, ior=1.52)
    # 5 mm LED: flange, cylinder, hemispherical dome
    lathe(f"{pid}_epoxy", [(0.0, 0.0), (0.205, 0.0), (0.205, 0.05), (0.18, 0.055), (0.18, 0.3),
                           (0.172, 0.35), (0.15, 0.4), (0.11, 0.44), (0.06, 0.462), (0.0, 0.468)],
          at(0, 0.0, 0), epoxy, root, parts, steps=40)
    # internal anvil (cathode cup) + post, visible through the epoxy
    box(f"{pid}_anvil", at(-0.06, 0.2, 0), (0.07, 0.3, 0.03), STEEL, root, parts)
    box(f"{pid}_post", at(0.06, 0.16, 0), (0.035, 0.22, 0.03), STEEL, root, parts)
    cyl(f"{pid}_cup", at(-0.05, 0.36, 0), 0.045, 0.04, STEEL, root, parts, verts=16, r2=0.06)
    # flat on cathode side of flange
    box(f"{pid}_flat", at(-0.2, 0.025, 0), (0.02, 0.05, 0.2), epoxy, root, parts)
    half = PITCH / 2
    # anode (longer, with a small kink) / cathode
    tube(f"{pid}_lead_a", [at(half, 0.0, 0), at(half, -0.12, 0), at(half + 0.03, -0.18, 0),
                           at(half, -0.24, 0), at(half, -0.34, 0)], 0.022, TIN, root, parts)
    lead(f"{pid}_lead_k", ox - half, root, parts, top=0.0)
    return root


def resistor(pid, slot, bands):
    root = part_root(pid, slot)
    ox = 0.0
    at = lambda x, y, z: (x, y, z)
    body = mat(f"{pid}_body", (0.78, 0.66, 0.46), 0.55, coat=0.3)
    # dog-bone carbon-film body along x
    lathe(f"{pid}_body", [(0.0, -0.3), (0.06, -0.3), (0.115, -0.28), (0.128, -0.22), (0.12, -0.14),
                          (0.105, -0.1), (0.105, 0.1), (0.12, 0.14), (0.128, 0.22), (0.115, 0.28),
                          (0.06, 0.3), (0.0, 0.3)], at(0, 0.12, 0), body, root, parts, axis="x")
    band_colors = {
        "brown": (0.25, 0.1, 0.04), "black": (0.02, 0.02, 0.02), "red": (0.65, 0.04, 0.03),
        "orange": (0.85, 0.3, 0.02), "gold": (0.8, 0.6, 0.2),
    }
    for i, (bx, name) in enumerate(zip((-0.2, -0.13, -0.06, 0.2), bands)):
        radius = 0.13 if abs(bx) > 0.15 else 0.108
        cyl(f"{pid}_band{i}", at(bx, 0.12, 0), radius + 0.002, 0.035,
            mat(f"band_{name}", band_colors[name], 0.35 if name != "gold" else 0.25, 1.0 if name == "gold" else 0.0),
            root, parts, axis="x", verts=32)
    sep = PITCH * 3
    for i, s in enumerate((-1, 1)):
        tube(f"{pid}_lead{i}", [at(s * 0.3, 0.12, 0), at(s * (sep / 2 - 0.06), 0.12, 0),
                                at(s * sep / 2, 0.06, 0), at(s * sep / 2, -0.34, 0)], 0.022, TIN, root, parts)
    return root


def battery(pid, slot):
    root = part_root(pid, slot)
    ox = 0.0
    at = lambda x, y, z: (x, y, z)
    sep = PITCH * 2
    # 9V: 48.5 x 26.5 x 17.5 mm -> scaled up like the other parts
    box(f"{pid}_can", at(0, 0.3, 0), (0.8, 0.72, 0.46), mat("battery_label_black", (0.02, 0.02, 0.025), 0.4, coat=0.5),
        root, parts, bevel=0.05)
    box(f"{pid}_band", at(0, 0.5, 0), (0.812, 0.2, 0.472), mat("battery_label_copper", (0.62, 0.32, 0.1), 0.3, 0.8),
        root, parts, bevel=0.04)
    box(f"{pid}_label", at(0, 0.28, 0.232), (0.5, 0.18, 0.004), mat("battery_label_text", (0.85, 0.75, 0.5), 0.5),
        root, parts)
    box(f"{pid}_cap", at(0, 0.685, 0), (0.78, 0.05, 0.44), DARK_STEEL, root, parts, bevel=0.02)
    # + terminal: round stud; - terminal: hexagonal socket
    cyl(f"{pid}_pos_base", at(sep / 2, 0.73, 0), 0.085, 0.04, STEEL, root, parts, verts=24)
    cyl(f"{pid}_pos_stud", at(sep / 2, 0.8, 0), 0.06, 0.1, STEEL, root, parts, verts=24)
    cyl(f"{pid}_pos_lip", at(sep / 2, 0.85, 0), 0.07, 0.025, STEEL, root, parts, verts=24)
    cyl(f"{pid}_neg_hex", at(-sep / 2, 0.79, 0), 0.1, 0.12, STEEL, root, parts, verts=6, smooth=False)
    cyl(f"{pid}_neg_hole", at(-sep / 2, 0.8, 0), 0.06, 0.13, BLACK_PLASTIC, root, parts, verts=6, smooth=False)
    for i, x in enumerate((-sep / 2, sep / 2)):
        lead(f"{pid}_lead{i}", ox + x, root, parts, top=-0.04, r=0.026)
    box(f"{pid}_foot", at(0, -0.06, 0), (0.7, 0.04, 0.36), RUBBER, root, parts, bevel=0.01)
    return root


def header_pins(prefix, at, x0, z, count, pitch, root, color=BLACK_PLASTIC, along="x"):
    for i in range(count):
        dx, dz = (i * pitch, 0) if along == "x" else (0, i * pitch)
        box(f"{prefix}_pin{i}", at(x0 + dx, 0.0, z + dz), (0.018, 0.2, 0.018), GOLD, root, parts)
    L = count * pitch
    cx = x0 + (L - pitch) / 2 if along == "x" else x0
    cz = z if along == "x" else z + (L - pitch) / 2
    size = (L, 0.07, pitch * 0.95) if along == "x" else (pitch * 0.95, 0.07, L)
    box(f"{prefix}_body", at(cx, -0.02, cz), size, color, root, parts)


def sensor(pid, slot, kind, accent):
    root = part_root(pid, slot)
    ox = 0.0
    at = lambda x, y, z: (x, y, z)
    sep = PITCH * 2
    if kind == "soil":
        # capacitive soil moisture v1.2: black PCB blade, fork tip buried in soil
        box(f"{pid}_head", at(0, 0.36, 0), (0.5, 0.34, 0.035), PCB_BLACK, root, parts, bevel=0.01)
        box(f"{pid}_blade", at(0, 0.02, 0), (0.3, 0.36, 0.035), PCB_BLACK, root, parts, bevel=0.01)
        box(f"{pid}_zone", at(0, 0.05, 0.019), (0.22, 0.26, 0.004), COPPER, root, parts)
        box(f"{pid}_ic", at(-0.08, 0.38, 0.03), (0.1, 0.1, 0.03), IC, root, parts)
        box(f"{pid}_reg", at(0.1, 0.38, 0.03), (0.08, 0.06, 0.03), IC, root, parts)
        box(f"{pid}_jst", at(0, 0.5, 0.05), (0.26, 0.08, 0.08), WHITE_PLASTIC, root, parts, bevel=0.005)
        box(f"{pid}_silk", at(0, 0.24, 0.019), (0.42, 0.012, 0.003), SILK, root, parts)
        box(f"{pid}_status", at(0.18, 0.28, 0.024), (0.03, 0.02, 0.012),
            mat("sensor_led_green", (0.1, 1, 0.3), 0.2, emit=(0.1, 1, 0.3), emit_strength=3), root, parts)
    elif kind == "climate":
        # DHT22 style: white grille housing on blue breakout
        box(f"{pid}_pcb", at(0, 0.14, 0), (0.46, 0.035, 0.36), PCB_BLUE, root, parts, bevel=0.01)
        box(f"{pid}_housing", at(0, 0.34, 0), (0.34, 0.34, 0.22), WHITE_PLASTIC, root, parts, bevel=0.02)
        for r in range(4):
            for c in range(3):
                box(f"{pid}_slot{r}{c}", at(-0.08 + c * 0.08, 0.24 + r * 0.065, 0.112), (0.045, 0.028, 0.01),
                    BLACK_PLASTIC, root, parts)
        header_pins(f"{pid}_hdr", at, -0.09, -0.14, 3, 0.09, root)
    else:
        # BH1750 lux sensor with diffuser dome
        box(f"{pid}_pcb", at(0, 0.3, 0), (0.46, 0.035, 0.36), mat("pcb_purple", (0.18, 0.05, 0.35), 0.35, coat=0.6),
            root, parts, bevel=0.01)
        sphere(f"{pid}_dome", at(0, 0.33, 0), 0.12, mat("diffuser_opal", (0.95, 0.95, 0.9), 0.3, transmission=0.4),
               root, parts, scale=(1, 0.8, 1))
        box(f"{pid}_chip", at(0.14, 0.33, 0.1), (0.07, 0.03, 0.05), IC, root, parts)
        for i in range(5):
            cyl(f"{pid}_hole{i}", at(-0.18 + i * 0.09, 0.3, -0.14), 0.025, 0.04, GOLD, root, parts, verts=12)
    # probe leads that seat in the grid sockets
    for i, x in enumerate((-sep / 2, sep / 2)):
        lead(f"{pid}_lead{i}", ox + x, root, parts, top=0.14 if kind != "soil" else -0.16)
    cyl(f"{pid}_tag", at(-0.2, 0.52 if kind == "soil" else 0.2, 0.0), 0.03, 0.02,
        mat(f"accent_{pid}", accent, 0.3, emit=accent, emit_strength=1.5), root, parts)
    return root


def controller(pid, slot):
    root = part_root(pid, slot)
    ox = 0.0
    at = lambda x, y, z: (x, y, z)
    sep = PITCH * 4
    # Uno-style dev board + 1-ch relay daughter board
    box(f"{pid}_pcb", at(0, 0.16, 0), (1.2, 0.04, 0.72), PCB_TEAL, root, parts, bevel=0.012)
    box(f"{pid}_usb", at(-0.5, 0.26, -0.18), (0.26, 0.16, 0.22), STEEL, root, parts, bevel=0.01)
    box(f"{pid}_jack", at(-0.52, 0.25, 0.2), (0.24, 0.16, 0.14), BLACK_PLASTIC, root, parts, bevel=0.01)
    box(f"{pid}_mcu", at(0.05, 0.215, 0.05), (0.52, 0.07, 0.12), IC, root, parts, bevel=0.005)
    for i in range(14):
        for s in (-1, 1):
            box(f"{pid}_dip{i}_{s}", at(-0.2 + i * 0.037, 0.2, 0.05 + s * 0.07), (0.012, 0.04, 0.03), TIN, root, parts)
    box(f"{pid}_xtal", at(-0.18, 0.21, -0.12), (0.1, 0.05, 0.04), STEEL, root, parts, bevel=0.01)
    header_pins(f"{pid}_hdrD", lambda x, y, z: at(x, y + 0.26, z), -0.4, -0.32, 14, 0.06, root)
    header_pins(f"{pid}_hdrA", lambda x, y, z: at(x, y + 0.26, z), -0.1, 0.32, 8, 0.06, root)
    for i, (x, z) in enumerate(((-0.3, -0.05), (-0.3, 0.05))):
        cyl(f"{pid}_cap{i}", at(x, 0.26, z), 0.035, 0.16, mat("cap_alu", (0.7, 0.72, 0.75), 0.3, 1.0),
            root, parts, verts=16)
    box(f"{pid}_led_on", at(0.3, 0.19, -0.2), (0.03, 0.02, 0.02),
        mat("board_led_on", (0.1, 1, 0.3), 0.2, emit=(0.1, 1, 0.3), emit_strength=4), root, parts)
    # relay module
    box(f"{pid}_relay_pcb", at(0.28, 0.31, 0.0), (0.46, 0.03, 0.42), PCB_BLUE, root, parts, bevel=0.01)
    box(f"{pid}_relay", at(0.28, 0.46, -0.02), (0.36, 0.28, 0.3), mat("relay_blue", (0.05, 0.25, 0.75), 0.3),
        root, parts, bevel=0.015)
    box(f"{pid}_relay_label", at(0.28, 0.605, -0.02), (0.28, 0.004, 0.2), SILK, root, parts)
    box(f"{pid}_terminal", at(0.28, 0.41, 0.19), (0.34, 0.16, 0.1), mat("terminal_blue", (0.1, 0.4, 0.85), 0.4),
        root, parts, bevel=0.008)
    for i in range(3):
        cyl(f"{pid}_screw{i}", at(0.18 + i * 0.1, 0.5, 0.19), 0.028, 0.02, STEEL, root, parts, verts=16)
    for i, x in enumerate((-sep / 2, sep / 2)):
        lead(f"{pid}_lead{i}", ox + x, root, parts, top=0.14)
    return root


def pump(pid, slot):
    root = part_root(pid, slot)
    ox = 0.0
    at = lambda x, y, z: (x, y, z)
    sep = PITCH * 3
    # 12 V diaphragm pump: motor can + black pump head with two hose barbs
    lathe(f"{pid}_can", [(0.0, -0.36), (0.2, -0.36), (0.23, -0.33), (0.24, -0.2), (0.24, 0.12),
                         (0.23, 0.14), (0.0, 0.14)], at(-0.05, 0.28, 0), STEEL, root, parts, axis="x")
    for i in range(6):
        cyl(f"{pid}_rib{i}", at(-0.33 + i * 0.05, 0.28, 0), 0.245, 0.015, STEEL, root, parts, axis="x", verts=32)
    cyl(f"{pid}_endcap", at(-0.43, 0.28, 0), 0.19, 0.04, BLACK_PLASTIC, root, parts, axis="x", verts=32)
    cyl(f"{pid}_bearing", at(-0.46, 0.28, 0), 0.06, 0.03, COPPER, root, parts, axis="x", verts=16)
    head = mat("pump_head", (0.03, 0.03, 0.035), 0.5)
    box(f"{pid}_head", at(0.22, 0.28, 0), (0.24, 0.46, 0.46), head, root, parts, bevel=0.05)
    for y in (0.1, 0.46):
        for z in (-0.18, 0.18):
            cyl(f"{pid}_bolt{y}{z}", at(0.35, y, z), 0.022, 0.03, STEEL, root, parts, axis="x", verts=12)
    for i, y in enumerate((0.18, 0.38)):
        cyl(f"{pid}_barb{i}", at(0.44, y, 0), 0.045, 0.24, WHITE_PLASTIC, root, parts, axis="x", verts=16)
        for k in range(3):
            cyl(f"{pid}_barb{i}_ring{k}", at(0.48 + k * 0.05, y, 0), 0.06, 0.03, WHITE_PLASTIC, root, parts,
                axis="x", verts=16, r2=0.045)
    # visible cooling impeller behind a grille; the app spins this ("rotor", about x)
    rotor = empty(f"{pid}_rotor", at(-0.5, 0.28, 0), parts, root)
    rotor.name = "rotor"
    for i in range(6):
        b = box(f"{pid}_vane{i}", at(-0.5, 0.28, 0), (0.012, 0.3, 0.05), mat("impeller_red", (0.7, 0.08, 0.05), 0.4),
                rotor, parts, rot=(i * math.pi / 6, 0, 0))
        b.location = (0, 0, 0)
        b.rotation_euler = (i * math.pi / 6, 0, 0)
    for i in range(2):
        tube(f"{pid}_wire{i}", [at(-0.43, 0.3 + i * 0.04, 0.12), at(-0.55, 0.2, 0.2), at(-0.5, 0.0, 0.25)],
             0.015, mat(f"wire_{'red' if i else 'black'}", (0.7, 0.05, 0.03) if i else (0.02, 0.02, 0.02), 0.5),
             root, parts)
    for x in (-0.28, 0.2):
        box(f"{pid}_foot{x}", at(x, 0.0, 0), (0.12, 0.08, 0.5), RUBBER, root, parts, bevel=0.015)
    box(f"{pid}_bracket", at(-0.05, 0.03, 0), (0.62, 0.02, 0.42), STEEL, root, parts, bevel=0.005)
    for i, x in enumerate((-sep / 2, sep / 2)):
        lead(f"{pid}_lead{i}", ox + x, root, parts, top=0.0)
    return root


def fan(pid, slot):
    root = part_root(pid, slot)
    ox = 0.0
    at = lambda x, y, z: (x, y, z)
    sep = PITCH * 3
    y0 = 0.38
    frame = mat("fan_frame", (0.05, 0.05, 0.055), 0.55)
    # 80 mm case fan lying flat: square frame with venturi ring + corner bosses
    for (x, z, sx, sz) in ((0, -0.38, 0.84, 0.08), (0, 0.38, 0.84, 0.08), (-0.38, 0, 0.08, 0.84), (0.38, 0, 0.08, 0.84)):
        box(f"{pid}_frame{x}{z}", at(x, y0, z), (sx, 0.2, sz), frame, root, parts, bevel=0.01)
    lathe(f"{pid}_venturi", [(0.34, -0.1), (0.36, -0.1), (0.36, 0.1), (0.34, 0.1), (0.33, 0.0), (0.34, -0.1)],
          at(0, y0, 0), frame, root, parts, steps=48)
    for x in (-0.36, 0.36):
        for z in (-0.36, 0.36):
            cyl(f"{pid}_boss{x}{z}", at(x, y0, z), 0.05, 0.21, frame, root, parts, verts=16)
            cyl(f"{pid}_hole{x}{z}", at(x, y0, z), 0.022, 0.22, BLACK_PLASTIC, root, parts, verts=12)
    for i in range(4):
        a = i * math.pi / 2 + math.pi / 4
        box(f"{pid}_strut{i}", at(math.cos(a) * 0.23, y0 - 0.09, math.sin(a) * 0.23), (0.28, 0.02, 0.025), frame,
            root, parts, rot=(0, -a, 0))
    rotor = empty(f"{pid}_rotor", at(0, y0, 0), parts, root)
    rotor.name = "rotor"
    blade_mat = mat("fan_blade", (0.08, 0.08, 0.09), 0.35)
    for i in range(7):
        a = i * 2 * math.pi / 7
        b = box(f"{pid}_blade{i}", at(0, 0, 0), (0.2, 0.012, 0.11), blade_mat, rotor, parts, bevel=0.004)
        b.location = t2b(math.cos(a) * 0.2, 0, math.sin(a) * 0.2)
        # yaw around the hub + 28 deg pitch
        pass
        b.rotation_euler = (math.radians(28), 0, -a)
    hub = cyl(f"{pid}_hub", at(0, 0, 0), 0.105, 0.14, frame, rotor, parts, verts=32)
    hub.location = (0, 0, 0)
    sticker = cyl(f"{pid}_sticker", at(0, 0, 0), 0.085, 0.005, mat("fan_sticker", (0.85, 0.85, 0.8), 0.6), rotor, parts,
                  verts=32)
    sticker.location = (0, 0, 0.072)
    for i, x in enumerate((-sep / 2, sep / 2)):
        lead(f"{pid}_lead{i}", ox + x, root, parts, top=0.28)
    return root


def solar(pid, slot):
    root = part_root(pid, slot)
    ox = 0.0
    at = lambda x, y, z: (x, y, z)
    sep = PITCH * 4
    alu = mat("solar_frame_alu", (0.75, 0.77, 0.8), 0.28, 1.0)
    for (x, z, sx, sz) in ((0, -0.37, 1.26, 0.04), (0, 0.37, 1.26, 0.04), (-0.61, 0, 0.04, 0.78), (0.61, 0, 0.04, 0.78)):
        box(f"{pid}_frame{x}{z}", at(x, 0.36, z), (sx, 0.07, sz), alu, root, parts, bevel=0.006)
    box(f"{pid}_backsheet", at(0, 0.34, 0), (1.2, 0.02, 0.72), WHITE_PLASTIC, root, parts)
    cell = mat("solar_cell_mono", (0.02, 0.03, 0.08), 0.18, 0.4, coat=1.0)
    finger = mat("solar_busbar", (0.8, 0.82, 0.85), 0.3, 1.0)
    cols, rows = 6, 4
    cw, ch = 1.18 / cols, 0.7 / rows
    for c in range(cols):
        for r in range(rows):
            cx, cz = -0.59 + cw * (c + 0.5), -0.35 + ch * (r + 0.5)
            box(f"{pid}_cell{c}{r}", at(cx, 0.36, cz), (cw - 0.012, 0.012, ch - 0.012), cell, root, parts, bevel=0.004)
            for k in (-1, 1):
                box(f"{pid}_bus{c}{r}{k}", at(cx + k * cw * 0.25, 0.367, cz), (0.006, 0.002, ch - 0.02), finger, root, parts)
    box(f"{pid}_glass", at(0, 0.372, 0), (1.18, 0.006, 0.7),
        mat("solar_glass", (0.9, 0.95, 1.0), 0.02, transmission=1.0, ior=1.5), root, parts)
    box(f"{pid}_jbox", at(0, 0.28, 0.1), (0.24, 0.08, 0.16), BLACK_PLASTIC, root, parts, bevel=0.01)
    # folding kickstand legs
    for x in (-0.45, 0.45):
        box(f"{pid}_leg{x}", at(x, 0.14, -0.1), (0.04, 0.34, 0.03), alu, root, parts, rot=(0.35, 0, 0))
    for i, x in enumerate((-sep / 2, sep / 2)):
        lead(f"{pid}_lead{i}", ox + x, root, parts, top=0.28)
    return root


led("led-red", 0, (1.0, 0.06, 0.04))
led("led-green", 1, (0.12, 1.0, 0.3))
resistor("resistor-220", 2, ("red", "red", "brown", "gold"))
resistor("resistor-1k", 3, ("brown", "black", "red", "gold"))
battery("battery-9v", 4)
sensor("soil-sensor", 5, "soil", (0.13, 0.77, 0.37))
sensor("temp-sensor", 6, "climate", (0.22, 0.74, 0.97))
sensor("light-sensor", 7, "light", (0.98, 0.8, 0.08))
controller("farm-controller", 8)
pump("water-pump", 9)
fan("vent-fan", 10)
solar("solar-panel", 11)


# ================================================================ SNAP LAB
# Snap Circuits-style kit (Seo, Koh et al. in Jung & Chang, ISLS 2024): clear
# base grid with studs, blue snap strips with silver snap rivets, printed part
# IDs and grade-1 braille labels for blind / low-vision makers.
SNAP_PITCH = 0.48
SNAP_BLUE = mat("snap_strip_blue", (0.02, 0.18, 0.62), 0.35, coat=0.4)
SNAP_RIVET = mat("snap_rivet_nickel", (0.8, 0.81, 0.83), 0.18, 1.0)
PRINT_WHITE = mat("snap_print_white", (0.95, 0.95, 0.93), 0.5)
BRAILLE = {
    "a": (1,), "b": (1, 2), "c": (1, 4), "d": (1, 4, 5), "l": (1, 2, 3), "m": (1, 3, 4),
    "s": (2, 3, 4), "#": (3, 4, 5, 6),
}
DIGIT = {"1": "a", "2": "b", "3": "c", "4": "d"}


def braille(prefix, text, x0, y, z, parent):
    """Raised grade-1 braille (number sign before digits) on a top surface."""
    cells = []
    for ch in text.lower():
        if ch.isdigit():
            if not cells or cells[-1] != "#":
                cells.append("#")
            cells.append(DIGIT[ch])
        else:
            cells.append(ch)
    for ci, cell in enumerate(cells):
        for dot in BRAILLE[cell]:
            col = 0 if dot <= 3 else 1
            row = (dot - 1) % 3
            sphere(f"{prefix}_br{ci}_{dot}", (x0 + ci * 0.075 + col * 0.032, y, z - 0.032 + row * 0.032), 0.012,
                   PRINT_WHITE, parent, parts, scale=(1, 0.6, 1), seg=8)


def label(prefix, text, c, size, parent, material=PRINT_WHITE):
    bpy.ops.object.text_add(location=t2b(*c))
    t = bpy.context.active_object
    t.data.body = text
    t.data.size = size
    t.data.extrude = 0.004
    t.data.align_x = "CENTER"
    t.data.align_y = "CENTER"
    bpy.ops.object.convert(target="MESH")
    t = bpy.context.active_object
    return _finish(t, f"{prefix}_text", material, parent, parts)


def snap_strip(pid, n, tag, body_top=0.08):
    root = empty(f"part_{pid}", (0, 0, 0), parts)
    L = n * SNAP_PITCH
    box(f"{pid}_strip", (0, 0.04, 0), (L + 0.3, 0.08, 0.34), SNAP_BLUE, root, parts, bevel=0.03)
    for i, x in enumerate((-L / 2, L / 2)):
        cyl(f"{pid}_socket{i}", (x, -0.05, 0), 0.095, 0.1, SNAP_RIVET, root, parts, verts=24)
        cyl(f"{pid}_socket_hole{i}", (x, -0.095, 0), 0.055, 0.012, BLACK_PLASTIC, root, parts, verts=16)
        lathe(f"{pid}_rivet{i}", [(0.0, 0.0), (0.12, 0.0), (0.12, 0.012), (0.1, 0.03), (0.06, 0.045), (0.0, 0.05)],
              (x, body_top, 0), SNAP_RIVET, root, parts, steps=28)
    label(pid, tag, (0, body_top + 0.003, 0.08 if n > 2 else 0.1), 0.13, root)
    braille(pid, tag, -0.06, body_top + 0.006, -0.06, root)
    return root


for pid, n in (("snap-w2", 2), ("snap-w3a", 3), ("snap-w3b", 3), ("snap-w4", 4)):
    snap_strip(pid, n, str(n))

# B1: 2 x AA holder on a 3-strip
r = snap_strip("snap-b1", 3, "B1")
box("snap-b1_holder", (0, 0.3, -0.02), (1.2, 0.42, 0.5), BLACK_PLASTIC, r, parts, bevel=0.04)
for k, z in enumerate((-0.12, 0.1)):
    s = -1 if k else 1
    cyl(f"snap-b1_cell{k}", (0, 0.43, z), 0.1, 0.9, mat("aa_wrap_copper", (0.7, 0.36, 0.1), 0.35, 0.6), r, parts, axis="x", verts=24)
    cyl(f"snap-b1_cellband{k}", (-s * 0.3, 0.43, z), 0.102, 0.3, mat("aa_wrap_black", (0.02, 0.02, 0.02), 0.4), r, parts, axis="x", verts=24)
    cyl(f"snap-b1_nub{k}", (s * 0.47, 0.43, z), 0.04, 0.04, STEEL, r, parts, axis="x", verts=12)
    tube(f"snap-b1_spring{k}", [(-s * 0.52, 0.43 + 0.05 * math.sin(i), z + 0.05 * math.cos(i)) for i in range(0, 7)],
         0.008, STEEL, r, parts)
label("snap-b1_plus", "+", (0.52, 0.52, 0.2), 0.14, r, mat("marking_red", (0.85, 0.05, 0.05), 0.4))

# S1: slide switch on a 2-strip; the app slides "switch_knob" along x
r = snap_strip("snap-s1", 2, "S1")
box("snap-s1_body", (0, 0.2, -0.05), (0.62, 0.22, 0.26), BLACK_PLASTIC, r, parts, bevel=0.02)
box("snap-s1_slot", (0, 0.312, -0.05), (0.36, 0.01, 0.09), mat("slot_dark", (0.005, 0.005, 0.005), 0.9), r, parts)
knob = box("switch_knob", (-0.1, 0.36, -0.05), (0.12, 0.12, 0.1), WHITE_PLASTIC, r, parts, bevel=0.015)
label("snap-s1_off", "OFF", (-0.2, 0.312, 0.06), 0.06, r)
label("snap-s1_on", "ON", (0.2, 0.312, 0.06), 0.06, r, mat("marking_green", (0.1, 0.7, 0.25), 0.4))

# L1: 2.5 V lamp in a threaded socket
r = snap_strip("snap-l1", 2, "L1")
cyl("snap-l1_mount", (0, 0.14, -0.02), 0.2, 0.12, BLACK_PLASTIC, r, parts, verts=32)
for i in range(4):
    cyl(f"snap-l1_thread{i}", (0, 0.22 + i * 0.03, -0.02), 0.12, 0.022, STEEL, r, parts, verts=24)
lathe("snap-l1_bulb", [(0.0, 0.0), (0.1, 0.0), (0.12, 0.05), (0.16, 0.14), (0.165, 0.22), (0.14, 0.3), (0.08, 0.35),
                       (0.0, 0.37)], (0, 0.33, -0.02),
      mat("LED_glow_snap-l1", (1.0, 0.92, 0.7), 0.05, emit=(1.0, 0.8, 0.45), transmission=0.9, ior=1.5), r, parts)
tube("snap-l1_filament", [(-0.05, 0.36, -0.02), (-0.04, 0.48, -0.02), (0.0, 0.5, -0.02), (0.04, 0.48, -0.02),
                          (0.05, 0.36, -0.02)], 0.006, mat("tungsten", (0.3, 0.3, 0.3), 0.4, 1.0), r, parts)

# M1: motor with 3-blade fan ("rotor" spins about y)
r = snap_strip("snap-m1", 2, "M1")
cyl("snap-m1_can", (0, 0.32, -0.03), 0.23, 0.46, mat("motor_can_grey", (0.55, 0.57, 0.6), 0.3, 0.9), r, parts, verts=32)
cyl("snap-m1_endbell", (0, 0.56, -0.03), 0.2, 0.04, BLACK_PLASTIC, r, parts, verts=32)
box("snap-m1_label", (0, 0.32, 0.2), (0.24, 0.2, 0.004), mat("motor_label", (0.95, 0.8, 0.1), 0.5), r, parts)
cyl("snap-m1_shaft", (0, 0.64, -0.03), 0.018, 0.14, STEEL, r, parts, verts=12)
rot = empty("rotor", (0, 0.7, -0.03), parts, r)
fan_red = mat("fan_prop_red", (0.8, 0.08, 0.05), 0.4)
for i in range(3):
    a = i * 2 * math.pi / 3
    b = box(f"snap-m1_blade{i}", (0, 0, 0), (0.42, 0.012, 0.12), fan_red, rot, parts, bevel=0.02)
    b.location = t2b(math.cos(a) * 0.22, 0, math.sin(a) * 0.22)
    b.rotation_euler = (math.radians(22), 0, -a)
cyl("snap-m1_hub", (0, 0, 0), 0.05, 0.06, fan_red, rot, parts, verts=16).location = (0, 0, 0)

# Base grid: clear plate, 9 x 7 studs, row letters + column numbers
base = empty("snap_base", (0, 0, 0), parts)
COLS_S, ROWS_S = 9, 7
W_S, D_S = COLS_S * SNAP_PITCH + 0.3, ROWS_S * SNAP_PITCH + 0.5
box("snap_base_plate", (0, 0.13, 0.08), (W_S, 0.26, D_S), mat("snap_base_clear", (0.78, 0.84, 0.88), 0.15, transmission=0.55, ior=1.49),
    base, parts, bevel=0.04)
box("snap_base_frame", (0, 0.04, 0.08), (W_S + 0.08, 0.08, D_S + 0.08), GREY_PLASTIC, base, parts, bevel=0.03)
for c_ in range(COLS_S):
    for r_ in range(ROWS_S):
        x = -(COLS_S - 1) * SNAP_PITCH / 2 + c_ * SNAP_PITCH
        z = -(ROWS_S - 1) * SNAP_PITCH / 2 + r_ * SNAP_PITCH
        cyl(f"snap_stud_{c_}_{r_}", (x, 0.31, z), 0.05, 0.1, mat("snap_stud", (0.85, 0.88, 0.9), 0.2), base, parts, verts=16)
        box(f"snap_grid_{c_}_{r_}", (x, 0.262, z), (0.28, 0.006, 0.006), mat("grid_print", (0.3, 0.4, 0.5), 0.6), base, parts)
for c_ in range(COLS_S):
    label(f"snap_col{c_}", str(c_ + 1), (-(COLS_S - 1) * SNAP_PITCH / 2 + c_ * SNAP_PITCH, 0.264, (ROWS_S - 1) * SNAP_PITCH / 2 + 0.3),
          0.13, base, mat("grid_print", (0.3, 0.4, 0.5), 0.6))
for r_ in range(ROWS_S):
    label(f"snap_row{r_}", "ABCDEFG"[r_], (-(COLS_S - 1) * SNAP_PITCH / 2 - 0.3, 0.264, -(ROWS_S - 1) * SNAP_PITCH / 2 + r_ * SNAP_PITCH),
          0.13, base, mat("grid_print", (0.3, 0.4, 0.5), 0.6))


# ================================================================ ROOM
room = collection("room")
R = empty("room", (0, 0, 0), room)
F = FLOOR_Y
W, D, H = 10.5 * M, 8.0 * M, 3.2 * M  # 10.5 x 8 m, 3.2 m ceiling
BACK_Z, LEFT_X = -D * 0.42, -W * 0.45
RIGHT_X, FRONT_Z = W * 0.55, D * 0.58

floor_mat = tex_mat("floor_polished_concrete", "concrete_floor_02", 6)
wall_mat = tex_mat("wall_painted_plaster", "painted_plaster_wall", 4)
bench_mat = tex_mat("bench_birch_ply", "plywood", 1.6)
ply_mat = tex_mat("plywood_sheet", "plywood", 1)

box("floor", ((LEFT_X + RIGHT_X) / 2, F - 0.1, (BACK_Z + FRONT_Z) / 2), (RIGHT_X - LEFT_X, 0.2, FRONT_Z - BACK_Z),
    floor_mat, R, room)
box("ceiling", ((LEFT_X + RIGHT_X) / 2, F + H + 0.1, (BACK_Z + FRONT_Z) / 2), (RIGHT_X - LEFT_X, 0.2, FRONT_Z - BACK_Z),
    mat("ceiling_tile", (0.82, 0.82, 0.8), 0.9), R, room)
box("wall_back", ((LEFT_X + RIGHT_X) / 2, F + H / 2, BACK_Z - 0.15), (RIGHT_X - LEFT_X, H, 0.3), wall_mat, R, room)
box("wall_left", (LEFT_X - 0.15, F + H / 2, (BACK_Z + FRONT_Z) / 2), (0.3, H, FRONT_Z - BACK_Z), wall_mat, R, room)
box("wall_right", (RIGHT_X + 0.15, F + H / 2, (BACK_Z + FRONT_Z) / 2), (0.3, H, FRONT_Z - BACK_Z), wall_mat, R, room)
box("wall_front", ((LEFT_X + RIGHT_X) / 2, F + H / 2, FRONT_Z + 0.15), (RIGHT_X - LEFT_X, H, 0.3), wall_mat, R, room)
# baseboards + accent wall stripe (library maker lab palette)
for name, c, s in (("base_back", (0, F + 0.35, BACK_Z + 0.03), (RIGHT_X - LEFT_X, 0.7, 0.06)),
                   ("base_left", (LEFT_X + 0.03, F + 0.35, 0), (0.06, 0.7, FRONT_Z - BACK_Z)),
                   ("base_right", (RIGHT_X - 0.03, F + 0.35, 0), (0.06, 0.7, FRONT_Z - BACK_Z))):
    box(name, c, s, mat("baseboard_rubber", (0.12, 0.13, 0.14), 0.7), R, room)
box("accent_stripe", ((LEFT_X + RIGHT_X) / 2, F + 7.5, BACK_Z + 0.02), (RIGHT_X - LEFT_X, 0.35, 0.02),
    mat("accent_teal", (0.0, 0.42, 0.45), 0.6), R, room)

# windows on the left wall with daylight panes
glass_day = mat("window_daylight", (0.75, 0.86, 1.0), 0.05, emit=(0.75, 0.86, 1.0), emit_strength=2.2)
for i, z in enumerate((-12, -2, 8)):
    box(f"window_{i}", (LEFT_X + 0.02, F + 11, z), (0.05, 7, 7.5), glass_day, R, room)
    for dz in (-3.75, 0, 3.75):
        box(f"mullion_{i}_{dz}", (LEFT_X + 0.08, F + 11, z + dz), (0.12, 7.2, 0.18), DARK_STEEL, R, room)
    for dy in (-3.5, 3.5):
        box(f"sill_{i}_{dy}", (LEFT_X + 0.1, F + 11 + dy, z), (0.2, 0.18, 7.7), DARK_STEEL, R, room)

# ceiling LED panels + pendant strip over the bench
panel_light = mat("led_panel", (1, 0.98, 0.94), 0.4, emit=(1, 0.97, 0.92), emit_strength=6)
for x in (-18, -4, 10, 24):
    for z in (-14, 0, 14):
        box(f"ceiling_panel_{x}_{z}", (x, F + H - 0.02, z), (3.6, 0.08, 3.6), panel_light, R, room)
box("pendant_bar", (0, 9.5, 0), (8, 0.25, 0.5), DARK_STEEL, R, room, bevel=0.05)
box("pendant_diffuser", (0, 9.36, 0), (7.8, 0.04, 0.42), panel_light, R, room)
for x in (-3.8, 3.8):
    cyl(f"pendant_cable_{x}", (x, (9.5 + F + H) / 2, 0), 0.02, F + H - 9.5, DARK_STEEL, R, room, verts=8)

# ---------------- main workbench (top surface at y=0, 11 x 7.8)
box("bench_top", (0, -0.2, 0), (11.2, 0.4, 8.0), bench_mat, R, room, bevel=0.06)
for x in (-5.2, 5.2):
    for z in (-3.6, 3.6):
        box(f"bench_leg_{x}_{z}", (x, (F + -0.4) / 2, z), (0.45, -0.4 - F, 0.45), DARK_STEEL, R, room, bevel=0.03)
        box(f"bench_foot_{x}_{z}", (x, F + 0.08, z), (0.7, 0.16, 0.7), RUBBER, R, room, bevel=0.03)
for z in (-3.6, 3.6):
    box(f"bench_rail_{z}", (0, -0.75, z), (10.4, 0.5, 0.2), DARK_STEEL, R, room, bevel=0.02)
box("bench_shelf", (0, F + 1.4, 0), (10.4, 0.18, 7.2), ply_mat, R, room, bevel=0.02)
# power strip + outlets on the bench edge
box("power_strip", (-4.4, 0.18, -3.7), (2.4, 0.36, 0.45), WHITE_PLASTIC, R, room, bevel=0.06)
for i in range(4):
    box(f"outlet_{i}", (-5.2 + i * 0.52, 0.37, -3.7), (0.22, 0.02, 0.28), BLACK_PLASTIC, R, room)
box("power_switch", (-3.4, 0.37, -3.7), (0.2, 0.04, 0.24),
    mat("switch_red", (0.9, 0.05, 0.05), 0.3, emit=(1, 0.1, 0.05), emit_strength=2), R, room)
# parts bins under the bench
bin_colors = [(0.9, 0.3, 0.1), (0.1, 0.45, 0.85), (0.95, 0.75, 0.1), (0.2, 0.6, 0.3)]
for i in range(8):
    x = -4.4 + i * 1.25
    bm = mat(f"bin_{i % 4}", bin_colors[i % 4], 0.45)
    box(f"bin_{i}", (x, F + 2.05, -1.8), (1.05, 1.1, 2.6), bm, R, room, bevel=0.06)
    box(f"bin_label_{i}", (x, F + 2.2, -0.49), (0.6, 0.35, 0.02), WHITE_PLASTIC, R, room)

# ---------------- pegboard wall with tools (back wall)
peg_x0, peg_y0 = -12, F + 7.5
box("pegboard", (peg_x0 + 6, peg_y0 + 3.2, BACK_Z + 0.12), (13, 6.4, 0.12), mat("pegboard_hardboard", (0.55, 0.4, 0.26), 0.8),
    R, room)
hole = mat("peg_hole", (0.1, 0.07, 0.05), 0.9)
for ix in range(26):
    for iy in range(12):
        if (ix + iy) % 2 == 0:
            box(f"peghole_{ix}_{iy}", (peg_x0 + 0.25 + ix * 0.5, peg_y0 + 0.3 + iy * 0.5, BACK_Z + 0.185),
                (0.08, 0.08, 0.005), hole, R, room)
tz = BACK_Z + 0.45
tool_red = mat("tool_grip_red", (0.75, 0.05, 0.04), 0.5)
tool_yellow = mat("tool_grip_yellow", (0.95, 0.7, 0.05), 0.5)
tool_blue = mat("tool_grip_blue", (0.05, 0.3, 0.8), 0.5)
# screwdrivers
for i, m_ in enumerate((tool_red, tool_yellow, tool_blue, tool_red, tool_yellow)):
    x = peg_x0 + 1 + i * 0.5
    cyl(f"screwdriver_grip_{i}", (x, peg_y0 + 4.9, tz), 0.14, 1.0, m_, R, room, verts=12)
    cyl(f"screwdriver_shaft_{i}", (x, peg_y0 + 3.9, tz), 0.04, 1.2, STEEL, R, room, verts=8)
# pliers / cutters (two handles + jaw)
for i, m_ in enumerate((tool_red, tool_blue, tool_yellow)):
    x = peg_x0 + 4.2 + i * 1.0
    for s in (-1, 1):
        box(f"plier_{i}_{s}", (x + s * 0.15, peg_y0 + 3.9, tz), (0.14, 1.3, 0.1), m_, R, room, bevel=0.04,
            rot=(0, 0, s * 0.12))
    box(f"plier_jaw_{i}", (x, peg_y0 + 4.8, tz), (0.2, 0.6, 0.12), STEEL, R, room, bevel=0.03)
# wrenches
for i in range(4):
    x = peg_x0 + 7.6 + i * 0.55
    L = 1.6 - i * 0.2
    box(f"wrench_{i}", (x, peg_y0 + 4.2, tz), (0.16, L, 0.05), STEEL, R, room, bevel=0.02)
    torus(f"wrench_ring_{i}", (x, peg_y0 + 4.2 + L / 2, tz), 0.14, 0.05, STEEL, R, room, axis="z")
# hammer + tape measure + adaptive loop scissors (Jung et al.: adaptive scissors)
box("hammer_handle", (peg_x0 + 10.6, peg_y0 + 3.8, tz), (0.2, 2.0, 0.16), mat("wood_handle", (0.55, 0.35, 0.18), 0.6),
    R, room, bevel=0.05)
box("hammer_head", (peg_x0 + 10.6, peg_y0 + 4.9, tz), (0.9, 0.3, 0.3), DARK_STEEL, R, room, bevel=0.04)
cyl("tape_measure", (peg_x0 + 11.9, peg_y0 + 4.5, tz), 0.4, 0.3, tool_yellow, R, room, axis="z", bevel=0.03)
torus("adaptive_scissors_loop", (peg_x0 + 11.9, peg_y0 + 2.2, tz), 0.35, 0.07, mat("scissor_loop_green", (0.1, 0.6, 0.3), 0.5),
      R, room, axis="z")
for s in (-1, 1):
    box(f"adaptive_scissors_blade_{s}", (peg_x0 + 11.9 + s * 0.06, peg_y0 + 3.0, tz), (0.08, 0.9, 0.03), STEEL, R, room,
        rot=(0, 0, s * 0.08))
# noise-dampening headphones on a hook (sensory-friendly station)
torus("headphone_band", (peg_x0 + 1.8, peg_y0 + 1.5, tz + 0.1), 0.6, 0.08, mat("headphone_navy", (0.05, 0.08, 0.2), 0.5),
      R, room, axis="z")
for s in (-1, 1):
    cyl(f"headphone_cup_{s}", (peg_x0 + 1.8 + s * 0.6, peg_y0 + 1.0, tz + 0.1), 0.34, 0.3,
        mat("headphone_navy", (0.05, 0.08, 0.2), 0.5), R, room, axis="x", bevel=0.05)
    cyl(f"headphone_pad_{s}", (peg_x0 + 1.8 + s * 0.44, peg_y0 + 1.0, tz + 0.1), 0.3, 0.08, RUBBER, R, room, axis="x")

# whiteboard + sensory-hour sign
box("whiteboard", (6, F + 11, BACK_Z + 0.1), (12, 6, 0.1), mat("whiteboard", (0.95, 0.95, 0.94), 0.12), R, room)
box("whiteboard_frame", (6, F + 11, BACK_Z + 0.06), (12.3, 6.3, 0.08), STEEL, R, room)
box("whiteboard_tray", (6, F + 7.9, BACK_Z + 0.35), (6, 0.12, 0.45), STEEL, R, room)
for i, c in enumerate(((0.1, 0.1, 0.1), (0.8, 0.1, 0.1), (0.1, 0.3, 0.8))):
    cyl(f"marker_{i}", (4.5 + i * 0.5, F + 8.05, BACK_Z + 0.35), 0.07, 0.8, mat(f"marker_{i}", c, 0.4), R, room, axis="x", verts=10)
# sketched circuit diagram strokes on the whiteboard
ink = mat("whiteboard_ink", (0.08, 0.2, 0.6), 0.5)
for (x, y, w, h) in ((2, 12.5, 3, 0.07), (5, 11, 0.07, 3), (2, 9.5, 3, 0.07), (0.5, 11, 0.07, 3),
                     (7, 12.5, 4, 0.07), (9, 11, 0.07, 3), (7, 9.5, 4, 0.07)):
    box(f"ink_{x}_{y}", (x, F + y, BACK_Z + 0.16), (w, h, 0.01), ink, R, room)

# ---------------- 3D printer station (right side)
PX, PZ = 26, -8
box("printer_table", (PX, F + 4.6, PZ), (9, 0.35, 5.5), ply_mat, R, room, bevel=0.04)
for x in (-4.2, 4.2):
    for z in (-2.5, 2.5):
        box(f"printer_table_leg_{x}_{z}", (PX + x, F + 2.2, PZ + z), (0.3, 4.4, 0.3), DARK_STEEL, R, room)
pr_orange = mat("printer_orange", (0.95, 0.4, 0.05), 0.45)
pz0 = F + 4.8
for x in (-2.0, 2.0):
    box(f"printer_upright_{x}", (PX + x - 1.5, pz0 + 2.6, PZ), (0.3, 5.2, 0.6), pr_orange, R, room, bevel=0.04)
box("printer_top_bar", (PX - 1.5, pz0 + 5.25, PZ), (4.3, 0.3, 0.6), pr_orange, R, room, bevel=0.04)
box("printer_base", (PX - 1.5, pz0 + 0.3, PZ), (4.6, 0.6, 3.8), DARK_STEEL, R, room, bevel=0.05)
box("printer_bed", (PX - 1.5, pz0 + 0.95, PZ), (3.4, 0.08, 3.2), mat("pei_sheet", (0.55, 0.45, 0.2), 0.4, 0.6), R, room)
box("printer_x_gantry", (PX - 1.5, pz0 + 2.9, PZ), (4.0, 0.12, 0.12), STEEL, R, room)
box("printer_hotend", (PX - 1.0, pz0 + 2.7, PZ), (0.6, 0.7, 0.6), pr_orange, R, room, bevel=0.06)
cyl("printer_nozzle", (PX - 1.0, pz0 + 2.25, PZ), 0.08, 0.2, GOLD, R, room, r2=0.02, verts=12)
box("printer_lcd", (PX - 1.5, pz0 + 0.4, PZ + 1.95), (1.4, 0.45, 0.08), mat("lcd_blue", (0.1, 0.3, 0.9), 0.2, emit=(0.2, 0.45, 1.0), emit_strength=2),
    R, room)
# part being printed: a gear on the bed
cyl("print_gear", (PX - 1.5, pz0 + 1.1, PZ), 0.7, 0.25, mat("pla_teal", (0.0, 0.6, 0.6), 0.35), R, room, verts=20)
for i in range(12):
    a = i * math.pi / 6
    box(f"print_gear_tooth_{i}", (PX - 1.5 + math.cos(a) * 0.78, pz0 + 1.1, PZ + math.sin(a) * 0.78), (0.2, 0.25, 0.16),
        mat("pla_teal", (0.0, 0.6, 0.6), 0.35), R, room, rot=(0, -a, 0))
cyl("filament_spool", (PX + 2.3, pz0 + 1.2, PZ), 1.1, 0.8, mat("pla_teal", (0.0, 0.6, 0.6), 0.35), R, room, axis="z", bevel=0.05)
cyl("spool_flange_a", (PX + 2.3, pz0 + 1.2, PZ + 0.42), 1.3, 0.06, BLACK_PLASTIC, R, room, axis="z")
cyl("spool_flange_b", (PX + 2.3, pz0 + 1.2, PZ - 0.42), 1.3, 0.06, BLACK_PLASTIC, R, room, axis="z")

# ---------------- laser cutter (right back)
LX, LZ = 26, 8
box("laser_body", (LX, F + 3.0, LZ), (8.5, 6.0, 5.0), mat("laser_body_white", (0.9, 0.9, 0.88), 0.35), R, room, bevel=0.1)
box("laser_lid", (LX, F + 6.25, LZ - 0.3), (8.2, 0.5, 4.2), mat("laser_lid_black", (0.03, 0.03, 0.03), 0.3), R, room, bevel=0.08)
box("laser_window", (LX, F + 6.52, LZ - 0.3), (6.5, 0.02, 3.2),
    mat("laser_window_tint", (0.9, 0.35, 0.05), 0.05, transmission=0.8, alpha=0.6), R, room)
box("laser_panel", (LX + 3.5, F + 5.2, LZ + 2.52), (1.1, 1.4, 0.05), mat("lcd_blue", (0.1, 0.3, 0.9), 0.2), R, room)
cyl("laser_estop", (LX + 3.5, F + 4.2, LZ + 2.55), 0.25, 0.2, mat("switch_red", (0.9, 0.05, 0.05), 0.3), R, room, axis="z")
cyl("laser_exhaust", (LX - 3.5, F + 9.0, LZ - 2.0), 0.5, 6.0, STEEL, R, room)

# ---------------- accessible Snap Circuits + Code Jumper table (left, wheelchair height, open knee space)
SX, SZ = -26, 6
box("access_table_top", (SX, F + 4.6, SZ), (9, 0.3, 6), bench_mat, R, room, bevel=0.05)
for x in (-4.2, 4.2):
    box(f"access_table_leg_{x}", (SX + x, F + 2.2, SZ), (0.3, 4.4, 5.2), DARK_STEEL, R, room)
snap_base = mat("snap_base_grid", (0.85, 0.87, 0.9), 0.5)
box("snap_base", (SX - 1.8, F + 4.85, SZ), (4.2, 0.2, 3.4), snap_base, R, room, bevel=0.04)
for ix in range(10):
    for iz in range(8):
        cyl(f"snap_peg_{ix}_{iz}", (SX - 3.7 + ix * 0.42, F + 5.0, SZ - 1.5 + iz * 0.42), 0.07, 0.1, snap_base, R, room, verts=8)
snap_blue = mat("snap_part_blue", (0.05, 0.3, 0.8), 0.4)
for i, (x, z, L) in enumerate(((-3.2, -1.1, 1.3), (-2.0, 0.2, 2.1), (-3.2, 1.0, 0.9))):
    box(f"snap_wire_{i}", (SX + x + L / 2, F + 5.15, SZ + z), (L, 0.12, 0.3), snap_blue, R, room, bevel=0.04)
    for s in (0, L):
        cyl(f"snap_stud_{i}_{s}", (SX + x + s, F + 5.25, SZ + z), 0.1, 0.1, STEEL, R, room, verts=12)
box("snap_battery", (SX - 1.0, F + 5.3, SZ - 0.8), (1.3, 0.5, 0.6), snap_blue, R, room, bevel=0.05)
sphere("snap_lamp", (SX - 0.6, F + 5.45, SZ + 1.0), 0.22, mat("snap_lamp_glow", (1, 0.9, 0.5), 0.2, emit=(1, 0.85, 0.4), emit_strength=3),
       R, room)
# braille-style dot labels on the snap parts (tactile accessibility)
for i in range(6):
    sphere(f"braille_dot_{i}", (SX - 3.0 + (i % 2) * 0.08, F + 5.22, SZ - 1.1 + (i // 2) * 0.08), 0.025, WHITE_PLASTIC, R, room, seg=8)
# Code Jumper: hub + tactile pods connected by thick cords
cj_hub = mat("codejumper_hub", (0.95, 0.55, 0.05), 0.4)
box("codejumper_hub", (SX + 2.4, F + 5.1, SZ - 1.2), (1.6, 0.5, 1.2), cj_hub, R, room, bevel=0.2)
cj_colors = [(0.1, 0.55, 0.9), (0.9, 0.2, 0.3), (0.2, 0.75, 0.35), (0.6, 0.3, 0.8)]
prev = (SX + 2.4, F + 5.0, SZ - 0.5)
for i, c in enumerate(cj_colors):
    p = (SX + 1.3 + i * 0.95, F + 5.05, SZ + 0.9 + (i % 2) * 0.5)
    box(f"codejumper_pod_{i}", p, (0.8, 0.35, 0.8), mat(f"codejumper_pod_{i}", c, 0.45), R, room, bevel=0.14)
    cyl(f"codejumper_knob_{i}", (p[0], p[1] + 0.25, p[2]), 0.18, 0.15, WHITE_PLASTIC, R, room, verts=16)
    tube(f"codejumper_cord_{i}", [prev, ((prev[0] + p[0]) / 2, F + 4.85, (prev[2] + p[2]) / 2), p], 0.05,
         mat("cord_grey", (0.4, 0.42, 0.45), 0.6), R, room)
    prev = p

# ---------------- storage shelving (back left)
for k, x0 in enumerate((-30, -22)):
    for x in (x0, x0 + 6.5):
        box(f"shelf_post_{k}_{x}", (x, F + 6, BACK_Z + 2), (0.2, 12, 0.2), DARK_STEEL, R, room)
        box(f"shelf_post_b_{k}_{x}", (x, F + 6, BACK_Z + 0.6), (0.2, 12, 0.2), DARK_STEEL, R, room)
    for j, y in enumerate((1, 4.5, 8, 11.5)):
        box(f"shelf_{k}_{j}", (x0 + 3.25, F + y, BACK_Z + 1.3), (6.6, 0.12, 1.6), STEEL, R, room)
        for b in range(3):
            cc = bin_colors[(b + j + k) % 4]
            box(f"shelf_bin_{k}_{j}_{b}", (x0 + 1.1 + b * 2.1, F + y + 0.75, BACK_Z + 1.3), (1.8, 1.35, 1.4),
                mat(f"bin_{(b + j + k) % 4}", cc, 0.45), R, room, bevel=0.06)

# ---------------- stools + wheelchair-accessible gap in front of the bench
for i, (x, z) in enumerate(((-3, 7.5), (3, 7.5), (-7.5, -2))):
    cyl(f"stool_seat_{i}", (x, F + 4.4, z), 1.0, 0.3, mat("stool_seat", (0.08, 0.08, 0.09), 0.6), R, room, bevel=0.08, verts=32)
    cyl(f"stool_post_{i}", (x, F + 2.3, z), 0.15, 4.0, STEEL, R, room, verts=12)
    torus(f"stool_ring_{i}", (x, F + 1.5, z), 0.8, 0.06, STEEL, R, room)
    for k in range(4):
        a = k * math.pi / 2 + 0.4
        box(f"stool_leg_{i}_{k}", (x + math.cos(a) * 0.6, F + 1.2, z + math.sin(a) * 0.6), (0.12, 2.4, 0.12), STEEL, R, room,
            rot=(math.sin(a) * 0.25, 0, -math.cos(a) * 0.25))

# ---------------- plants on the window sill side (ties to greenhouse module)
for i, z in enumerate((-12, 8)):
    cyl(f"planter_{i}", (LEFT_X + 2, F + 1.2, z), 1.0, 2.4, mat("planter_terracotta", (0.65, 0.3, 0.18), 0.8), R, room, r2=0.8)
    for k in range(7):
        a = k * 2 * math.pi / 7
        box(f"leaf_{i}_{k}", (LEFT_X + 2 + math.cos(a) * 0.35, F + 3.6, z + math.sin(a) * 0.35), (0.35, 2.6, 0.06),
            mat("leaf_green", (0.1, 0.4, 0.12), 0.6), R, room, rot=(math.sin(a) * 0.3, a, -math.cos(a) * 0.3))

# ---------------------------------------------------------------- UVs
# box-project every textured room mesh so tiled textures read at real-world scale
for o in room.objects:
    if o.type != "MESH" or not o.data.materials:
        continue
    scale = o.data.materials[0].get("uv_scale")
    if scale is None:
        continue
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.cube_project(cube_size=8.0 / scale * 2)
    bpy.ops.object.mode_set(mode="OBJECT")


# ---------------------------------------------------------------- export
def export(col, path):
    bpy.ops.object.select_all(action="DESELECT")
    for o in col.all_objects:
        o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_image_format="JPEG",
        export_jpeg_quality=82,
        export_draco_mesh_compression_enable=False,
    )
    print("exported", path, os.path.getsize(path) // 1024, "KB")


export(parts, os.path.join(OUT, "makerspace_parts.glb"))
export(room, os.path.join(OUT, "makerspace_room.glb"))
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT, "blender", "makerspace.blend"))
