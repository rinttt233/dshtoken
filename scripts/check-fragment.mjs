// Parse-checks one client fragment without running it: node scripts/check-fragment.mjs src/client/chart.js
//
// Fragments are a function body sharing one factory scope, so `node --check` on the
// file alone is not enough; wrapping it in a function body validates the same thing
// the build does.

import { readFile } from 'node:fs/promises'

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/check-fragment.mjs <file>')
  process.exitCode = 2
} else {
  try {
    const body = await readFile(file, 'utf8')
    new Function(body)
    console.log(`✓ syntax ok: ${file}`)
  } catch (error) {
    console.error(`✗ syntax error in ${file}:`, error && error.message)
    process.exitCode = 1
  }
}
