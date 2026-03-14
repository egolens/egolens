declare module 'lz4js' {
  export function decompress(src: Uint8Array, maxSize?: number): Uint8Array
  export function compress(src: Uint8Array, maxSize?: number): Uint8Array
}
