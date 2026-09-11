/** Byte-bounded LRU. Eviction releases the actual owner's references. */
export class PayloadCacheV1<K, V> {
  readonly #entries = new Map<K, { value: V; bytes: number; release: () => void }>()
  #bytes = 0
  #peak = 0
  readonly limit: number
  constructor(limit: number) {
    this.limit = limit
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('PAYLOAD_CACHE_LIMIT_INVALID')
  }
  get bytes(): number { return this.#bytes }
  get peakBytes(): number { return this.#peak }
  keys(): K[] { return [...this.#entries.keys()] }
  has(key: K): boolean { return this.#entries.has(key) }
  get(key: K): V | undefined {
    const entry = this.#entries.get(key)
    if (!entry) return undefined
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return entry.value
  }
  set(key: K, value: V, bytes: number, release: () => void = () => {}, protectedKey?: K): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.limit) return false
    const pinned = protectedKey === key ? undefined : this.#entries.get(protectedKey as K)
    if (pinned && pinned.bytes + bytes > this.limit) return false
    this.delete(key)
    while (this.#bytes + bytes > this.limit) {
      const oldest = [...this.#entries.keys()].find(k => k !== protectedKey)
      if (oldest === undefined) return false
      this.delete(oldest)
    }
    this.#entries.set(key, { value, bytes, release })
    this.#bytes += bytes
    this.#peak = Math.max(this.#peak, this.#bytes)
    return true
  }
  delete(key: K): void {
    const entry = this.#entries.get(key)
    if (!entry) return
    this.#entries.delete(key)
    this.#bytes -= entry.bytes
    entry.release()
  }
  clear(): void { for (const key of this.keys()) this.delete(key) }
}

/** Counts retained buffers once, with conservative overhead for plain metadata. */
export function retainedPayloadBytesV1(value: unknown, seen = new Set<object>()): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'string') return value.length * 2
  if (typeof value !== 'object') return 8
  if (seen.has(value)) return 0
  seen.add(value)
  if (value instanceof ArrayBuffer) return value.byteLength
  if (ArrayBuffer.isView(value)) return retainedPayloadBytesV1(value.buffer, seen)
  if (value instanceof Map) return [...value].reduce((n, entry) => n + retainedPayloadBytesV1(entry, seen), 0)
  if (value instanceof Set) return [...value].reduce((n, entry) => n + retainedPayloadBytesV1(entry, seen), 0)
  return 32 + Object.values(value).reduce<number>((n, entry) => n + retainedPayloadBytesV1(entry, seen), 0)
}
