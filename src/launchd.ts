import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { copyFile, mkdir, unlink, writeFile } from "node:fs/promises"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as Cron from "./cron.ts"
import { home, paths, type Job } from "./store.ts"

const TIMEOUT_MS = 10_000

export const LAUNCHD_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

// No shell: arguments are passed as an array, and every call is bounded by a timeout.
export function exec(command: string, args: string[]): Promise<ExecResult> {
  return new Promise((done) => {
    execFile(command, args, { timeout: TIMEOUT_MS, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0
      done({ code, stdout, stderr: stderr || (error && typeof error.code !== "number" ? error.message : "") })
    })
  })
}

export class LaunchdError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message)
  }
}

function domain() {
  return `gui/${process.getuid?.() ?? 501}`
}

function escape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function renderCalendar(calendar: Cron.Calendar) {
  return Object.entries(calendar)
    .map(([key, value]) => `    <key>${key}</key>\n    <integer>${value}</integer>`)
    .join("\n")
}

// Byte-for-byte the same layout as opencode-scheduler's createLaunchdPlist, so regenerated plists match.
export function renderPlist(job: Job) {
  const log = paths.log(job.scopeId, job.slug)
  const calendars = Cron.toLaunchdCalendars(job.schedule)
  const calendarXml =
    calendars.length === 1
      ? `  <dict>\n${renderCalendar(calendars[0] ?? {})}\n  </dict>`
      : `  <array>\n${calendars.map((calendar) => `  <dict>\n${renderCalendar(calendar)}\n  </dict>`).join("\n")}\n  </array>`
  const programArguments = ["/usr/bin/perl", paths.supervisor(), paths.job(job.scopeId, job.slug)]
    .map((arg) => `    <string>${escape(arg)}</string>`)
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${paths.label(job.scopeId, job.slug)}</string>
  
  <key>WorkingDirectory</key>
  <string>${escape(job.workdir || home())}</string>
  
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${LAUNCHD_PATH}</string>
  </dict>
  
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  
  <key>StartCalendarInterval</key>
${calendarXml}
  
  <key>StandardOutPath</key>
  <string>${log}</string>
  
  <key>StandardErrorPath</key>
  <string>${log}</string>
  
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>`
}

export async function writePlist(job: Job) {
  await mkdir(paths.launchAgents(), { recursive: true })
  await writeFile(paths.plist(job.scopeId, job.slug), renderPlist(job))
}

export async function removePlist(scopeId: string, slug: string) {
  await unlink(paths.plist(scopeId, slug)).catch(() => {})
}

export async function isLoaded(scopeId: string, slug: string) {
  return (await exec("launchctl", ["print", `${domain()}/${paths.label(scopeId, slug)}`])).code === 0
}

export async function bootstrap(scopeId: string, slug: string) {
  const result = await exec("launchctl", ["bootstrap", domain(), paths.plist(scopeId, slug)])
  if (result.code !== 0) throw new LaunchdError(`launchctl bootstrap failed (exit ${result.code})`, result.stderr.trim())
}

export async function bootout(scopeId: string, slug: string) {
  if (!(await isLoaded(scopeId, slug))) return
  const result = await exec("launchctl", ["bootout", `${domain()}/${paths.label(scopeId, slug)}`])
  if (result.code !== 0) throw new LaunchdError(`launchctl bootout failed (exit ${result.code})`, result.stderr.trim())
}

export async function kickstart(scopeId: string, slug: string) {
  const result = await exec("launchctl", ["kickstart", `${domain()}/${paths.label(scopeId, slug)}`])
  if (result.code !== 0) throw new LaunchdError(`launchctl kickstart failed (exit ${result.code})`, result.stderr.trim())
}

export function findOpencode() {
  const override = process.env.OPENCODE_SCHEDULER_OPENCODE_PATH?.trim()
  if (override) return override
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...LAUNCHD_PATH.split(":"), join(home(), ".opencode", "bin")]
  for (const dir of dirs) {
    if (dir && existsSync(join(dir, "opencode"))) return join(dir, "opencode")
  }
  return "opencode"
}

const VENDORED_SUPERVISOR = join(dirname(fileURLToPath(import.meta.url)), "..", "scheduler", "supervisor.pl")

// Never overwrite: existing plists point at this exact file.
export async function ensureSupervisor() {
  if (existsSync(paths.supervisor())) return
  await mkdir(dirname(paths.supervisor()), { recursive: true })
  await copyFile(VENDORED_SUPERVISOR, paths.supervisor())
}
