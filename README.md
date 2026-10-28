# opencode-scheduled-jobs

Run OpenCode prompts on a schedule on macOS, and manage them from the agent or from OpenCode Desktop.

[opencode-scheduler](https://github.com/different-ai/opencode-scheduler) introduced scheduled OpenCode jobs on launchd, but it's an OpenCode V1 plugin and doesn't load in OpenCode V2. This plugin is a V2 replacement that **reads and writes the same files**, so jobs you already scheduled keep running and show up without migration.

- **Agent tools:** `schedule_job`, `list_jobs`, `get_job`, `update_job`, `delete_job`, `run_job`, `stop_job`, `pause_job`, `resume_job`.
- **OpenCode Desktop:** a **Scheduled jobs** side panel with each job's schedule, next run, run history and log. You can create, edit, run, stop, pause and delete jobs from it.
- **Titlebar pill:** shows how many jobs are running or failed, and opens the panel.
- **Settings page and `/jobs` command:** other ways to reach the same panel.

> The OpenCode Desktop plugin API is experimental, so the panel may need updates as OpenCode changes.

## Install

Add the plugin to your **global** OpenCode config. OpenCode Desktop only loads plugin UIs from the global config.

```sh
opencode plugin add opencode-scheduled-jobs
```

Or edit `~/.config/opencode/opencode.jsonc` yourself:

```jsonc
{
  "plugins": ["opencode-scheduled-jobs"],
}
```

If you used `opencode-scheduler`, remove it from your config. Your existing jobs keep running either way, because launchd runs them, not the plugin.

## Use

Ask the agent:

```text
Every weekday at 9:00, summarize yesterday's commits in this repo and write them to notes/daily.md.
```

The agent calls `schedule_job` with a cron expression, the working directory and the prompt. Or open the **Scheduled jobs** panel in OpenCode Desktop and click **New job**.

Each run starts `opencode run` in the job's working directory with your normal configuration. Runs are non-interactive: questions are denied, so write prompts that can finish on their own.

## How it works

Each job is a JSON file plus a launchd agent:

| Path | Contents |
|---|---|
| `~/.config/opencode/scheduler/scopes/<scope>/jobs/<slug>.json` | Job definition and last-run status |
| `~/.config/opencode/scheduler/scopes/<scope>/runs/<slug>.jsonl` | One line per finished run |
| `~/.config/opencode/scheduler/scopes/<scope>/locks/<slug>.json` | Present while a run is active |
| `~/.config/opencode/logs/scheduler/<scope>/<slug>.log` | Run output |
| `~/Library/LaunchAgents/com.opencode.job.<scope>.<slug>.plist` | launchd agent |

The launchd agent runs `scheduler/supervisor.pl`, which takes the lock, runs `opencode run`, enforces the job's timeout and records the run. A scope groups jobs by working directory.

- **Delete** removes the job and its launchd agent. Run history and logs are kept.
- **Pause** unloads the launchd agent without deleting the job. **Resume** loads it again.
- **Stop** ends the active run's process group, the same way the supervisor handles a timeout.
- **Stuck:** a run counts as stuck after its timeout, or after 24 hours when the job has no timeout. Set a timeout on jobs that could hang.

Prompts are stored in plain text in job files and logs. Don't put secrets in them.

## Develop

```sh
bun install
bun run dev        # rebuild the Desktop bundle on change; Desktop reloads it
bun run typecheck
bun test
```

To use a local checkout, put its absolute path in your global config's `plugins`, then run `bun run build`.

To test the server part without changing your global config, create `.opencode/opencode.jsonc` in the checkout (it's gitignored) with the checkout's absolute path in `plugins`. Then call the RPC:

```sh
opencode api post "/api/rpc/scheduled-jobs/list?location%5Bdirectory%5D=$PWD" --data '{"input":{}}'
```

Tests run against a temporary `HOME` with a stub `launchctl`, and refuse to run if any path resolves outside it.

## License

MIT. Includes code from [opencode-scheduler](https://github.com/different-ai/opencode-scheduler), also MIT. See [LICENSE](LICENSE).
