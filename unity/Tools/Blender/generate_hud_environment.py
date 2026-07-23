#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
# How to run:
# blender --background --python generate_hud_environment.py

from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from vm_blender_common import (
    collection,
    cube,
    cylinder,
    export_collection,
    palette,
    reset_scene,
    save_blend,
    sphere,
    torus,
)


def wrist_hud(mats):
    target = collection("WristHUD")
    cube("HUD_Housing", (0.095, 0.042, 0.052), (0.0, 0.0, 0.025), mats["graphite"], target, 0.009)
    cube("HUD_Glass", (0.072, 0.006, 0.034), (0.0, -0.024, 0.028), mats["cyan"], target, 0.005)
    torus("Wrist_Strap", 0.040, 0.008, (0.0, 0.02, 0.0), mats["black"], target)
    for x in (-0.041, 0.041):
        cylinder("Fastener", 0.004, 0.005, (x, -0.027, 0.046), mats["metal"], target, rotation=(math.pi / 2, 0.0, 0.0), vertices=12)
    return target


def beacon(mats):
    target = collection("ParticipantBeacon")
    cylinder("Beacon", 0.025, 0.05, (0.0, 0.0, 0.025), mats["graphite"], target, vertices=24)
    torus("Voice_Ring", 0.026, 0.003, (0.0, 0.0, 0.03), mats["cyan"], target)
    sphere("Presence_Dot", 0.008, (0.0, -0.024, 0.03), mats["green"], target)
    return target


def feedback_ring(name, radius, mat, mats):
    target = collection(name)
    torus("Ring", radius, 0.006, (0.0, 0.0, 0.0), mat, target)
    cube("Marker", (0.018, 0.010, 0.018), (0.0, -radius, 0.0), mats["graphite"], target, 0.004)
    return target


def badge(name, mat, mats):
    target = collection(name)
    cylinder("Badge", 0.035, 0.012, (0.0, 0.0, 0.0), mats["graphite"], target, vertices=32)
    torus("Emissive_Border", 0.028, 0.004, (0.0, 0.0, 0.008), mat, target)
    return target


def room_terminal(mats):
    target = collection("RoomCodeTerminal")
    cube("Terminal", (0.12, 0.075, 0.06), (0.0, 0.0, 0.03), mats["graphite"], target, 0.012)
    for index in range(6):
        cube(f"Code_Tile_{index + 1}", (0.014, 0.010, 0.026), (-0.042 + index * 0.017, -0.041, 0.04), mats["black"], target, 0.002)
    cube("Status_Light", (0.07, 0.004, 0.005), (0.0, -0.041, 0.014), mats["cyan"], target)
    return target


def pegboard(mats):
    target = collection("Pegboard")
    cube("Panel", (0.90, 0.025, 0.45), (0.0, 0.0, 0.225), mats["graphite"], target, 0.008)
    for row in range(9):
        for column in range(18):
            cylinder("Peg_Hole", 0.004, 0.03, (-0.425 + column * 0.05, -0.015, 0.025 + row * 0.05), mats["black"], target, rotation=(math.pi / 2, 0.0, 0.0), vertices=8)
    return target


def drawer_cabinet(mats):
    target = collection("DrawerCabinet")
    cube("Cabinet", (0.60, 0.55, 0.80), (0.0, 0.0, 0.40), mats["graphite"], target, 0.018)
    for index in range(4):
        z = 0.14 + index * 0.17
        cube("Drawer", (0.54, 0.025, 0.145), (0.0, -0.288, z), mats["blue"], target, 0.008)
        cube("Handle", (0.18, 0.025, 0.018), (0.0, -0.315, z), mats["metal"], target, 0.004)
    return target


def shelving(mats):
    target = collection("MetalShelving")
    for x in (-0.48, 0.48):
        for y in (-0.18, 0.18):
            cube("Post", (0.035, 0.035, 2.0), (x, y, 1.0), mats["graphite"], target, 0.005)
    for z in (0.08, 0.55, 1.02, 1.49, 1.96):
        cube("Shelf", (1.0, 0.40, 0.035), (0.0, 0.0, z), mats["metal"], target, 0.005)
    return target


def stool(mats):
    target = collection("RollingStool")
    cylinder("Seat", 0.18, 0.06, (0.0, 0.0, 0.58), mats["black"], target, vertices=32)
    cylinder("Post", 0.035, 0.45, (0.0, 0.0, 0.33), mats["metal"], target, vertices=20)
    for angle in range(0, 360, 72):
        rad = math.radians(angle)
        x, y = math.cos(rad) * 0.19, math.sin(rad) * 0.19
        cube("Caster_Arm", (0.25, 0.025, 0.025), (x * 0.5, y * 0.5, 0.08), mats["graphite"], target, 0.005)
        sphere("Caster", 0.035, (x, y, 0.035), mats["black"], target)
    return target


def side_cart(mats):
    target = collection("SideCart")
    for z in (0.10, 0.43, 0.82):
        cube("Tray", (0.60, 0.40, 0.04), (0.0, 0.0, z), mats["graphite"], target, 0.008)
    for x in (-0.27, 0.27):
        for y in (-0.17, 0.17):
            cube("Post", (0.025, 0.025, 0.75), (x, y, 0.45), mats["metal"], target, 0.004)
            sphere("Caster", 0.025, (x, y, 0.035), mats["black"], target)
    return target


def storage_bin(mats):
    target = collection("StorageBin")
    cube("Bin_Base", (0.24, 0.34, 0.06), (0.0, 0.0, 0.03), mats["blue"], target, 0.01)
    cube("Back", (0.24, 0.025, 0.18), (0.0, 0.16, 0.12), mats["blue"], target, 0.008)
    for x in (-0.11, 0.11):
        cube("Side", (0.025, 0.32, 0.15), (x, 0.0, 0.10), mats["blue"], target, 0.008)
    return target


def floor_tile(mats):
    target = collection("ESDFloorTile")
    cube("Tile", (0.60, 0.60, 0.008), (0.0, 0.0, 0.004), mats["graphite"], target, 0.004)
    return target


def tool_rail(mats):
    target = collection("ToolRail")
    cube("Rail", (0.60, 0.04, 0.06), (0.0, 0.0, 0.03), mats["graphite"], target, 0.005)
    for x in (-0.24, -0.12, 0.0, 0.12, 0.24):
        torus("Hook", 0.025, 0.004, (x, -0.025, 0.0), mats["metal"], target)
    return target


def main() -> None:
    reset_scene()
    mats = palette()
    assets = (
        wrist_hud(mats),
        beacon(mats),
        feedback_ring("VoiceActivityRing", 0.30, mats["cyan"], mats),
        feedback_ring("OwnershipHalo", 0.25, mats["green"], mats),
        feedback_ring("SnapSocketRing", 0.06, mats["cyan"], mats),
        badge("SuccessBadge", mats["green"], mats),
        badge("CautionBadge", mats["amber"], mats),
        badge("ErrorBadge", mats["red"], mats),
        room_terminal(mats),
        pegboard(mats),
        drawer_cabinet(mats),
        shelving(mats),
        stool(mats),
        side_cart(mats),
        storage_bin(mats),
        floor_tile(mats),
        tool_rail(mats),
    )
    for asset in assets:
        export_collection(asset, asset.name)
    save_blend("VirtualMakerspace_HUD_Environment")


if __name__ == "__main__":
    main()


