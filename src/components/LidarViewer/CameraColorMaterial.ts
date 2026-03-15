/**
 * CameraColorMaterial — custom ShaderMaterial for camera-colormap mode.
 *
 * Projects each LiDAR point to all cameras on the GPU (vertex shader),
 * picks the best (shallowest depth) camera, and samples RGB from the
 * camera texture (fragment shader).
 *
 * Performance: eliminates CPU-side projection+sampling entirely.
 * ~168K points × 5 cameras fully parallelized on GPU.
 *
 * Supports up to MAX_CAMERAS cameras (configurable, default 7).
 */

import * as THREE from 'three'

const MAX_CAMERAS = 7

// ---------------------------------------------------------------------------
// GLSL Shaders
// ---------------------------------------------------------------------------

const vertexShader = /* glsl */ `
uniform int uNumCameras;
uniform mat4 uInvExtrinsic[${MAX_CAMERAS}];
uniform vec4 uIntrinsics[${MAX_CAMERAS}];   // [f_u, f_v, c_u, c_v]
uniform vec2 uImgSize[${MAX_CAMERAS}];       // [width, height]
uniform float uIsOptical[${MAX_CAMERAS}];    // 1.0 = optical, 0.0 = sensor frame
uniform float uPointSize;

varying vec2 vBestUV;
varying float vBestCamIndex;
varying float vHasColor;

void main() {
  // Camera projection uses raw position (ego/vehicle frame).
  // modelMatrix may contain ego→world transform (world mode) which must
  // NOT be applied to camera projection — calibration is in ego frame.
  vec3 egoPos = position;

  float bestDepth = 1e10;
  vec2 bestUV = vec2(0.0);
  float bestCam = -1.0;

  for (int c = 0; c < ${MAX_CAMERAS}; c++) {
    if (c >= uNumCameras) break;

    // Transform ego → camera sensor frame
    vec4 camPos4 = uInvExtrinsic[c] * vec4(egoPos, 1.0);
    float cx = camPos4.x;
    float cy = camPos4.y;
    float cz = camPos4.z;

    // Convert sensor → optical frame if needed
    if (uIsOptical[c] < 0.5) {
      float ox = -cy;
      float oy = -cz;
      float oz = cx;
      cx = ox; cy = oy; cz = oz;
    }

    // Depth check
    if (cz < 1.0) continue;
    if (cz >= bestDepth) continue;

    // Pinhole projection
    float invZ = 1.0 / cz;
    float u = uIntrinsics[c].x * (cx * invZ) + uIntrinsics[c].z;
    float v = uIntrinsics[c].y * (cy * invZ) + uIntrinsics[c].w;

    // Bounds check
    float w = uImgSize[c].x;
    float h = uImgSize[c].y;
    if (u < 0.0 || u >= w || v < 0.0 || v >= h) continue;

    // This camera wins
    bestDepth = cz;
    bestUV = vec2(u / w, v / h);
    bestCam = float(c);
  }

  vBestUV = bestUV;
  vBestCamIndex = bestCam;
  vHasColor = bestCam >= 0.0 ? 1.0 : 0.0;

  // gl_Position uses full modelViewProjection (includes world mode transform)
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vec4 mvPosition = viewMatrix * worldPos;
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = uPointSize / -mvPosition.z;
}
`

const fragmentShader = /* glsl */ `
uniform sampler2D uCameraTex[${MAX_CAMERAS}];
uniform float uOpacity;
uniform float uCircle;

varying vec2 vBestUV;
varying float vBestCamIndex;
varying float vHasColor;

void main() {
  // Circle point shape: discard fragments outside unit circle
  if (uCircle > 0.5) {
    vec2 cxy = 2.0 * gl_PointCoord - 1.0;
    if (dot(cxy, cxy) > 1.0) discard;
  }

  if (vHasColor < 0.5) {
    // No camera coverage → dark gray
    gl_FragColor = vec4(0.12, 0.12, 0.12, uOpacity);
    return;
  }

  vec3 color = vec3(0.12);
  int camIdx = int(vBestCamIndex + 0.5);

  // Static branching for texture sampling (WebGL2 doesn't support dynamic indexing)
  ${Array.from({ length: MAX_CAMERAS }, (_, i) =>
    `${i > 0 ? 'else ' : ''}if (camIdx == ${i}) color = texture2D(uCameraTex[${i}], vBestUV).rgb;`
  ).join('\n  ')}

  gl_FragColor = vec4(color, uOpacity);
}
`

// ---------------------------------------------------------------------------
// Material factory
// ---------------------------------------------------------------------------

/** Flat struct for passing camera calibration to the shader */
export interface ShaderCameraInfo {
  cameraName: number
  invExtrinsic: number[]  // 16 floats (4x4 row-major)
  f_u: number
  f_v: number
  c_u: number
  c_v: number
  width: number
  height: number
  isOpticalFrame: boolean
}

/**
 * Create the camera-color ShaderMaterial.
 * Call updateCameraTextures() each frame to upload new camera images.
 */
export function createCameraColorMaterial(): THREE.ShaderMaterial {
  // Initialize uniform arrays
  const invExtrinsics = Array.from({ length: MAX_CAMERAS }, () => new THREE.Matrix4())
  const intrinsics = Array.from({ length: MAX_CAMERAS }, () => new THREE.Vector4())
  const imgSizes = Array.from({ length: MAX_CAMERAS }, () => new THREE.Vector2())
  const isOptical = new Float32Array(MAX_CAMERAS)
  const textures = Array.from({ length: MAX_CAMERAS }, () => createPlaceholderTexture())

  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uNumCameras: { value: 0 },
      uInvExtrinsic: { value: invExtrinsics },
      uIntrinsics: { value: intrinsics },
      uImgSize: { value: imgSizes },
      uIsOptical: { value: isOptical },
      uCameraTex: { value: textures },
      uPointSize: { value: 2.0 },
      uOpacity: { value: 1.0 },
      uCircle: { value: 1.0 },
    },
    transparent: true,
    depthWrite: false,
  })
}

function createPlaceholderTexture(): THREE.Texture {
  const data = new Uint8Array([30, 30, 30, 255])  // dark gray
  const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat)
  tex.needsUpdate = true
  return tex
}

// ---------------------------------------------------------------------------
// Texture management
// ---------------------------------------------------------------------------

/** Texture cache: reuse textures across frames (avoid re-creating GPU objects) */
const texturePool: THREE.Texture[] = []

function getOrCreateTexture(index: number): THREE.Texture {
  if (!texturePool[index]) {
    texturePool[index] = new THREE.Texture()
    texturePool[index].minFilter = THREE.LinearFilter
    texturePool[index].magFilter = THREE.LinearFilter
    texturePool[index].generateMipmaps = false
    texturePool[index].flipY = false
  }
  return texturePool[index]
}

/**
 * Decode camera JPEGs into OffscreenCanvas for GPU texture upload.
 *
 * Uses createImageBitmap for fast JPEG decode, then draws to OffscreenCanvas.
 * Canvas2D has predictable pixel orientation (y=0 = top) across all browsers
 * and image formats, avoiding ImageBitmap's platform-dependent Y-flip behavior
 * when used directly as a WebGL texture source.
 *
 * Performance: decode (~2-5ms) + drawImage (~1ms) per camera. The main perf
 * win is the GPU-side projection (vs old CPU path), so this overhead is minimal.
 */
export async function decodeCameraTextures(
  cameraImages: Map<number, ArrayBuffer>,
): Promise<Map<number, OffscreenCanvas>> {
  const result = new Map<number, OffscreenCanvas>()
  const entries = [...cameraImages.entries()]
  const decoded = await Promise.all(
    entries.map(async ([camName, jpegBuf]) => {
      try {
        const blob = new Blob([jpegBuf], { type: 'image/jpeg' })
        const bitmap = await createImageBitmap(blob)
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(bitmap, 0, 0)
        bitmap.close()
        return { camName, canvas }
      } catch {
        return null
      }
    }),
  )
  for (const d of decoded) {
    if (d) result.set(d.camName, d.canvas)
  }
  return result
}

/**
 * Update the shader material's camera uniforms and textures for a new frame.
 *
 * @param material  The CameraColorMaterial created by createCameraColorMaterial()
 * @param cameras   Camera calibration data (from buildCameraProjectors)
 * @param bitmaps   Decoded ImageBitmaps (from decodeCameraTextures)
 * @param cameraOrder  Ordered list of camera names to set (determines texture slots)
 */
export function updateCameraUniforms(
  material: THREE.ShaderMaterial,
  cameras: ShaderCameraInfo[],
  bitmaps: Map<number, OffscreenCanvas>,
): void {
  const uniforms = material.uniforms
  const numCameras = Math.min(cameras.length, MAX_CAMERAS)
  uniforms.uNumCameras.value = numCameras

  const invExArr = uniforms.uInvExtrinsic.value as THREE.Matrix4[]
  const intrArr = uniforms.uIntrinsics.value as THREE.Vector4[]
  const sizeArr = uniforms.uImgSize.value as THREE.Vector2[]
  const optArr = uniforms.uIsOptical.value as Float32Array
  const texArr = uniforms.uCameraTex.value as THREE.Texture[]

  for (let i = 0; i < numCameras; i++) {
    const cam = cameras[i]

    // invExtrinsic: row-major → Three.js column-major
    const m = cam.invExtrinsic
    invExArr[i].set(
      m[0], m[1], m[2], m[3],
      m[4], m[5], m[6], m[7],
      m[8], m[9], m[10], m[11],
      m[12] ?? 0, m[13] ?? 0, m[14] ?? 0, m[15] ?? 1,
    )
    // Three.js Matrix4.set() takes row-major order, which matches our data

    intrArr[i].set(cam.f_u, cam.f_v, cam.c_u, cam.c_v)
    sizeArr[i].set(cam.width, cam.height)
    optArr[i] = cam.isOpticalFrame ? 1.0 : 0.0

    // Upload camera texture from OffscreenCanvas
    const canvas = bitmaps.get(cam.cameraName)
    if (canvas) {
      const tex = getOrCreateTexture(i)
      tex.image = canvas
      tex.needsUpdate = true
      texArr[i] = tex
    }
  }
}

/** Dispose all cached textures (call on unmount/segment switch) */
export function disposeCameraTextures(): void {
  for (const tex of texturePool) {
    tex.dispose()
  }
  texturePool.length = 0
}
