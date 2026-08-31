import type { CompiledRecipeV1 } from '../recipe/compiler'
import type { RecipeSourceV1 } from '../recipe/types'

function escapeRegexCharacter(character: string): string {
  return character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&')
}

/** Compile the recipe's bounded glob dialect. A recursive directory wildcard may match zero directories. */
export function sourceGlobRegexV1(glob: string): RegExp {
  let pattern = '^'
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]
    if (character === '*' && glob[index + 1] === '*') {
      if (glob[index + 2] === '/') {
        pattern += '(?:.*/)?'
        index += 2
      } else {
        pattern += '.*'
        index += 1
      }
    } else if (character === '*') pattern += '[^/]*'
    else if (character === '?') pattern += '[^/]'
    else pattern += escapeRegexCharacter(character)
  }
  return new RegExp(`${pattern}$`, 'u')
}

function selectorPatterns(
  compiledRecipe: CompiledRecipeV1,
  selector: string,
): readonly string[] {
  if (!selector.includes('{versionRoot}')) return [selector]
  const policy = compiledRecipe.recipe.match.versionRoot
  if (!policy) return []
  return policy.candidates.map((candidate) => selector.replaceAll('{versionRoot}', candidate))
}

export function sourceSelectorMatchesV1(
  compiledRecipe: CompiledRecipeV1,
  source: RecipeSourceV1,
  path: string,
): boolean {
  if (source.files.exact) {
    return selectorPatterns(compiledRecipe, source.files.exact).some((candidate) => candidate === path)
  }
  if (!source.files.glob) return false
  return selectorPatterns(compiledRecipe, source.files.glob)
    .some((candidate) => sourceGlobRegexV1(candidate).test(path))
}
