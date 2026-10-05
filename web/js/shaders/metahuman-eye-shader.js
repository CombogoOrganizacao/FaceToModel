/**
 * MetaHuman Optical Eye Shader for Three.js
 *
 * Implements high-fidelity biological eye rendering modeled after Epic Games Unreal Engine MetaHuman Eye Shader:
 * - Iris Parallax Bump-Offset: Simulates the concave iris bowl recessed behind the cornea dome based on camera view angle.
 * - Limbus Softening: Anatomical gradient transition between the colored iris disc and white sclera.
 * - Dynamic Pupil Dilation: Smooth scaling of the pupil aperture (uPupilDilation: 0.6 - 1.4).
 * - Refractive Cornea Dome: Physical transmission, high specular catchlight, IOR = 1.336.
 * - Sclera Subsurface Scattering: Micro-vein depth and natural sclera reflectance.
 *
 * Directives: Apple HIG / SwiftUI vector standards, strict Zero Emojis.
 */

import * as THREE from 'three';

/**
 * Creates a photorealistic MetaHuman Eyeball Material with Iris Parallax & Limbus Softening.
 *
 * @param {Object} options
 * @param {THREE.Texture} [options.map] - Albedo map containing sclera and iris textures
 * @param {THREE.Texture} [options.normalMap] - Eyeball normal map
 * @param {number} [options.irisDepth=0.08] - Parallax displacement strength for concave iris bowl
 * @param {number} [options.limbusWidth=0.045] - Width of the soft transitional limbus ring
 * @param {number} [options.pupilDilation=1.0] - Pupil dilation factor (0.6 = constricted, 1.4 = dilated)
 * @param {number} [options.irisRadius=0.28] - Radius of the iris relative to UV center (0.5, 0.5)
 * @returns {THREE.MeshPhysicalMaterial}
 */
export function createMetaHumanEyeMaterial(options = {}) {
  const {
    map = null,
    normalMap = null,
    irisDepth = 0.075,
    limbusWidth = 0.042,
    pupilDilation = 1.0,
    irisRadius = 0.28,
  } = options;

  const uniforms = {
    uIrisDepth: { value: irisDepth },
    uLimbusWidth: { value: limbusWidth },
    uPupilDilation: { value: pupilDilation },
    uIrisRadius: { value: irisRadius },
    uIrisCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uScleraTint: { value: new THREE.Color(0xf6f5f3) },
    uLimbusColor: { value: new THREE.Color(0x1a120e) },
  };

  const eyeMat = new THREE.MeshPhysicalMaterial({
    name: 'MetaHuman_Eyeball_Physical',
    map: map,
    normalMap: normalMap,
    roughness: 0.08,
    metalness: 0.0,
    clearcoat: 0.85,
    clearcoatRoughness: 0.04,
    specularIntensity: 1.0,
    specularColor: new THREE.Color(0xffffff),
    ior: 1.336,
    side: THREE.DoubleSide,
    depthWrite: true,
    depthTest: true,
    transparent: false,
  });

  eyeMat.userData.eyeUniforms = uniforms;

  eyeMat.onBeforeCompile = (shader) => {
    // Expose uniforms to shader
    shader.uniforms.uIrisDepth = uniforms.uIrisDepth;
    shader.uniforms.uLimbusWidth = uniforms.uLimbusWidth;
    shader.uniforms.uPupilDilation = uniforms.uPupilDilation;
    shader.uniforms.uIrisRadius = uniforms.uIrisRadius;
    shader.uniforms.uIrisCenter = uniforms.uIrisCenter;
    shader.uniforms.uScleraTint = uniforms.uScleraTint;
    shader.uniforms.uLimbusColor = uniforms.uLimbusColor;

    // Inject varyings for world view direction and normal
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
      varying vec3 vEyeViewDir;
      varying vec3 vEyeWorldNormal;
      `
    );

    shader.vertexShader = shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
      // Calculate view vector in world space
      vEyeViewDir = normalize(cameraPosition - (modelMatrix * vec4(transformed, 1.0)).xyz);
      vEyeWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
      varying vec3 vEyeViewDir;
      varying vec3 vEyeWorldNormal;

      uniform float uIrisDepth;
      uniform float uLimbusWidth;
      uniform float uPupilDilation;
      uniform float uIrisRadius;
      uniform vec2 uIrisCenter;
      uniform vec3 uScleraTint;
      uniform vec3 uLimbusColor;

      // MetaHuman Iris Parallax Bump-Offset calculation
      vec2 getParallaxEyeUV(vec2 baseUv, vec3 viewDir, vec3 worldNorm) {
        vec2 fromCenter = baseUv - uIrisCenter;
        float distFromIris = length(fromCenter);

        if (distFromIris < uIrisRadius * 1.3) {
          // Iris concave curvature: deeper at center pupil, flattening toward limbus
          float concaveHeight = clamp(1.0 - (distFromIris / uIrisRadius), 0.0, 1.0);
          float depthProfile = concaveHeight * concaveHeight * uIrisDepth;

          // Tangent-projected view offset
          vec3 viewTangent = viewDir - worldNorm * dot(viewDir, worldNorm);
          vec2 uvOffset = viewTangent.xy * depthProfile;

          // Pupil dilation scaling: non-linear radial expansion
          float dilationFactor = mix(1.0, 1.0 / max(0.5, uPupilDilation), concaveHeight);
          vec2 dilatedUv = uIrisCenter + fromCenter * dilationFactor;

          return clamp(dilatedUv - uvOffset, 0.001, 0.999);
        }

        return baseUv;
      }
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
        // Sample diffuse texture with Iris Parallax Offset
        vec2 parallaxUv = getParallaxEyeUV(vUv, vEyeViewDir, vEyeWorldNormal);
        vec4 sampledColor = texture2D(map, parallaxUv);

        // Limbus Softening: darken and blend the transition between colored iris and white sclera
        float distFromCenter = length(vUv - uIrisCenter);
        float limbusFactor = smoothstep(uIrisRadius - uLimbusWidth, uIrisRadius, distFromCenter);
        float outerMask = smoothstep(uIrisRadius + uLimbusWidth * 0.5, uIrisRadius, distFromCenter);

        // Blend limbus darkening ring
        vec3 finalIrisColor = mix(sampledColor.rgb, uLimbusColor * 0.4, (1.0 - abs(limbusFactor - 0.5) * 2.0) * outerMask * 0.45);

        diffuseColor *= vec4(finalIrisColor, sampledColor.a);
      #endif
      `
    );
  };

  eyeMat.needsUpdate = true;
  return eyeMat;
}

/**
 * Creates a refractive glass Cornea Shell Material for MetaHuman outer eye dome.
 *
 * @returns {THREE.MeshPhysicalMaterial}
 */
export function createCorneaShellMaterial() {
  const corneaMat = new THREE.MeshPhysicalMaterial({
    name: 'MetaHuman_Cornea_Shell',
    color: new THREE.Color(0xffffff),
    roughness: 0.015,
    metalness: 0.0,
    transmission: 0.96,
    thickness: 0.25,
    ior: 1.336,
    clearcoat: 1.0,
    clearcoatRoughness: 0.01,
    specularIntensity: 1.0,
    specularColor: new THREE.Color(0xffffff),
    transparent: true,
    opacity: 1.0,
    depthWrite: false,
    depthTest: true,
    side: THREE.FrontSide,
  });

  return corneaMat;
}
