/**
 * Unit tests for dataHost.ts.
 *
 * This classifier exists to answer "does anyone point EgoLens at their own
 * infrastructure?" without shipping the hostname that would answer "whose?".
 * The tests pin both halves: the families are recognised, and anything
 * unrecognised collapses to 'other' rather than leaking through.
 */

import { describe, it, expect } from 'vitest'
import { classifyDataHost } from '../dataHost'

describe('classifyDataHost', () => {
  it('recognises S3 in the forms datasets actually use', () => {
    // Argoverse's public bucket, virtual-hosted with a region
    expect(classifyDataHost('https://argoverse.s3.us-east-1.amazonaws.com/datasets/av2/')).toBe('aws_s3')
    expect(classifyDataHost('https://my-bucket.s3.amazonaws.com/logs/')).toBe('aws_s3')
    expect(classifyDataHost('https://s3.us-west-2.amazonaws.com/bucket/prefix/')).toBe('aws_s3')
  })

  it('recognises the other major object stores', () => {
    expect(classifyDataHost('https://storage.googleapis.com/bucket/av/')).toBe('gcs')
    expect(classifyDataHost('https://myaccount.blob.core.windows.net/container/')).toBe('azure')
    expect(classifyDataHost('https://abc123.r2.cloudflarestorage.com/bucket/')).toBe('r2')
  })

  it('separates a local dev server from real hosting', () => {
    expect(classifyDataHost('http://localhost:8000/waymo_data/')).toBe('localhost')
    expect(classifyDataHost('http://127.0.0.1:5173/data/')).toBe('localhost')
  })

  it('reports self-hosted servers as other, without their hostname', () => {
    // The point of the coarse bucket: an internal host often names the company.
    const kind = classifyDataHost('https://av-data.internal.some-company.com/logs/')
    expect(kind).toBe('other')
    expect(kind).not.toContain('company')
  })

  it('reports local files as none rather than guessing', () => {
    expect(classifyDataHost(null)).toBe('none')
    expect(classifyDataHost(undefined)).toBe('none')
    expect(classifyDataHost('')).toBe('none')
  })

  it('does not throw on unparseable input', () => {
    expect(classifyDataHost('not a url')).toBe('unknown')
    expect(classifyDataHost('///')).toBe('unknown')
  })

  it('is not fooled by a lookalike hostname', () => {
    // A host merely ending in something S3-ish is not S3.
    expect(classifyDataHost('https://amazonaws.com.evil.example/bucket/')).toBe('other')
    expect(classifyDataHost('https://notlocalhost.example/data/')).toBe('other')
  })
})
