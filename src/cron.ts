// Five-field cron: minute hour day-of-month month day-of-week.
// Supports `*`, `*/n`, `a`, `a-b`, `a-b/n`, and comma lists of those. Day-of-week 7 is Sunday.

type Values = number[] | null

interface Parsed {
  minute: Values
  hour: Values
  day: Values
  month: Values
  weekday: Values
}

export type Calendar = Partial<Record<"Minute" | "Hour" | "Day" | "Month" | "Weekday", number>>

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function parseNumber(raw: string, min: number, max: number, label: string, sundaySeven: boolean): number {
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid cron ${label} value: ${raw}`)
  const value = Number(raw)
  const normalized = sundaySeven && value === 7 ? 0 : value
  if (normalized < min || normalized > max) throw new Error(`Invalid cron ${label} value: ${raw}`)
  return normalized
}

function parseField(field: string, min: number, max: number, label: string, sundaySeven = false): Values {
  if (field === "*") return null
  const values = new Set<number>()
  for (const part of field.split(",")) {
    const [range, stepRaw] = part.split("/")
    if (range === undefined || range === "") throw new Error(`Invalid cron ${label} field: ${field}`)
    const step = stepRaw === undefined ? 1 : Number(stepRaw)
    if (!Number.isInteger(step) || step <= 0) throw new Error(`Invalid cron ${label} step: ${part}`)
    let start: number
    let end: number
    if (range === "*") {
      start = min
      end = sundaySeven ? 6 : max
    } else if (range.includes("-")) {
      const [a, b] = range.split("-")
      start = parseNumber(a ?? "", min, max, label, false)
      end = parseNumber(b ?? "", min, max, label, false)
      if (start > end) throw new Error(`Invalid cron ${label} range: ${range}`)
    } else {
      if (stepRaw !== undefined) throw new Error(`Invalid cron ${label} field: ${part}`)
      values.add(parseNumber(range, min, max, label, sundaySeven))
      continue
    }
    for (let value = start; value <= end; value += step) values.add(sundaySeven && value === 7 ? 0 : value)
  }
  return [...values].sort((a, b) => a - b)
}

export function parse(cron: string): Parsed {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`Invalid cron: expected 5 fields, got ${parts.length}`)
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string]
  return {
    minute: parseField(minute, 0, 59, "minute"),
    hour: parseField(hour, 0, 23, "hour"),
    day: parseField(day, 1, 31, "day of month"),
    month: parseField(month, 1, 12, "month"),
    weekday: parseField(weekday, 0, 7, "day of week", true),
  }
}

export function validate(cron: string): string | undefined {
  try {
    parse(cron)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function expand(entries: Calendar[], key: keyof Calendar, values: Values): Calendar[] {
  if (!values) return entries
  return entries.flatMap((entry) => values.map((value) => ({ ...entry, [key]: value })))
}

function calendars(p: Pick<Parsed, "minute" | "hour" | "month">, day: Values, weekday: Values): Calendar[] {
  let entries: Calendar[] = [{}]
  entries = expand(entries, "Minute", p.minute)
  entries = expand(entries, "Hour", p.hour)
  entries = expand(entries, "Day", day)
  entries = expand(entries, "Month", p.month)
  entries = expand(entries, "Weekday", weekday)
  return entries
}

// Matches opencode-scheduler: when both day-of-month and day-of-week are set, cron runs on either.
export function toLaunchdCalendars(cron: string): Calendar[] {
  const p = parse(cron)
  if (p.day && p.weekday) return [...calendars(p, p.day, null), ...calendars(p, null, p.weekday)]
  return calendars(p, p.day, p.weekday)
}

function matches(values: Values, value: number) {
  return values === null || values.includes(value)
}

function dayMatches(p: Parsed, date: Date) {
  if (p.day && p.weekday) return p.day.includes(date.getDate()) || p.weekday.includes(date.getDay())
  return matches(p.day, date.getDate()) && matches(p.weekday, date.getDay())
}

export function nextRuns(cron: string, from: Date, count: number): Date[] {
  const p = parse(cron)
  const result: Date[] = []
  const cursor = new Date(from)
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)
  const limit = from.getTime() + 366 * 24 * 60 * 60 * 1000 * 5
  while (result.length < count && cursor.getTime() < limit) {
    if (!matches(p.month, cursor.getMonth() + 1) || !dayMatches(p, cursor)) {
      cursor.setDate(cursor.getDate() + 1)
      cursor.setHours(0, 0, 0, 0)
      continue
    }
    if (!matches(p.hour, cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0)
      continue
    }
    if (matches(p.minute, cursor.getMinutes())) result.push(new Date(cursor))
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  return result
}

function time(hour: number, minute: number) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
}

export function describe(cron: string): string {
  let p: Parsed
  try {
    p = parse(cron)
  } catch {
    return cron
  }
  const single = (values: Values) => values?.length === 1 ? values[0] : undefined
  const minute = single(p.minute)
  const hour = single(p.hour)
  const everyDay = p.day === null && p.month === null
  if (!everyDay) return cron
  if (p.weekday === null && p.hour === null && minute !== undefined) return `Hourly at :${String(minute).padStart(2, "0")}`
  if (p.weekday === null && p.hour === null && p.minute && p.minute.length > 1) {
    const step = (p.minute[1] ?? 0) - (p.minute[0] ?? 0)
    const regular = p.minute[0] === 0 && p.minute.every((value, index) => value === index * step)
    if (regular && 60 % step === 0) return `Every ${step} minutes`
  }
  if (minute === undefined || hour === undefined) return cron
  if (p.weekday === null) return `Daily at ${time(hour, minute)}`
  if (p.weekday.join(",") === "1,2,3,4,5") return `Weekdays at ${time(hour, minute)}`
  return `${p.weekday.map((day) => WEEKDAYS[day]).join(", ")} at ${time(hour, minute)}`
}
