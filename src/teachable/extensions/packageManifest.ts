import type { OperatorJsonSchema } from '../operators/registry'

export interface EgoLensOperatorPackageManifest {
  readonly packageId: string
  readonly version: string
  readonly engineRange: string
  readonly integrity: string
  readonly operators: readonly {
    readonly name: string
    readonly majorVersion: number
    readonly inputContract: OperatorJsonSchema
    readonly paramsContract: OperatorJsonSchema
    readonly outputContract: OperatorJsonSchema
    readonly execution: 'worker'
  }[]
}
