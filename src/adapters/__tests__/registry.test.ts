/**
 * Unit tests for the dataset adapter registry and Waymo manifest.
 *
 * Verifies:
 * - Registry defaults to Waymo manifest
 * - setManifest() / getManifest() correctly swap the active manifest
 * - Waymo manifest structure is internally consistent
 * - Manifest contract (required fields, no duplicates, valid colors)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { getManifest, setManifest } from '../registry'
import { waymoManifest } from '../waymo/manifest'
import type { DatasetManifest } from '../../types/dataset'

// ---------------------------------------------------------------------------
// Registry: getManifest / setManifest
// ---------------------------------------------------------------------------

describe('adapter registry', () => {
  beforeEach(() => {
    // Reset to Waymo after each test
    setManifest(waymoManifest)
  })

  it('defaults to waymoManifest', () => {
    expect(getManifest()).toBe(waymoManifest)
    expect(getManifest().id).toBe('waymo')
  })

  it('setManifest() swaps the active manifest', () => {
    const mock: DatasetManifest = {
      id: 'test-dataset',
      name: 'Test Dataset',
      lidarSensors: [{ id: 1, label: 'LIDAR', color: '#fff' }],
      cameraSensors: [{ id: 1, label: 'CAM', color: '#000', width: 640, height: 480 }],
      boxTypes: [{ id: 0, label: 'Unknown', color: '#888' }],
      frameRate: 5,
      cameraColors: { 1: '#000' },
      cameraPovLabels: { 1: 'C' },
    }

    setManifest(mock)
    expect(getManifest()).toBe(mock)
    expect(getManifest().id).toBe('test-dataset')
  })

  it('setManifest() can be called multiple times', () => {
    const m1: DatasetManifest = { ...waymoManifest, id: 'a', name: 'A' }
    const m2: DatasetManifest = { ...waymoManifest, id: 'b', name: 'B' }

    setManifest(m1)
    expect(getManifest().id).toBe('a')

    setManifest(m2)
    expect(getManifest().id).toBe('b')
  })
})

// ---------------------------------------------------------------------------
// Waymo manifest: structural integrity
// ---------------------------------------------------------------------------

describe('waymoManifest', () => {
  it('has correct id and name', () => {
    expect(waymoManifest.id).toBe('waymo')
    expect(waymoManifest.name).toBe('Waymo Open Dataset')
  })

  it('has 5 lidar sensors', () => {
    expect(waymoManifest.lidarSensors).toHaveLength(5)
  })

  it('has 5 camera sensors', () => {
    expect(waymoManifest.cameraSensors).toHaveLength(5)
  })

  it('has 5 box types (including Unknown)', () => {
    expect(waymoManifest.boxTypes).toHaveLength(5)
  })

  it('has frameRate of 10 Hz', () => {
    expect(waymoManifest.frameRate).toBe(10)
  })

  // Uniqueness checks
  it('lidar sensor ids are unique', () => {
    const ids = waymoManifest.lidarSensors.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('camera sensor ids are unique', () => {
    const ids = waymoManifest.cameraSensors.map(s => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('box type ids are unique', () => {
    const ids = waymoManifest.boxTypes.map(b => b.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  // Required field checks
  it('every lidar sensor has id, label, and color', () => {
    for (const s of waymoManifest.lidarSensors) {
      expect(s.id).toBeTypeOf('number')
      expect(s.label).toBeTypeOf('string')
      expect(s.label.length).toBeGreaterThan(0)
      expect(s.color).toMatch(/^#[0-9a-fA-F]{3,8}$/)
    }
  })

  it('every camera sensor has id, label, color, width, and height', () => {
    for (const c of waymoManifest.cameraSensors) {
      expect(c.id).toBeTypeOf('number')
      expect(c.label).toBeTypeOf('string')
      expect(c.label.length).toBeGreaterThan(0)
      expect(c.color).toMatch(/^#[0-9a-fA-F]{3,8}$/)
      expect(c.width).toBeGreaterThan(0)
      expect(c.height).toBeGreaterThan(0)
    }
  })

  it('every box type has id, label, and valid hex color', () => {
    for (const b of waymoManifest.boxTypes) {
      expect(b.id).toBeTypeOf('number')
      expect(b.label).toBeTypeOf('string')
      expect(b.color).toMatch(/^#[0-9a-fA-F]{3,8}$/)
    }
  })

  // Cross-referencing: cameraColors and cameraPovLabels should cover all camera ids
  it('cameraColors has an entry for every camera sensor', () => {
    for (const cam of waymoManifest.cameraSensors) {
      expect(waymoManifest.cameraColors[cam.id]).toBeTypeOf('string')
    }
  })

  it('cameraPovLabels has an entry for every camera sensor', () => {
    for (const cam of waymoManifest.cameraSensors) {
      expect(waymoManifest.cameraPovLabels[cam.id]).toBeTypeOf('string')
    }
  })

  // Camera sensor colors should match cameraColors map
  it('camera sensor colors are consistent with cameraColors map', () => {
    for (const cam of waymoManifest.cameraSensors) {
      expect(cam.color).toBe(waymoManifest.cameraColors[cam.id])
    }
  })

  // Specific Waymo sensor IDs match expected values (regression guard)
  it('lidar sensor ids are 1-5 (TOP, FRONT, SIDE_L, SIDE_R, REAR)', () => {
    const ids = waymoManifest.lidarSensors.map(s => s.id).sort()
    expect(ids).toEqual([1, 2, 3, 4, 5])
  })

  it('camera sensor ids are 1-5 (FRONT, FRONT_LEFT, FRONT_RIGHT, SIDE_LEFT, SIDE_RIGHT)', () => {
    const ids = waymoManifest.cameraSensors.map(s => s.id).sort()
    expect(ids).toEqual([1, 2, 3, 4, 5])
  })

  // Camera display order: SIDE_LEFT, FRONT_LEFT, FRONT, FRONT_RIGHT, SIDE_RIGHT
  it('camera sensors are ordered left-to-right (SL, FL, F, FR, SR)', () => {
    const labels = waymoManifest.cameraSensors.map(c => c.label)
    expect(labels).toEqual(['SIDE LEFT', 'FRONT LEFT', 'FRONT', 'FRONT RIGHT', 'SIDE RIGHT'])
  })

  // FRONT camera should have larger flex
  it('FRONT camera has flex > 1 (larger panel)', () => {
    const front = waymoManifest.cameraSensors.find(c => c.id === 1)
    expect(front).toBeDefined()
    expect(front!.flex).toBeGreaterThan(1)
  })

  it('non-FRONT cameras have flex 1', () => {
    const nonFront = waymoManifest.cameraSensors.filter(c => c.id !== 1)
    for (const c of nonFront) {
      expect(c.flex).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// Manifest contract: generic validation helper
// ---------------------------------------------------------------------------

describe('manifest contract validation', () => {
  /** Validates any DatasetManifest for structural correctness */
  function validateManifest(m: DatasetManifest) {
    expect(m.id).toBeTypeOf('string')
    expect(m.id.length).toBeGreaterThan(0)
    expect(m.name).toBeTypeOf('string')
    expect(m.name.length).toBeGreaterThan(0)
    expect(m.lidarSensors.length).toBeGreaterThan(0)
    expect(m.cameraSensors.length).toBeGreaterThan(0)
    expect(m.boxTypes.length).toBeGreaterThan(0)
    expect(m.frameRate).toBeGreaterThan(0)

    // All camera ids have colors and labels
    for (const cam of m.cameraSensors) {
      expect(m.cameraColors[cam.id]).toBeDefined()
      expect(m.cameraPovLabels[cam.id]).toBeDefined()
    }
  }

  it('waymoManifest passes contract validation', () => {
    validateManifest(waymoManifest)
  })
})
