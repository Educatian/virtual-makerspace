#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow>=11.0"]
# ///
# How to run: python generate_pbr_textures.py

from __future__ import annotations

import math
import random
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "Assets" / "VirtualMakerspace" / "Art" / "PBRTextures"
SIZE = 256

PROFILES = {
    "Walnut": ((92, 42, 18), "wood", 28, 1.2),
    "Graphite": ((48, 55, 68), "powder", 7, 0.45),
    "BlackRubber": ((22, 25, 29), "rubber", 6, 0.8),
    "BrushedMetal": ((148, 155, 164), "metal", 11, 0.7),
    "WhitePlastic": ((218, 221, 216), "plastic", 4, 0.25),
    "RedPlastic": ((176, 24, 20), "plastic", 6, 0.35),
    "BluePlastic": ((20, 64, 174), "plastic", 6, 0.35),
    "GreenPlastic": ((18, 134, 66), "plastic", 6, 0.35),
    "YellowPlastic": ((224, 142, 18), "plastic", 6, 0.35),
}


def clamp(value: float) -> int:
    return max(0, min(255, round(value)))


def surface_value(kind: str, x: int, y: int, rng: random.Random) -> float:
    grain = rng.uniform(-1.0, 1.0)
    if kind == "wood":
        flow = x + 11.0 * math.sin(y * 0.045) + 4.0 * math.sin(y * 0.14)
        return 0.62 * math.sin(flow * 0.13) + 0.24 * math.sin(flow * 0.47) + 0.14 * grain
    if kind == "metal":
        return 0.52 * math.sin(y * 2.3) + 0.18 * math.sin(y * 7.7) + 0.30 * grain
    if kind == "rubber":
        return 0.55 * grain + (0.45 if rng.random() > 0.94 else -0.08)
    if kind == "powder":
        return 0.72 * grain + 0.28 * math.sin((x + y) * 0.31)
    return grain


def build_texture(stem: str, base: tuple[int, int, int], kind: str, variation: int, normal_strength: float) -> None:
    rng = random.Random(stem)
    heights: list[list[float]] = []
    albedo = Image.new("RGB", (SIZE, SIZE))
    pixels = albedo.load()
    for y in range(SIZE):
        row = []
        for x in range(SIZE):
            value = surface_value(kind, x, y, rng)
            row.append(value)
            tint = variation * value
            warm = 1.16 if kind == "wood" else 1.0
            pixels[x, y] = (
                clamp(base[0] + tint * warm),
                clamp(base[1] + tint * 0.72),
                clamp(base[2] + tint * 0.45),
            )
        heights.append(row)

    normal = Image.new("RGB", (SIZE, SIZE))
    normal_pixels = normal.load()
    for y in range(SIZE):
        for x in range(SIZE):
            dx = heights[y][(x + 1) % SIZE] - heights[y][(x - 1) % SIZE]
            dy = heights[(y + 1) % SIZE][x] - heights[(y - 1) % SIZE][x]
            nx, ny, nz = -dx * normal_strength, -dy * normal_strength, 1.0
            length = math.sqrt(nx * nx + ny * ny + nz * nz)
            normal_pixels[x, y] = (
                clamp((nx / length * 0.5 + 0.5) * 255),
                clamp((ny / length * 0.5 + 0.5) * 255),
                clamp((nz / length * 0.5 + 0.5) * 255),
            )

    albedo.save(OUTPUT / f"{stem}_Albedo.png", optimize=True)
    normal.save(OUTPUT / f"{stem}_Normal.png", optimize=True)


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for stem, profile in PROFILES.items():
        build_texture(stem, *profile)
    print(f"Generated {len(PROFILES) * 2} PBR textures in {OUTPUT}")


if __name__ == "__main__":
    main()
