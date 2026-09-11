/** Shared graph I/O budget. Signals carry mutable priority through lazy readers. */
const priorities = new WeakMap<AbortSignal, { value: number }>()
export function setReadPriority(signal: AbortSignal, value: number): void {
  const priority = priorities.get(signal)
  if (priority) priority.value = value
  else priorities.set(signal, { value })
}
export function linkedReadSignal(lifecycle: AbortSignal, request?: AbortSignal): AbortSignal {
  if (!request) return lifecycle
  const signal = AbortSignal.any([lifecycle, request])
  const priority = priorities.get(request)
  if (priority) priorities.set(signal, priority)
  return signal
}
const aborted = () => new DOMException('Source read was aborted.', 'AbortError')
interface Subscriber {
  signal: AbortSignal
  resolve: (bytes: ArrayBuffer) => void
  reject: (error: unknown) => void
  abort: () => void
}
interface ReadJob {
  key: string
  controller: AbortController
  read: (signal: AbortSignal) => Promise<ArrayBuffer>
  subscribers: Set<Subscriber>
  active: boolean
}
export class ReadSchedulerV1 {
  readonly #jobs = new Map<string, ReadJob>()
  #active = 0
  #peak = 0
  #completed = 0
  #disposed = false
  readonly concurrency: number
  constructor(concurrency = 6) {
    this.concurrency = concurrency
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('READ_CONCURRENCY_INVALID')
  }
  snapshot() { return { active: this.#active, queued: [...this.#jobs.values()].filter(j => !j.active).length, peak: this.#peak, completed: this.#completed } }
  read(key: string, read: ReadJob['read'], signal: AbortSignal): Promise<ArrayBuffer> {
    if (this.#disposed || signal.aborted) return Promise.reject(aborted())
    let job = this.#jobs.get(key)
    if (!job || job.controller.signal.aborted) {
      job = { key, read, controller: new AbortController(), subscribers: new Set(), active: false }
      this.#jobs.set(key, job)
    }
    const selected = job
    return new Promise((resolve, reject) => {
      const subscriber: Subscriber = { signal, resolve, reject, abort: () => {
        selected.subscribers.delete(subscriber)
        signal.removeEventListener('abort', subscriber.abort)
        reject(aborted())
        if (!selected.subscribers.size) {
          selected.controller.abort()
          if (this.#jobs.get(key) === selected) this.#jobs.delete(key)
        }
        this.#pump()
      } }
      selected.subscribers.add(subscriber)
      signal.addEventListener('abort', subscriber.abort, { once: true })
      this.#pump()
    })
  }
  dispose(): void {
    this.#disposed = true
    for (const job of [...this.#jobs.values()]) {
      for (const subscriber of [...job.subscribers]) subscriber.abort()
      job.controller.abort()
    }
    this.#jobs.clear()
  }
  #pump(): void {
    if (this.#disposed) return
    while (this.#active < this.concurrency) {
      const priority = (job: ReadJob) => Math.min(...[...job.subscribers].map(s => priorities.get(s.signal)?.value ?? 0))
      const job = [...this.#jobs.values()].filter(j => !j.active && j.subscribers.size && !j.controller.signal.aborted).sort((a, b) => priority(a) - priority(b))[0]
      if (!job) return
      job.active = true
      this.#active++
      this.#peak = Math.max(this.#peak, this.#active)
      void this.#execute(job)
    }
  }
  async #execute(job: ReadJob): Promise<void> {
    try {
      const bytes = await job.read(job.controller.signal)
      if (job.controller.signal.aborted) throw aborted()
      const subscribers = [...job.subscribers]
      subscribers.forEach((subscriber, index) => subscriber.resolve(index === subscribers.length - 1 ? bytes : bytes.slice(0)))
      this.#completed++
    } catch (error) {
      for (const subscriber of job.subscribers) subscriber.reject(error)
    } finally {
      for (const subscriber of job.subscribers) subscriber.signal.removeEventListener('abort', subscriber.abort)
      job.subscribers.clear()
      if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key)
      this.#active--
      this.#pump()
    }
  }
}

/** Bounded fan-out retaining input order, including for metadata row readers. */
export async function mapConcurrentV1<T, R>(values: readonly T[], mapper: (value: T, index: number) => Promise<R>, concurrency = 6): Promise<R[]> {
  const output: R[] = new Array(values.length)
  let cursor = 0
  let failed = false
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!failed && cursor < values.length) {
      const index = cursor++
      try { output[index] = await mapper(values[index], index) }
      catch (error) { failed = true; throw error }
    }
  }))
  return output
}
