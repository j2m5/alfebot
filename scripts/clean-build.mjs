import { existsSync, realpathSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)))
const output = resolve(root, 'dist')
if (dirname(output) !== root || (existsSync(output) && realpathSync(output) !== output)) {
    throw new Error('Build output must be the dist directory inside this project')
}
rmSync(output, { recursive: true, force: true })
