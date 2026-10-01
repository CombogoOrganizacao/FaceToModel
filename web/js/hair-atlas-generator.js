/**
 * @fileoverview MetaHuman Hair Atlas & Flow Generator
 *
 * Generates directional strand flow maps, depth micro-shadows, and root-to-tip
 * gradient maps in runtime to drive Marschner anisotropic specular highlights.
 *
 * @module hair-atlas-generator
 */

import * as THREE from 'three';

let cachedFlowMap = null;

/**
 * Generates a high-precision tangent flow map for hair cards.
 * Encodes flow vectors along the strand curvature (Tangent X, Bitangent Y, Normal Z).
 *
 * @param {number} [size=512]
 * @returns {THREE.CanvasTexture}
 */
export function generateHairFlowMap(size = 512) {
  if (cachedFlowMap) return cachedFlowMap;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  const imgData = ctx.createImageData(size, size);
  const data = imgData.data;

  // Tangent flow vector: (R, G, B) -> (X, Y, Z) in tangent space
  // Base vector points along +Y (0.5, 1.0, 0.5) with slight wave variation
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const idx = (y * size + x) * 4;

      // Subtle strand wave pattern
      const angle = Math.sin(u * 28.0 + v * 4.0) * 0.12 + (Math.sin(u * 64.0) * 0.05);
      const fx = Math.sin(angle);
      const fy = Math.cos(angle);
      const fz = 0.85; // Normal z protrusion

      // Map [-1, 1] to [0, 255]
      data[idx]     = Math.round(((fx + 1.0) * 0.5) * 255);
      data[idx + 1] = Math.round(((fy + 1.0) * 0.5) * 255);
      data[idx + 2] = Math.round(((fz + 1.0) * 0.5) * 255);
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;

  cachedFlowMap = texture;
  return texture;
}
