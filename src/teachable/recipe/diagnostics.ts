export type AdapterDiagnosticStage =
  | 'parse'
  | 'schema'
  | 'compile'
  | 'bind'
  | 'sample'
  | 'cross-output'
  | 'human'

export interface AdapterDiagnostic {
  readonly stage: AdapterDiagnosticStage
  readonly severity: 'error' | 'warning' | 'info'
  readonly code: string
  readonly jsonPointer?: string
  readonly source?: string
  readonly expected?: unknown
  readonly got?: unknown
  readonly hint: string
}

export class AdapterValidationError extends Error {
  readonly name = 'AdapterValidationError'
  readonly diagnostics: readonly AdapterDiagnostic[]

  constructor(diagnostics: readonly AdapterDiagnostic[]) {
    super(diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.hint}`).join('\n'))
    this.diagnostics = diagnostics
  }
}

export class AdapterCompileError extends Error {
  readonly name = 'AdapterCompileError'
  readonly diagnostics: readonly AdapterDiagnostic[]

  constructor(diagnostics: readonly AdapterDiagnostic[]) {
    super(diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.hint}`).join('\n'))
    this.diagnostics = diagnostics
  }
}
