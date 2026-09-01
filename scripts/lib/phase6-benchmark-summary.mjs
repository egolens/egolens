function markGeneration(mark) {
  return mark?.detail?.sceneGeneration
}

/** Select milestones for the scene that survived initial loading and was measured. */
export function selectInitialSceneMilestones(run) {
  const marks = run.snapshots?.afterWarmup?.app?.marks ?? []
  const activeGeneration = run.snapshots?.afterWarmup?.app?.scene?.sceneGeneration
  const generation = Number.isSafeInteger(activeGeneration)
    ? activeGeneration
    : marks.find((mark) => mark.name.startsWith('egolens:dataset-ready:'))?.detail?.sceneGeneration
      ?? marks.find((mark) => mark.name.startsWith('egolens:first-usable-frame:'))?.detail?.sceneGeneration
  const ready = marks.find((mark) =>
    mark.name.startsWith('egolens:dataset-ready:') && markGeneration(mark) === generation)
  const first = marks.find((mark) =>
    mark.name.startsWith('egolens:first-usable-frame:') && markGeneration(mark) === generation)
  const milestoneTime = ready?.startTime ?? first?.startTime
  const start = marks
    .filter((mark) => mark.name.startsWith('egolens:scene-load-start:'))
    .filter((mark) => !Number.isFinite(milestoneTime) || mark.startTime <= milestoneTime)
    .at(-1)
  return { start, ready, first, initialGeneration: generation }
}
