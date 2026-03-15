/**
 * Feather (Arrow IPC) file parser for browser.
 *
 * Uses `flechette` — a lightweight (~7KB) Arrow IPC reader optimized for
 * the browser. Argoverse 2 Feather files use LZ4 frame compression,
 * so we register lz4js as the decompression codec.
 */

import { tableFromIPC, setCompressionCodec } from '@uwdata/flechette'
import lz4 from 'lz4js'

// Register LZ4_FRAME codec (type id = 0 in flechette's CompressionType enum)
// AV2 Feather files are LZ4-compressed.
setCompressionCodec(0, {
  decode(buf: Uint8Array): Uint8Array {
    return lz4.decompress(buf)
  },
  encode(buf: Uint8Array): Uint8Array {
    return lz4.compress(buf)
  },
})

// Re-export for worker to register separately
export { setCompressionCodec }

/**
 * Read a .feather file and return rows as plain JS objects.
 * Accepts a File (reads via .arrayBuffer()) or a pre-fetched ArrayBuffer.
 * OK for small files (calibration). For large files use readFeatherColumns.
 */
export async function readFeatherFile(input: File | ArrayBuffer): Promise<Record<string, unknown>[]> {
  const buffer = input instanceof ArrayBuffer ? input : await input.arrayBuffer()
  return readFeatherBuffer(buffer)
}

/**
 * Read a .feather file from an ArrayBuffer → row objects.
 */
export function readFeatherBuffer(buffer: ArrayBuffer): Record<string, unknown>[] {
  const table = tableFromIPC(buffer, { useProxy: false, useBigInt: true })
  const names = table.schema.fields.map((f: { name: string }) => f.name)
  const numRows = table.numRows

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const arrays: any[] = names.map((name: string) => {
    const col = table.getChild(name)
    return col ? col.toArray() : []
  })

  const rows: Record<string, unknown>[] = new Array(numRows)
  for (let i = 0; i < numRows; i++) {
    const row: Record<string, unknown> = {}
    for (let j = 0; j < names.length; j++) {
      row[names[j]] = arrays[j][i]
    }
    rows[i] = row
  }

  return rows
}

/**
 * Read a .feather file and return named columns as flat arrays.
 * Accepts a File (reads via .arrayBuffer()) or a pre-fetched ArrayBuffer.
 * Much faster than readFeatherFile for large tables —
 * avoids creating per-row objects entirely.
 */
export async function readFeatherColumns(input: File | ArrayBuffer): Promise<{ columns: Record<string, unknown[]>; numRows: number }> {
  const buffer = input instanceof ArrayBuffer ? input : await input.arrayBuffer()
  const table = tableFromIPC(buffer, { useProxy: false, useBigInt: true })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const columns: Record<string, any> = {}
  for (const field of table.schema.fields) {
    const col = table.getChild(field.name)
    if (col) columns[field.name] = col.toArray()
  }
  return { columns, numRows: table.numRows }
}
