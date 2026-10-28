import { createSignal, onCleanup } from "solid-js"
import type { Context } from "@opencode/plugin/gui"
import { ScheduledJobs, type JobView } from "../rpc.ts"

const POLL_MS = 30_000

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message
  return String(error)
}

export type JobsState = ReturnType<typeof createJobsState>

// One job list per window, shared by the panel, the settings page and the titlebar pill.
export function createJobsState(ctx: Context) {
  const [jobs, setJobs] = createSignal<readonly JobView[]>([])
  const [loaded, setLoaded] = createSignal(false)
  const [unreachable, setUnreachable] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  let pending: Promise<void> | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined

  // ctx.client changes when the server restarts, so read it on every call.
  const rpc = () => ctx.client.rpc(ScheduledJobs)

  const refresh = () => {
    pending ??= rpc()
      .list({})
      .then((result) => {
        setJobs(result.jobs)
        setUnreachable(false)
      })
      .catch(() => {
        setUnreachable(true)
      })
      .finally(() => {
        pending = undefined
        setLoaded(true)
        setNow(Date.now())
      })
    return pending
  }

  const scheduleRefresh = () => {
    clearTimeout(debounce)
    debounce = setTimeout(() => void refresh(), 150)
  }

  let unsubscribe = () => {}
  let subscribed: unknown
  const subscribe = () => {
    if (subscribed === ctx.client) return
    subscribed = ctx.client
    unsubscribe()
    try {
      unsubscribe = rpc().events.on("changed", scheduleRefresh, { signal: ctx.signal })
    } catch {
      unsubscribe = () => {}
    }
  }

  // Events are the fast path. Polling covers missed events, a dead watcher and server restarts.
  subscribe()
  void refresh()
  const poll = setInterval(() => {
    subscribe()
    void refresh()
  }, POLL_MS)
  onCleanup(() => {
    clearInterval(poll)
    clearTimeout(debounce)
    unsubscribe()
  })

  return {
    jobs,
    loaded,
    unreachable,
    now,
    refresh,
    rpc,
    running: () => jobs().filter((job) => job.running).length,
    failed: () => jobs().filter((job) => !job.running && job.lastRun && job.lastRun.status !== "success").length,
  }
}
