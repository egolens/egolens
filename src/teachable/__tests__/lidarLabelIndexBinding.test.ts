import { describe, expect, it } from 'vitest'
import { nuScenesCompiledRecipe } from '../../adapters/recipes/bundled'
import { bundledPhase2OperatorRegistry } from '../operators/bundledPhase2'
import { coreGraphOperatorImplementationsV1 } from '../operators/coreGraphOperators'
import { compileRecipeV1 } from '../recipe/compiler'
import { AdapterCompileError } from '../recipe/diagnostics'

const attach = coreGraphOperatorImplementationsV1['labels.attach_by_point_index']!

function binary(paths: readonly string[]) {
  return { kind: 'binary-collection', files: paths.map((path) => ({ path, size: 1 })), cache: new Map(), retainedReleases: new Map() }
}
function records(rows: readonly Record<string, unknown>[]) {
  return { kind: 'records', rows }
}
function pointClouds(recordKeys: readonly string[]) {
  return {
    kind: 'binary-point-cloud-plan', records: binary([]),
    bindings: recordKeys.map((recordKey, index) => ({
      frameKey: `frame-${index}`, recordKey, timestamp: BigInt(index), path: `samples/LIDAR_TOP/${index}.bin`,
      sensorId: 'LIDAR_TOP', frameId: 'ego', egoFromSensor: null,
    })),
  }
}
const params = { taxonomy: 'nuscenes-lidar-semantics', indexRecordKeyField: 'sample_data_token', indexPathField: 'filename' }

function diagnosticsOf(recipe: unknown) {
  try {
    compileRecipeV1(recipe as never, bundledPhase2OperatorRegistry)
    return []
  } catch (error) {
    return (error as AdapterCompileError).diagnostics
  }
}

describe('lidar label index binding', () => {
  it('accepts semantic labels with an index and no panoptic inputs', () => {
    const recipe = structuredClone(nuScenesCompiledRecipe.recipe)
    const node = recipe.pipelines.lidarSegmentation.nodes[0] as unknown as { inputs: Record<string, string> }
    delete node.inputs.panoptic
    delete node.inputs.panopticIndex
    expect(diagnosticsOf(recipe)).toEqual([])
  })

  it('binds label files to point-cloud records through the index', async () => {
    const plan = (await attach({
      pointClouds: pointClouds(['sd-1', 'sd-2']),
      labels: binary(['lidarseg/v1.0-mini/a.bin']),
      labelIndex: records([{ sample_data_token: 'sd-2', filename: 'lidarseg/v1.0-mini/a.bin' }]),
    }, params)).segmentation as { semanticPathByRecordKey: Map<string, string> }
    expect([...plan.semanticPathByRecordKey]).toEqual([['sd-2', 'lidarseg/v1.0-mini/a.bin']])
  })

  it('fails the sample with both keys when no label file reaches a point-cloud record', async () => {
    await expect(attach({
      pointClouds: pointClouds(['sd-1']),
      labels: binary(['lidarseg/v1.0-mini/a.bin']),
      labelIndex: records([{ token: 'lidarseg-1', sample_data_token: 'sd-1', filename: 'lidarseg/v1.0-mini/a.bin' }]),
    }, { ...params, indexRecordKeyField: 'token' })).rejects.toThrow(
      /GRAPH_LABEL_INDEX_UNMATCHED: .*"token".*First index key: "lidarseg-1".*first point-cloud record key: "sd-1"/u,
    )
    await expect(attach({
      pointClouds: pointClouds(['sd-1']),
      labels: binary(['lidarseg/v1.0-mini/a.bin']),
    }, params)).rejects.toThrow(/GRAPH_LABEL_INDEX_UNMATCHED: .*labelIndex is missing or empty/u)
  })

  it('stays silent when no label file was selected at all', async () => {
    const plan = (await attach({ pointClouds: pointClouds(['sd-1']), labels: binary([]) }, params)).segmentation as { semanticPathByRecordKey: Map<string, string> }
    expect(plan.semanticPathByRecordKey.size).toBe(0)
  })

  it('rejects an undeclared taxonomy at compile time', () => {
    const recipe = structuredClone(nuScenesCompiledRecipe.recipe)
    const node = recipe.pipelines.lidarSegmentation.nodes[0] as unknown as { params: Record<string, unknown> }
    node.params.taxonomy = 'lidarseg'
    expect(diagnosticsOf(recipe)).toContainEqual(expect.objectContaining({
      code: 'TAXONOMY_UNDECLARED',
      jsonPointer: '/pipelines/lidarSegmentation/nodes/attachSemanticLabels/params/taxonomy',
    }))
  })
})
