import type { EgoLensAdapterRecipeV1, JsonObject } from '../recipe/types'
import type { HumanReviewCapabilityV1 } from './review'

const DATABASE_NAME = 'egolens-teachable-v1'
const DATABASE_VERSION = 1

export interface FinalizedArtifactRecordV1 {
  readonly recipeHash: string
  readonly formatFingerprint: string
  readonly artifact: EgoLensAdapterRecipeV1
  readonly finalizedAt: string
  readonly capabilities: readonly string[]
  readonly reviewedCapabilities: readonly HumanReviewCapabilityV1[]
  readonly matcherEvidence: JsonObject
  readonly validationSummary: JsonObject
}

interface PreferredRecipeRecordV1 {
  readonly formatFingerprint: string
  readonly recipeHash: string
  readonly updatedAt: string
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction was aborted.'))
  })
}

/** IndexedDB cache. Exported JSON remains the source of truth. */
export class TeachableArtifactCacheV1 {
  readonly #indexedDb?: IDBFactory
  readonly #memoryArtifacts = new Map<string, FinalizedArtifactRecordV1>()
  readonly #memoryPreferred = new Map<string, PreferredRecipeRecordV1>()
  #databasePromise: Promise<IDBDatabase> | null = null

  constructor(indexedDb: IDBFactory | undefined = globalThis.indexedDB) {
    this.#indexedDb = indexedDb
  }

  async saveFinalized(record: FinalizedArtifactRecordV1): Promise<void> {
    if (!this.#indexedDb) {
      this.#memoryArtifacts.set(record.recipeHash, structuredClone(record))
      this.#memoryPreferred.set(record.formatFingerprint, {
        formatFingerprint: record.formatFingerprint,
        recipeHash: record.recipeHash,
        updatedAt: record.finalizedAt,
      })
      return
    }
    const database = await this.#database()
    const transaction = database.transaction(['artifacts', 'preferred'], 'readwrite')
    transaction.objectStore('artifacts').put(record)
    transaction.objectStore('preferred').put({
      formatFingerprint: record.formatFingerprint,
      recipeHash: record.recipeHash,
      updatedAt: record.finalizedAt,
    } satisfies PreferredRecipeRecordV1)
    await transactionDone(transaction)
  }

  async get(recipeHash: string): Promise<FinalizedArtifactRecordV1 | null> {
    if (!this.#indexedDb) return structuredClone(this.#memoryArtifacts.get(recipeHash) ?? null)
    const database = await this.#database()
    const transaction = database.transaction('artifacts', 'readonly')
    return await requestResult(transaction.objectStore('artifacts').get(recipeHash)) as FinalizedArtifactRecordV1 | undefined ?? null
  }

  async preferredForFormat(formatFingerprint: string): Promise<FinalizedArtifactRecordV1 | null> {
    if (!this.#indexedDb) {
      const preferred = this.#memoryPreferred.get(formatFingerprint)
      return preferred ? await this.get(preferred.recipeHash) : null
    }
    const database = await this.#database()
    const transaction = database.transaction(['preferred', 'artifacts'], 'readonly')
    const preferred = await requestResult(transaction.objectStore('preferred').get(formatFingerprint)) as PreferredRecipeRecordV1 | undefined
    if (!preferred) return null
    return await requestResult(transaction.objectStore('artifacts').get(preferred.recipeHash)) as FinalizedArtifactRecordV1 | undefined ?? null
  }

  /** Every finalized artifact in this browser, newest first. */
  async listAll(): Promise<readonly FinalizedArtifactRecordV1[]> {
    if (!this.#indexedDb) {
      return [...this.#memoryArtifacts.values()].sort((left, right) => right.finalizedAt.localeCompare(left.finalizedAt)).map((record) => structuredClone(record))
    }
    const database = await this.#database()
    const transaction = database.transaction('artifacts', 'readonly')
    const records = await requestResult(transaction.objectStore('artifacts').getAll()) as FinalizedArtifactRecordV1[]
    return records.sort((left, right) => right.finalizedAt.localeCompare(left.finalizedAt))
  }

  async listByFormat(formatFingerprint: string): Promise<readonly FinalizedArtifactRecordV1[]> {
    if (!this.#indexedDb) {
      return [...this.#memoryArtifacts.values()]
        .filter((record) => record.formatFingerprint === formatFingerprint)
        .sort((left, right) => right.finalizedAt.localeCompare(left.finalizedAt))
        .map((record) => structuredClone(record))
    }
    const database = await this.#database()
    const transaction = database.transaction('artifacts', 'readonly')
    const records = await requestResult(transaction.objectStore('artifacts').getAll()) as FinalizedArtifactRecordV1[]
    return records
      .filter((record) => record.formatFingerprint === formatFingerprint)
      .sort((left, right) => right.finalizedAt.localeCompare(left.finalizedAt))
  }

  async #database(): Promise<IDBDatabase> {
    if (!this.#indexedDb) throw new Error('IndexedDB is unavailable.')
    if (this.#databasePromise) return this.#databasePromise
    this.#databasePromise = new Promise((resolve, reject) => {
      const request = this.#indexedDb!.open(DATABASE_NAME, DATABASE_VERSION)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains('artifacts')) {
          const artifacts = database.createObjectStore('artifacts', { keyPath: 'recipeHash' })
          artifacts.createIndex('formatFingerprint', 'formatFingerprint', { unique: false })
        }
        if (!database.objectStoreNames.contains('preferred')) {
          database.createObjectStore('preferred', { keyPath: 'formatFingerprint' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Could not open the Teachable Lens cache.'))
    })
    return this.#databasePromise
  }
}
