// Runs the real scheduler/supervisor.pl against a temp HOME.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Job } from "../src/store.ts"

const root = mkdtempSync(join(tmpdir(), "scheduled-jobs-supervisor-"))
const home = join(root, "home")
const config = join(home, ".config", "opencode")
const supervisor = join(import.meta.dir, "..", "scheduler", "supervisor.pl")
const running = new Set<ChildProcess>()

beforeAll(() => {
  mkdirSync(home, { recursive: true })
  // Never let these tests touch the real ~/.config/opencode.
  if (!config.startsWith(root)) throw new Error(`Refusing to run: config resolves outside the temp HOME (${config})`)
})

afterAll(async () => {
  for (const proc of running) {
    const exited = new Promise((resolve) => proc.once("exit", resolve))
    try {
      proc.kill("SIGKILL")
      await exited
    } catch {}
  }
  for (const file of readdirSync(root).filter((name) => name.endsWith(".pid"))) {
    try {
      process.kill(-Number(readFileSync(join(root, file), "utf8")), "SIGKILL")
    } catch {}
  }
  rmSync(root, { recursive: true, force: true })
})

const scopeDir = (scopeId: string) => join(config, "scheduler", "scopes", scopeId)
const lockPath = (scopeId: string) => join(scopeDir(scopeId), "locks", "job.json")
const readJobFile = (scopeId: string) => JSON.parse(readFileSync(join(scopeDir(scopeId), "jobs", "job.json"), "utf8"))
// Raw JSONL, because readRuns() drops pid.
const lastRun = (scopeId: string) =>
  JSON.parse(readFileSync(join(scopeDir(scopeId), "runs", "job.jsonl"), "utf8").trim().split("\n").at(-1)!)

const base = (scopeId: string): Job => ({ scopeId, slug: "job", name: "Job", schedule: "0 9 * * *", workdir: home })

// The child writes its own PID ($$) to a file. The supervisor setsid()s the child,
// so that PID is also its process group ID. afterAll uses these files to kill
// leftovers, which matters before the fix, when no run record is written.
const pidFile = (scopeId: string) => join(root, `${scopeId}.pid`)
const sleeper = (scopeId: string, prefix = "") => ({
  command: "/bin/sh",
  args: ["-c", `${prefix}echo $$ > '${pidFile(scopeId)}'; exec sleep 30`],
})

function runSupervisor(job: Job): Promise<{ code: number | null; signal: string | null }> {
  const jobPath = join(scopeDir(job.scopeId), "jobs", `${job.slug}.json`)
  mkdirSync(join(scopeDir(job.scopeId), "jobs"), { recursive: true })
  writeFileSync(jobPath, JSON.stringify(job, null, 2))
  return new Promise((resolve, reject) => {
    const proc = spawn("/usr/bin/perl", [supervisor, jobPath], { env: { ...process.env, HOME: home }, stdio: "ignore" })
    running.add(proc)
    const deadline = setTimeout(() => {
      proc.kill("SIGKILL")
      reject(new Error("supervisor did not exit within 15s"))
    }, 15_000)
    proc.once("error", (err) => {
      clearTimeout(deadline)
      running.delete(proc)
      reject(err)
    })
    proc.once("exit", (code, signal) => {
      clearTimeout(deadline)
      running.delete(proc)
      resolve({ code, signal })
    })
  })
}

function expectGroupGone(pid: unknown) {
  expect(Number.isInteger(pid) && (pid as number) > 0).toBe(true)
  let code: string | undefined
  try {
    process.kill(-(pid as number), 0)
  } catch (err) {
    code = (err as NodeJS.ErrnoException).code
  }
  expect(code).toBe("ESRCH")
}

test("a timeout kills the job, not the supervisor", async () => {
  const result = await runSupervisor({ ...base("timeout-a"), timeoutSeconds: 1, invocation: sleeper("timeout-a") })
  expect(result.signal).toBeNull()
  expect(result.code).toBe(124)
  const run = lastRun("timeout-a")
  expect(run.status).toBe("failed")
  expect(run.error).toBe("timeout")
  expect(run.exitCode).toBe(124)
  expect(existsSync(lockPath("timeout-a"))).toBe(false)
  expect(readJobFile("timeout-a").lastRunStatus).toBe("failed")
  expect(readJobFile("timeout-a").lastRunError).toBe("timeout")
  expect(run.pid).toBe(Number(readFileSync(pidFile("timeout-a"), "utf8")))
  expectGroupGone(run.pid)
}, 20_000)

test("a child that ignores SIGTERM is killed after the grace period", async () => {
  const result = await runSupervisor({
    ...base("timeout-b"),
    timeoutSeconds: 1,
    invocation: sleeper("timeout-b", "trap '' TERM; "),
  })
  expect(result.code).toBe(124)
  const run = lastRun("timeout-b")
  expect(run.error).toBe("timeout")
  // TERM was ignored, so only the KILL after the 5s grace period ended it.
  expect(run.durationMs).toBeGreaterThanOrEqual(5500)
  expectGroupGone(run.pid)
}, 20_000)

test.each([
  ["fast-positive", 10],
  ["fast-zero", 0],
  ["fast-omitted", undefined],
] as const)("a run that finishes in time is unaffected (%s)", async (scopeId, timeoutSeconds) => {
  const job: Job = { ...base(scopeId), invocation: { command: "/usr/bin/true", args: [] } }
  if (timeoutSeconds !== undefined) job.timeoutSeconds = timeoutSeconds
  const result = await runSupervisor(job)
  expect(result.code).toBe(0)
  const run = lastRun(scopeId)
  expect(run.status).toBe("success")
  expect(run.exitCode).toBe(0)
  expect(run.error).toBeNull()
  expect(existsSync(lockPath(scopeId))).toBe(false)
}, 20_000)
