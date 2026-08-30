export type NumericExpressionV1 =
  | { readonly input: string }
  | { readonly constant: number }
  | { readonly negate: NumericExpressionV1 }
  | { readonly add: readonly [NumericExpressionV1, NumericExpressionV1] }
  | { readonly subtract: readonly [NumericExpressionV1, NumericExpressionV1] }
  | { readonly multiply: readonly [NumericExpressionV1, NumericExpressionV1] }
  | { readonly divide: readonly [NumericExpressionV1, NumericExpressionV1] }
  | { readonly clamp: { readonly value: NumericExpressionV1; readonly min: number; readonly max: number } }

export interface BoundedVectorExpressionV1 {
  readonly components: readonly NumericExpressionV1[]
  readonly scale?: number
}

export const EXPRESSION_LIMITS_V1 = {
  maxDepth: 12,
  maxNodes: 64,
  maxComponents: 16,
} as const

export function countExpressionNodes(expression: NumericExpressionV1, depth = 1): { nodes: number; depth: number } {
  if ('input' in expression || 'constant' in expression) return { nodes: 1, depth }
  if ('negate' in expression) {
    const child = countExpressionNodes(expression.negate, depth + 1)
    return { nodes: child.nodes + 1, depth: child.depth }
  }
  if ('clamp' in expression) {
    const child = countExpressionNodes(expression.clamp.value, depth + 1)
    return { nodes: child.nodes + 1, depth: child.depth }
  }
  const children = 'add' in expression
    ? expression.add
    : 'subtract' in expression
      ? expression.subtract
      : 'multiply' in expression
        ? expression.multiply
        : expression.divide
  const left = countExpressionNodes(children[0], depth + 1)
  const right = countExpressionNodes(children[1], depth + 1)
  return { nodes: left.nodes + right.nodes + 1, depth: Math.max(left.depth, right.depth) }
}
