// Job operations shared by the RPC handlers (GUI) and the agent tools.
import { existsSync, statSync } from "node:fs"
import * as Cron from "./cron.ts"
import * as Launchd from "./launchd.ts"
import type { CreateInput, ErrorType, JobView, RunView, UpdateInput } from "./rpc.ts"
import * as Store from "./store.ts"
import type { Job, JobEntry, RunSpec } from "./store.ts"

export class JobError extends Error {
  constructor(
    readonly type: ErrorType,
    message: string,
    readonly stderr?: string,
  ) {
    super(message)
  }
}

const STUCK_WITHOUT_TIMEOUT_MS = 24 * 60 * 60 * 1000
const STOP_GRACE_MS = 5_000
const SUPERVISOR_EXIT_MS = 10_000

function now() {
  return new Date().toISOString()
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

async function withLaunchd<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof Launchd.LaunchdError) throw new JobError("launchd_failed", error.message, error.stderr)
    throw error
  }
}

// Port of opencode-scheduler's buildOpencodeArgs. Only `prompt` and `title` are editable here; the other fields are
// carried over from jobs created by the old plugin.
export function buildInvocation(run: RunSpec, command: string) {
  const args = ["run"]
  if (run.attachUrl) args.push("--attach", run.attachUrl)
  if (run.port !== undefined) args.push("--port", String(run.port))
  if (run.command) args.push("--command", run.command)
  if (run.agent) args.push("--agent", run.agent)
  if (run.model) args.push("--model", run.model)
  if (run.variant) args.push("--variant", run.variant)
  if (run.runFormat) args.push("--format", run.runFormat)
  if (run.share) args.push("--share")
  if (run.title) args.push("--title", run.title)
  if (run.continue) args.push("--continue")
  if (run.session) args.push("--session", run.session)
  for (const file of run.files ?? []) args.push("--file", file)
  args.push("--", run.command ? (run.arguments ?? "") : (run.prompt ?? ""))
  return { command, args }
}

function promptOf(job: Job) {
  return job.run?.prompt ?? job.prompt ?? ""
}

async function view(entry: JobEntry, at = new Date()): Promise<JobView> {
  if (!entry.readable) {
    return {
      scopeId: entry.scopeId,
      slug: entry.slug,
      readable: false,
      error: entry.error,
      name: entry.slug,
      schedule: "",
      workdir: "",
      prompt: "",
      paused: false,
      running: false,
      stuck: false,
    }
  }
  const { job } = entry
  const lock = await Store.readLiveLock(job.scopeId, job.slug)
  const [latest] = await Store.readRuns(job.scopeId, job.slug, 1)
  const startedAt = lock?.startedAt ? new Date(lock.startedAt).getTime() : undefined
  const limit = job.timeoutSeconds && job.timeoutSeconds > 0 ? job.timeoutSeconds * 1000 : STUCK_WITHOUT_TIMEOUT_MS
  const paused = job.paused === true
  let nextRunAt: string | undefined
  try {
    nextRunAt = paused ? undefined : Cron.nextRuns(job.schedule, at, 1)[0]?.toISOString()
  } catch {
    nextRunAt = undefined
  }
  const lastRun = latest
    ? { status: latest.status, at: latest.startedAt, exitCode: latest.exitCode ?? undefined, error: latest.error ?? undefined }
    : job.lastRunStatus && job.lastRunStatus !== "running"
      ? { status: job.lastRunStatus, at: job.lastRunAt, exitCode: job.lastRunExitCode, error: job.lastRunError }
      : undefined
  return {
    scopeId: job.scopeId,
    slug: job.slug,
    readable: true,
    name: job.name,
    schedule: job.schedule,
    workdir: job.workdir,
    prompt: promptOf(job),
    title: job.run?.title,
    timeoutSeconds: job.timeoutSeconds,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    paused,
    running: lock !== undefined,
    runStartedAt: lock?.startedAt,
    stuck: startedAt !== undefined && !Number.isNaN(startedAt) && at.getTime() - startedAt > limit,
    nextRunAt,
    lastRun,
  }
}

export async function list(): Promise<JobView[]> {
  const at = new Date()
  return Promise.all((await Store.listJobs()).map((entry) => view(entry, at)))
}

async function load(scopeId: string, slug: string): Promise<Job> {
  if (!Store.SLUG_PATTERN.test(slug) || !/^[a-z0-9-]+$/.test(scopeId)) throw new JobError("not_found", `No job ${scopeId}/${slug}`)
  const job = await Store.readJob(scopeId, slug)
  if (!job) throw new JobError("not_found", `No job ${scopeId}/${slug}`)
  return job
}

export async function get(scopeId: string, slug: string): Promise<{ job: JobView; runs: RunView[]; logPath: string }> {
  const job = await load(scopeId, slug)
  return {
    job: await view({ scopeId, slug, readable: true, job }),
    runs: await Store.readRuns(scopeId, slug, 20),
    logPath: Store.paths.log(scopeId, slug),
  }
}

export async function log(scopeId: string, slug: string, lines = 200) {
  await load(scopeId, slug)
  return Store.tailLog(scopeId, slug, Math.min(Math.max(1, Math.floor(lines)), 2000))
}

function validateSchedule(schedule: string) {
  const error = Cron.validate(schedule)
  if (error) throw new JobError("invalid_cron", error)
}

function validateWorkdir(workdir: string) {
  if (!existsSync(workdir) || !statSync(workdir).isDirectory()) {
    throw new JobError("workdir_missing", `Working directory does not exist: ${workdir}`)
  }
}

function validateTimeout(timeoutSeconds: number | undefined) {
  if (timeoutSeconds !== undefined && (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0)) {
    throw new JobError("invalid_input", "timeoutSeconds must be a whole number of seconds, 0 for none")
  }
}

async function assertIdle(job: Job, action: string) {
  if (await Store.readLiveLock(job.scopeId, job.slug)) {
    throw new JobError("job_running", `Can't ${action} "${job.name}" while it is running. Stop the run first.`)
  }
}

export async function create(input: CreateInput): Promise<JobView> {
  const name = input.name.trim()
  const slug = Store.slugify(name)
  if (!Store.SLUG_PATTERN.test(slug)) {
    throw new JobError("invalid_input", "Name must contain letters or numbers, and be at most 64 characters as a slug")
  }
  if (!input.prompt.trim()) throw new JobError("invalid_input", "Prompt is required")
  validateSchedule(input.schedule)
  validateTimeout(input.timeoutSeconds)
  const workdir = Store.normalizeWorkdir(input.workdir)
  validateWorkdir(workdir)
  const scopeId = Store.deriveScopeId(workdir)
  if (await Store.readJob(scopeId, slug).catch(() => true)) {
    throw new JobError("slug_exists", `A job named "${slug}" already exists for ${workdir}`)
  }
  const title = input.title?.trim() || undefined
  const run: RunSpec = { prompt: input.prompt, ...(title ? { title } : {}) }
  const job: Job = {
    scopeId,
    slug,
    name,
    schedule: input.schedule.trim(),
    run,
    prompt: input.prompt,
    workdir,
    ...(input.timeoutSeconds ? { timeoutSeconds: input.timeoutSeconds } : {}),
    createdAt: now(),
    invocation: buildInvocation(run, Launchd.findOpencode()),
  }
  await Launchd.ensureSupervisor()
  await Store.ensureScopeDirs(scopeId)
  await Store.writeJob(job)
  try {
    await withLaunchd(async () => {
      await Launchd.writePlist(job)
      await Launchd.bootstrap(scopeId, slug)
    })
  } catch (error) {
    await Launchd.removePlist(scopeId, slug)
    await Store.removeJob(scopeId, slug)
    throw error
  }
  return view({ scopeId, slug, readable: true, job })
}

export async function update(input: UpdateInput): Promise<JobView> {
  const previous = await load(input.scopeId, input.slug)
  await assertIdle(previous, "edit")
  if (input.schedule !== undefined) validateSchedule(input.schedule)
  validateTimeout(input.timeoutSeconds)
  const workdir = input.workdir !== undefined ? Store.normalizeWorkdir(input.workdir) : previous.workdir
  if (input.workdir !== undefined) validateWorkdir(workdir)
  if (input.prompt !== undefined && !input.prompt.trim()) throw new JobError("invalid_input", "Prompt is required")

  const run: RunSpec = { ...previous.run, prompt: input.prompt ?? promptOf(previous) }
  if (input.title !== undefined) {
    const title = input.title.trim()
    if (title) run.title = title
    else delete run.title
  }
  const job: Job = {
    ...previous,
    name: input.name?.trim() || previous.name,
    schedule: input.schedule?.trim() ?? previous.schedule,
    workdir,
    prompt: run.prompt,
    run,
    updatedAt: now(),
    invocation: buildInvocation(run, previous.invocation?.command ?? Launchd.findOpencode()),
  }
  if (input.timeoutSeconds !== undefined) {
    if (input.timeoutSeconds > 0) job.timeoutSeconds = input.timeoutSeconds
    else delete job.timeoutSeconds
  }

  const reschedule = job.schedule !== previous.schedule || job.workdir !== previous.workdir
  await Store.writeJob(job)
  if (!reschedule || job.paused) {
    if (reschedule) await Launchd.writePlist(job)
    return view({ scopeId: job.scopeId, slug: job.slug, readable: true, job })
  }
  try {
    await withLaunchd(async () => {
      await Launchd.bootout(job.scopeId, job.slug)
      await Launchd.writePlist(job)
      await Launchd.bootstrap(job.scopeId, job.slug)
    })
  } catch (error) {
    await Store.writeJob(previous)
    await Launchd.writePlist(previous)
    await Launchd.bootstrap(previous.scopeId, previous.slug).catch(() => {})
    throw error
  }
  return view({ scopeId: job.scopeId, slug: job.slug, readable: true, job })
}

async function childPids(pid: number) {
  const result = await Launchd.exec("pgrep", ["-P", String(pid)])
  return result.stdout
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((child) => Number.isInteger(child) && child > 0)
}

async function waitFor(check: () => boolean | Promise<boolean>, ms: number) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(200)
  }
  return check()
}

function signal(pid: number, sig: NodeJS.Signals) {
  try {
    process.kill(pid, sig)
  } catch {
    // Already gone.
  }
}

// supervisor.pl starts the job with setsid, so the child leads its own process group. Signal the group the same way
// the supervisor's timeout does, then let the supervisor record the failed run and remove its lock.
export async function stop(scopeId: string, slug: string) {
  const job = await load(scopeId, slug)
  const lock = await Store.readLiveLock(scopeId, slug)
  if (!lock) throw new JobError("not_running", `"${job.name}" is not running`)
  const children = await childPids(lock.pid)
  for (const child of children) signal(-child, "SIGTERM")
  const exited = await waitFor(() => children.every((child) => !Store.pidAlive(child)), STOP_GRACE_MS)
  if (!exited) for (const child of children) signal(-child, "SIGKILL")
  if (children.length === 0) signal(lock.pid, "SIGTERM")

  const released = await waitFor(async () => !(await Store.readLiveLock(scopeId, slug)), SUPERVISOR_EXIT_MS)
  if (released) return
  signal(lock.pid, "SIGKILL")
  await waitFor(() => !Store.pidAlive(lock.pid), 2_000)
  await Store.removeLock(scopeId, slug)
  const latest = (await Store.readJob(scopeId, slug)) ?? job
  await Store.writeJob({ ...latest, lastRunStatus: "failed", lastRunError: "stopped", updatedAt: now() })
}

async function stopIfRunning(job: Job) {
  if (await Store.readLiveLock(job.scopeId, job.slug)) await stop(job.scopeId, job.slug)
}

export async function remove(scopeId: string, slug: string, options: { stop: boolean }) {
  const job = await load(scopeId, slug)
  if (!options.stop) await assertIdle(job, "delete")
  await stopIfRunning(job)
  await withLaunchd(() => Launchd.bootout(scopeId, slug))
  await Launchd.removePlist(scopeId, slug)
  await Store.removeJob(scopeId, slug)
}

export async function run(scopeId: string, slug: string) {
  const job = await load(scopeId, slug)
  if (job.paused) throw new JobError("job_paused", `"${job.name}" is paused. Resume it before running.`)
  await assertIdle(job, "start")
  if (!(await Launchd.isLoaded(scopeId, slug))) {
    throw new JobError("launchd_failed", `"${job.name}" is not loaded in launchd. Pause and resume it to reload.`)
  }
  await withLaunchd(() => Launchd.kickstart(scopeId, slug))
}

export async function pause(scopeId: string, slug: string, options: { stop: boolean }) {
  const job = await load(scopeId, slug)
  if (!options.stop) await assertIdle(job, "pause")
  await stopIfRunning(job)
  await withLaunchd(() => Launchd.bootout(scopeId, slug))
  const latest = (await Store.readJob(scopeId, slug)) ?? job
  await Store.writeJob({ ...latest, paused: true, updatedAt: now() })
}

export async function resume(scopeId: string, slug: string) {
  const job = await load(scopeId, slug)
  await Launchd.ensureSupervisor()
  if (!existsSync(Store.paths.plist(scopeId, slug))) await Launchd.writePlist(job)
  if (!(await Launchd.isLoaded(scopeId, slug))) await withLaunchd(() => Launchd.bootstrap(scopeId, slug))
  const { paused: _paused, ...rest } = job
  await Store.writeJob({ ...rest, updatedAt: now() })
}
