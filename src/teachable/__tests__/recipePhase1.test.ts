import { describe, expect, it } from 'vitest'
import { LegacyDatasetAdapter } from '../../adapters/legacy'
import type { DatasetAdapter } from '../../adapters/types'
import { waymoManifest } from '../../adapters/waymo/manifest'
import { OperatorRegistry, type CoreOperatorDescriptor } from '../operators/registry'
import { canonicalizeJson, canonicalizeRecipeSemantics } from '../recipe/canonicalize'
import { compileRecipeV1 } from '../recipe/compiler'
import { AdapterCompileError } from '../recipe/diagnostics'
import type { EgoLensAdapterRecipeV1, JsonValue } from '../recipe/types'
import { RecipeBackedDatasetAdapter } from '../runtime/RecipeBackedDatasetAdapter'
import { assertValidRecipeV1, validateRecipeV1 } from '../schema/validateSchema'
import minimalJson from '../__fixtures__/minimal.egolens-adapter.json'
import schemaJson from '../schema/egolens-adapter-v1.schema.json?raw'

const contract = { type: 'object' } as const
const operators: readonly CoreOperatorDescriptor[] = [
  {
    name: 'json.records',
    majorVersion: 1,
    provider: 'core',
    tier: 1,
    inputContract: contract,
    paramsContract: contract,
    outputContract: contract,
    execution: 'worker',
    deterministic: true,
  },
  {
    name: 'timeline.from_records',
    majorVersion: 1,
    provider: 'core',
    tier: 1,
    inputContract: contract,
    paramsContract: contract,
    outputContract: contract,
    execution: 'worker',
    deterministic: true,
  },
]

function registry(): OperatorRegistry {
  return new OperatorRegistry(operators)
}

function recipe(): EgoLensAdapterRecipeV1 {
  return assertValidRecipeV1(structuredClone(minimalJson))
}

describe('EgoLensAdapterRecipeV1 schema', () => {
  it('keeps the checked-in schema itself strict and duplicate-key free', () => {
    expect(validateRecipeV1(schemaJson).diagnostics.some((item) => item.code === 'DUPLICATE_JSON_KEY')).toBe(false)
  })

  it('accepts the hand-authored Phase 1 fixture', () => {
    expect(validateRecipeV1(minimalJson)).toMatchObject({ ok: true, diagnostics: [] })
  })

  it('rejects unknown top-level and nested fields', () => {
    const topLevel = { ...minimalJson, executable: 'alert(1)' }
    const nested = structuredClone(minimalJson) as typeof minimalJson & { scene: typeof minimalJson.scene & { theme?: string } }
    nested.scene.theme = 'dark'
    expect(validateRecipeV1(topLevel).diagnostics.some((item) => item.code === 'UNKNOWN_PROPERTY')).toBe(true)
    expect(validateRecipeV1(nested).diagnostics.some((item) => item.code === 'UNKNOWN_PROPERTY')).toBe(true)
  })

  it('rejects a schema version mismatch', () => {
    expect(validateRecipeV1({ ...minimalJson, schemaVersion: 2 }).ok).toBe(false)
  })

  it('rejects duplicate JSON keys before schema validation', () => {
    const duplicate = JSON.stringify(minimalJson).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')
    const result = validateRecipeV1(duplicate)
    expect(result.ok).toBe(false)
    expect(result.diagnostics.some((item) => item.code === 'DUPLICATE_JSON_KEY')).toBe(true)
  })

  it('rejects absolute paths, traversal, and URLs', () => {
    for (const exact of ['/tmp/frames.json', '../frames.json', 'https://example.com/frames.json']) {
      const candidate = structuredClone(minimalJson)
      candidate.sources.frames.files.exact = exact
      expect(validateRecipeV1(candidate).ok, exact).toBe(false)
    }
  })

  it('rejects executable source and network URLs inside operator parameters', () => {
    const candidate = structuredClone(minimalJson)
    candidate.pipelines.timeline.nodes[0].params = { timestampField: 'timestamp_us', callback: 'value => value' }
    expect(validateRecipeV1(candidate).diagnostics.some((item) => item.code === 'EXECUTABLE_SOURCE_FORBIDDEN')).toBe(true)

    candidate.pipelines.timeline.nodes[0].params = { endpoint: 'https://example.com/private-data' }
    expect(validateRecipeV1(candidate).diagnostics.some((item) => item.code === 'NETWORK_URL_FORBIDDEN')).toBe(true)
  })
})

describe('canonicalization', () => {
  it('is stable across property insertion order', () => {
    expect(canonicalizeJson({ z: 1, a: [3, 2, 1] })).toBe(canonicalizeJson({ a: [3, 2, 1], z: 1 }))
    expect(canonicalizeJson({ z: 1, a: [3, 2, 1] })).toBe('{"a":[3,2,1],"z":1}')
  })

  it('excludes identity and provenance from executable semantics', () => {
    const original = recipe()
    const renamed = {
      ...original,
      identity: { ...original.identity, name: 'Renamed display title' },
      provenance: { author: 'codex' as const, createdAt: '2026-08-29T00:00:00Z' },
    }
    expect(canonicalizeRecipeSemantics(original)).toBe(canonicalizeRecipeSemantics(renamed))
  })

  it('rejects non-finite values', () => {
    expect(() => canonicalizeJson(Number.NaN as unknown as JsonValue)).toThrow(/non-finite/u)
  })
})

describe('compiler and strategy boundary', () => {
  it('compiles the minimal recipe and derives capabilities', () => {
    const compiled = compileRecipeV1(recipe(), registry())
    expect(compiled.capabilities).toEqual(new Set(['timeline']))
    expect(compiled.pipelines.get('timeline')?.nodes.map((node) => node.id)).toEqual(['makeTimeline'])
  })

  it('instantiates recipe and legacy implementations through DatasetAdapter', () => {
    const strategies: DatasetAdapter[] = [
      new LegacyDatasetAdapter(waymoManifest),
      new RecipeBackedDatasetAdapter(recipe(), registry()),
    ]
    expect(strategies.map((strategy) => strategy.prepare().kind)).toEqual(['legacy', 'recipe'])
    expect(strategies[1].matches({ entryNames: ['frames.json'] })).toBe(true)
  })

  it('fails before binding when a required operator is absent', () => {
    expect(() => compileRecipeV1(recipe(), new OperatorRegistry())).toThrow(AdapterCompileError)
    try {
      compileRecipeV1(recipe(), new OperatorRegistry())
    } catch (error) {
      expect((error as AdapterCompileError).diagnostics.some((item) => item.code === 'OPERATOR_MISSING')).toBe(true)
    }
  })

  it('rejects graph cycles deterministically', () => {
    const cyclic = structuredClone(recipe())
    cyclic.pipelines.timeline = {
      nodes: [
        { id: 'a', op: 'timeline.from_records', version: 1, inputs: { rows: 'b.rows' } },
        { id: 'b', op: 'timeline.from_records', version: 1, inputs: { rows: 'a.rows' } },
      ],
      result: 'a.frames',
    }
    expect(() => compileRecipeV1(cyclic, registry())).toThrow(AdapterCompileError)
    try {
      compileRecipeV1(cyclic, registry())
    } catch (error) {
      expect((error as AdapterCompileError).diagnostics.some((item) => item.code === 'GRAPH_CYCLE')).toBe(true)
    }
  })
})

describe('Phase 2 contract decisions', () => {
  it('uses semantic formatId rather than display identity for adapter identity', () => {
    const original = compileRecipeV1(recipe(), registry())
    const renamed = structuredClone(recipe())
    renamed.identity = { ...renamed.identity, name: 'A different display name' }
    const renamedCompiled = compileRecipeV1(renamed, registry())
    expect(original.normalizedManifest.id).toBe('minimal-fixture')
    expect(renamedCompiled.normalizedManifest.id).toBe(original.normalizedManifest.id)
  })

  it('projects inventory and raw source bindings only at the legacy manifest edge', () => {
    const compiled = compileRecipeV1(recipe(), registry())
    expect(compiled.compatibilityManifest).toMatchObject({
      id: 'minimal-fixture',
      knownComponents: ['frames.json'],
      requiredComponents: ['frames.json'],
      pointStride: 3,
      colormapModes: ['distance'],
      columnMap: {
        frameTimestamp: 'timestamp_us',
        laserName: '',
        rangeImageShape: '',
        rangeImageValues: '',
        vehiclePose: '',
      },
    })
    expect(compiled.normalizedManifest).not.toHaveProperty('columnMap')
  })

  it('projects interleaved layout, semantic taxonomy roles, and camera view policy exactly', () => {
    const candidate = structuredClone(recipe())
    candidate.scene.pointAttributes = [
      ...candidate.scene.pointAttributes,
      { id: 'intensity', storage: 'float32', range: [0, 255] },
    ]
    candidate.scene.pointLayout = {
      interleavedAttributes: ['x', 'y', 'z', 'intensity'],
      colorModes: ['distance', 'intensity', 'segment', 'camera'],
    }
    candidate.scene.sensors = [{
      id: 'front-camera',
      rendererId: 1,
      label: 'FRONT',
      modality: 'camera',
      frameId: 'ego',
      color: '#ffffff',
      image: { width: 1600, height: 900, model: 'pinhole', view: 'front', povLabel: 'FRONT', aliases: ['CAM_FRONT'] },
    }]
    candidate.scene.taxonomies = [
      { id: 'objects', role: 'objects', classes: [{ id: 'vehicle', rendererId: 1, label: 'Vehicle', color: '#ff9900', modelHint: 'vehicle' }] },
      { id: 'lidar-labels', role: 'lidar-semantics', classes: [{ id: 'road', rendererId: 0, label: 'Road', color: '#808080' }], palette: [[0.5, 0.5, 0.5]] },
      { id: 'camera-labels', role: 'camera-semantics', classes: [{ id: 'sky', rendererId: 0, label: 'Sky', color: '#0080ff' }], palette: [[0, 0.5, 1]] },
    ]

    const manifest = compileRecipeV1(candidate, registry()).compatibilityManifest
    expect(manifest.pointStride).toBe(4)
    expect(manifest.colormapModes).toEqual(['distance', 'intensity', 'segment', 'camera'])
    expect(manifest.intensityRange).toEqual([0, 255])
    expect(manifest.cameraSensors[0]).toMatchObject({ flex: 1.3 })
    expect(manifest.cameraAliases).toEqual({ CAM_FRONT: 1 })
    expect(manifest.boxTypes[0]).toMatchObject({ id: 1, label: 'Vehicle', model: 'vehicle' })
    expect(manifest.semanticLabels).toEqual(['Road'])
    expect(manifest.cameraSemanticLabels).toEqual(['Sky'])
  })

  it('allows renderer IDs to overlap across point-sensor and camera namespaces', () => {
    const candidate = structuredClone(recipe())
    candidate.scene.sensors = [
      { id: 'lidar', rendererId: 1, label: 'LIDAR', modality: 'lidar', frameId: 'ego', color: '#ffffff' },
      {
        id: 'camera', rendererId: 1, label: 'CAMERA', modality: 'camera', frameId: 'ego', color: '#ffffff',
        image: { width: 100, height: 100, model: 'pinhole', view: 'front' },
      },
    ]
    expect(() => compileRecipeV1(candidate, registry())).not.toThrow()
  })

  it('rejects manifest fragments: Phase 2 assets remain complete recipe shells', () => {
    const fragment = structuredClone(minimalJson) as unknown as Record<string, unknown>
    delete fragment.pipelines
    delete fragment.outputs
    const result = validateRecipeV1(fragment)
    expect(result.ok).toBe(false)
    expect(result.diagnostics.some((item) => item.jsonPointer === '/')).toBe(true)
  })

  it('rejects conflicting logical source bindings', () => {
    const candidate = structuredClone(recipe())
    candidate.match.inventory.rootEntries = [
      ...candidate.match.inventory.rootEntries,
      { path: 'other.json', required: false },
    ]
    candidate.sources = {
      ...candidate.sources,
      other: {
        reader: 'json.records',
        files: { exact: 'other.json' },
        columns: ['other_timestamp'],
        bindings: { timestamp: 'other_timestamp' },
      },
    }
    expect(() => compileRecipeV1(candidate, registry())).toThrow(AdapterCompileError)
    try {
      compileRecipeV1(candidate, registry())
    } catch (error) {
      expect((error as AdapterCompileError).diagnostics.some((item) => item.code === 'SOURCE_BINDING_AMBIGUOUS')).toBe(true)
    }
  })
})
