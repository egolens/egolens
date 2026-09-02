/// <reference types="vite/client" />

declare const __EGOLENS_GIT_COMMIT__: string
declare const __EGOLENS_SOURCE_TREE_HASH__: string

interface Window {
  readonly __EGOLENS_BENCHMARK_MODE__?: boolean
  readonly __EGOLENS_BENCHMARK_HOLD__?: boolean
  readonly __EGOLENS_ORACLE_CAPTURE_REQUESTED__?: boolean
  readonly __EGOLENS_ADAPTER_AMNESIA_CAPTURE__?: boolean
  readonly __EGOLENS_EXPECTED_SOURCE_MANIFEST_HASH__?: string
  readonly __EGOLENS_PREFLIGHT_SCENE__?: string
  readonly __EGOLENS_PREFLIGHT_RECIPE__?: unknown
  readonly __EGOLENS_PREFLIGHT_PRESENTATION__?: import('./teachable/share/ShareDescriptor').ShareDescriptorV1['presentation']
  readonly __EGOLENS_AMNESIA_BUILD__?: Readonly<{
    runtimeId: 'egolens-adapter-amnesia-author-v1'
    commit: string
  }>
}
