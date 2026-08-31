const INITIAL = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

const ROUND = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count))
}

function bytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

/** Small incremental SHA-256 used where WebCrypto's one-shot API would retain a whole source file. */
export class IncrementalSha256V1 {
  readonly #state = new Uint32Array(INITIAL)
  readonly #buffer = new Uint8Array(64)
  readonly #schedule = new Uint32Array(64)
  #bufferLength = 0
  #totalBytes = 0
  #finished = false

  update(value: ArrayBuffer | ArrayBufferView): this {
    if (this.#finished) throw new Error('SHA256_ALREADY_FINALIZED')
    const input = bytes(value)
    if (!Number.isSafeInteger(this.#totalBytes + input.byteLength)) throw new Error('SHA256_INPUT_TOO_LARGE')
    this.#totalBytes += input.byteLength
    let offset = 0
    if (this.#bufferLength > 0) {
      const take = Math.min(64 - this.#bufferLength, input.byteLength)
      this.#buffer.set(input.subarray(0, take), this.#bufferLength)
      this.#bufferLength += take
      offset = take
      if (this.#bufferLength === 64) {
        this.#compress(this.#buffer, 0)
        this.#bufferLength = 0
      }
    }
    while (offset + 64 <= input.byteLength) {
      this.#compress(input, offset)
      offset += 64
    }
    if (offset < input.byteLength) {
      this.#buffer.set(input.subarray(offset), 0)
      this.#bufferLength = input.byteLength - offset
    }
    return this
  }

  digest(): Uint8Array {
    if (this.#finished) throw new Error('SHA256_ALREADY_FINALIZED')
    this.#finished = true
    const finalBlocks = new Uint8Array(this.#bufferLength < 56 ? 64 : 128)
    finalBlocks.set(this.#buffer.subarray(0, this.#bufferLength))
    finalBlocks[this.#bufferLength] = 0x80
    const highBits = Math.floor(this.#totalBytes / 0x20000000)
    const lowBits = (this.#totalBytes * 8) >>> 0
    const view = new DataView(finalBlocks.buffer)
    view.setUint32(finalBlocks.byteLength - 8, highBits, false)
    view.setUint32(finalBlocks.byteLength - 4, lowBits, false)
    for (let offset = 0; offset < finalBlocks.byteLength; offset += 64) this.#compress(finalBlocks, offset)
    const digest = new Uint8Array(32)
    const digestView = new DataView(digest.buffer)
    this.#state.forEach((word, index) => digestView.setUint32(index * 4, word, false))
    return digest
  }

  #compress(block: Uint8Array, offset: number): void {
    const view = new DataView(block.buffer, block.byteOffset + offset, 64)
    for (let index = 0; index < 16; index += 1) this.#schedule[index] = view.getUint32(index * 4, false)
    for (let index = 16; index < 64; index += 1) {
      const x = this.#schedule[index - 15]
      const y = this.#schedule[index - 2]
      const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3)
      const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10)
      this.#schedule[index] = (this.#schedule[index - 16] + sigma0 + this.#schedule[index - 7] + sigma1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = this.#state
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
      const choice = (e & f) ^ (~e & g)
      const temp1 = (h + sum1 + choice + ROUND[index] + this.#schedule[index]) >>> 0
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (sum0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    this.#state[0] = (this.#state[0] + a) >>> 0
    this.#state[1] = (this.#state[1] + b) >>> 0
    this.#state[2] = (this.#state[2] + c) >>> 0
    this.#state[3] = (this.#state[3] + d) >>> 0
    this.#state[4] = (this.#state[4] + e) >>> 0
    this.#state[5] = (this.#state[5] + f) >>> 0
    this.#state[6] = (this.#state[6] + g) >>> 0
    this.#state[7] = (this.#state[7] + h) >>> 0
  }
}

export function sha256HexBytesV1(value: ArrayBuffer | ArrayBufferView): string {
  const digest = new IncrementalSha256V1().update(value).digest()
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function sha256DigestV1(value: ArrayBuffer | ArrayBufferView): string {
  return `sha256:${sha256HexBytesV1(value)}`
}
