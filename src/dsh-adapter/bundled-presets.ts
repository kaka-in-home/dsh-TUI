import type { Context } from '@deepseek-ai/cordis'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { packagedPresetRoot } from './packaged-presets.js'

interface DeclarativePresets {
  register(definition: PresetDefinition): Promise<() => Promise<void>>
}

interface PresetLoader {
  entries(): Iterable<{ disabled: boolean; options: { name?: string; config?: unknown } }>
}

function declarativePresets(ctx: Context): DeclarativePresets | undefined {
  const service: unknown = ctx.get('agentPresets')
  return service !== null && typeof service === 'object'
    && 'register' in service && typeof service.register === 'function'
    ? service as DeclarativePresets
    : undefined
}

/** Preserve the Loader's expressions; only the owning plugin may evaluate them. */
function readPresetPatch(path: string): PresetDefinition {
  const patches: unknown = parse(readFileSync(path, 'utf8'), {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }],
  })
  if (Array.isArray(patches) && patches.length === 1) {
    const row = patches[0]?.insert?.[0]
    if (row?.name === '@deepseek-ai/dsh-agent-preset'
      && typeof row.config?.id === 'string' && Array.isArray(row.config.plugins)) {
      return row.config as PresetDefinition
    }
  }
  throw new Error(`dsh-tui: invalid upstream preset declaration: ${path}`)
}

/**
 * The preset ids this package registers into the official declarative roster.
 *
 * `liangshen` is the shipped experimental preset. Each entry is registered only
 * when no enabled loader row already declares the same id, so a profile or
 * another bundle that owns the seat wins.
 *
 * Agent Teams is deliberately NOT here. The official composition for it is a
 * PROFILE LAYER (`@deepseek-ai/dsh-experimental-agent-team-profile`), which
 * inserts the kernel and its tools at the composition root; a second, TUI-owned
 * preset would have to re-derive that decision and could drift from the official
 * one. This plugin only reads the team state the official layer produces.
 */
const BUNDLED_PRESETS = ['liangshen'] as const

/**
 * 0.1.7 removed directory discovery. Consume the official bundle definitions
 * through its registry, without copying or reimplementing their tool sets.
 * Web/profile declarations own their seats even while still activating.
 * Returns false on the legacy directory-backed roster or while absent. An
 * absent service is watched through Cordis so a late registry is not missed.
 */
export async function registerBundledPresets(ctx: Context): Promise<boolean> {
  if (ctx.get('agentPresets') === undefined) {
    ctx.inject(['agentPresets'], async (ready) => {
      await registerBundledPresets(ready)
    })
    return false
  }
  if (declarativePresets(ctx) === undefined) return false
  const declared = new Set<string>()
  const loader = ctx.get('loader') as PresetLoader | undefined
  for (const entry of loader?.entries() ?? []) {
    if (entry.disabled || entry.options.name !== '@deepseek-ai/dsh-agent-preset') continue
    const config: unknown = entry.options.config
    if (config !== null && typeof config === 'object' && 'id' in config && typeof config.id === 'string') {
      declared.add(config.id)
    }
  }
  const require = createRequire(ctx.baseUrl ?? import.meta.url)
  for (const id of ['standard', 'ptc', 'minimal', 'cordis']) {
    if (declared.has(id)) continue
    const path = require.resolve(`@deepseek-ai/dsh-web-app/presets/${id}.patch.yml`)
    const owner = ctx.extend({ baseUrl: pathToFileURL(path).href })
    const dispose = await declarativePresets(owner)!.register(readPresetPatch(path))
    ctx.effect(() => dispose)
  }
  for (const id of BUNDLED_PRESETS) {
    if (declared.has(id)) continue
    const root = join(packagedPresetRoot(), id)
    const metadata: Pick<PresetDefinition, 'name' | 'description' | 'order'> = parse(readFileSync(join(root, 'preset.yml'), 'utf8'))
    const dispose = await declarativePresets(ctx)!.register({
      id,
      name: metadata.name,
      description: metadata.description,
      order: metadata.order,
      plugins: [{
        id: `${id}-plugins`,
        name: '@deepseek-ai/cordis-plugin-include',
        config: { path: pathToFileURL(join(root, 'agent.cordis.yml')).href },
      }],
    })
    ctx.effect(() => dispose)
  }
  return true
}
