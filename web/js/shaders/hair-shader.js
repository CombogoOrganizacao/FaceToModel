/**
 * @fileoverview Unreal Engine 5 Marschner Hair Shader for Three.js
 *
 * Implements the physically-based Marschner / Scheuermann dual-lobe anisotropic hair model
 * used in Unreal Engine 5 MetaHumans:
 *   - Lobe R: Primary specular highlight (shifted towards hair tip by cuticle tilt)
 *   - Lobe TRT: Secondary colored specular highlight with melanin pigment absorption
 *   - Lobe TT: Backlit transmission / forward scattering through hair fibers
 *   - Tangent Flow Vector computation from geometry / UVs (dP/dv)
 *   - Dithered / Alpha-to-Coverage anti-aliased transparency
 *
 * @module shaders/hair-shader
 */

import * as THREE from 'three';

const HairVertexShader = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
varying vec3 vTangent;
varying vec3 vBitangent;

void main() {
  vUv = uv;
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPos.xyz;
  
  // Transform surface normal
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  
  // Calculate tangent along V-axis (direction of hair flow in MetaHuman cards)
  #ifdef USE_TANGENT
    vTangent = normalize(mat3(modelMatrix) * tangent.xyz);
    vBitangent = normalize(cross(vWorldNormal, vTangent) * tangent.w);
  #else
    // Default hair strand flow down the UV V-coordinate
    vec3 upVec = vec3(0.0, 1.0, 0.0);
    vec3 t = normalize(cross(vWorldNormal, upVec));
    if (length(t) < 0.1) {
      t = normalize(cross(vWorldNormal, vec3(1.0, 0.0, 0.0)));
    }
    vTangent = t;
    vBitangent = normalize(cross(vWorldNormal, vTangent));
  #endif

  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const HairFragmentShader = /* glsl */ `
precision highp float;

uniform sampler2D tBaseColor;
uniform sampler2D tAlpha;
uniform sampler2D tFlow;
uniform bool uHasBaseColor;
uniform bool uHasAlpha;
uniform bool uHasFlow;

uniform vec3 uBaseColor;
uniform vec3 uMelaninColor;
uniform float uRoughness;
uniform float uSpecularR;
uniform float uSpecularTRT;
uniform float uTransmissionTT;
uniform float uShiftR;
uniform float uShiftTRT;
uniform float uAlphaTest;

// Lighting uniforms
uniform vec3 uKeyLightColor;
uniform vec3 uKeyLightDir;
uniform vec3 uFillLightColor;
uniform vec3 uFillLightDir;
uniform vec3 uRimLightColor;
uniform vec3 uRimLightDir;
uniform vec3 uAmbientColor;
uniform samplerCube uEnvMap;
uniform bool uHasEnvMap;

varying vec2 vUv;
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
varying vec3 vTangent;
varying vec3 vBitangent;

// Shift tangent along normal (Marschner cuticle tilt)
vec3 shiftTangent(vec3 T, vec3 N, float shift) {
  return normalize(T + N * shift);
}

// Strand specular intensity (Kajiya-Kay / Marschner formulation)
float strandSpecular(vec3 T, vec3 V, vec3 L, float exponent) {
  vec3 H = normalize(L + V);
  float dotTH = dot(T, H);
  float sinTH = sqrt(max(0.0, 1.0 - dotTH * dotTH));
  float dirAtten = smoothstep(-1.0, 0.0, dot(T, H));
  return dirAtten * pow(sinTH, exponent);
}

// 4x4 Bayer Dither Matrix for ultra-smooth strand edge blending
float bayerDither4x4(vec2 screenPos) {
  int x = int(mod(screenPos.x, 4.0));
  int y = int(mod(screenPos.y, 4.0));
  int index = x + y * 4;
  
  float pattern[16];
  pattern[0] = 0.0625; pattern[1] = 0.5625; pattern[2] = 0.1875; pattern[3] = 0.6875;
  pattern[4] = 0.8125; pattern[5] = 0.3125; pattern[6] = 0.9375; pattern[7] = 0.4375;
  pattern[8] = 0.2500; pattern[9] = 0.7500; pattern[10] = 0.1250; pattern[11] = 0.6250;
  pattern[12] = 1.0000; pattern[13] = 0.5000; pattern[14] = 0.8750; pattern[15] = 0.3750;
  
  for (int i = 0; i < 16; i++) {
    if (i == index) return pattern[i];
  }
  return 0.5;
}

vec3 computeHairLighting(vec3 L, vec3 lightColor, vec3 V, vec3 N, vec3 T, vec3 albedo) {
  // 1. Diffuse scattering across cylindrical strand (Kajiya-Kay diffuse)
  float NdotL = dot(N, L);
  float diffuse = max(0.0, (NdotL * 0.75 + 0.25)); // Wrapped diffuse for hair volume
  
  // 2. Lobe R: Primary specular highlight (shifted towards tip by ~ -0.05)
  vec3 tR = shiftTangent(T, N, uShiftR);
  float specR = strandSpecular(tR, V, L, 42.0 / max(0.05, uRoughness));
  vec3 rLobe = lightColor * specR * uSpecularR;
  
  // 3. Lobe TRT: Secondary colored specular highlight (shifted towards root by ~ +0.08)
  vec3 tTRT = shiftTangent(T, N, uShiftTRT);
  float specTRT = strandSpecular(tTRT, V, L, 18.0 / max(0.05, uRoughness));
  vec3 trtLobe = lightColor * uMelaninColor * specTRT * uSpecularTRT;
  
  // 4. Lobe TT: Backlit Transmission (light shining through translucent hair strands)
  float backLight = max(0.0, dot(-L, V));
  float transPower = pow(backLight, 3.0) * uTransmissionTT;
  vec3 ttLobe = lightColor * albedo * transPower * 1.5;
  
  return (albedo * diffuse * lightColor) + rLobe + trtLobe + ttLobe;
}

void main() {
  // Sample Base Color & Alpha
  vec4 baseSample = uHasBaseColor ? texture2D(tBaseColor, vUv) : vec4(uBaseColor, 1.0);
  float alpha = 1.0;
  
  if (uHasAlpha) {
    alpha = texture2D(tAlpha, vUv).r;
  } else if (uHasBaseColor) {
    // If texture is RGB with black background, use luminance
    float maxChan = max(baseSample.r, max(baseSample.g, baseSample.b));
    alpha = smoothstep(0.015, 0.22, maxChan);
  }
  
  // Stochastic dithered alpha threshold for silky strand anti-aliasing
  float dither = bayerDither4x4(gl_FragCoord.xy);
  if (alpha < (uAlphaTest * 0.7 + dither * 0.3 * uAlphaTest)) {
    discard;
  }
  
  vec3 albedo = baseSample.rgb * uBaseColor;
  
  // Normal and Tangent orientation
  vec3 N = normalize(vWorldNormal);
  if (!gl_FrontFacing) N = -N;
  
  vec3 T = normalize(vBitangent); // Hair direction along card flow
  if (uHasFlow) {
    vec3 flowVec = texture2D(tFlow, vUv).rgb * 2.0 - 1.0;
    T = normalize(vTangent * flowVec.x + vBitangent * flowVec.y + N * flowVec.z);
  }
  
  vec3 V = normalize(cameraPosition - vWorldPosition);
  
  // Composite Hair Lighting from all cinematic light sources
  vec3 totalColor = uAmbientColor * albedo * 0.85;
  
  // Key Light
  totalColor += computeHairLighting(normalize(uKeyLightDir), uKeyLightColor, V, N, T, albedo);
  
  // Fill Light
  totalColor += computeHairLighting(normalize(uFillLightDir), uFillLightColor, V, N, T, albedo);
  
  // Rim Light (Backlight highlight)
  totalColor += computeHairLighting(normalize(uRimLightDir), uRimLightColor, V, N, T, albedo);
  
  // IBL Environment Ambient Specular
  if (uHasEnvMap) {
    vec3 R = reflect(-V, N);
    vec3 envColor = textureCube(uEnvMap, R).rgb;
    totalColor += envColor * uMelaninColor * 0.25 * uSpecularTRT;
  }
  
  gl_FragColor = vec4(totalColor, alpha);
}
`;

/**
 * Creates an Unreal Engine 5 Marschner Hair Shader Material.
 *
 * @param {Object} [options]
 * @returns {THREE.ShaderMaterial}
 */
export function createMarschnerHairMaterial(options = {}) {
  const uniforms = {
    tBaseColor:      { value: options.map || null },
    tAlpha:          { value: options.alphaMap || null },
    tFlow:           { value: options.flowMap || null },
    uHasBaseColor:   { value: Boolean(options.map) },
    uHasAlpha:       { value: Boolean(options.alphaMap) },
    uHasFlow:        { value: Boolean(options.flowMap) },

    uBaseColor:      { value: options.color || new THREE.Color(0x3a2418) },
    uMelaninColor:   { value: options.melaninColor || new THREE.Color(0x7c4522) },
    uRoughness:      { value: options.roughness !== undefined ? options.roughness : 0.38 },
    uSpecularR:      { value: options.specularR !== undefined ? options.specularR : 0.85 },
    uSpecularTRT:    { value: options.specularTRT !== undefined ? options.specularTRT : 1.25 },
    uTransmissionTT: { value: options.transmissionTT !== undefined ? options.transmissionTT : 0.65 },
    uShiftR:         { value: -0.06 },  // Primary lobe cuticle tilt (towards tip)
    uShiftTRT:       { value: 0.08 },   // Secondary lobe internal bounce tilt (towards root)
    uAlphaTest:      { value: options.alphaTest !== undefined ? options.alphaTest : 0.18 },

    // Lighting (synced with Renderer)
    uKeyLightColor:  { value: new THREE.Color(0xfffaec) },
    uKeyLightDir:    { value: new THREE.Vector3(2.2, 2.6, 2.4).normalize() },
    uFillLightColor: { value: new THREE.Color(0x94a3b8) },
    uFillLightDir:   { value: new THREE.Vector3(-2.4, 0.6, 1.8).normalize() },
    uRimLightColor:  { value: new THREE.Color(0x93c5fd) },
    uRimLightDir:    { value: new THREE.Vector3(0.4, 2.0, -2.6).normalize() },
    uAmbientColor:   { value: new THREE.Color(0x1e293b) },
    uEnvMap:         { value: options.envMap || null },
    uHasEnvMap:      { value: Boolean(options.envMap) },
  };

  const mat = new THREE.ShaderMaterial({
    vertexShader: HairVertexShader,
    fragmentShader: HairFragmentShader,
    uniforms,
    transparent: true,
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide,
    name: options.name || 'UnrealMarschnerHairMaterial',
  });

  return mat;
}
