import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { ensurePackagedPresets, packagedPresetRoot } from '../lib/types/dsh-adapter/packaged-presets.js'

const workspace = new URL('..', import.meta.url)
const packagedRoot = join(fileURLToPath(workspace), 'presets')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-tui-presets-'))

try {
  assert.equal(packagedPresetRoot(), packagedRoot)
  const dshHome = join(temporary, 'home')
  // Every shipped preset is materialized (readdir order is the install order).
  const shipped = (await (await import('node:fs/promises')).readdir(packagedRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
  assert.deepEqual(ensurePackagedPresets({ dshHome, sourceRoot: packagedRoot }).map(row => row.id).sort(), shipped)
  assert.deepEqual(ensurePackagedPresets({ dshHome, sourceRoot: packagedRoot }).map(row => row.status), shipped.map(() => 'current'))

  for (const id of shipped) {
    const installed = await readFile(join(dshHome, '.agent-presets', id, 'agent.cordis.yml'), 'utf8')
    assert.deepEqual(parse(installed, { logLevel: 'silent' }),
      parse(await readFile(join(packagedRoot, id, 'agent.cordis.yml'), 'utf8'), { logLevel: 'silent' }),
      `${id} must install byte-identically`)
  }

  const conflictingHome = join(temporary, 'conflicting-home')
  const conflictingPreset = join(conflictingHome, '.agent-presets', 'liangshen')
  await mkdir(conflictingPreset, { recursive: true })
  await writeFile(join(conflictingPreset, 'keep.txt'), 'user-owned\n')
  assert.deepEqual(
    ensurePackagedPresets({ dshHome: conflictingHome, sourceRoot: packagedRoot })
      .filter(row => row.id === 'liangshen'),
    [{ id: 'liangshen', status: 'conflict' }])
  assert.equal(await readFile(join(conflictingPreset, 'keep.txt'), 'utf8'), 'user-owned\n')

  const nextRoot = join(temporary, 'next')
  await cp(packagedRoot, nextRoot, { recursive: true })
  const markerPath = join(nextRoot, 'liangshen', '.dsh-tui-managed.json')
  const marker = JSON.parse(await readFile(markerPath, 'utf8'))
  marker.revision = `${marker.revision}-test-update`
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`)
  assert.deepEqual(
    ensurePackagedPresets({ dshHome, sourceRoot: nextRoot })
      .filter(row => row.id === 'liangshen'),
    [{ id: 'liangshen', status: 'updated' }])
  assert.equal(JSON.parse(await readFile(join(dshHome, '.agent-presets', 'liangshen', '.dsh-tui-managed.json'), 'utf8')).revision, marker.revision)
} finally {
  await rm(temporary, { recursive: true, force: true })
}

console.log('packaged presets OK (install, discover, preserve conflict, update; every shipped preset)')
