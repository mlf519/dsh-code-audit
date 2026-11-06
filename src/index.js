import { resolve } from 'node:path'
import { createApiHandler } from './api.js'
import { registerAuditCommand } from './commands.js'
import { invalidateDshSkills, syncSkillToDsh } from './dshskills.js'
import { AuditRunner } from './runner.js'
import { AuditScheduler } from './scheduler.js'
import { AuditStore } from './store.js'
import { registerAuditTools } from './tools.js'
import { defaultDataDir } from './util.js'

export const name = 'code-audit'

/**
 * dsh-code-audit — code audit task manager for DeepSeek Harness.
 *
 * Storage: plugin-owned SQLite (tasks, findings, prompts, runs, settings) plus
 * native DSH trajectory JSONL files for every audit run. The web console is
 * served by the host webServer at /dsh-code-audit/.
 */
export function apply(ctx, config = {}) {
  const dataDir = resolve(String(config.dataDir ?? '').trim() || defaultDataDir())
  const log = message => console.warn(`[dsh-code-audit] ${message}`)

  const store = new AuditStore(dataDir)

  // Keep the user-level DSH skill catalog in sync so existing audit skills
  // are available as `/skill-name` outside the plugin console as well.
  for (const skill of store.listSkills()) {
    try {
      syncSkillToDsh(skill, { log })
    } catch (error) {
      log(`同步 Skill 到 DSH 失败：${error?.message ?? error}`)
    }
  }

  ctx.effect(() => () => {
    scheduler.stop()
    runner.dispose()
    store.close()
  })

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    runner.onSessionEvent(session, event)
  }))

  // Models come from the client's configured LLM providers, so the task form
  // can offer the same selection as the rest of DSH.
  let modelsCache = null
  let modelsCacheAt = 0
  // Models may be configured but not yet registered with an adapter (for
  // example while a provider has no credential). Read the client's settings
  // section as the authoritative catalog and merge adapter discovery on top.
  const modelsFromSettings = () => {
    const settings = ctx.get?.('settings') ?? ctx.settings
    let section
    try {
      section = settings?.get?.('llm-pi-ai')
      if (!section && settings?.describe) {
        // DSH 0.2.x exposes config through describe() rather than get(ns).
        section = settings.describe({ redactSecrets: true }).find(row => row.ns === 'llm-pi-ai')?.value
      }
    } catch {
      section = undefined
    }
    const providers = section?.providers
    const result = []
    if (!providers || typeof providers !== 'object') return result
    for (const [provider, profile] of Object.entries(providers)) {
      const list = Array.isArray(profile?.models) ? profile.models : []
      for (const model of list) {
        if (!model?.id) continue
        result.push({
          provider,
          providerName: profile?.displayName || provider,
          id: model.id,
          name: model.name || model.id,
        })
      }
    }
    return result
  }

  const listModels = async () => {
    if (modelsCache && Date.now() - modelsCacheAt < 30_000) return modelsCache
    const merged = new Map()
    const add = model => {
      if (!model?.provider || !model?.id) return
      const key = `${model.provider}/${model.id}`
      if (!merged.has(key)) merged.set(key, model)
    }
    for (const model of modelsFromSettings()) add(model)
    const llm = ctx.get?.('llm') ?? ctx.llm
    if (llm?.listProviders) {
      for (const provider of llm.listProviders()) {
        try {
          const models = await llm.listModels(provider.id)
          for (const model of models) {
            add({
              provider: provider.id,
              providerName: provider.name || provider.id,
              id: model.id,
              name: model.name || model.id,
            })
          }
        } catch (error) {
          add({
            provider: provider.id,
            providerName: provider.name || provider.id,
            id: '',
            name: '',
            error: String(error?.message ?? error),
          })
        }
      }
    }
    modelsCache = [...merged.values()]
    modelsCacheAt = Date.now()
    return modelsCache
  }

  // Audit sessions must carry a provider/model; otherwise the host system
  // prompt cannot resolve variables such as {{model}}. Prefer the same default
  // selection normal client sessions use, then fall back to the configured
  // provider catalog.
  const resolveDefaultModel = () => {
    try {
      const service = ctx.get?.('agentDefaultModel') ?? ctx.agentDefaultModel
      const selection = service?.currentSelection?.()
      if (selection?.provider && selection?.model) return selection
    } catch {
      // fall through to configured providers
    }
    const models = modelsFromSettings()
    if (models.length) return { provider: models[0].provider, model: models[0].id }
    return null
  }

  const runner = new AuditRunner({ ctx, store, dataDir, config, resolveDefaultModel })
  const scheduler = new AuditScheduler({
    store,
    runner,
    intervalMs: Number(config.schedulerIntervalMs) || 30_000,
    log,
  })

  // The web console binds to the host webServer once that service is available;
  // profiles without a Web surface simply never run this callback.
  // Mutating `~/.dsh/skills` from this plugin must refresh DSH's skill catalog,
  // otherwise a deleted skill keeps showing up as a dead `/skill-name` entry.
  const invalidateSkills = () => invalidateDshSkills(ctx)

  const handler = createApiHandler({ store, runner, scheduler, dataDir, listModels, invalidateSkills })
  ctx.inject(['webServer'], webCtx => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/dsh-code-audit',
      handler,
    }))
  })

  registerAuditTools(ctx, { store, runner, dataDir, config, log }).catch(error => {
    log(`Agent 工具注册失败：${error?.message ?? error}`)
  })
  registerAuditCommand(ctx, { store, runner, dataDir, log })

  if (config.autoStartScheduler !== false) scheduler.start()
}
