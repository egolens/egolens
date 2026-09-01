import assert from 'node:assert/strict'
import test from 'node:test'
import { selectInitialSceneMilestones } from './lib/phase6-benchmark-summary.mjs'

test('selects the active measured generation after local multi-scene discovery', () => {
  const marks = [
    { name: 'egolens:scene-load-start:1', startTime: 10, detail: { scene: 'first' } },
    { name: 'egolens:dataset-ready:2', startTime: 20, detail: { sceneGeneration: 1 } },
    { name: 'egolens:first-usable-frame:3', startTime: 21, detail: { sceneGeneration: 1 } },
    { name: 'egolens:scene-load-start:4', startTime: 30, detail: { scene: 'counted' } },
    { name: 'egolens:dataset-ready:5', startTime: 42, detail: { sceneGeneration: 3 } },
    { name: 'egolens:first-usable-frame:6', startTime: 44, detail: { sceneGeneration: 3 } },
  ]
  const selected = selectInitialSceneMilestones({
    snapshots: { afterWarmup: { app: { scene: { sceneGeneration: 3 }, marks } } },
  })
  assert.equal(selected.initialGeneration, 3)
  assert.equal(selected.start.name, 'egolens:scene-load-start:4')
  assert.equal(selected.ready.name, 'egolens:dataset-ready:5')
  assert.equal(selected.first.name, 'egolens:first-usable-frame:6')
})

test('retains the single-generation startup case', () => {
  const marks = [
    { name: 'egolens:scene-load-start:1', startTime: 10, detail: {} },
    { name: 'egolens:dataset-ready:2', startTime: 20, detail: { sceneGeneration: 1 } },
    { name: 'egolens:first-usable-frame:3', startTime: 21, detail: { sceneGeneration: 1 } },
  ]
  const selected = selectInitialSceneMilestones({
    snapshots: { afterWarmup: { app: { scene: { sceneGeneration: 1 }, marks } } },
  })
  assert.equal(selected.initialGeneration, 1)
  assert.equal(selected.start.name, 'egolens:scene-load-start:1')
})
