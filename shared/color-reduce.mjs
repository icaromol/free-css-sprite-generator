// Perceptual color clustering + palette-reduction, shared between Node (scripts/lib/pixel-grid.mjs's
// image-import pipeline) and the browser (tools/sprite-editor/public/app.js's "simplify colors"
// slider) -- see tools/sprite-editor/server.mjs's explicit /shared/color-reduce.mjs route for how
// the browser copy gets served. Deliberately dependency-free (no node:* imports, no browser-only
// globals): that's the whole reason this lives in its own top-level shared/ directory instead of
// scripts/lib/, which is Node-only elsewhere. Both consumers used to hand-roll their own "keep the
// N most-used colors, remap the rest to the nearest survivor by raw RGB distance" logic
// independently -- raw RGB distance doesn't separate lightness from hue/saturation, so a small
// cluster of vivid pink pixels could get merged into a much bigger, differently-hued brown cluster
// just because they weren't that numerically far apart. This module fixes the metric (CIE Lab
// distance) and replaces frequency-ranking altogether: colors are reduced by always merging the
// most similar pair first (see reduceCandidates below), so a distinct color is only ever sacrificed
// once nothing more similar remains to consolidate instead of it -- not by how rare it is.

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

// ---- selection: merge the most similar colors first, so distinct colors are the last thing touched ----

// Reduces `candidates` ({ rgb, count, ...anything }) to at most `maxCount` colors by repeatedly
// merging the two most similar remaining colors -- agglomerative clustering using Ward's linkage,
// not a frequency-ranked keep-list. This is a structural guarantee rather than a heuristic: at
// every step, the two things merged are provably the closest pair that currently exists, so a
// color only ever gets merged away once there's nothing more similar left to consolidate instead.
// A rare-but-distinct accent color (a handful of pixels, even just one) survives for exactly the
// same reason a common one does -- there's no separate "frequency" tier it has to out-rank first.
//
// Merge cost between two clusters uses Ward's formula --
// `(countA * countB / (countA + countB)) * deltaE76(centroidA, centroidB) ** 2` -- rather than
// plain centroid distance. Plain nearest-centroid merging can invert: after merging two small
// clusters, the new (still fairly light) centroid can land closer to some large, genuinely
// distinct cluster than either original one was, pulling that large cluster in too early. Ward's
// cost weighting keeps merges between low-mass clusters cheap and merges between two substantial,
// roughly-equal-mass clusters expensive, so it favors consolidating subtones over collapsing
// distinct color families even when their raw centroid distance would suggest otherwise.
//
// No pixel-count floor gates what's "distinct enough to survive" -- a true anti-aliasing/
// compression artifact is, by definition, Lab-close to the majority color it came from, so it
// merges away in an early round on its own merit. Gating by count would just reintroduce a
// frequency bias by another name.
//
// Every original candidate ends up in exactly one final cluster by construction. Extra properties
// on a candidate are preserved (the returned medoids and the map's keys/values are the original
// candidate objects), so a caller can stash an opaque id (e.g. a cluster index, or a grid char)
// and get it back unchanged. `kept` colors are always an original candidate's own rgb (its
// cluster's highest-count member, its "medoid"), never a synthetic blended average -- callers
// like the sprite editor's simplify slider can only relabel pixels onto a color that already
// exists in the grid, not invent a new one, so this keeps both callers on the same footing.
export function reduceCandidates(candidates, maxCount) {
  if (candidates.length <= maxCount) {
    return { kept: [...candidates], representativeOf: new Map(candidates.map((c) => [c, c])) };
  }

  const clusters = candidates.map((c) => ({
    rgb: c.rgb,
    count: c.count,
    lab: rgbToLab(...c.rgb),
    members: [c],
  }));

  const wardCost = (a, b) => {
    const d = deltaE76(a.lab, b.lab);
    return ((a.count * b.count) / (a.count + b.count)) * d * d;
  };

  while (clusters.length > maxCount) {
    let bestI = 0;
    let bestJ = 1;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const cost = wardCost(clusters[i], clusters[j]);
        if (cost < bestCost) {
          bestCost = cost;
          bestI = i;
          bestJ = j;
        }
      }
    }

    const a = clusters[bestI];
    const b = clusters[bestJ];
    const mergedCount = a.count + b.count;
    const mergedRgb = [0, 1, 2].map((k) => (a.rgb[k] * a.count + b.rgb[k] * b.count) / mergedCount);
    const merged = {
      rgb: mergedRgb,
      count: mergedCount,
      lab: rgbToLab(...mergedRgb),
      members: [...a.members, ...b.members],
    };

    // Splice the higher index first so removing it doesn't shift bestI out from under the second splice.
    clusters.splice(bestJ, 1);
    clusters.splice(bestI, 1);
    clusters.push(merged);
  }

  const kept = [];
  const representativeOf = new Map();
  for (const cluster of clusters) {
    const medoid = cluster.members.reduce((best, m) => (m.count > best.count ? m : best));
    kept.push(medoid);
    for (const m of cluster.members) representativeOf.set(m, medoid);
  }

  return { kept, representativeOf };
}
