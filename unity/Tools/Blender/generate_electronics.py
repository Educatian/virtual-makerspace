#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
# How to run:
# blender --background --python generate_electronics.py

from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from vm_blender_common import (
    collection,
    cube,
    curve_tube,
    cylinder,
    export_collection,
    palette,
    reset_scene,
    save_blend,
    sphere,
)


def breadboard(mats):
    target = collection("Breadboard")
    cube("Breadboard_Base", (1.65, 0.72, 0.075), (0.0, 0.0, 0.04), mats["white"], target, 0.025)
    cube("Center_Channel", (1.48, 0.045, 0.012), (0.0, 0.0, 0.082), mats["graphite"], target, 0.003)
    for y, mat in ((0.29, mats["red"]), (0.25, mats["blue"]), (-0.25, mats["red"]), (-0.29, mats["blue"])):
        cube("Power_Rail", (1.48, 0.012, 0.006), (0.0, y, 0.082), mat, target)
    for row in range(10):
        y = -0.205 + row * 0.045
        if row >= 5:
            y += 0.045
        for column in range(30):
            x = -0.65 + column * 0.045
            cylinder("Socket", 0.006, 0.008, (x, y, 0.084), mats["graphite"], target, vertices=10)
    return target


def resistor(mats):
    target = collection("Resistor")
    cylinder("Body", 0.04, 0.22, (0.0, 0.0, 0.0), mats["yellow"], target, rotation=(0.0, math.pi / 2, 0.0))
    for x, mat in ((-0.05, mats["red"]), (-0.015, mats["black"]), (0.025, mats["red"]), (0.065, mats["yellow"])):
        cylinder("Band", 0.041, 0.012, (x, 0.0, 0.0), mat, target, rotation=(0.0, math.pi / 2, 0.0))
    for x in (-0.24, 0.24):
        cylinder("Lead", 0.006, 0.28, (x, 0.0, 0.0), mats["metal"], target, rotation=(0.0, math.pi / 2, 0.0), vertices=10)
    return target


def led(mats):
    target = collection("LED")
    sphere("Lens", 0.055, (0.0, 0.0, 0.085), mats["glass_red"], target)
    cylinder("Flange", 0.065, 0.025, (0.0, 0.0, 0.035), mats["glass_red"], target)
    cylinder("Long_Lead", 0.006, 0.30, (-0.018, 0.0, -0.12), mats["metal"], target, vertices=10)
    cylinder("Short_Lead", 0.006, 0.22, (0.018, 0.0, -0.08), mats["metal"], target, vertices=10)
    return target


def pushbutton(mats):
    target = collection("Pushbutton")
    cube("Housing", (0.12, 0.12, 0.055), (0.0, 0.0, 0.03), mats["graphite"], target, 0.008)
    cylinder("Cap", 0.042, 0.045, (0.0, 0.0, 0.08), mats["black"], target, vertices=24)
    for x in (-0.045, 0.045):
        for y in (-0.045, 0.045):
            cylinder("Pin", 0.006, 0.10, (x, y, -0.05), mats["metal"], target, vertices=10)
    return target


def potentiometer(mats):
    target = collection("Potentiometer")
    cylinder("Body", 0.11, 0.055, (0.0, 0.0, 0.03), mats["metal"], target, vertices=32)
    cylinder("Shaft", 0.035, 0.16, (0.0, 0.0, 0.13), mats["metal"], target, vertices=20)
    cylinder("Knob", 0.07, 0.10, (0.0, 0.0, 0.23), mats["graphite"], target, vertices=24)
    for x in (-0.06, 0.0, 0.06):
        cube("Terminal", (0.018, 0.04, 0.08), (x, 0.09, -0.03), mats["metal"], target, 0.002)
    return target


def battery(mats):
    target = collection("Battery9V")
    cube("Battery", (0.26, 0.17, 0.46), (0.0, 0.0, 0.23), mats["graphite"], target, 0.025)
    cube("Copper_Top", (0.25, 0.16, 0.07), (0.0, 0.0, 0.49), mats["yellow"], target, 0.012)
    cylinder("Positive", 0.032, 0.03, (-0.055, 0.0, 0.54), mats["metal"], target, vertices=20)
    cylinder("Negative", 0.045, 0.03, (0.055, 0.0, 0.54), mats["metal"], target, vertices=20)
    return target


def multimeter(mats):
    target = collection("Multimeter")
    cube("Meter_Body", (0.42, 0.18, 0.68), (0.0, 0.0, 0.34), mats["yellow"], target, 0.045)
    cube("Meter_Face", (0.36, 0.012, 0.60), (0.0, -0.096, 0.35), mats["graphite"], target, 0.025)
    cube("Display", (0.27, 0.008, 0.13), (0.0, -0.105, 0.54), mats["cyan"], target, 0.012)
    cylinder("Selector", 0.085, 0.035, (0.0, -0.12, 0.28), mats["black"], target, rotation=(math.pi / 2, 0.0, 0.0), vertices=24)
    for x, mat in ((-0.09, mats["black"]), (0.09, mats["red"])):
        cylinder("Probe_Port", 0.022, 0.02, (x, -0.12, 0.10), mat, target, rotation=(math.pi / 2, 0.0, 0.0))
    return target


def cutters(mats, name, length):
    target = collection(name)
    for side in (-1.0, 1.0):
        curve_tube("Handle", ((0.0, side * 0.06, 0.0), (-length * 0.35, side * 0.10, 0.0), (-length * 0.55, side * 0.14, 0.0)), 0.035, mats["blue"], target)
        cube("Jaw", (length * 0.38, 0.035, 0.045), (length * 0.17, side * 0.025, 0.0), mats["metal"], target, 0.008)
    cylinder("Pivot", 0.05, 0.055, (0.0, 0.0, 0.0), mats["metal"], target, vertices=20)
    return target


def lamp(mats):
    target = collection("DeskLamp")
    cylinder("Base", 0.18, 0.04, (0.0, 0.0, 0.02), mats["graphite"], target, vertices=28)
    curve_tube("Arm", ((0.0, 0.0, 0.05), (0.0, 0.0, 0.55), (0.28, 0.0, 0.80)), 0.025, mats["metal"], target)
    cylinder("Shade", 0.14, 0.22, (0.36, 0.0, 0.74), mats["graphite"], target, rotation=(0.0, math.pi / 2, 0.0), vertices=28)
    sphere("Bulb", 0.06, (0.24, 0.0, 0.74), mats["amber"], target)
    return target


def workbench(mats):
    target = collection("Workbench")
    cube("Walnut_Top", (1.80, 0.80, 0.07), (0.0, 0.0, 0.76), mats["wood"], target, 0.018)
    for x in (-0.82, 0.82):
        for y in (-0.32, 0.32):
            cube("Steel_Leg", (0.06, 0.06, 0.74), (x, y, 0.37), mats["graphite"], target, 0.008)
    return target


def main() -> None:
    reset_scene()
    mats = palette()
    assets = (
        breadboard(mats),
        resistor(mats),
        led(mats),
        pushbutton(mats),
        potentiometer(mats),
        battery(mats),
        multimeter(mats),
        cutters(mats, "WireCutters", 0.55),
        cutters(mats, "NeedleNosePliers", 0.70),
        lamp(mats),
        workbench(mats),
    )
    for asset in assets:
        export_collection(asset, asset.name)
    save_blend("VirtualMakerspace_Electronics")


if __name__ == "__main__":
    main()


