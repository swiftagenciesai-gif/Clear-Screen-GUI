// A holographic-look ShaderMaterial: keeps the scanned object's own surface
// color -- a UV photo texture when OpenMVS's TextureMesh produced one,
// per-vertex colors otherwise (COLMAP/Meshroom's Poisson-based output) --
// but adds a view-dependent Fresnel rim glow, animated scanlines, and
// transparency so the model reads as a projection floating over the live
// camera feed rather than a solid, opaque object pasted on top of it.
import * as THREE from "three";

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec3 vColor;
  varying vec3 vWorldPos;
  #ifdef USE_MAP
    varying vec2 vMapUv;
  #endif

  void main() {
    #ifdef USE_COLOR
      // three.js injects the built-in color attribute as vec4 (RGBA) --
      // take just the RGB channels since vColor only needs to feed a tint mix.
      vColor = color.rgb;
    #else
      vColor = vec3(1.0);
    #endif
    #ifdef USE_MAP
      // three.js auto-declares the uv attribute when USE_MAP is defined
      // (i.e. when this material has a map set), the same way it
      // auto-declares color above for USE_COLOR.
      vMapUv = uv;
    #endif
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vNormal = normalize(normalMatrix * normal);
    vViewDir = normalize(cameraPosition - worldPos.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 tintColor;
  uniform float time;
  uniform float baseOpacity;
  uniform float rimPower;
  uniform float scanlineSpeed;
  uniform float scanlineDensity;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec3 vColor;
  varying vec3 vWorldPos;
  #ifdef USE_MAP
    uniform sampler2D map;
    varying vec2 vMapUv;
  #endif

  void main() {
    float fresnel = pow(1.0 - clamp(dot(normalize(vNormal), normalize(vViewDir)), 0.0, 1.0), rimPower);

    float scan = sin(vWorldPos.y * scanlineDensity - time * scanlineSpeed) * 0.5 + 0.5;
    scan = smoothstep(0.75, 1.0, scan) * 0.35;

    #ifdef USE_MAP
      vec3 surfaceColor = texture2D(map, vMapUv).rgb;
    #else
      vec3 surfaceColor = vColor;
    #endif
    vec3 base = mix(surfaceColor, tintColor, 0.35);
    vec3 rimColor = tintColor * fresnel * 1.8;
    vec3 finalColor = base + rimColor + scan * tintColor;

    float alpha = clamp(baseOpacity + fresnel * 0.6 + scan, 0.0, 1.0);
    gl_FragColor = vec4(finalColor, alpha);
  }
`;

export function createHolographicMaterial({
  tintColor = new THREE.Color(0x33e0ff),
  baseOpacity = 0.55,
  rimPower = 2.2,
  scanlineSpeed = 1.2,
  scanlineDensity = 40.0,
  hasVertexColor = true,
  map = null,
} = {}) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      tintColor: { value: tintColor },
      time: { value: 0 },
      baseOpacity: { value: baseOpacity },
      rimPower: { value: rimPower },
      scanlineSpeed: { value: scanlineSpeed },
      scanlineDensity: { value: scanlineDensity },
      map: { value: map },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexColors: hasVertexColor,
  });
  // `map` isn't a constructor-recognized property on plain ShaderMaterial
  // (passing it as a constructor option silently no-ops with a console
  // warning -- verified against a real render, not assumed), but assigning
  // it directly afterward works exactly like it does on any other material:
  // WebGLPrograms.js derives HAS_MAP from `material.map` for every material
  // type, and that's what makes three.js define USE_MAP and auto-wire the
  // `uv` vertex attribute for this shader.
  material.map = map;
  return material;
}
