import { Command, MenuItem, Panel, SettingsPage, Style, TitlebarItem, type PanelTab, type Plugin } from "@opencode/plugin/gui"
import type { definition } from "./definition.ts"
import { createJobsState } from "./state.ts"
import css from "./styles.css?inline"
import { JobsView } from "./view.tsx"

export const setup: Plugin.Setup<typeof definition> = (ctx) => {
  const state = createJobsState(ctx)
  const key = `${ctx.id}:jobs`
  const defaultWorkdir = () => ctx.sessions.current()?.directory

  // Side panels belong to a session, so without one (Home, drafts) fall back to the settings page.
  const open = () => {
    const session = ctx.sessions.current()
    if (session) ctx.layout.open(key, session, { tab: "select" })
    else ctx.layout.settings(ctx.id)
  }

  const tab: PanelTab = {
    id: "jobs",
    get title() {
      return ctx.t("title")
    },
    closable: "hover",
  }

  ctx.add(Style, css)

  ctx.add(Panel, {
    id: "jobs",
    region: "side",
    mobile: {
      get title() {
        return ctx.t("title")
      },
      order: 60,
      kind: "menu",
      icon: "task",
    },
    list: (input) => (input.open.includes("jobs") ? [tab] : []),
    render: () => <JobsView state={state} defaultWorkdir={defaultWorkdir} />,
  })

  ctx.add(SettingsPage, {
    id: ctx.id,
    icon: "task",
    get title() {
      return ctx.t("title")
    },
    get entries() {
      return [{ id: "jobs", title: ctx.t("title"), keywords: "cron launchd schedule recurring automation" }]
    },
    render: () => <JobsView state={state} defaultWorkdir={defaultWorkdir} />,
  })

  ctx.add(TitlebarItem, (): TitlebarItem => {
    const running = state.running()
    const failed = state.failed()
    const session = ctx.sessions.current()
    return {
      id: "status",
      icon: "task",
      label: running > 0 ? ctx.t("pill.running", { count: running }) : failed > 0 ? ctx.t("pill.failed", { count: failed }) : ctx.t("pill.idle"),
      title: ctx.t("title"),
      busy: running > 0,
      pressed: !!session && ctx.layout.state(key, session) === "visible",
      run: open,
    }
  })

  ctx.add(Command, () => ({
    id: "open",
    title: ctx.t("command.open"),
    description: ctx.t("command.open.description"),
    keywords: "cron launchd schedule jobs",
    slash: { name: "jobs" },
    run: open,
  }))

  ctx.add(MenuItem, (): MenuItem => {
    const session = ctx.sessions.current()
    return {
      menu: "session.panel",
      id: "open",
      title: ctx.t("title"),
      icon: "task",
      keybind: `${ctx.id}.open`,
      opened: !!session && ctx.layout.state(key, session) !== "closed",
      run: open,
    }
  })
}
