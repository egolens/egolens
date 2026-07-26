/**
 * @vitest-environment happy-dom
 *
 * Unit tests for folder-rejection diagnostics and their telemetry.
 *
 * Two properties are load-bearing and pull in opposite directions:
 *
 *   1. The on-screen message must name what the user actually pointed at, or it
 *      is the same unhelpful "drop a dataset folder" that stalled a domain
 *      expert against a 2 TB tree.
 *   2. The analytics event must NOT carry those names. A folder is often named
 *      after an employer or an unreleased project, and knowing the shape people
 *      drop does not require knowing that.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { describeRejection, describeFolderProblem } from '../folderScan'
import { trackFolderRejected } from '../analytics'

let events: { name: string; params: Record<string, unknown> }[] = []

beforeEach(() => {
  events = []
  ;(window as unknown as { gtag: (...a: unknown[]) => void }).gtag = (
    _kind: unknown,
    name: unknown,
    params: unknown,
  ) => {
    events.push({ name: name as string, params: (params ?? {}) as Record<string, unknown> })
  }
})

describe('describeRejection', () => {
  it('recognises a dataset archive root', () => {
    // The exact shape that stalled a real user: the top of the Waymo download.
    const r = describeRejection(['training', 'validation', 'testing'])
    expect(r.looksLikeArchiveRoot).toBe(true)
    expect(r.knownNames).toEqual(['testing', 'training', 'validation'])
    expect(r.dirCount).toBe(3)
  })

  it('recognises generic split names too', () => {
    expect(describeRejection(['train', 'val', 'test']).looksLikeArchiveRoot).toBe(true)
    expect(describeRejection(['val']).looksLikeArchiveRoot).toBe(true)
  })

  it('does not call an ordinary folder an archive root', () => {
    const r = describeRejection(['Documents', 'Downloads', 'code'])
    expect(r.looksLikeArchiveRoot).toBe(false)
    expect(r.knownNames).toEqual([])
    expect(r.dirCount).toBe(3)
  })

  it('keeps every name for the message', () => {
    // The message needs the real listing; it renders in the browser only.
    const r = describeRejection(['acme-internal-logs', 'validation'])
    expect(r.found).toEqual(['acme-internal-logs', 'validation'])
  })

  it('reports only published layout names as known', () => {
    const r = describeRejection(['acme-internal-logs', 'project-zeta', 'samples', 'sweeps'])
    expect(r.knownNames).toEqual(['samples', 'sweeps'])
    expect(r.knownNames).not.toContain('acme-internal-logs')
    expect(r.knownNames).not.toContain('project-zeta')
  })

  it('is case-insensitive about layout names', () => {
    const r = describeRejection(['Validation', 'TESTING'])
    expect(r.looksLikeArchiveRoot).toBe(true)
    expect(r.knownNames).toEqual(['testing', 'validation'])
  })

  it('handles an empty drop', () => {
    const r = describeRejection([])
    expect(r.dirCount).toBe(0)
    expect(r.looksLikeArchiveRoot).toBe(false)
    expect(r.found).toEqual([])
  })
})

describe('trackFolderRejected', () => {
  it('reports shape: count, known names, archive-root flag', () => {
    trackFolderRejected(describeRejection(['training', 'validation', 'testing']))

    const [event] = events
    expect(event.name).toBe('folder_rejected')
    expect(event.params.dir_count).toBe(3)
    expect(event.params.known_names).toBe('testing,training,validation')
    expect(event.params.archive_root).toBe(true)
  })

  it('never transmits a name outside the published layout list', () => {
    trackFolderRejected(describeRejection(['acme-internal-logs', 'project-zeta', 'unreleased-robot']))

    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain('acme')
    expect(serialized).not.toContain('project-zeta')
    expect(serialized).not.toContain('unreleased-robot')
    // The shape still comes through.
    expect(events[0].params.dir_count).toBe(3)
    expect(events[0].params.known_names).toBe('none')
  })

  it('distinguishes "nothing known" from "nothing at all"', () => {
    trackFolderRejected(describeRejection(['random-folder']))
    trackFolderRejected(describeRejection([]))

    expect(events[0].params.dir_count).toBe(1)
    expect(events[1].params.dir_count).toBe(0)
    expect(events[0].params.known_names).toBe('none')
    expect(events[1].params.known_names).toBe('none')
  })
})

// ---------------------------------------------------------------------------

describe('describeFolderProblem', () => {
  it('tells an archive-root user which way to go', () => {
    const msg = describeFolderProblem(describeRejection(['training', 'validation', 'testing']))

    // The actionable part: go down a level, not "drop a dataset folder".
    expect(msg).toMatch(/archive root/i)
    expect(msg).toMatch(/validation/)
    expect(msg).toMatch(/single log folder/i)
  })

  it('lists what an unrecognised folder actually contained', () => {
    const msg = describeFolderProblem(describeRejection(['Documents', 'Downloads', 'code']))

    expect(msg).toContain('Documents')
    expect(msg).toContain('Downloads')
    expect(msg).not.toMatch(/archive root/i)
  })

  it('truncates a long listing instead of dumping it', () => {
    const many = Array.from({ length: 40 }, (_, i) => `dir${i}`)
    const msg = describeFolderProblem(describeRejection(many))

    expect(msg).toContain('dir0')
    expect(msg).toMatch(/35 more/)
    expect(msg).not.toContain('dir39')
  })

  it('handles a drop with no folders at all', () => {
    const msg = describeFolderProblem(describeRejection([]))
    expect(msg).toMatch(/not individual files/i)
  })

  it('always says what a valid folder looks like', () => {
    for (const dirs of [[], ['validation'], ['Documents']]) {
      const msg = describeFolderProblem(describeRejection(dirs))
      expect(msg).toMatch(/vehicle_pose/)
      expect(msg).toMatch(/samples/)
      expect(msg).toMatch(/Argoverse 2/)
    }
  })

  it('survives a missing diagnostic', () => {
    expect(() => describeFolderProblem(undefined)).not.toThrow()
    expect(describeFolderProblem(undefined)).toMatch(/vehicle_pose/)
  })
})
