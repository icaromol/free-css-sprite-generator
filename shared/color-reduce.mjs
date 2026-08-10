// Perceptual color clustering + palette-reduction, shared between Node (scripts/lib/pixel-grid.mjs's
// image-import pipeline) and the browser (tools/sprite-editor/public/app.js's "simplify colors"
// slider) -- see tools/sprite-editor/server.mjs's explicit /shared/color-reduce.mjs route for how
// the browser copy gets served. Deliberately dependency-free (no node:* imports, no browser-only
// globals): that's the whole reason this lives in its own top-level shared/ directory instead of
// scripts/lib/, which is Node-only elsewhere. Both consumers used to hand-roll their own "keep the
// N most-used colors, remap the rest to the nearest survivor by raw RGB distance" logic
// independently -- raw RGB distance doesn't separate lightness from hue/saturation, so a small
// cluster of vivid pink pixels could get merged into a much bigger, differently-hued brown cluster
// just because they weren't that numerically far apart. This module fixes both the metric (CIE Lab
// distance) and the two failure modes raw frequency-ranking has on its own: near-identical colors
// fragmenting into many tiny buckets instead of coalescing into one real cluster, and small-but-
// visually-distinct color families losing every tie-break against a much larger, duller majority.

// ---- sRGB -> CIE Lab (D65 white point) ----

const D65 = [0.95047, 1.0, 1.08883];

function srgbToLinear(c) {
  const cn = c / 255;
  return cn <= 0.04045 ? cn / 12.92 : ((cn + 0.055) / 1.055) ** 2.4;
}

// CIE Lab's piecewise cube-root, avoiding an infinite slope near t=0.
function labF(t) {
  const delta = 6 / 29;
  return t > delta ** 3 ? Math.cbrt(t) : t / (3 * delta * delta) + 4 / 29;
}

export function rgbToLab(r, g, b) {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);

  // sRGB primaries -> XYZ, normalized by the D65 reference white.
  const x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / D65[0];
  const y = (0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl) / D65[1];
  const z = (0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl) / D65[2];

  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// CIE76 Delta-E: plain Euclidean distance in Lab space. Not as refined as CIEDE2000, but a large,
// well-understood improvement over raw RGB distance for a fraction of the code -- good enough to
// fix "pink getting confused for brown" without pulling in a much heavier formula this tool's
// failure modes don't need.
export function deltaE76(labA, labB) {
  const dl = labA[0] - labB[0];
  const da = labA[1] - labB[1];
  const db = labA[2] - labB[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

// ---- clustering: coalesce visually-identical pixels regardless of where they land on a fixed grid ----

const HASH_STEP = 8; // coarse Lab-space grid used only to shortlist merge candidates, not to decide merges

function hashKeyFor(lab) {
  const bx = Math.round(lab[0] / HASH_STEP);
  const by = Math.round(lab[1] / HASH_STEP);
  const bz = Math.round(lab[2] / HASH_STEP);
  return `${bx},${by},${bz}`;
}

function neighborKeysFor(lab) {
  const bx = Math.round(lab[0] / HASH_STEP);
  const by = Math.round(lab[1] / HASH_STEP);
  const bz = Math.round(lab[2] / HASH_STEP);
  const keys = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        keys.push(`${bx + dx},${by + dy},${bz + dz}`);
      }
    }
  }
  return keys;
}

function addToHash(hashIndex, key, clusterIndex) {
  const bucket = hashIndex.get(key);
  if (bucket) bucket.push(clusterIndex);
  else hashIndex.set(key, [clusterIndex]);
}

function removeFromHash(hashIndex, key, clusterIndex) {
  const bucket = hashIndex.get(key);
  if (!bucket) return;
  const i = bucket.indexOf(clusterIndex);
  if (i !== -1) bucket.splice(i, 1);
}

// Groups a flat list of [r,g,b] pixels into perceptually-coherent clusters. Unlike a fixed-size
// quantization grid (rounding each channel independently), this has no fixed cell boundaries, so
// near-identical colors that happen to straddle where a grid line would fall still end up in the
// same cluster instead of fragmenting into several tiny ones.
//
// `mergeDeltaE`: colors within this Delta-E of an existing cluster's centroid join it; otherwise
// they start a new cluster. `maxClusters`: once reached, every remaining pixel merges into
// whichever existing cluster is nearest regardless of `mergeDeltaE`, so this stays bounded even on
// a pathologically high-cardinality source image (a real upload can be up to 2048x2048 pixels).
//
// Nearest-cluster lookup is accelerated by a coarse spatial hash over Lab space (only the pixel's
// own hash cell + its 26 neighbors are scanned) rather than a linear scan over every cluster --
// needed because this runs per-pixel over potentially millions of pixels. The neighbor-cell check
// still catches pixels straddling a coarse hash boundary (mergeDeltaE is small relative to
// HASH_STEP), which is the exact fragmentation failure mode this function exists to avoid; it's a
// deliberate speed/exactness tradeoff, not a guarantee that no near-duplicate is ever missed.
export function clusterPixels(rgbList, { mergeDeltaE = 8, maxClusters = 512 } = {}) {
  const clusters = []; // { rgb: [r,g,b] running centroid, count, lab }
  const hashIndex = new Map(); // coarse hash key -> cluster indices
  const clusterIndexForPixel = [];

  const findNearest = (lab) => {
    let bestIdx = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const key of neighborKeysFor(lab)) {
      const bucket = hashIndex.get(key);
      if (!bucket) continue;
      for (const idx of bucket) {
        const dist = deltaE76(lab, clusters[idx].lab);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = idx;
        }
      }
    }
    return { bestIdx, bestDist };
  };

  for (const rgb of rgbList) {
    const lab = rgbToLab(...rgb);
    let { bestIdx, bestDist } = findNearest(lab);

    // Hash-neighborhood search found nothing, but we're capped -- fall back to an exhaustive scan
    // rather than exceeding maxClusters. Rare in practice (only isolated regions of color space
    // once many clusters already exist), bounded by maxClusters when it does happen.
    if (bestIdx === -1 && clusters.length >= maxClusters) {
      for (let i = 0; i < clusters.length; i++) {
        const dist = deltaE76(lab, clusters[i].lab);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }
    }

    const shouldMerge =
      bestIdx !== -1 && (bestDist <= mergeDeltaE || clusters.length >= maxClusters);
    if (shouldMerge) {
      const cluster = clusters[bestIdx];
      const oldKey = hashKeyFor(cluster.lab);
      const newCount = cluster.count + 1;
      cluster.rgb = [
        (cluster.rgb[0] * cluster.count + rgb[0]) / newCount,
        (cluster.rgb[1] * cluster.count + rgb[1]) / newCount,
        (cluster.rgb[2] * cluster.count + rgb[2]) / newCount,
      ];
      cluster.count = newCount;
      cluster.lab = rgbToLab(...cluster.rgb);
      const newKey = hashKeyFor(cluster.lab);
      if (newKey !== oldKey) {
        removeFromHash(hashIndex, oldKey, bestIdx);
        addToHash(hashIndex, newKey, bestIdx);
      }
      clusterIndexForPixel.push(bestIdx);
    } else {
      const idx = clusters.length;
      clusters.push({ rgb: [...rgb], count: 1, lab });
      addToHash(hashIndex, hashKeyFor(lab), idx);
      clusterIndexForPixel.push(idx);
    }
  }

  return {
    clusterIndexForPixel,
    clusters: clusters.map((c) => ({ rgb: c.rgb.map(Math.round), count: c.count })),
  };
}

// ---- selection: keep the N most useful colors without letting frequency alone crowd out real diversity ----

// Picks up to `maxCount` representative colors from `candidates` ({ rgb, count, ...anything }).
// Extra properties on a candidate are preserved on the returned objects, so a caller can stash an
// opaque id (e.g. a cluster index) and get it back unchanged.
//
// Plain top-N-by-frequency (the previous behavior everywhere this ran) starves any color family
// that's real but numerically rare -- a handful of pixels (even just one) of a deliberate accent
// color, up against a much larger, duller majority, always loses every tie-break. `rescueFraction`
// of the slots are held back for a second pass: among the leftover candidates (at least
// `minRescueCount` pixels each), whichever are most perceptually distinct (by Lab Delta-E) from
// everything already kept get first claim on those slots. `minRescueCount` defaults to 1 rather
// than filtering small counts outright, because the Delta-E cut already does the real noise
// filtering: true anti-aliasing/compression artifacts are almost always color-close to the
// majority pixel they came from, so they fail the distinctness threshold on their own merit,
// whereas a single genuinely distinct pixel (a real 1px accent) deserves to survive. Any rescue
// slots that can't be filled (not enough sufficiently-distinct candidates) backfill by frequency
// as before, so this never keeps fewer colors than plain top-N would.
export function selectColorsToKeep(
  candidates,
  maxCount,
  { rescueFraction = 0.15, minRescueCount = 1, rescueDeltaE = 15 } = {},
) {
  const chosen =
    candidates.length <= maxCount
      ? [...candidates]
      : pickWithRescue(candidates, maxCount, { rescueFraction, minRescueCount, rescueDeltaE });

  const chosenLabs = chosen.map((c) => rgbToLab(...c.rgb));
  const nearestKept = (rgb) => {
    if (chosen.length === 0) return null;
    const lab = rgbToLab(...rgb);
    let best = chosen[0];
    let bestDist = Number.POSITIVE_INFINITY;
    chosen.forEach((c, i) => {
      const dist = deltaE76(lab, chosenLabs[i]);
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    });
    return best;
  };

  return { kept: chosen, nearestKept };
}

function pickWithRescue(candidates, maxCount, { rescueFraction, minRescueCount, rescueDeltaE }) {
  const sorted = [...candidates].sort((a, b) => b.count - a.count);
  const rescueSlots = Math.min(sorted.length, Math.max(1, Math.round(maxCount * rescueFraction)));
  const frequencySlots = maxCount - rescueSlots;

  const kept = sorted.slice(0, frequencySlots);
  const keptLabs = kept.map((c) => rgbToLab(...c.rgb));
  const remaining = sorted.slice(frequencySlots);

  const rescueCandidates = remaining
    .filter((c) => c.count >= minRescueCount)
    .map((c) => {
      const lab = rgbToLab(...c.rgb);
      const dist = keptLabs.reduce(
        (min, k) => Math.min(min, deltaE76(lab, k)),
        Number.POSITIVE_INFINITY,
      );
      return { candidate: c, lab, dist };
    })
    .filter((s) => s.dist >= rescueDeltaE)
    .sort((a, b) => b.dist - a.dist); // most visually distinct from the frequency-kept set first

  const rescued = [];
  for (const s of rescueCandidates) {
    if (rescued.length >= rescueSlots) break;
    // Re-check against the growing kept set (including colors already rescued this pass) so two
    // similar outliers don't both get rescued at the expense of a legitimately common color.
    const currentDist = keptLabs.reduce(
      (min, k) => Math.min(min, deltaE76(s.lab, k)),
      Number.POSITIVE_INFINITY,
    );
    if (currentDist < rescueDeltaE) continue;
    rescued.push(s.candidate);
    keptLabs.push(s.lab);
  }

  const chosen = [...kept, ...rescued];
  if (chosen.length < maxCount) {
    const chosenSet = new Set(chosen);
    for (const c of remaining) {
      if (chosen.length >= maxCount) break;
      if (!chosenSet.has(c)) chosen.push(c);
    }
  }
  return chosen;
}
