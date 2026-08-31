import type { EgoLensOperatorPackageManifest } from './packageManifest'

export const TEST_EXTENSION_PACKAGE_ID = 'org.egolens.test-extension'
export const TEST_EXTENSION_PACKAGE_VERSION = '1.0.0'
export const TEST_EXTENSION_PACKAGE_INTEGRITY = `sha256-${'7'.repeat(64)}`

/** Harmless build-registered package used to prove the Phase 7 extension boundary. */
export const TEST_EXTENSION_PACKAGE_MANIFEST = Object.freeze({
  packageId: TEST_EXTENSION_PACKAGE_ID,
  version: TEST_EXTENSION_PACKAGE_VERSION,
  engineRange: '>=1.0.0 <2.0.0',
  integrity: TEST_EXTENSION_PACKAGE_INTEGRITY,
  operators: [{
    name: 'testing.bounded_echo',
    majorVersion: 1,
    inputContract: {
      type: 'object',
      properties: { value: {} },
      required: ['value'],
      additionalProperties: false,
    },
    paramsContract: {
      type: 'object',
      properties: {
        allocationBytes: { type: 'integer', minimum: 0 },
        outputBytes: { type: 'integer', minimum: 0 },
        transferableCount: { type: 'integer', minimum: 0 },
        delayMs: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
    outputContract: {
      type: 'object',
      properties: {
        value: {},
        padding: {},
      },
      required: ['value'],
      additionalProperties: false,
    },
    execution: 'worker',
    resources: {
      timeoutMs: 1_000,
      maxInputBytes: 64 * 1024,
      maxOutputBytes: 64 * 1024,
      maxAllocationBytes: 64 * 1024,
      maxTransferables: 4,
    },
  }],
} satisfies EgoLensOperatorPackageManifest)
