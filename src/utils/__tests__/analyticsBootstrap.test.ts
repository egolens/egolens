/**
 * @vitest-environment happy-dom
 *
 * Unit tests for deployment classification.
 *
 * This label is the correction to a real mistake: localhost was excluded from
 * analytics outright, which turned out to silence roughly two thirds of usage —
 * hundreds of users in the Netherlands and Germany running a cloned repo, plus
 * every Waymo user, whose licence leaves them no hosted option at all. Local runs
 * are now measured and labelled instead, so the two can be told apart without
 * losing either.
 */

import { describe, it, expect } from 'vitest'
import { classifyDeployment } from '../analyticsBootstrap'

describe('classifyDeployment', () => {
  it('labels the canonical hosted build', () => {
    expect(classifyDeployment('egolens.org')).toBe('hosted')
    expect(classifyDeployment('www.egolens.org')).toBe('hosted')
  })

  it('labels a clone running on someone’s own machine', () => {
    expect(classifyDeployment('localhost')).toBe('local')
    expect(classifyDeployment('127.0.0.1')).toBe('local')
    expect(classifyDeployment('0.0.0.0')).toBe('local')
    expect(classifyDeployment('[::1]')).toBe('local')
    expect(classifyDeployment('egolens.localhost')).toBe('local')
  })

  it('labels forks and embeds as other', () => {
    // A real one: someone forked EgoLens into an AV triage tool on Pages.
    expect(classifyDeployment('rafaelmaranon.github.io')).toBe('other')
    expect(classifyDeployment('egolens.github.io')).toBe('other')
    expect(classifyDeployment('some-company.internal')).toBe('other')
  })

  it('does not mistake a lookalike host for local', () => {
    expect(classifyDeployment('notlocalhost.example')).toBe('other')
    expect(classifyDeployment('localhost.evil.example')).toBe('other')
  })

  it('does not mistake a lookalike host for the hosted build', () => {
    expect(classifyDeployment('egolens.org.evil.example')).toBe('other')
    expect(classifyDeployment('notegolens.org')).toBe('other')
  })
})
