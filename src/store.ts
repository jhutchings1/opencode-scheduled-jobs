// Reads and writes the on-disk format shared with opencode-scheduler and supervisor.pl:
//   ~/.config/opencode/scheduler/scopes/<scopeId>/{jobs,runs,locks}/<slug>.{json,jsonl,json}
//   ~/.config/opencode/logs/scheduler/<scopeId>/<slug>.log
import { existsSync } from "node:fs"
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

export interface RunSpec {
  prompt?: string
  title?: string
  command?: string
  arguments?: string
  agent?: string
  model?: string
  variant?: string
  runFormat?: string
  share?: boolean
  continue?: boolean
  session?: string
  files?: string[]
  attachUrl?: string
  port?: number
}

export interface Job {
  scopeId: string
  slug: string
  name: string
  schedule: string
  workdir: string
  prompt?: string
  run?: RunSpec
  invocation?: { command: string; args: string[] }
  timeoutSeconds?: number
  paused?: boolean
  createdAt?: string
  updatedAt?: string
  lastRunAt?: string
  lastRunStatus?: string
  lastRunExitCode?: number
  lastRunError?: string
  lastRunSource?: string
  [key: string]: unknown
}

export interface Run {
  runId: string
  startedAt: string
  finishedAt: string
  durationMs: number
  status: string
  exitCode: number | null
  error: string | null
}

export interface Lock {
  pid: number
  startedAt?: string
}

export type JobEntry =
  | { scopeId: string; slug: string; readable: true; job: Job }
  | { scopeId: string; slug: string; readable: false; error: string }

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

// Read $HOME like supervisor.pl does. Bun's os.homedir() ignores later changes to HOME, which tests rely on.
export function home() {
  return process.env.HOME || homedir()
}

export const paths = {
  config: () => join(home(), ".config", "opencode"),
  scopes: () => join(paths.config(), "scheduler", "scopes"),
  supervisor: () => join(paths.config(), "scheduler", "supervisor.pl"),
  job: (scopeId: string, slug: string) => join(paths.scopes(), scopeId, "jobs", `${slug}.json`),
  runs: (scopeId: string, slug: string) => join(paths.scopes(), scopeId, "runs", `${slug}.jsonl`),
  lock: (scopeId: string, slug: string) => join(paths.scopes(), scopeId, "locks", `${slug}.json`),
  log: (scopeId: string, slug: string) => join(paths.config(), "logs", "scheduler", scopeId, `${slug}.log`),
  launchAgents: () => join(home(), "Library", "LaunchAgents"),
  label: (scopeId: string, slug: string) => `com.opencode.job.${scopeId}.${slug}`,
  plist: (scopeId: string, slug: string) => join(paths.launchAgents(), `${paths.label(scopeId, slug)}.plist`),
}

export function slugify(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

function fnv1a64Hex(input: string) {
  let hash = 0xcbf29ce484222325n
  for (const byte of Buffer.from(input, "utf8")) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, "0")
}

export function normalizeWorkdir(input: string) {
  const trimmed = input.trim()
  return trimmed ? resolve(trimmed) : home()
}

// Must match opencode-scheduler's deriveScopeId so existing scopes are reused.
export function deriveScopeId(workdir: string) {
  const normalized = normalizeWorkdir(workdir)
  return `${slugify(basename(normalized)) || "workspace"}-${fnv1a64Hex(normalized).slice(0, 12)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toJob(value: unknown): Job | string {
  if (!isRecord(value)) return "job file is not an object"
  const { scopeId, slug, name, schedule, workdir } = value
  if (typeof scopeId !== "string") return `job file is missing "scopeId"`
  if (typeof slug !== "string") return `job file is missing "slug"`
  if (typeof name !== "string") return `job file is missing "name"`
  if (typeof schedule !== "string") return `job file is missing "schedule"`
  // Unknown fields are kept so writes round-trip anything opencode-scheduler or supervisor.pl stored.
  return { ...value, scopeId, slug, name, schedule, workdir: typeof workdir === "string" ? workdir : home() }
}

export async function readJob(scopeId: string, slug: string): Promise<Job | undefined> {
  const file = paths.job(scopeId, slug)
  if (!existsSync(file)) return undefined
  const job = toJob(JSON.parse(await readFile(file, "utf8")))
  if (typeof job === "string") throw new Error(job)
  return job
}

async function listNames(dir: string) {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

export async function listJobs(): Promise<JobEntry[]> {
  const entries: JobEntry[] = []
  for (const scopeId of (await listNames(paths.scopes())).sort()) {
    const files = (await listNames(join(paths.scopes(), scopeId, "jobs"))).filter((file) => file.endsWith(".json"))
    for (const file of files.sort()) {
      const slug = file.slice(0, -".json".length)
      try {
        const job = toJob(JSON.parse(await readFile(paths.job(scopeId, slug), "utf8")))
        entries.push(typeof job === "string" ? { scopeId, slug, readable: false, error: job } : { scopeId, slug, readable: true, job })
      } catch (error) {
        entries.push({ scopeId, slug, readable: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  return entries
}

// Same approach as supervisor.pl: write a temp file in the same directory, then rename over the target.
export async function writeJob(job: Job) {
  const file = paths.job(job.scopeId, job.slug)
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${process.pid}`
  await writeFile(tmp, JSON.stringify(job))
  await rename(tmp, file)
}

export async function removeJob(scopeId: string, slug: string) {
  await unlink(paths.job(scopeId, slug)).catch(() => {})
}

export async function ensureScopeDirs(scopeId: string) {
  for (const sub of ["jobs", "runs", "locks"]) await mkdir(join(paths.scopes(), scopeId, sub), { recursive: true })
  await mkdir(dirname(paths.log(scopeId, "x")), { recursive: true })
}

export async function readRuns(scopeId: string, slug: string, limit: number): Promise<Run[]> {
  let raw: string
  try {
    raw = await readFile(paths.runs(scopeId, slug), "utf8")
  } catch {
    return []
  }
  const runs: Run[] = []
  for (const line of raw.split("\n").reverse()) {
    if (runs.length >= limit) break
    if (!line.trim()) continue
    try {
      const value: unknown = JSON.parse(line)
      if (!isRecord(value) || typeof value.status !== "string" || typeof value.startedAt !== "string") continue
      runs.push({
        runId: String(value.runId ?? ""),
        startedAt: value.startedAt,
        finishedAt: String(value.finishedAt ?? ""),
        durationMs: Number(value.durationMs ?? 0),
        status: value.status,
        exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
        error: typeof value.error === "string" ? value.error : null,
      })
    } catch {
      // A corrupt line must not hide the rest of the history.
    }
  }
  return runs
}

export function pidAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return isRecord(error) && error.code === "EPERM"
  }
}

// Returns the lock only while its supervisor is alive. Stale locks are left for supervisor.pl to clean up.
export async function readLiveLock(scopeId: string, slug: string): Promise<Lock | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(paths.lock(scopeId, slug), "utf8"))
    if (!isRecord(value) || typeof value.pid !== "number" || !pidAlive(value.pid)) return undefined
    return { pid: value.pid, startedAt: typeof value.startedAt === "string" ? value.startedAt : undefined }
  } catch {
    return undefined
  }
}

export async function removeLock(scopeId: string, slug: string) {
  await unlink(paths.lock(scopeId, slug)).catch(() => {})
}

const LOG_TAIL_BYTES = 256 * 1024

export async function tailLog(scopeId: string, slug: string, lines: number): Promise<string> {
  const file = paths.log(scopeId, slug)
  let size: number
  try {
    size = (await stat(file)).size
  } catch {
    return ""
  }
  const start = Math.max(0, size - LOG_TAIL_BYTES)
  const handle = await open(file, "r")
  try {
    const buffer = Buffer.alloc(size - start)
    await handle.read(buffer, 0, buffer.length, start)
    const text = buffer.toString("utf8")
    return text.split("\n").slice(-lines).join("\n")
  } finally {
    await handle.close()
  }
}
