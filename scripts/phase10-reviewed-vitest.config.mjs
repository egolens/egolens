export default {
  server: { host: '127.0.0.1' },
  test: {
    pool: 'threads',
    teardownTimeout: 10_000,
    // The WebGPU consistency tests probe a native GPU adapter through a
    // re-executed Node child, which the deny-default reviewed test profile
    // forbids; they would otherwise register as silently skipped tests and
    // the gate requires zero pending tests.
    exclude: ['**/rangeImageBenchmark*', '**/rangeImageGpu*', '**/node_modules/**'],
  },
}
