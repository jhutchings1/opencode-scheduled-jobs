import { Schema } from "effect"
import { Rpc } from "@opencode/plugin/rpc"

const standard = Schema.toStandardSchemaV1

const Ref = Schema.Struct({ scopeId: Schema.String, slug: Schema.String })

export const LastRun = Schema.Struct({
  status: Schema.String,
  at: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
})

export const JobView = Schema.Struct({
  scopeId: Schema.String,
  slug: Schema.String,
  readable: Schema.Boolean,
  error: Schema.optional(Schema.String),
  name: Schema.String,
  schedule: Schema.String,
  workdir: Schema.String,
  prompt: Schema.String,
  title: Schema.optional(Schema.String),
  timeoutSeconds: Schema.optional(Schema.Number),
  createdAt: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.String),
  paused: Schema.Boolean,
  running: Schema.Boolean,
  runStartedAt: Schema.optional(Schema.String),
  stuck: Schema.Boolean,
  nextRunAt: Schema.optional(Schema.String),
  lastRun: Schema.optional(LastRun),
})
export type JobView = typeof JobView.Type

export const RunView = Schema.Struct({
  runId: Schema.String,
  startedAt: Schema.String,
  finishedAt: Schema.String,
  durationMs: Schema.Number,
  status: Schema.String,
  exitCode: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
})
export type RunView = typeof RunView.Type

export const CreateInput = Schema.Struct({
  name: Schema.String,
  workdir: Schema.String,
  schedule: Schema.String,
  prompt: Schema.String,
  title: Schema.optional(Schema.String),
  timeoutSeconds: Schema.optional(Schema.Number),
})
export type CreateInput = typeof CreateInput.Type

export const UpdateInput = Schema.Struct({
  scopeId: Schema.String,
  slug: Schema.String,
  name: Schema.optional(Schema.String),
  workdir: Schema.optional(Schema.String),
  schedule: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  timeoutSeconds: Schema.optional(Schema.Number),
})
export type UpdateInput = typeof UpdateInput.Type

const ErrorData = standard(Schema.Struct({ stderr: Schema.optional(Schema.String) }))
const errors = {
  invalid_input: ErrorData,
  invalid_cron: ErrorData,
  slug_exists: ErrorData,
  workdir_missing: ErrorData,
  not_found: ErrorData,
  not_running: ErrorData,
  job_running: ErrorData,
  job_paused: ErrorData,
  launchd_failed: ErrorData,
}
export type ErrorType = keyof typeof errors

const Empty = standard(Schema.Struct({}))
const Ok = standard(Schema.Struct({ ok: Schema.Boolean }))

export const ScheduledJobs = Rpc.define({
  id: "scheduled-jobs",
  methods: {
    list: { input: Empty, output: standard(Schema.Struct({ jobs: Schema.Array(JobView) })) },
    get: {
      input: standard(Ref),
      output: standard(Schema.Struct({ job: JobView, runs: Schema.Array(RunView), logPath: Schema.String })),
      errors,
    },
    log: {
      input: standard(Schema.Struct({ scopeId: Schema.String, slug: Schema.String, lines: Schema.optional(Schema.Number) })),
      output: standard(Schema.Struct({ text: Schema.String })),
      errors,
    },
    create: { input: standard(CreateInput), output: standard(Schema.Struct({ job: JobView })), errors },
    update: { input: standard(UpdateInput), output: standard(Schema.Struct({ job: JobView })), errors },
    remove: { input: standard(Ref), output: Ok, errors },
    run: { input: standard(Ref), output: Ok, errors },
    stop: { input: standard(Ref), output: Ok, errors },
    pause: { input: standard(Ref), output: Ok, errors },
    resume: { input: standard(Ref), output: Ok, errors },
  },
  events: {
    changed: { schema: Empty },
  },
})
