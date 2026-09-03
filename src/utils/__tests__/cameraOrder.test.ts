import { describe, expect, it } from 'vitest'
import { orderCamerasByYawV1, splitCamerasIntoRowsV1 } from '../cameraOrder'

const yawRow = (id: number, yawDeg: number) => {
  const yaw = (yawDeg * Math.PI) / 180
  const c = Math.cos(yaw), s = Math.sin(yaw)
  // optical frame: camera z (forward) = column 2 → [c, s, 0] in ego x/y
  return { 'key.camera_name': id, __isOpticalFrame: true, '[CameraCalibrationComponent].extrinsic.transform': [0, 0, c, 0, 0, 0, s, 0, 1, 0, 0, 0, 0, 0, 0, 1] }
}
const cam = (id: number, label: string) => ({ id, label, color: '#fff', width: 1, height: 1 })

describe('orderCamerasByYawV1', () => {
  it('sweeps left → front → right → back for a six-camera rig', () => {
    const cameras = [cam(1, 'front'), cam(2, 'front_left'), cam(3, 'front_right'), cam(4, 'back'), cam(5, 'left'), cam(6, 'right')]
    const rows = [yawRow(1, 0), yawRow(2, 45), yawRow(3, -45), yawRow(4, 180), yawRow(5, 90), yawRow(6, -90)]
    expect(orderCamerasByYawV1(cameras, rows).map((c) => c.label)).toEqual(['left', 'front_left', 'front', 'front_right', 'right', 'back'])
  })
  it('keeps the given order for a forward stereo rig and appends cameras without calibration', () => {
    const cameras = [cam(1, 'left_gray'), cam(2, 'right_gray'), cam(3, 'left_color'), cam(4, 'right_color'), cam(9, 'uncalibrated')]
    const rows = [yawRow(1, 0.1), yawRow(2, -0.1), yawRow(3, 0.2), yawRow(4, -0.2)]
    expect(orderCamerasByYawV1(cameras, rows).map((c) => c.label)).toEqual(['left_gray', 'right_gray', 'left_color', 'right_color', 'uncalibrated'])
  })

  it('splits a six-camera rig into front-centred and rear-centred rows', () => {
    const cameras = [cam(1, 'front'), cam(2, 'front_left'), cam(3, 'front_right'), cam(4, 'back'), cam(5, 'left'), cam(6, 'right')]
    const rows = [yawRow(1, 0), yawRow(2, 45), yawRow(3, -45), yawRow(4, 180), yawRow(5, 90), yawRow(6, -90)]
    const [top, bottom] = splitCamerasIntoRowsV1(cameras, rows)!
    expect(top.map((c) => c.label)).toEqual(['front_left', 'front', 'front_right'])
    expect(bottom.map((c) => c.label)).toEqual(['left', 'back', 'right'])
  })
})
