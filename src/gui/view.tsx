import { createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import * as Cron from "../cron.ts"
import type { JobView } from "../rpc.ts"
import type { definition } from "./definition.ts"
import { errorMessage, type JobsState } from "./state.ts"

type Ref = { scopeId: string; slug: string }
type Screen = { kind: "list" } | { kind: "detail"; ref: Ref } | { kind: "form"; ref?: Ref }

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

function relative(iso: string | undefined, now: number, locale: string) {
  if (!iso) return ""
  const ms = new Date(iso).getTime() - now
  if (Number.isNaN(ms)) return ""
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
  const minutes = Math.round(ms / 60_000)
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute")
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 48) return format.format(hours, "hour")
  return format.format(Math.round(hours / 24), "day")
}

function elapsed(iso: string | undefined, now: number) {
  if (!iso) return ""
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

function scopeLabel(job: JobView) {
  return job.workdir ? job.workdir.split("/").filter(Boolean).at(-1) ?? job.scopeId : job.scopeId
}

export function JobsView(props: { state: JobsState; defaultWorkdir: () => string | undefined }) {
  const [screen, setScreen] = createSignal<Screen>({ kind: "list" })
  return (
    <div class="sj-root">
      <Switch>
        <Match when={screen().kind === "list"}>
          <JobList state={props.state} onOpen={(ref) => setScreen({ kind: "detail", ref })} onNew={() => setScreen({ kind: "form" })} onEdit={(ref) => setScreen({ kind: "form", ref })} />
        </Match>
        <Match when={(() => { const s = screen(); return s.kind === "detail" ? s : undefined })()}>
          {(s) => (
            <JobDetail state={props.state} ref={s().ref} onBack={() => setScreen({ kind: "list" })} onEdit={() => setScreen({ kind: "form", ref: s().ref })} />
          )}
        </Match>
        <Match when={(() => { const s = screen(); return s.kind === "form" ? s : undefined })()}>
          {(s) => (
            <JobForm
              state={props.state}
              ref={s().ref}
              defaultWorkdir={props.defaultWorkdir}
              onDone={(ref) => setScreen(ref ? { kind: "detail", ref } : { kind: "list" })}
            />
          )}
        </Match>
      </Switch>
    </div>
  )
}

// Shared confirm + RPC + toast handling for row and detail actions.
function useActions(state: JobsState) {
  const ctx = usePlugin<typeof definition>()
  const act = async (job: JobView, work: () => Promise<unknown>, toast: string) => {
    try {
      await work()
      ctx.toast.show({ title: ctx.t(toast, { name: job.name }), variant: "success" })
    } catch (error) {
      ctx.toast.show({ title: ctx.t("toast.failed"), description: errorMessage(error), variant: "error" })
    } finally {
      void state.refresh()
    }
  }
  const ref = (job: JobView) => ({ scopeId: job.scopeId, slug: job.slug })
  return {
    run: (job: JobView) => act(job, () => state.rpc().run(ref(job)), "toast.started"),
    stop: async (job: JobView) => {
      const ok = await ctx.dialogs.confirm({
        title: ctx.t("confirm.stop.title", { name: job.name }),
        description: ctx.t("confirm.stop.description"),
        confirm: ctx.t("action.stop"),
        danger: true,
      })
      if (ok) await act(job, () => state.rpc().stop(ref(job)), "toast.stopped")
    },
    pause: async (job: JobView) => {
      if (job.running) {
        const ok = await ctx.dialogs.confirm({
          title: ctx.t("confirm.pause.title", { name: job.name }),
          description: ctx.t("confirm.pause.running"),
          confirm: ctx.t("action.pause"),
        })
        if (!ok) return
      }
      await act(job, () => state.rpc().pause(ref(job)), "toast.paused")
    },
    resume: (job: JobView) => act(job, () => state.rpc().resume(ref(job)), "toast.resumed"),
    remove: async (job: JobView) => {
      const description = [ctx.t("confirm.delete.description"), job.running ? ctx.t("confirm.delete.running") : ""].join(" ").trim()
      const ok = await ctx.dialogs.confirm({
        title: ctx.t("confirm.delete.title", { name: job.name }),
        description,
        confirm: ctx.t("action.delete"),
        danger: true,
      })
      if (!ok) return false
      await act(job, () => state.rpc().remove(ref(job)), "toast.deleted")
      return true
    },
  }
}

function StatusDot(props: { job: JobView }) {
  const tone = () =>
    !props.job.readable || props.job.stuck
      ? "danger"
      : props.job.running
        ? "running"
        : !props.job.lastRun
          ? "none"
          : props.job.lastRun.status === "success"
            ? "success"
            : "danger"
  return <span class={`sj-dot sj-dot-${tone()}`} aria-hidden="true" />
}

function JobList(props: { state: JobsState; onOpen: (ref: Ref) => void; onNew: () => void; onEdit: (ref: Ref) => void }) {
  const ctx = usePlugin<typeof definition>()
  const actions = useActions(props.state)
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set())
  const groups = createMemo(() => {
    const map = new Map<string, JobView[]>()
    for (const job of props.state.jobs()) map.set(job.scopeId, [...(map.get(job.scopeId) ?? []), job])
    return [...map.entries()].map(([scopeId, jobs]) => ({ scopeId, label: jobs[0] ? scopeLabel(jobs[0]) : scopeId, jobs }))
  })
  const toggle = (scopeId: string) => {
    const next = new Set(collapsed())
    if (next.has(scopeId)) next.delete(scopeId)
    else next.add(scopeId)
    setCollapsed(next)
  }

  return (
    <>
      <header class="sj-header">
        <h2 class="sj-heading">{ctx.t("title")}</h2>
        <ctx.ui.IconButton icon="refresh" label={ctx.t("list.refresh")} variant="ghost" onClick={() => void props.state.refresh()} />
        <ctx.ui.Button icon="plus" size="small" onClick={props.onNew}>
          {ctx.t("list.new")}
        </ctx.ui.Button>
      </header>
      <Show when={props.state.unreachable()}>
        <p class="sj-error">{ctx.t("list.unreachable")}</p>
      </Show>
      <Show when={props.state.loaded()} fallback={<ctx.ui.Loader />}>
        <Show when={props.state.jobs().length > 0} fallback={<p class="sj-muted">{ctx.t("list.empty")}</p>}>
          <For each={groups()}>
            {(group) => (
              <section class="sj-group">
                <button class="sj-group-title" onClick={() => toggle(group.scopeId)} title={group.scopeId}>
                  <ctx.ui.Icon name={collapsed().has(group.scopeId) ? "chevron-right" : "chevron-down"} size="small" />
                  {group.label}
                  <span class="sj-muted">{group.jobs.length}</span>
                </button>
                <Show when={!collapsed().has(group.scopeId)}>
                  <For each={group.jobs}>
                    {(job) => <JobRow job={job} state={props.state} actions={actions} onOpen={props.onOpen} onEdit={props.onEdit} />}
                  </For>
                </Show>
              </section>
            )}
          </For>
        </Show>
      </Show>
    </>
  )
}

function JobRow(props: {
  job: JobView
  state: JobsState
  actions: ReturnType<typeof useActions>
  onOpen: (ref: Ref) => void
  onEdit: (ref: Ref) => void
}) {
  const ctx = usePlugin<typeof definition>()
  const locale = () => ctx.locale.locale()
  const ref = () => ({ scopeId: props.job.scopeId, slug: props.job.slug })
  const subtitle = () => {
    const job = props.job
    if (!job.readable) return job.error ?? ""
    const parts = [Cron.describe(job.schedule)]
    if (job.nextRunAt) parts.push(ctx.t("row.next", { time: relative(job.nextRunAt, props.state.now(), locale()) }))
    parts.push(
      job.lastRun
        ? ctx.t("row.last", { status: job.lastRun.status, time: relative(job.lastRun.at, props.state.now(), locale()) })
        : ctx.t("row.never"),
    )
    return parts.join(" · ")
  }
  return (
    <div class="sj-row">
      <button class="sj-row-main" onClick={() => props.job.readable && props.onOpen(ref())}>
        <StatusDot job={props.job} />
        <span class="sj-row-text">
          <span class="sj-row-title">
            {props.job.name}
            <Show when={props.job.running}>
              <span class="sj-badge">{ctx.t("badge.running", { elapsed: elapsed(props.job.runStartedAt, props.state.now()) })}</span>
            </Show>
            <Show when={props.job.stuck}>
              <span class="sj-badge sj-badge-danger">{ctx.t("badge.stuck")}</span>
            </Show>
            <Show when={props.job.paused}>
              <span class="sj-badge">{ctx.t("badge.paused")}</span>
            </Show>
            <Show when={!props.job.readable}>
              <span class="sj-badge sj-badge-danger">{ctx.t("badge.unreadable")}</span>
            </Show>
          </span>
          <span class="sj-muted sj-row-subtitle">{subtitle()}</span>
        </span>
      </button>
      <Show when={props.job.readable}>
        <Show
          when={props.job.running}
          fallback={
            <ctx.ui.IconButton icon="arrow-right" label={ctx.t("action.run")} variant="ghost" disabled={props.job.paused} onClick={() => void props.actions.run(props.job)} />
          }
        >
          <ctx.ui.IconButton icon="stop" label={ctx.t("action.stop")} variant="ghost" onClick={() => void props.actions.stop(props.job)} />
        </Show>
        <ctx.ui.Menu
          label={ctx.t("action.more")}
          items={[
            props.job.paused
              ? { label: ctx.t("action.resume"), icon: "outline-rotate-clockwise", onSelect: () => void props.actions.resume(props.job) }
              : { label: ctx.t("action.pause"), icon: "circle-ban-sign", onSelect: () => void props.actions.pause(props.job) },
            { label: ctx.t("action.edit"), icon: "edit", disabled: props.job.running, onSelect: () => props.onEdit(ref()) },
            { type: "separator" },
            { label: ctx.t("action.delete"), icon: "trash", onSelect: () => void props.actions.remove(props.job) },
          ]}
        />
      </Show>
    </div>
  )
}

function JobDetail(props: { state: JobsState; ref: Ref; onBack: () => void; onEdit: () => void }) {
  const ctx = usePlugin<typeof definition>()
  const actions = useActions(props.state)
  // Refetch whenever the shared list changes, which follows the server's `changed` events.
  const source = () => ({ ...props.ref, version: props.state.jobs() })
  const [detail] = createResource(source, (ref) => props.state.rpc().get({ scopeId: ref.scopeId, slug: ref.slug }))
  const [log] = createResource(source, (ref) => props.state.rpc().log({ scopeId: ref.scopeId, slug: ref.slug, lines: 200 }))
  const job = () => detail.latest?.job

  return (
    <>
      <header class="sj-header">
        <ctx.ui.IconButton icon="arrow-left" label={ctx.t("action.back")} variant="ghost" onClick={props.onBack} />
        <h2 class="sj-heading">{job()?.name ?? props.ref.slug}</h2>
        <Show when={job()}>
          {(current) => (
            <>
              <Show
                when={current().running}
                fallback={<ctx.ui.IconButton icon="arrow-right" label={ctx.t("action.run")} variant="ghost" disabled={current().paused} onClick={() => void actions.run(current())} />}
              >
                <ctx.ui.IconButton icon="stop" label={ctx.t("action.stop")} variant="ghost" onClick={() => void actions.stop(current())} />
              </Show>
              <ctx.ui.Menu
                label={ctx.t("action.more")}
                items={[
                  current().paused
                    ? { label: ctx.t("action.resume"), icon: "outline-rotate-clockwise", onSelect: () => void actions.resume(current()) }
                    : { label: ctx.t("action.pause"), icon: "circle-ban-sign", onSelect: () => void actions.pause(current()) },
                  { label: ctx.t("action.edit"), icon: "edit", disabled: current().running, onSelect: props.onEdit },
                  { type: "separator" },
                  {
                    label: ctx.t("action.delete"),
                    icon: "trash",
                    onSelect: () => void actions.remove(current()).then((removed) => removed && props.onBack()),
                  },
                ]}
              />
            </>
          )}
        </Show>
      </header>
      <Show when={detail.error}>
        <p class="sj-error">{errorMessage(detail.error)}</p>
      </Show>
      <Show when={job()} fallback={<Show when={!detail.error}><ctx.ui.Loader /></Show>}>
        {(current) => (
          <div class="sj-detail">
            <dl class="sj-fields">
              <dt>{ctx.t("detail.schedule")}</dt>
              <dd>
                {Cron.describe(current().schedule)} <code class="sj-muted">{current().schedule}</code>
              </dd>
              <dt>{ctx.t("detail.workdir")}</dt>
              <dd>
                <code>{current().workdir}</code>
              </dd>
              <dt>{ctx.t("detail.timeout")}</dt>
              <dd>{current().timeoutSeconds ? `${current().timeoutSeconds}s` : ctx.t("detail.timeout.none")}</dd>
            </dl>
            <h3 class="sj-subheading">{ctx.t("detail.prompt")}</h3>
            <pre class="sj-pre">{current().prompt}</pre>
            <h3 class="sj-subheading">{ctx.t("detail.runs")}</h3>
            <Show when={(detail.latest?.runs.length ?? 0) > 0} fallback={<p class="sj-muted">{ctx.t("detail.runs.empty")}</p>}>
              <table class="sj-table">
                <tbody>
                  <For each={detail.latest?.runs}>
                    {(run) => (
                      <tr>
                        <td>
                          <span class={`sj-dot sj-dot-${run.status === "success" ? "success" : "danger"}`} aria-hidden="true" />
                        </td>
                        <td>{new Date(run.startedAt).toLocaleString(ctx.locale.locale())}</td>
                        <td>{Math.round(run.durationMs / 1000)}s</td>
                        <td>{run.status}</td>
                        <td class="sj-muted">exit {run.exitCode ?? "?"}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
            <header class="sj-header">
              <h3 class="sj-subheading">{ctx.t("detail.log")}</h3>
              <Show when={ctx.desktop && detail.latest?.logPath}>
                {(path) => (
                  <ctx.ui.Button variant="ghost" size="small" icon="folder" onClick={() => void ctx.desktop?.reveal(path())}>
                    {ctx.t("action.reveal")}
                  </ctx.ui.Button>
                )}
              </Show>
            </header>
            <pre class="sj-pre sj-log">{log.latest?.text || ctx.t("detail.log.empty")}</pre>
          </div>
        )}
      </Show>
    </>
  )
}

type Preset = "hourly" | "daily" | "weekdays" | "weekly" | "custom"

function presetCron(preset: Preset, minute: number, time: string, weekday: number, custom: string) {
  const [hour, min] = time.split(":").map(Number)
  const h = Number.isInteger(hour) ? hour : 9
  const m = Number.isInteger(min) ? min : 0
  switch (preset) {
    case "hourly":
      return `${minute} * * * *`
    case "daily":
      return `${m} ${h} * * *`
    case "weekdays":
      return `${m} ${h} * * 1-5`
    case "weekly":
      return `${m} ${h} * * ${weekday}`
    case "custom":
      return custom.trim()
  }
}

// Best-effort: map an existing cron back onto a preset so editing a simple job doesn't drop into raw cron.
function parsePreset(cron: string): { preset: Preset; minute: number; time: string; weekday: number } {
  const match = /^(\d+) (\*|\d+) \* \* (\*|1-5|\d)$/.exec(cron.trim())
  const fallback = { preset: "custom" as const, minute: 0, time: "09:00", weekday: 1 }
  if (!match) return fallback
  const [, m = "0", h = "*", dow = "*"] = match
  const time = h === "*" ? "09:00" : `${h.padStart(2, "0")}:${m.padStart(2, "0")}`
  if (h === "*") return dow === "*" ? { ...fallback, preset: "hourly", minute: Number(m) } : fallback
  if (dow === "*") return { ...fallback, preset: "daily", time }
  if (dow === "1-5") return { ...fallback, preset: "weekdays", time }
  return { ...fallback, preset: "weekly", time, weekday: Number(dow) % 7 }
}

function JobForm(props: { state: JobsState; ref?: Ref; defaultWorkdir: () => string | undefined; onDone: (ref?: Ref) => void }) {
  const ctx = usePlugin<typeof definition>()
  const existing = () => (props.ref ? props.state.jobs().find((job) => job.scopeId === props.ref?.scopeId && job.slug === props.ref?.slug) : undefined)
  const initial = existing()
  const parsed = parsePreset(initial?.schedule ?? "0 9 * * 1-5")

  const [name, setName] = createSignal(initial?.name ?? "")
  const [workdir, setWorkdir] = createSignal(initial?.workdir ?? props.defaultWorkdir() ?? "")
  const [title, setTitle] = createSignal(initial?.title ?? "")
  const [prompt, setPrompt] = createSignal(initial?.prompt ?? "")
  const [preset, setPreset] = createSignal<Preset>(initial ? parsed.preset : "weekdays")
  const [minute, setMinute] = createSignal(parsed.minute)
  const [time, setTime] = createSignal(parsed.time)
  const [weekday, setWeekday] = createSignal(parsed.weekday)
  const [custom, setCustom] = createSignal(initial?.schedule ?? "0 9 * * 1-5")
  const [timeout, setTimeoutSeconds] = createSignal(String(initial?.timeoutSeconds ?? 0))
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const schedule = () => presetCron(preset(), minute(), time(), weekday(), custom())
  const cronError = () => Cron.validate(schedule())
  const upcoming = () => (cronError() ? [] : Cron.nextRuns(schedule(), new Date(), 3))
  const timeoutValue = () => Number(timeout())
  const valid = () =>
    !cronError() && name().trim() !== "" && prompt().trim() !== "" && workdir().trim() !== "" && Number.isInteger(timeoutValue()) && timeoutValue() >= 0

  const browse = async () => {
    const [folder] = (await ctx.desktop?.pick({ directory: true, title: ctx.t("form.workdir") })) ?? []
    if (folder) setWorkdir(folder)
  }

  const save = async () => {
    if (!valid() || saving()) return
    setSaving(true)
    setError(undefined)
    try {
      const fields = {
        name: name(),
        workdir: workdir(),
        schedule: schedule(),
        prompt: prompt(),
        title: title(),
        timeoutSeconds: timeoutValue(),
      }
      const { job } = props.ref
        ? await props.state.rpc().update({ ...props.ref, ...fields })
        : await props.state.rpc().create(fields)
      ctx.toast.show({ title: ctx.t("toast.saved", { name: job.name }), variant: "success" })
      void props.state.refresh()
      props.onDone({ scopeId: job.scopeId, slug: job.slug })
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <header class="sj-header">
        <ctx.ui.IconButton icon="arrow-left" label={ctx.t("action.back")} variant="ghost" onClick={() => props.onDone(props.ref)} />
        <h2 class="sj-heading">{initial ? ctx.t("form.edit", { name: initial.name }) : ctx.t("form.new")}</h2>
      </header>
      <form
        class="sj-form"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <label class="sj-label">
          {ctx.t("form.name")}
          <ctx.ui.TextInput label={ctx.t("form.name")} value={name()} onInput={setName} />
        </label>
        <label class="sj-label">
          {ctx.t("form.workdir")}
          <span class="sj-inline">
            <ctx.ui.TextInput label={ctx.t("form.workdir")} value={workdir()} onInput={setWorkdir} />
            <Show when={ctx.desktop}>
              <ctx.ui.Button size="small" onClick={() => void browse()}>
                {ctx.t("form.browse")}
              </ctx.ui.Button>
            </Show>
          </span>
        </label>
        <label class="sj-label">
          {ctx.t("form.title")}
          <ctx.ui.TextInput label={ctx.t("form.title")} value={title()} onInput={setTitle} />
        </label>
        <label class="sj-label">
          {ctx.t("form.prompt")}
          <textarea class="sj-textarea" rows={6} value={prompt()} onInput={(event) => setPrompt(event.currentTarget.value)} />
          <span class="sj-muted">{ctx.t("form.prompt.warning")}</span>
        </label>
        <fieldset class="sj-fieldset">
          <legend class="sj-label">{ctx.t("form.schedule")}</legend>
          <select class="sj-select" value={preset()} onChange={(event) => setPreset(toPreset(event.currentTarget.value))}>
            <option value="hourly">{ctx.t("form.preset.hourly")}</option>
            <option value="daily">{ctx.t("form.preset.daily")}</option>
            <option value="weekdays">{ctx.t("form.preset.weekdays")}</option>
            <option value="weekly">{ctx.t("form.preset.weekly")}</option>
            <option value="custom">{ctx.t("form.preset.custom")}</option>
          </select>
          <Switch>
            <Match when={preset() === "hourly"}>
              <label class="sj-inline">
                {ctx.t("form.minute")}
                <input class="sj-input" type="number" min="0" max="59" value={minute()} onInput={(event) => setMinute(Number(event.currentTarget.value))} />
              </label>
            </Match>
            <Match when={preset() === "custom"}>
              <ctx.ui.TextInput label={ctx.t("form.cron")} placeholder="0 9 * * 1-5" value={custom()} onInput={setCustom} />
            </Match>
            <Match when={true}>
              <span class="sj-inline">
                <Show when={preset() === "weekly"}>
                  <select class="sj-select" aria-label={ctx.t("form.day")} value={weekday()} onChange={(event) => setWeekday(Number(event.currentTarget.value))}>
                    <For each={WEEKDAYS}>{(day, index) => <option value={index()}>{day}</option>}</For>
                  </select>
                </Show>
                <input class="sj-input" type="time" aria-label={ctx.t("form.time")} value={time()} onInput={(event) => setTime(event.currentTarget.value)} />
              </span>
            </Match>
          </Switch>
          <Show when={cronError()} fallback={
            <span class="sj-muted">
              {ctx.t("form.next")}: {upcoming().map((date) => date.toLocaleString(ctx.locale.locale(), { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })).join(" · ")}
            </span>
          }>
            {(message) => <span class="sj-error">{message()}</span>}
          </Show>
        </fieldset>
        <label class="sj-label">
          {ctx.t("form.timeout")}
          <input class="sj-input" type="number" min="0" step="1" value={timeout()} onInput={(event) => setTimeoutSeconds(event.currentTarget.value)} />
        </label>
        <Show when={error()}>{(message) => <p class="sj-error">{message()}</p>}</Show>
        <div class="sj-actions">
          <ctx.ui.Button variant="ghost" onClick={() => props.onDone(props.ref)}>
            {ctx.t("form.cancel")}
          </ctx.ui.Button>
          <ctx.ui.Button variant="contrast" disabled={!valid()} busy={saving()} onClick={() => void save()}>
            {ctx.t("form.save")}
          </ctx.ui.Button>
        </div>
      </form>
    </>
  )
}

function toPreset(value: string): Preset {
  return value === "hourly" || value === "daily" || value === "weekdays" || value === "weekly" ? value : "custom"
}
