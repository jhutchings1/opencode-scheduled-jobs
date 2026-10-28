// Integration tests against a temp HOME, with a stub `launchctl` on PATH that records calls and tracks loaded labels.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Jobs from "../src/jobs.ts"
import { paths, readJob, readRuns } from "../src/store.ts"

const root = mkdtempSync(join(tmpdir(), "scheduled-jobs-"))
const home = join(root, "home")
const bin = join(root, "bin")
const state = join(root, "launchd")
const calls = join(root, "calls.log")
const workdir = join(home, "project")
const saved = { HOME: process.env.HOME, PATH: process.env.PATH }

const STUB = `#!/bin/sh
echo "$@" >> "${calls}"
label() { echo "$1" | sed 's#^gui/[0-9]*/##'; }
case "$1" in
  bootstrap)
    [ -n "$LAUNCHCTL_FAIL" ] && { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }
    touch "${state}/$(basename "$3" .plist)" ;;
  bootout) [ -f "${state}/$(label "$2")" ] || exit 3; : > /dev/null; mv "${state}/$(label "$2")" "${state}/.gone" ;;
  print|kickstart) [ -f "${state}/$(label "$2")" ] || exit 113 ;;
esac
`

function launchctlCalls() {
  return existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []
}

beforeAll(() => {
  for (const dir of [home, bin, state, workdir]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(bin, "launchctl"), STUB)
  chmodSync(join(bin, "launchctl"), 0o755)
  process.env.HOME = home
  process.env.PATH = `${bin}:${saved.PATH}`
  process.env.OPENCODE_SCHEDULER_OPENCODE_PATH = "/usr/local/bin/opencode"
  // Never let these tests touch the real ~/.config/opencode or ~/Library/LaunchAgents.
  if (!paths.config().startsWith(root) || !paths.launchAgents().startsWith(root)) {
    throw new Error(`Refusing to run: paths resolve outside the temp HOME (${paths.config()})`)
  }
})

afterAll(() => {
  process.env.HOME = saved.HOME
  process.env.PATH = saved.PATH
})

beforeEach(() => {
  writeFileSync(calls, "")
  delete process.env.LAUNCHCTL_FAIL
})

const input = { name: "Daily Report", workdir, schedule: "0 9 * * 1-5", prompt: "Write the report" }

describe("job lifecycle", () => {
  let scopeId = ""

  test("create writes the job, plist and supervisor, and bootstraps", async () => {
    const job = await Jobs.create(input)
    scopeId = job.scopeId
    expect(job.slug).toBe("daily-report")
    expect(job.nextRunAt).toBeDefined()
    expect(existsSync(paths.supervisor())).toBe(true)
    expect(readFileSync(paths.plist(scopeId, "daily-report"), "utf8")).toContain("<key>Weekday</key>")
    const stored = await readJob(scopeId, "daily-report")
    expect(stored?.invocation).toEqual({ command: "/usr/local/bin/opencode", args: ["run", "--", "Write the report"] })
    expect(launchctlCalls()).toEqual([expect.stringMatching(/^bootstrap gui\/\d+ .*daily-report\.plist$/)])
  })

  test("create rejects duplicates, bad cron and missing workdirs", async () => {
    await expect(Jobs.create(input)).rejects.toMatchObject({ type: "slug_exists" })
    await expect(Jobs.create({ ...input, name: "x", schedule: "nope" })).rejects.toMatchObject({ type: "invalid_cron" })
    await expect(Jobs.create({ ...input, name: "y", workdir: join(root, "missing") })).rejects.toMatchObject({ type: "workdir_missing" })
  })

  test("create rolls back when launchd fails", async () => {
    process.env.LAUNCHCTL_FAIL = "1"
    await expect(Jobs.create({ ...input, name: "Broken" })).rejects.toMatchObject({ type: "launchd_failed", stderr: expect.stringContaining("Bootstrap failed") })
    expect(existsSync(paths.job(scopeId, "broken"))).toBe(false)
    expect(existsSync(paths.plist(scopeId, "broken"))).toBe(false)
  })

  test("update keeps run metadata, sets the title and reloads on schedule change", async () => {
    const before = await readJob(scopeId, "daily-report")
    writeFileSync(paths.job(scopeId, "daily-report"), JSON.stringify({ ...before, lastRunStatus: "success", lastRunExitCode: 0 }))
    const job = await Jobs.update({ scopeId, slug: "daily-report", schedule: "0 10 * * *", title: "Report" })
    expect(job.schedule).toBe("0 10 * * *")
    const stored = await readJob(scopeId, "daily-report")
    expect(stored).toMatchObject({ lastRunStatus: "success", createdAt: before?.createdAt })
    expect(stored?.invocation?.args).toEqual(["run", "--title", "Report", "--", "Write the report"])
    expect(launchctlCalls().map((line) => line.split(" ")[0])).toEqual(["print", "bootout", "bootstrap"])
  })

  test("update restores the previous job when launchd fails", async () => {
    process.env.LAUNCHCTL_FAIL = "1"
    await expect(Jobs.update({ scopeId, slug: "daily-report", schedule: "0 11 * * *" })).rejects.toMatchObject({ type: "launchd_failed" })
    expect((await readJob(scopeId, "daily-report"))?.schedule).toBe("0 10 * * *")
    expect(readFileSync(paths.plist(scopeId, "daily-report"), "utf8")).toContain("<integer>10</integer>")
  })

  test("pause boots out and resume bootstraps", async () => {
    // The rollback in the previous test could not reload the agent either, since launchctl was still failing.
    await Jobs.resume(scopeId, "daily-report")
    writeFileSync(calls, "")
    await Jobs.pause(scopeId, "daily-report", { stop: false })
    expect((await Jobs.get(scopeId, "daily-report")).job).toMatchObject({ paused: true, nextRunAt: undefined })
    await expect(Jobs.run(scopeId, "daily-report")).rejects.toMatchObject({ type: "job_paused" })
    await Jobs.resume(scopeId, "daily-report")
    expect((await readJob(scopeId, "daily-report"))?.paused).toBeUndefined()
    expect(launchctlCalls().map((line) => line.split(" ")[0])).toEqual(["print", "bootout", "print", "bootstrap"])
  })

  test("run kickstarts the agent", async () => {
    await Jobs.run(scopeId, "daily-report")
    expect(launchctlCalls().at(-1)).toMatch(/^kickstart gui\/\d+\/com\.opencode\.job\..*\.daily-report$/)
  })

  test("running jobs reject edits; remove keeps history", async () => {
    copyFileSync(join(import.meta.dir, "fixtures", "daily-summary.jsonl"), paths.runs(scopeId, "daily-report"))
    writeFileSync(paths.lock(scopeId, "daily-report"), JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }))
    const listed = (await Jobs.list()).find((job) => job.slug === "daily-report")
    expect(listed).toMatchObject({ running: true, stuck: true, lastRun: { status: "success" } })
    await expect(Jobs.update({ scopeId, slug: "daily-report", prompt: "x" })).rejects.toMatchObject({ type: "job_running" })
    await expect(Jobs.remove(scopeId, "daily-report", { stop: false })).rejects.toMatchObject({ type: "job_running" })
    writeFileSync(paths.lock(scopeId, "daily-report"), JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }))
    expect((await Jobs.get(scopeId, "daily-report")).job.running).toBe(false)

    await Jobs.remove(scopeId, "daily-report", { stop: false })
    expect(existsSync(paths.job(scopeId, "daily-report"))).toBe(false)
    expect(existsSync(paths.plist(scopeId, "daily-report"))).toBe(false)
    expect(await readRuns(scopeId, "daily-report", 20)).toHaveLength(3)
  })

  test("a corrupt job file shows as unreadable without breaking the list", async () => {
    mkdirSync(join(paths.scopes(), "other-000000000000", "jobs"), { recursive: true })
    writeFileSync(paths.job("other-000000000000", "bad"), "{not json")
    const jobs = await Jobs.list()
    expect(jobs.find((job) => job.slug === "bad")).toMatchObject({ readable: false })
  })
})

// A stand-in for supervisor.pl: forks a setsid child, waits for it, then removes the lock.
function fakeSupervisor(lock: string, child: string, supervisorIgnoresTerm = false) {
  const script = `
use POSIX;
$SIG{TERM} = "IGNORE" if ${supervisorIgnoresTerm ? 1 : 0};
my $c = fork();
if (!$c) { setsid(); exec "/usr/bin/perl", "-e", '${child}'; }
waitpid($c, 0);
sleep 600 if ${supervisorIgnoresTerm ? 1 : 0};
unlink $ARGV[0];`
  const proc = spawn("/usr/bin/perl", ["-e", script, lock], { stdio: "ignore", detached: true })
  writeFileSync(lock, JSON.stringify({ pid: proc.pid, startedAt: new Date().toISOString() }))
  return proc
}

describe("stop", () => {
  let scopeId = ""

  beforeAll(async () => {
    scopeId = (await Jobs.create({ ...input, name: "Stopper" })).scopeId
  })

  test("not_running when idle", async () => {
    await expect(Jobs.stop(scopeId, "stopper")).rejects.toMatchObject({ type: "not_running" })
  })

  test("terminates the child's process group; the supervisor removes the lock", async () => {
    fakeSupervisor(paths.lock(scopeId, "stopper"), "sleep 300")
    await Bun.sleep(300)
    await Jobs.stop(scopeId, "stopper")
    expect(existsSync(paths.lock(scopeId, "stopper"))).toBe(false)
  }, 20_000)

  test("SIGKILLs a child that ignores SIGTERM", async () => {
    fakeSupervisor(paths.lock(scopeId, "stopper"), '$SIG{TERM}="IGNORE"; sleep 300')
    await Bun.sleep(300)
    await Jobs.stop(scopeId, "stopper")
    expect(existsSync(paths.lock(scopeId, "stopper"))).toBe(false)
  }, 20_000)

  test("kills a stuck supervisor and records the run as stopped", async () => {
    fakeSupervisor(paths.lock(scopeId, "stopper"), "sleep 300", true)
    await Bun.sleep(300)
    await Jobs.stop(scopeId, "stopper")
    expect(existsSync(paths.lock(scopeId, "stopper"))).toBe(false)
    expect(await readJob(scopeId, "stopper")).toMatchObject({ lastRunStatus: "failed", lastRunError: "stopped" })
  }, 30_000)
})
