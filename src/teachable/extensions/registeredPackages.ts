import type { OperatorRegistry } from '../operators/registry'
import { TEST_EXTENSION_PACKAGE_MANIFEST } from './testExtensionManifest'

export const BUILD_REGISTERED_EXTENSION_MANIFESTS = Object.freeze([
  TEST_EXTENSION_PACKAGE_MANIFEST,
])

/** The only package admission path. Recipe parsing never calls this function. */
export function registerBuiltInExtensionPackagesV1(registry: OperatorRegistry): void {
  for (const manifest of BUILD_REGISTERED_EXTENSION_MANIFESTS) registry.registerExtensionPackage(manifest)
}
