function finiteRect(rect) {
  return rect !== null && typeof rect === 'object'
    && ['left', 'top', 'right', 'bottom', 'width', 'height']
      .every((key) => Number.isFinite(rect[key]))
}

/**
 * Phase 6 oracle-compatible clip. The reviewed screenshots passed Chromium the
 * responsive DOMRect verbatim, including fractional coordinates and extent.
 */
export function phase6PerceptualClipV1(rect) {
  if (!finiteRect(rect)) throw new TypeError('Perceptual clip requires a finite DOMRect projection')
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    scale: 1,
  }
}

/**
 * Phase 10 transport-parity clip. Use the largest inner integer rectangle so
 * flex-layout half pixels cannot select a different compositor edge.
 */
export function transportPerceptualClipV2(rect) {
  if (!finiteRect(rect)) throw new TypeError('Perceptual clip requires a finite DOMRect projection')
  const x = Math.ceil(rect.left)
  const y = Math.ceil(rect.top)
  return {
    x,
    y,
    width: Math.max(0, Math.floor(rect.right) - x),
    height: Math.max(0, Math.floor(rect.bottom) - y),
    scale: 1,
  }
}
