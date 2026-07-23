#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
# How to run:
# blender --background --python vm_blender_common.py

from __future__ import annotations

import math
from pathlib import Path

import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
EXPORT_ROOT = ROOT / "Assets" / "VirtualMakerspace" / "Art" / "BlenderGenerated"
TEXTURE_ROOT = ROOT / "Assets" / "VirtualMakerspace" / "Art" / "PBRTextures"


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in list(bpy.data.collections):
        if collection.name != "Collection":
            bpy.data.collections.remove(collection)


def material(name: str, color: tuple[float, float, float, float], metallic: float = 0.0, roughness: float = 0.45, emission: tuple[float, float, float, float] | None = None, texture_stem: str | None = None):
    found = bpy.data.materials.get(name)
    if found is not None:
        return found
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color
    metallic_socket = bsdf.inputs.get("Metallic IOR Level")
    if metallic_socket is None:
        metallic_socket = bsdf.inputs.get("Metallic")
    metallic_socket.default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if texture_stem is not None:
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links
        coordinates = nodes.new("ShaderNodeTexCoord")
        albedo = nodes.new("ShaderNodeTexImage")
        albedo.image = bpy.data.images.load(
            str(TEXTURE_ROOT / f"{texture_stem}_Albedo.png"), check_existing=True
        )
        albedo.projection = "BOX"
        albedo.projection_blend = 0.18
        links.new(coordinates.outputs["Generated"], albedo.inputs["Vector"])
        links.new(albedo.outputs["Color"], bsdf.inputs["Base Color"])

        normal_texture = nodes.new("ShaderNodeTexImage")
        normal_texture.image = bpy.data.images.load(
            str(TEXTURE_ROOT / f"{texture_stem}_Normal.png"), check_existing=True
        )
        normal_texture.image.colorspace_settings.name = "Non-Color"
        normal_texture.projection = "BOX"
        normal_texture.projection_blend = 0.18
        normal_map = nodes.new("ShaderNodeNormalMap")
        normal_map.inputs["Strength"].default_value = 0.38
        links.new(coordinates.outputs["Generated"], normal_texture.inputs["Vector"])
        links.new(normal_texture.outputs["Color"], normal_map.inputs["Color"])
        links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
    if emission is not None:
        emission_socket = bsdf.inputs.get("Emission Color")
        if emission_socket is None:
            emission_socket = bsdf.inputs.get("Emission")
        emission_socket.default_value = emission
        strength_socket = bsdf.inputs.get("Emission Strength")
        if strength_socket is not None:
            strength_socket.default_value = 3.0
    return mat


def assign(obj, mat) -> None:
    obj.data.materials.append(mat)


def collection(name: str):
    found = bpy.data.collections.get(name)
    if found is not None:
        return found
    created = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(created)
    return created


def move_to(obj, target) -> None:
    for owner in list(obj.users_collection):
        owner.objects.unlink(obj)
    target.objects.link(obj)


def cube(name: str, size: tuple[float, float, float], location: tuple[float, float, float], mat, target, bevel: float = 0.0):
    bpy.ops.mesh.primitive_cube_add(location=location)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel > 0.0:
        modifier = obj.modifiers.new("Edge Bevel", "BEVEL")
        modifier.width = bevel
        modifier.segments = 2
    assign(obj, mat)
    move_to(obj, target)
    return obj


def cylinder(name: str, radius: float, depth: float, location: tuple[float, float, float], mat, target, rotation: tuple[float, float, float] = (0.0, 0.0, 0.0), vertices: int = 20):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    assign(obj, mat)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    move_to(obj, target)
    return obj


def sphere(name: str, radius: float, location: tuple[float, float, float], mat, target):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=12, radius=radius, location=location)
    obj = bpy.context.object
    obj.name = name
    assign(obj, mat)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    move_to(obj, target)
    return obj


def torus(name: str, major_radius: float, minor_radius: float, location: tuple[float, float, float], mat, target):
    bpy.ops.mesh.primitive_torus_add(major_radius=major_radius, minor_radius=minor_radius, major_segments=32, minor_segments=8, location=location)
    obj = bpy.context.object
    obj.name = name
    assign(obj, mat)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    move_to(obj, target)
    return obj


def curve_tube(name: str, points: tuple[tuple[float, float, float], ...], radius: float, mat, target):
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = radius
    curve.bevel_resolution = 3
    spline = curve.splines.new("BEZIER")
    spline.bezier_points.add(len(points) - 1)
    for point, coordinate in zip(spline.bezier_points, points, strict=True):
        point.co = Vector(coordinate)
        point.handle_left_type = "AUTO"
        point.handle_right_type = "AUTO"
    obj = bpy.data.objects.new(name, curve)
    target.objects.link(obj)
    assign(obj, mat)
    return obj


def export_collection(target, asset_name: str) -> None:
    destination = EXPORT_ROOT / asset_name
    destination.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in target.all_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = next(iter(target.all_objects))
    bpy.ops.wm.obj_export(filepath=str(destination / f"{asset_name}.obj"), export_selected_objects=True)
    bpy.ops.object.select_all(action="DESELECT")


def save_blend(name: str) -> None:
    EXPORT_ROOT.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(EXPORT_ROOT / f"{name}.blend"))


def palette() -> dict[str, object]:
    return {
        "white": material("M_Plastic_White", (0.82, 0.84, 0.82, 1.0), roughness=0.38, texture_stem="WhitePlastic"),
        "graphite": material("M_Graphite", (0.035, 0.045, 0.06, 1.0), metallic=0.25, roughness=0.32, texture_stem="Graphite"),
        "black": material("M_Black_Rubber", (0.015, 0.018, 0.022, 1.0), roughness=0.72, texture_stem="BlackRubber"),
        "metal": material("M_Brushed_Metal", (0.42, 0.46, 0.5, 1.0), metallic=0.9, roughness=0.28, texture_stem="BrushedMetal"),
        "wood": material("M_Dark_Walnut", (0.19, 0.075, 0.025, 1.0), roughness=0.46, texture_stem="Walnut"),
        "red": material("M_Red", (0.72, 0.025, 0.02, 1.0), roughness=0.35, texture_stem="RedPlastic"),
        "blue": material("M_Blue", (0.02, 0.16, 0.72, 1.0), roughness=0.35, texture_stem="BluePlastic"),
        "green": material("M_Green", (0.02, 0.55, 0.18, 1.0), roughness=0.35, texture_stem="GreenPlastic"),
        "yellow": material("M_Yellow", (0.9, 0.55, 0.02, 1.0), roughness=0.35, texture_stem="YellowPlastic"),
        "cyan": material("M_Cyan_Emission", (0.02, 0.35, 0.48, 0.55), roughness=0.15, emission=(0.02, 0.7, 1.0, 1.0)),
        "amber": material("M_Amber_Emission", (0.7, 0.28, 0.01, 1.0), emission=(1.0, 0.35, 0.01, 1.0)),
        "glass_red": material("M_LED_Red", (0.7, 0.02, 0.015, 0.72), roughness=0.18, emission=(1.0, 0.01, 0.005, 1.0)),
    }


