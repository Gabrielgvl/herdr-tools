---
name: oracle
description: "Oracle second-model review: bundle prompts/files, debug, refactor, design."
---

# Oracle (CLI) — best use

## Routing

Use Oracle for critical-plan reviews. Treat a plan as critical when it is explicitly marked critical or when it covers an irreversible or high-blast-radius architecture, security or IAM, infrastructure or deployment, production, or data-migration decision. Ordinary plan reviews and code reviews use `pi-review` instead.

## Mandatory simplicity instruction

Every prompt sent to Oracle must explicitly include this instruction:

> Recommend the simplest correct solution that fully satisfies the stated requirements. Avoid overengineering, speculative abstractions, unnecessary configuration, compatibility layers, and broad refactors. Prefer existing code and dependencies, deletion, native platform features, and the smallest root-cause change. Do not simplify away validation at trust boundaries, data-loss prevention, security, accessibility, error handling, or anything explicitly requested.

Oracle bundles a prompt and selected files into a one-shot request so another
model can answer with real repository context through the API or browser. A
prompt is required; attach files only when they add necessary context. Treat
responses as advisory and verify them against the codebase and tests.

## Gabriel's deployment: remote Oracle service on the Mac

This section overrides the local-browser examples below for Gabriel's agents.
The Linux-side agent assembles the prompt and files; the Mac owns Chrome, the
signed-in ChatGPT session, cookies, and browser automation through `oracle serve`.

- Preferred endpoint: `gabriels-macbook-pro.piranha-palermo.ts.net:9473` over Tailscale.
- Prefer the user-level `~/.oracle/config.json` fields
  `engine: "browser"`, `browser.remoteHost`, and `browser.remoteToken`; then omit
  `--remote-host` and `--remote-token` from ordinary commands.
- Keep the remote token only in the mode-`0600` user config or
  `ORACLE_REMOTE_TOKEN`. Never place it in a skill, prompt, `AGENTS.md`, shell
  example, log, repository, or CLI argv.
- Oracle 0.18.0 resolves remote routing as CLI flags >
  `config.browser.remoteHost`/`remoteToken` > environment. Merely exporting
  `ORACLE_REMOTE_HOST`/`ORACLE_REMOTE_TOKEN` does not override a conflicting
  `$ORACLE_HOME_DIR/config.json`. For automated runners that load a nonstandard
  application config, point `ORACLE_HOME_DIR` at a private (`0700`), empty,
  per-run directory and pass the validated host/token through the environment;
  this also keeps the token out of process listings. Verify the real resolver
  with an offline `--dry-run` containing a hostile ambient `config.json`.
- Do not add `--browser-manual-login` on the Linux client: the Mac service owns
  the authenticated browser lifecycle.
- Do not silently fall back to a local browser when the Mac service is down.
  Report the remote-service blocker instead.
- Use `--engine browser` explicitly so an API key in the caller environment
  cannot redirect the run to a billable API path.

The Linux client and Mac service are validated together on Oracle `0.18.0`.
The Mac service uses its own isolated persistent profile at
`/Users/gabrieldelima/.oracle-authenticated-browser` and exposes the authenticated
`/health` endpoint on port `9473`. Never point Oracle at
`/Users/gabrieldelima/.hermes-authenticated-browser`: that profile is owned by the
job-autopilot browser manager, whose deterministic cleanup may stop its exact-profile
Chrome process. Use the upstream GPT-5.6
commands below. Before a run, fail fast if `oracle --version` differs between the
client and `/health.version`; update both sides together rather than applying a
compatibility fallback.

A live remote run on this deployment successfully used `gpt-5.6-sol` with
`--browser-thinking-time extra-high`. Explicit `--browser-thinking-time pro`
must fail closed unless the exact selected `Pro` label and verified Sol model are
freshly observed before submission. English `Pro, 5 of 5` and Portuguese
`Pro, 5 de 5` qualify because the selected label is exact; position alone never
proves Pro. Do not bypass this gate or silently downgrade a Pro request.

### macOS passkey and picker regressions

- The Portuguese Intelligence picker may expose effort as a five-position slider instead of separate effort chips. If a Pro run fails closed with `chip not found` and the diagnostic shows `Extra alto, 4 de 5`, do not downgrade or bypass evidence. On the isolated Oracle tab only, focus the slider's `role="menuitem"` with `aria-label="Potência"`, send one trusted `ArrowRight`, and require all of: slider `aria-valuenow="4"` equals `aria-valuemax="4"`, fresh text `Pro, 5 de 5`, selected `GPT-5.6 Sol` radio, then a closed-menu composer pill exactly `Pro`. Position alone is insufficient. Retry the same deterministic synthesis slug only when the failed attempt was pre-submit.
- Launch the isolated manual-login Chrome through macOS LaunchServices (`open -na ... --args`), not a raw spawned Chromium root. Preserve the Oracle profile, and do not copy passkeys or profile files. Avoid `--use-mock-keychain`, `--password-store=basic`, `--disable-sync`, and unrelated extension-disable flags; they can make passkeys unavailable even though Bluetooth and macOS permissions are correct.
- A GPT-5.6 Sol `extra-high` run must not enter the strict Pro-evidence path. The browser implementation has both an initial selection assertion and a fresh pre-submit assertion. Gate both on `thinkingTime === "pro"`. If Extra High fails with `requested effort Pro`, test the direct assertion and the submission wrapper separately before redeploying.
- Verify a repair with a real remote canary and stored session evidence: completed status, requested `thinkingTime`, `resolvedLabel: "GPT-5.6 Sol"`, `modelSelection.verified: true`, and the persisted transcript marker.

### Remote concurrency and recovery

- The Mac bridge admits concurrent HTTP runs; the browser lease registry permits at most three ChatGPT tabs. Additional runs wait for a lease instead of returning global `busy`. Queue order follows lease acquisition races, so the waiter is not necessarily the fourth process launched.
- Before reinstalling or restarting the service, inspect established connections on port `9473` and identify their local Oracle PIDs/slugs. Do not interrupt an active Herdr manager run. Stage the package first, then restart only after the bridge is quiescent.
- A stale `chatgpt.com/` target with `document.readyState=loading` and no composer can cause `Page did not reach ready state in time`. Inspect every CDP target and close only the exact stale target; preserve completed conversations and the authenticated profile.
- ChatGPT can leave `[data-testid=stop-button]` active after the expected answer is already visible. Treat that as a provider-stream stall, not evidence that bridge concurrency failed. If the client becomes orphaned, identify the exact canary target by its unique marker, close only that target, and verify both the server-side failed-run/released-lease log and `/status` health before continuing.
- Capture service output with a private Screen logfile when debugging crashes, and redact the access token from every displayed command or log.

## Main use case (browser, GPT-5.6)

Use browser mode with GPT-5.6 when the ChatGPT account exposes it. `GPT-5.6 Sol`
is the model; Extra High and Pro are distinct effort levels in the Intelligence
picker, not separate model IDs. Use `--model gpt-5.6-sol` for both and select the
effort explicitly with `--browser-thinking-time extra-high|pro`.

Recommended defaults:

- Engine: browser (`--engine browser`)
- Base Sol: `--model gpt-5.6-sol`
- Base Sol maximum reasoning: `--browser-thinking-time extra-high` (Extra High)
- Explicit Pro effort on GPT-5.6 Sol: `--browser-thinking-time pro` (fails closed if Pro cannot be confirmed)
- Browser GPT-5.5 with Pro effort: `--model gpt-5.5 --browser-thinking-time pro`
- API Pro maximum reasoning: `--model gpt-5.6-sol --reasoning-mode pro --reasoning-effort max`
- Fallback: explicitly use `--model gpt-5.5-pro` when GPT-5.6 is unavailable
- Attachments: directories/globs plus excludes; never attach secrets by default

GPT-5.6 availability is account-dependent. Confirm the base Sol picker and
retain model-selection evidence. A bare `Pro` picker label proves picker
selection but does not, by itself, prove the server-side Pro generation.

## GPT-5.6 model selection

This version supports GPT-5.6 on both surfaces, but Pro selection differs:

- `gpt-5.6`: follow the GPT-5.6 family default
- `gpt-5.6-sol`: pin ChatGPT's `GPT-5.6 Sol` entry
- Browser: `gpt-5-pro` selects ChatGPT's `Pro` target
- API: `--reasoning-mode pro` enables Pro execution on `gpt-5.6-sol`; pair it with `--reasoning-effort max` for maximum reasoning

For base Sol, use:

```bash
oracle --engine browser --browser-manual-login --model gpt-5.6-sol \
  --browser-thinking-time extra-high \
  -p "<task>" --file "src/**"
```

For GPT-5.6 Sol Pro through the Responses API, use:

```bash
oracle --engine api --model gpt-5.6-sol \
  --reasoning-mode pro \
  --reasoning-effort max \
  -p "<task>" --file "src/**"
```

Do not use `--model "GPT-5.6 Sol Pro"`. Pro is intentionally handled as a
browser picker target and an API reasoning mode. Browser label validation rejects unknown future
variants such as `gpt-5.6-luna` instead of silently falling back to Sol; API
runs preserve such provider model IDs unchanged.

Browser mode maps these aliases to ChatGPT's Sol picker. API and multi-model
runs preserve the corresponding first-party OpenAI model IDs; provider-qualified
and unrelated custom IDs remain pass-through values.

The GPT-5.6 browser support depends on the unified Intelligence picker. It
recognizes the current English and Chinese effort labels, avoids matching
`高` inside `极高`, and re-queries the composer pill after React replaces it so
selection verification cannot rely on a detached stale node.

## Golden path

1. Pick the smallest file set that still contains the truth.
2. Preview the bundle with `--dry-run` and `--files-report`.
3. Use browser mode for GPT-5.6; use API only when explicitly intended.
4. If a run detaches or times out, reattach to the stored session instead of
   starting a duplicate.

## Commands

- Show help:
  - `npx -y @steipete/oracle --help --verbose`

- Preview without calling a model:
  - `npx -y @steipete/oracle --dry-run summary -p "<task>" --file "src/**" --file "!**/*.test.*"`
  - `npx -y @steipete/oracle --dry-run full -p "<task>" --file "src/**"`

- Inspect token usage:
  - `npx -y @steipete/oracle --dry-run summary --files-report -p "<task>" --file "src/**"`

- Browser run:
  - `oracle --engine browser --browser-manual-login --model gpt-5.6-sol --browser-thinking-time extra-high -p "<task>" --file "src/**"`

- Manual paste fallback:
  - `npx -y @steipete/oracle --render-markdown --copy-markdown -p "<task>" --file "src/**"`
  - `--render` is an alias for `--render-markdown`.

- Performance trace:
  - `npx -y @steipete/oracle --perf-trace --perf-trace-path /tmp/oracle-perf.json --dry-run summary -p "<task>" --file "src/**"`

## Attaching files

`--file` accepts files, directories, and globs. Pass it multiple times or use
comma-separated entries.

- Include: `--file "src/**"`, `--file src/index.ts`, `--file docs --file README.md`
- Exclude: prefix a pattern with `!`, for example `--file "!src/**/*.test.ts"`
- Default ignored directories: `node_modules`, `dist`, `coverage`, `.git`,
  `.turbo`, `.next`, `build`, and `tmp`
- Globs honor `.gitignore` and do not follow symlinks.
- Dotfiles require an explicit dot-segment in the pattern, such as
  `--file ".github/**"`.
- Files over 1 MB are rejected by default; configure
  `ORACLE_MAX_FILE_SIZE_BYTES` or `maxFileSizeBytes` when necessary.

Keep total input under roughly 196k tokens. Use `--files-report` or
`--dry-run json` to identify oversized inputs. Never attach `.env` files,
private keys, auth tokens, or other secrets unless they have been redacted and
are essential to the question.

## Engines and browser controls

- Auto-selection uses API when `OPENAI_API_KEY` is set and browser otherwise.
- Browser supports GPT models through ChatGPT and Gemini models through Gemini
  web. API-only models include `gpt-5.1-codex`.
- Current model families include GPT-5.5/5.4/5.2/5.1, Gemini 3.x, and Claude
  4.x; availability depends on engine and provider.
- API runs require explicit user consent because they may incur usage costs.
- Browser attachments use `--browser-attachments auto|never|always`.
- For many files, add `--browser-bundle-files --browser-bundle-format auto|zip`.
- Reuse an existing Chrome session with `--browser-tab <ref>`,
  `--browser-attach-running`, or `--remote-chrome <host:port>`.
- Use `--browser-model-strategy select|current|ignore` to control picker
  behavior.
- Use `--browser-follow-up "<prompt>"` for another turn in the same browser
  conversation, or `--followup <sessionId|responseId>` for a stored run.
- Use `--browser-research deep` only when Deep Research is explicitly wanted.

## API preflight

Before an API run, check provider readiness without printing secrets:

```bash
oracle doctor --providers --models gpt-5.4,claude-4.6-sonnet,gemini-3-pro
oracle --preflight --models gpt-5.4,gemini-3-pro
oracle --route --model gpt-5.4
```

Use `--provider openai` or `--no-azure` when first-party OpenAI routing is
required. For multi-model panels where partial success is useful, use
`--allow-partial --write-output <path>` so successful outputs and the manifest
can be recovered.

Set an explicit deadline for automation, for example `--timeout 10m`; Oracle
derives the HTTP timeout unless `--http-timeout` is supplied.

## Sessions and recovery

- Sessions are stored under `~/.oracle/sessions`; override with
  `ORACLE_HOME_DIR`.
- Browser artifacts include `transcript.md` and, when available, research
  reports and generated images.
- List recent sessions with `oracle status --hours 72`.
- Attach with `oracle session <id> --render`.
- Use `--slug "<3-5 words>"` for readable session IDs.
- If a run times out, reattach; do not re-run it. Use `--force` only when a
  genuinely new identical run is intended.
- Successful non-project browser one-shots are archived automatically by
  default; override with `--browser-archive never|always`.

## Prompt template

Oracle starts with zero project knowledge. Include:

- Project briefing: stack, services, build/test commands, and platform constraints
- Where things live: entrypoints, configs, key modules, and dependency boundaries
- Exact question, prior attempts, and verbatim error text
- Constraints such as API compatibility, performance budgets, and files not to change
- Desired output such as a patch plan, tests, risk list, or tradeoff comparison

For a long investigation, make the prompt restorable: put a 6–30 sentence
briefing at the top, concrete reproduction and errors in the middle, and attach
all context files required by a fresh model at the bottom. Oracle runs are
one-shot; the model does not remember prior runs.

## Always ask for simplifications (ruling `oracle-always-ask-for-simplifications`, owner 2026-09-04)

Every Oracle request carries an explicit numbered question asking for **the simplest sufficient design and what can be REMOVED**, not only a list of defects. Report those simplifications next to the verdict.

When Oracle is required for a critical plan or explicitly selected for a design consult, use it before the implementation brief rather than after machinery has been designed or built. Record Oracle's recommended minimum, deletions, and rejected complexity, then make those the implementation boundary.

A consult is cheap and differently shaped from a review: use a short prompt, the fewest files that contain the truth, and questions such as "is this needed?", "what is the smallest root-cause fix?", and "what can be removed?" Cap the requested answer near 1,500 words.

## Operational facts for browser runs (verified 2026-09-03/04, this deployment)

- **Sessions persist no ChatGPT conversation URL.** `oracle --followup <slug>` fails with "does not contain a ChatGPT conversation URL", and run-time `--browser-follow-up` is unavailable once a run completes. A follow-up is therefore a **fresh Pro one-shot with the prior run's `transcript.md` attached** — the same carry-forward pattern successive review rounds already use. This is not a re-run of an answered question, so the reattach-never-rerun rule does not bind.
- **Many attachments need a longer upload window.** With ~10 attachments (~264 KB) the composer send button never became clickable inside the default 45 s and the run failed **pre-submit** (nothing submitted, no Pro downgrade). `ORACLE_BROWSER_ATTACHMENT_TIMEOUT=5m` fixes it; the flag is absent from `--help` but maps to `browserConfig.attachmentTimeoutMs` and is allowlisted by the Mac service. Set it from the start on any multi-attachment run. A pre-submit failure is the one case where retrying the same deterministic slug is sanctioned.
- **Oracle auto-bundles large attachment sets** (observed at 14 files / ~376 KB) into a single concatenated text document with per-file delimiters, without `--browser-bundle-files`. It still verifies per-file SHA-256 pins; say so in the report rather than dropping evidence to stay under the threshold.
- **Pro evidence has two shapes.** The literal `Pro, 5 of 5` / `Pro, 5 de 5` string is emitted only on the pt-BR slider path. On the already-selected chip path the evidence is `thinkingTime: "pro"` in the session config plus `modelSelection{resolvedLabel:"GPT-5.6 Sol", verified:true, source:"chatgpt-model-picker"}` and the picker line "Thinking time: Pro (already selected)". Absence of the literal string is **not** a downgrade; Oracle's own fail-closed gate not tripping is the signal that matters. Record whichever shape appeared.
- **Pin every attachment by SHA-256 immediately before the run** and re-pin from the current head when code moved; a stale pin invalidates the whole review's grounding.
