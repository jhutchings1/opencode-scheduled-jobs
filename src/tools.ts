import { Schema } from "effect"
import type { Plugin } from "@opencode/plugin"
import * as Cron from "./cron.ts"
import * as Jobs from "./jobs.ts"
import { CreateInput, UpdateInput, type JobView } from "./rpc.ts"
import { deriveScopeId } from "./store.ts"

type Context = Plugin.Context

const Ref = Schema.Struct({
  slug: Schema.String,
  scopeId: Schema.optional(Schema.String),
})

function summary(job: JobView) {
  const state = !job.readable
    ? `unreadable: ${job.error}`
    : job.running
      ? `running since ${job.runStartedAt}${job.stuck ? " (stuck)" : ""}`
      : job.paused
        ? "paused"
        : `next run ${job.nextRunAt ?? "unknown"}`
  const last = job.lastRun ? `, last run ${job.lastRun.status}${job.lastRun.at ? ` at ${job.lastRun.at}` : ""}` : ""
  return `- ${job.name} [${job.scopeId}/${job.slug}] ${job.schedule} (${Cron.describe(job.schedule)}) — ${state}${last}`
}

// Expected failures go back to the model as text so it can correct itself; unexpected ones propagate.
async function respond(work: () => Promise<string>) {
  try {
    return { content: await work() }
  } catch (error) {
    if (error instanceof Jobs.JobError) {
      return { content: `Error (${error.type}): ${error.message}${error.stderr ? `\n${error.stderr}` : ""}` }
    }
    throw error
  }
}

export async function registerTools(ctx: Context) {
  const currentScope = deriveScopeId(ctx.location.directory)
  const scopeOf = (input: { scopeId?: string }) => input.scopeId ?? currentScope

  return ctx.tool.transform((editor) => {
    editor.add({
      name: "schedule_job",
      description:
        "Schedule a recurring OpenCode prompt with launchd. `schedule` is a 5-field cron expression in local time. " +
        "`workdir` is where `opencode run` executes. Don't put secrets in the prompt: it is stored in plain text.",
      input: CreateInput,
      execute: (input) =>
        respond(async () => {
          const job = await Jobs.create(input)
          return `Scheduled "${job.name}" [${job.scopeId}/${job.slug}]: ${Cron.describe(job.schedule)}. Next run ${job.nextRunAt ?? "unknown"}.`
        }),
    })

    editor.add({
      name: "list_jobs",
      description: "List scheduled jobs. Defaults to jobs for the current directory; pass all=true for every scope.",
      input: Schema.Struct({ all: Schema.optional(Schema.Boolean) }),
      execute: (input) =>
        respond(async () => {
          const jobs = (await Jobs.list()).filter((job) => input.all || job.scopeId === currentScope)
          if (jobs.length === 0) return input.all ? "No scheduled jobs." : "No scheduled jobs for this directory. Try all=true."
          return jobs.map(summary).join("\n")
        }),
    })

    editor.add({
      name: "get_job",
      description: "Show a scheduled job's details, recent runs and the tail of its log.",
      input: Ref,
      execute: (input) =>
        respond(async () => {
          const scopeId = scopeOf(input)
          const { job, runs, logPath } = await Jobs.get(scopeId, input.slug)
          const log = await Jobs.log(scopeId, input.slug, 50)
          return [
            summary(job),
            `Workdir: ${job.workdir}`,
            `Prompt: ${job.prompt}`,
            job.timeoutSeconds ? `Timeout: ${job.timeoutSeconds}s` : "Timeout: none",
            "Recent runs:",
            ...runs.slice(0, 5).map((run) => `  ${run.startedAt} ${run.status} exit=${run.exitCode ?? "?"} ${Math.round(run.durationMs / 1000)}s`),
            `Log (${logPath}, last 50 lines):`,
            log,
          ].join("\n")
        }),
    })

    editor.add({
      name: "update_job",
      description: "Update a scheduled job's name, schedule, prompt, title, workdir or timeout. Fails while the job is running.",
      input: Schema.Struct({ ...UpdateInput.fields, scopeId: Schema.optional(Schema.String) }),
      execute: (input) =>
        respond(async () => {
          const job = await Jobs.update({ ...input, scopeId: scopeOf(input) })
          return `Updated "${job.name}": ${Cron.describe(job.schedule)}.`
        }),
    })

    editor.add({
      name: "delete_job",
      description: "Delete a scheduled job. Keeps its run history and log. Pass stop=true to stop an active run first.",
      input: Schema.Struct({ ...Ref.fields, stop: Schema.optional(Schema.Boolean) }),
      execute: (input, context) =>
        respond(async () => {
          const scopeId = scopeOf(input)
          await ctx.permission.assert({
            sessionID: context.sessionID,
            agent: context.agent,
            source: { type: "tool", messageID: context.messageID, id: context.id },
            action: "scheduled-jobs.delete",
            resources: [`${scopeId}/${input.slug}`],
          })
          await Jobs.remove(scopeId, input.slug, { stop: input.stop === true })
          return `Deleted ${scopeId}/${input.slug}.`
        }),
    })

    editor.add({
      name: "run_job",
      description: "Start a scheduled job now through launchd. Returns immediately; use get_job to check the result.",
      input: Ref,
      execute: (input) =>
        respond(async () => {
          await Jobs.run(scopeOf(input), input.slug)
          return `Started ${scopeOf(input)}/${input.slug}.`
        }),
    })

    editor.add({
      name: "stop_job",
      description: "Stop a scheduled job's active run.",
      input: Ref,
      execute: (input) =>
        respond(async () => {
          await Jobs.stop(scopeOf(input), input.slug)
          return `Stopped ${scopeOf(input)}/${input.slug}.`
        }),
    })

    editor.add({
      name: "pause_job",
      description: "Pause a scheduled job without deleting it. Pass stop=true to stop an active run first.",
      input: Schema.Struct({ ...Ref.fields, stop: Schema.optional(Schema.Boolean) }),
      execute: (input) =>
        respond(async () => {
          await Jobs.pause(scopeOf(input), input.slug, { stop: input.stop === true })
          return `Paused ${scopeOf(input)}/${input.slug}.`
        }),
    })

    editor.add({
      name: "resume_job",
      description: "Resume a paused scheduled job.",
      input: Ref,
      execute: (input) =>
        respond(async () => {
          await Jobs.resume(scopeOf(input), input.slug)
          return `Resumed ${scopeOf(input)}/${input.slug}.`
        }),
    })
  })
}
