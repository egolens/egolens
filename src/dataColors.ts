/**
 * Dataset-semantic colors. These are deliberately separate from theme.ts:
 * changing the UI theme or custom accent must never change sensor identity.
 */
export const dataColors = {
  sensorTop: '#00E89D',
  sensorFront: '#00C9DB',
  sensorSideL: '#4DA8FF',
  sensorSideR: '#7B6FFF',
  sensorRear: '#B490FF',

  radarFront: '#FF6B6B',
  radarFrontLeft: '#FF9F43',
  radarFrontRight: '#FECA57',
  radarBackLeft: '#FF6348',
  radarBackRight: '#EE5A24',

  camFront: '#FFFFFF',
  camFrontLeft: '#00E89D',
  camFrontRight: '#00C9DB',
  camSideLeft: '#4DA8FF',
  camSideRight: '#B490FF',
  camBack: '#00C9DB',
} as const
