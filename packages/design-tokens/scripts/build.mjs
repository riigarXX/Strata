import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildCss, buildJson, buildTypes, loadTokens, root } from './lib.mjs'

const distDir = join(root, 'dist')
const generatedTypesFile = join(root, 'src', 'tokens.generated.ts')

async function main() {
  const model = await loadTokens()
  await mkdir(distDir, { recursive: true })
  await writeFile(join(distDir, 'tokens.css'), buildCss(model))
  await writeFile(join(distDir, 'tokens.json'), buildJson(model))
  await writeFile(generatedTypesFile, buildTypes(model))
  console.log(
    `design-tokens: ${model.variableCount} tokens -> dist/tokens.css, dist/tokens.json, src/tokens.generated.ts`,
  )
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
