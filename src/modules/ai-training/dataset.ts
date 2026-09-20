/**
 * Generates 80 data points in 3 class clusters within a unit cube.
 * 16 of them (20%) start with currentClass != trueClass — the mislabeled set
 * the learner must find and correct.
 *
 * Returned positions are in the cube's local space ([-0.5, 0.5]^3).
 * The module places the cube in world space at spawn time.
 */
export interface DataPointSeed {
  pointId: number;
  trueClass: number;
  currentClass: number;
  position: [number, number, number];
}

export const NUM_CLASSES = 3;
export const POINTS_PER_CLASS = [27, 27, 26];
export const TOTAL_POINTS = POINTS_PER_CLASS.reduce((a, b) => a + b, 0); // 80
export const MISLABELED_TARGET = 16;

const CLASS_CENTERS: Array<[number, number, number]> = [
  [-0.25, 0.15, -0.2],
  [0.25, 0.15, -0.2],
  [0.0, 0.15, 0.25],
];
const CLUSTER_RADIUS = 0.18;

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateDataset(seed = 1): DataPointSeed[] {
  const rng = mulberry32(seed);
  const seeds: DataPointSeed[] = [];

  let pointId = 0;
  for (let c = 0; c < NUM_CLASSES; c++) {
    const [cx, cy, cz] = CLASS_CENTERS[c];
    for (let i = 0; i < POINTS_PER_CLASS[c]; i++) {
      // Gaussian-ish offset (sum of 3 uniforms, central-limit approx)
      const ox = ((rng() + rng() + rng()) / 3 - 0.5) * 2 * CLUSTER_RADIUS;
      const oy = ((rng() + rng() + rng()) / 3 - 0.5) * 2 * CLUSTER_RADIUS;
      const oz = ((rng() + rng() + rng()) / 3 - 0.5) * 2 * CLUSTER_RADIUS;
      seeds.push({
        pointId: pointId++,
        trueClass: c,
        currentClass: c,
        position: [cx + ox, cy + oy, cz + oz],
      });
    }
  }

  // Pick MISLABELED_TARGET points, scramble their currentClass to a wrong class
  const indices = Array.from({ length: seeds.length }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const toScramble = indices.slice(0, MISLABELED_TARGET);
  for (const idx of toScramble) {
    const seed = seeds[idx];
    const wrongOptions = [0, 1, 2].filter((c) => c !== seed.trueClass);
    seed.currentClass = wrongOptions[Math.floor(rng() * wrongOptions.length)];
  }

  return seeds;
}

export const CLASS_COLORS: number[] = [0xe74c3c, 0x2ecc71, 0x3498db];
export const CLASS_NAMES: string[] = ["Class A", "Class B", "Class C"];
