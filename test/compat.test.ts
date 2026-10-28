import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as Cron from "../src/cron.ts"
import { buildInvocation } from "../src/jobs.ts"
import { renderPlist } from "../src/launchd.ts"
import { deriveScopeId, type Job } from "../src/store.ts"

// The plist was written by opencode-scheduler, and the scope id was computed with its deriveScopeId. Paths and names
// were then changed to generic ones.
const fixtures = join(import.meta.dir, "fixtures")
const job: Job = JSON.parse(readFileSync(join(fixtures, "daily-summary.json"), "utf8"))

describe("opencode-scheduler compatibility", () => {
  test("derives the same scope id", () => {
    expect(deriveScopeId(job.workdir)).toBe(job.scopeId)
  })

  test("regenerates an identical plist", () => {
    const home = process.env.HOME
    process.env.HOME = "/Users/example"
    try {
      expect(renderPlist(job)).toBe(readFileSync(join(fixtures, "daily-summary.plist"), "utf8"))
    } finally {
      process.env.HOME = home
    }
  })

  test("rebuilds the same invocation", () => {
    expect(buildInvocation(job.run ?? {}, job.invocation?.command ?? "")).toEqual(job.invocation ?? { command: "", args: [] })
  })

  test("omits --title when there is no title", () => {
    expect(buildInvocation({ prompt: "hi" }, "opencode").args).toEqual(["run", "--", "hi"])
  })
})

describe("cron", () => {
  test("converts lists, ranges and steps to launchd calendars", () => {
    expect(Cron.toLaunchdCalendars("0 12 * * *")).toEqual([{ Minute: 0, Hour: 12 }])
    expect(Cron.toLaunchdCalendars("*/30 9 * * 1-5")).toHaveLength(10)
    expect(Cron.toLaunchdCalendars("0 9 1 * 7")).toEqual([
      { Minute: 0, Hour: 9, Day: 1 },
      { Minute: 0, Hour: 9, Weekday: 0 },
    ])
  })

  test("rejects invalid expressions", () => {
    expect(Cron.validate("0 25 * * *")).toContain("hour")
    expect(Cron.validate("0 12 * *")).toContain("5 fields")
    expect(Cron.validate("5-1 * * * *")).toContain("range")
  })

  test("computes next runs in local time", () => {
    const from = new Date(2026, 9, 28, 12, 30) // Wed Oct 28 2026 12:30
    const [weekday, daily] = [Cron.nextRuns("0 9 * * 1-5", from, 3), Cron.nextRuns("0 12 * * *", from, 1)]
    expect(weekday.map((date) => [date.getDate(), date.getHours()])).toEqual([
      [29, 9],
      [30, 9],
      [2, 9],
    ])
    expect(daily[0]?.getDate()).toBe(29)
  })

  test("describes common schedules", () => {
    expect(Cron.describe("0 12 * * *")).toBe("Daily at 12:00")
    expect(Cron.describe("30 9 * * 1-5")).toBe("Weekdays at 09:30")
    expect(Cron.describe("15 * * * *")).toBe("Hourly at :15")
    expect(Cron.describe("*/15 * * * *")).toBe("Every 15 minutes")
    expect(Cron.describe("0 9 1 * *")).toBe("0 9 1 * *")
  })
})
