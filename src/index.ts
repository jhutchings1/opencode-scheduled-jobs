import { watch, type FSWatcher } from "node:fs"
import { mkdir } from "node:fs/promises"
import { Plugin } from "@opencode/plugin"
import * as Jobs from "./jobs.ts"
import { ScheduledJobs } from "./rpc.ts"
import { paths } from "./store.ts"
import { registerTools } from "./tools.ts"

// One watcher per process, shared by every location's plugin instance. Only the first instance's emitter fires, so
// the GUI does not get one event per loaded location.
// RPC output must be a JSON value; optional fields left as `undefined` fail the server's response encoding.
function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

const emitters: Array<() => void> = []
let watcher: FSWatcher | undefined
let debounce: ReturnType<typeof setTimeout> | undefined

async function startWatcher() {
  if (watcher) return
  await mkdir(paths.scopes(), { recursive: true })
  if (watcher) return
  watcher = watch(paths.scopes(), { recursive: true }, () => {
    clearTimeout(debounce)
    debounce = setTimeout(() => emitters[0]?.(), 250)
  })
  watcher.on("error", (error) => {
    console.error("[scheduled-jobs] watcher failed; the GUI falls back to polling", error)
    watcher?.close()
    watcher = undefined
  })
}

function stopWatcherIfUnused() {
  if (emitters.length > 0) return
  clearTimeout(debounce)
  watcher?.close()
  watcher = undefined
}

export default Plugin.define({
  id: "scheduled-jobs",
  async setup(ctx) {
    if (process.platform !== "darwin") return

    const registration = await ctx.rpc.register(ScheduledJobs, {
      list: async () => json({ jobs: await Jobs.list() }),
      get: (input, context) => wrap(context, () => Jobs.get(input.scopeId, input.slug)),
      log: (input, context) => wrap(context, async () => ({ text: await Jobs.log(input.scopeId, input.slug, input.lines) })),
      create: (input, context) => wrap(context, async () => ({ job: await Jobs.create(input) })),
      update: (input, context) => wrap(context, async () => ({ job: await Jobs.update(input) })),
      remove: (input, context) => wrap(context, () => ok(Jobs.remove(input.scopeId, input.slug, { stop: true }))),
      run: (input, context) => wrap(context, () => ok(Jobs.run(input.scopeId, input.slug))),
      stop: (input, context) => wrap(context, () => ok(Jobs.stop(input.scopeId, input.slug))),
      pause: (input, context) => wrap(context, () => ok(Jobs.pause(input.scopeId, input.slug, { stop: true }))),
      resume: (input, context) => wrap(context, () => ok(Jobs.resume(input.scopeId, input.slug))),
    })

    async function ok(work: Promise<void>) {
      await work
      return { ok: true }
    }

    // Expected failures become declared RPC errors so the GUI can show their message; anything else is internal.
    async function wrap<T, E>(
      context: { error: (type: Jobs.JobError["type"], message: string, data: { stderr?: string }) => E },
      work: () => Promise<T>,
    ): Promise<T | E> {
      try {
        return json(await work())
      } catch (error) {
        if (error instanceof Jobs.JobError) return context.error(error.type, error.message, error.stderr === undefined ? {} : { stderr: error.stderr })
        throw error
      }
    }

    const emit = () => void registration.events.emit("changed", {}).catch(() => {})
    emitters.push(emit)
    await startWatcher().catch((error: unknown) => console.error("[scheduled-jobs] could not watch jobs", error))

    const tools = await registerTools(ctx)

    return async () => {
      emitters.splice(emitters.indexOf(emit), 1)
      stopWatcherIfUnused()
      await tools.dispose()
      await registration.dispose()
    }
  },
})
