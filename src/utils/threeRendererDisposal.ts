import type * as THREE from 'three'

/**
 * Release scene-bound WebGL cache entries before the renderer itself is
 * disposed. WebGLRenderer.dispose() does not clear WebGLAttributes: Three.js
 * removes those entries only when each geometry emits its dispose event.
 */
export function disposeThreeRendererResources(
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer,
  retainedGeometries: Iterable<THREE.BufferGeometry> = [],
  retainedMaterials: Iterable<THREE.Material> = [],
): void {
  const geometries = new Set<THREE.BufferGeometry>(retainedGeometries)
  const materials = new Set<THREE.Material>(retainedMaterials)

  scene.traverse((object) => {
    const renderable = object as THREE.Object3D & {
      geometry?: THREE.BufferGeometry
      material?: THREE.Material | THREE.Material[]
    }
    if (renderable.geometry) geometries.add(renderable.geometry)
    if (Array.isArray(renderable.material)) {
      for (const material of renderable.material) materials.add(material)
    } else if (renderable.material) {
      materials.add(renderable.material)
    }
  })

  for (const geometry of geometries) geometry.dispose()
  for (const material of materials) material.dispose()
  renderer.dispose()
}
