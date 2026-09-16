# opencode-session-cost

Accurate token & cost tracking for [opencode](https://opencode.ai). Shows a toast at the end of every chat turn with:

- Wall-clock time the turn took
- Input tokens (with cache reads) and output tokens (including reasoning)
- Cost of the turn and cumulative session cost

Numbers come straight from opencode's own per-message accounting (`message.updated` events), so they match what your provider billed.

## Install

### Option A — project-local copy

Copy `src/index.ts` into your project:

```
.opencode/plugin/session-cost.ts
```

It is auto-loaded at startup, no config needed.

### Option B — config reference

Point your `opencode.json` at this repo directly:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["D:/Projects/opencode-plugins/session-cost/src/index.ts"]
}
```

(Relative paths work too, e.g. `"../opencode-plugins/session-cost/src/index.ts"`.)

### Option C — npm

```json
{
  "plugin": ["opencode-session-cost"]
}
```

## Options

Passed via the tuple form:

```json
{
  "plugin": [
    ["D:/Projects/opencode-plugins/session-cost/src/index.ts", { "toastDuration": 5000 }]
  ]
}
```

| Option             | Default        | Description                                        |
| ------------------ | -------------- | -------------------------------------------------- |
| `toastDuration`    | `8000`         | How long the toast stays visible (ms)               |
| `showTime`         | `true`         | Show per-turn wall-clock time                       |
| `showSessionTotals`| `true`         | Show cumulative session line                        |
| `pricingUrl`       | models.dev API | Where to fetch per-model pricing from               |
| `pricingRefreshMs` | `21600000`     | Pricing re-fetch interval (6h)                      |
| `rates`            | —              | Rate overrides, `"provider/model": { input, output, cache_read, cache_write }` per 1M tokens |
| `useReportedCost`  | `false`        | Use opencode's reported cost instead of recomputing |

## Pricing accuracy

Cost is **recomputed from raw tokens × rates**, not taken from opencode, so
stale pricing data can't silently skew your totals:

1. Your `rates` option overrides (highest priority)
2. Built-in corrections for models where models.dev is known wrong
   (currently `zai/glm-5.3-flash`, which models.dev lists at half of Z.AI's
   official price)
3. Live pricing fetched from [models.dev](https://models.dev) at startup and
   refreshed every 6 hours
4. If no rate is found: opencode's own reported cost (fallback)

When the recomputed cost differs from opencode's reported number by more than
2%, the toast shows both so you can spot drift. Rates are USD per 1M tokens.

For GLM-5.3-Flash you should also override the rates in `opencode.json` so
opencode's *own* displays are correct too (the plugin can't change those):

```json
{
  "provider": {
    "zai": {
      "models": {
        "glm-5.3-flash": {
          "cost": { "input": 0.15, "output": 0.5, "cache_read": 0.03, "cache_write": 0 }
        }
      }
    }
  }
}
```

(Rates per 1M tokens, from https://docs.z.ai/guides/overview/pricing, verified
2026-09-17. If you're on a GLM Coding Plan subscription you aren't billed per
token — these are API-equivalent prices.)

## Notes

- Subagent (task) sessions are tracked but don't pop toasts, to keep the TUI quiet.
- Session totals reset when opencode restarts (they are tracked in memory per run).
