---
name: oracle
description: "Use only when Gabriel explicitly requests an Oracle review or remote Mac canary."
---

# Oracle (CLI) — best use

## Routing

Invoke Oracle only when Gabriel explicitly requests Oracle for the current
task. Never infer authorization from criticality, risk, complexity, or review
type. Without an explicit Oracle request, use `pi-review` for code and plan
reviews: `pi-review <number|#N|url>` reviews a PR, `pi-review <file>` reviews
a plan document, and bare `pi-review` reviews the current branch's committed
change.

## Mandatory two-track solution instruction

Every prompt sent to Oracle must explicitly include this instruction:

> Produce and compare two concrete solutions:
>
> 1. **Current-system path:** Recommend the simplest correct solution that fully satisfies the stated requirements within the existing architecture. Avoid overengineering, speculative abstractions, unnecessary configuration, compatibility layers, and broad refactors. Prefer existing code and dependencies, deletion, native platform features, and the smallest root-cause change.
> 2. **Greenfield path:** Independently design the best solution you would choose if the system were being built today without constraints from the current implementation. Respect the stated product, platform, security, data-integrity, and operational requirements, but do not preserve existing architecture merely because it exists. Keep this design concrete enough to implement, not an aspirational rewrite.
>
> Compare both paths on correctness, complexity, maintainability, extensibility justified by known requirements, operational burden, performance, delivery risk, and migration/cutover cost. State which path you recommend and the evidence or threshold that would make the other path preferable. Do not automatically choose the fastest path when the greenfield design is materially better long term. Do not simplify away validation at trust boundaries, data-loss prevention, security, accessibility, error handling, or anything explicitly requested.

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
- Oracle 0.21.3 resolves remote routing as CLI flags >
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

The Linux client and Mac service are currently validated together on Oracle `0.21.3`.
Treat that as an observed deployment version, not a permanent pin: before every run,
require exact client/server equality and update both sides together when upgrading.
The Mac service uses its own isolated persistent profile at
`/Users/gabrieldelima/.oracle-authenticated-browser` and exposes the authenticated
`/health` endpoint on port `9473`. Never point Oracle at
`/Users/gabrieldelima/.hermes-authenticated-browser`: that profile is owned by the
job-autopilot browser manager, whose deterministic cleanup may stop its exact-profile
Chrome process. Gabriel's current approved browser target is **ChatGPT Latest with Extra High**:
`--model gpt-6 --browser-thinking-time extra-high`. In the localized picker, the
Latest option is displayed as `Recente`; this is model evidence, while `Extra alto`
is only effort evidence. Extra High is the default. Escalate the same `gpt-6` run to
Pro with `--browser-thinking-time pro` only when the assignment or owner explicitly
requires Pro. Pro consumes a separate limited quota; complexity alone is not
authorization, and an agent must never infer permission from task scope or a failed
Extra High run.
Before a run, fail fast if `oracle --version` differs between the client and
`/health.version`; update both sides together rather than applying a compatibility
fallback. Also run a no-cost parser probe for the exact Latest command. Never
silently fall back to GPT-5.6 Sol, Pro, API, or a local browser.

Preflight is one bounded gate. On failure, report and stop; do not hunt builds, reinstall, restart, or
poll inside the review. Repair is separate owner-authorized work, and review resumes only after fresh
version equality and parser proof.

### macOS passkey, picker, and remote-browser regressions

- A remote service started with `--manual-login` may launch a visible persistent-profile Chrome even when the Linux request asks for `--browser-hide-window`. The Oracle task requires that exact window to remain open until completion; closing it produces `Chrome window closed before oracle finished`. Do not close or repurpose it mid-run. If picker automation fails before submit, retry the same request at most once with the CLI-suggested strategy only when the already-selected model is independently known; never use `current` to bypass required model evidence.
- In Oracle 0.21.3, `--browser-research search|deep` is a local-browser pilot and is rejected with `--remote-host`. Do not add it to Gabriel's remote bridge commands; attach current official sources instead. Use `--browser-inline-files` for small text-only packets when attachment upload readiness stalls, and keep total inline content comfortably below the CLI's ~60k-character threshold.

- `Entendido` alongside real options (`Recente`, `GPT-5.6 Sol`, etc.) can be the Portuguese request-rate modal, not a coachmark or matcher bug. Inspect the dialog text: `Excesso de solicitações`, `solicitações rápido demais`, or `Limitamos temporariamente o acesso às suas conversas` is a real transient throttle. Detect it as `chatgpt-throttled`, do not dismiss/bypass it, close orphan tabs, wait for cooldown, and retry only a claim proven pre-submit. Keep `Latest`/`Recente`; do not add a model fallback.
- Hidden macOS runs have three independent focus paths. A Linux-side `--browser-hide-window` is insufficient because the remote service strips client host-control fields. Start the Mac host with `oracle serve --browser-hide-window`, and resolve serve options with Commander's `optsWithGlobals()`—when the same option exists globally and on `serve`, the action's child-only options report `browserHideWindow=false` even though argv contains the flag. Launch headful Chrome through LaunchServices with `open -g -n ... --args` plus the off-screen position; raw Chrome spawn activates the app. Create isolated tabs with browser-level `Target.createTarget({ background: true })`; the `/json/new`/`CDP.New` endpoint activates even an already-running off-screen Chrome. Do not call `Page.bringToFront()` before trusted clicks. Verify with a live frontmost-app monitor spanning both a fresh service/Chrome launch and a complete Oracle request; process argv or off-screen geometry alone is not proof. For batch reviewers, use one active session and keep starts at least 600 seconds apart; 300-second starts empirically triggered the Portuguese rate modal on roughly every third request.
- The Portuguese Intelligence picker may expose effort as a five-position slider instead of separate effort chips. If a Pro run fails closed with `chip not found` and the diagnostic shows `Extra alto, 4 de 5`, do not downgrade or bypass evidence. First check `trailingCount` in the picker diagnostic JSON: `chip not found` with `trailingCount: 0` means the effort pill itself was never claimed — an entry-button localization gap (next bullet), not a slider-selection problem; the ArrowRight slider workaround does not apply and will not help. Only when the pill was claimed does the slider workaround apply: on the isolated Oracle tab only, focus the slider's `role="menuitem"` with `aria-label="Potência"`, send one trusted `ArrowRight`, and require all of: slider `aria-valuenow="4"` equals `aria-valuemax="4"`, fresh text `Pro, 5 de 5`, selected `Latest` or `Recente` radio, then a closed-menu composer pill exactly `Pro`. Position alone is insufficient. Retry the same deterministic synthesis slug only when the failed attempt was pre-submit.
- Entry-button localization gap (observed 2026-09-02, PT UI): the effort opener button can be labeled `Esforço de raciocínio` (localized; the English pill bears the `thinking` token). `findComposerEffortPill` claims a pill only via the token `thinking`, a pure effort-tier label, or Pro-model context, so this localized pill is never claimed; the run falls to the legacy trailing path (`trailingCount: 0`) and dies `chip not found` before any slider fix is reached. The in-expression `normalize()` also does not fold Latin accents (only ä/ö/ü/ß), so `esforço` becomes `esfor o` — adding a Portuguese token alone is NOT enough; accent folding must be added too. The root-cause fix belongs in the picker's pill matcher + normalize, not in the slider logic. The fix has THREE layers, not two: pill tokens, accent folding, AND PT tier tokens in `LEVEL_TOKENS` — an extra-high run failing `selection-unverified` on an open slider is the tier-token layer ("Extra alto" has no accent; accent folding does not fix it).
- Python runner deployment pitfall: `uv pip install --reinstall .` may hardlink packaged prompt templates from uv's cache, while the fail-closed runner requires `st_nlink == 1`; the CLI then reports only `review failed` before any Oracle request. Install with `uv pip install --link-mode=copy --reinstall .` and verify both installed `prompts/*.md` have link count 1 before a live run.
- Deployment clobber between private builds (observed 2026-09-02): two diverged private fix branches were each deployed to the Mac, and the later install silently reverted the earlier one's fixes because its base predated them. `oracle --version` and `/health` parity (both `0.18.0`) does NOT prove code parity between private builds. After any Mac redeploy, grep the deployed dist over SSH (read-only) for the specific fix markers of ALL known private fixes (e.g. `thinkingTime !== "pro"` guard, `(?:of|de)` ordinal regex, PT tier tokens). Before building a new private Oracle build, run `git worktree list` and check every other private fix branch for commits your base lacks (`git log <base>..<branch> --oneline`); merge or rebase them in first, or ship them together.
- Live canary vs offline validation: the unit-test fixtures use English labels (`"Power"`, `"High, 3 of 5"`), so a green offline suite does NOT prove localized entry buttons are recognized. A picker-localization fix is only verified by a real remote canary reaching the picker (watch `modelButton.text`/`trailingCount` in the diagnostic). Canaries that abort with `ETIMEDOUT` before submission validated nothing.
- Launch the isolated manual-login Chrome through macOS LaunchServices (`open -g -n -a ... --args`), not a raw spawned Chromium root; `-g` is required to avoid activation. Preserve the Oracle profile, and do not copy passkeys or profile files. Avoid `--use-mock-keychain`, `--password-store=basic`, `--disable-sync`, and unrelated extension-disable flags; they can make passkeys unavailable even though Bluetooth and macOS permissions are correct.
- A Latest `extra-high` run must not enter the strict Pro-evidence path. The browser implementation has both an initial selection assertion and a fresh pre-submit assertion. Gate both on `thinkingTime === "pro"`. If Extra High fails with `requested effort Pro`, test the direct assertion and the submission wrapper separately before redeploying.
- Verify a repair with a real remote canary and stored session evidence: completed status, requested `thinkingTime: "extra-high"`, a fresh `Latest`/`Recente` resolved label, `modelSelection.verified: true`, and the persisted transcript marker.

### Mac sleep vs canary gating

This is a bounded setup step before Oracle preflight, not recovery from a failed
preflight. If the Mac is known to be asleep, wake it before starting preflight;
once preflight starts, any `ETIMEDOUT` is reported and stops the run. To wake it:
when `wakeonlan`/`etherwake` are absent from the host, send the magic packet
with a stdlib one-liner (`python3` broadcasting `b'\xff'*6 +
bytes.fromhex('b0be83724a3f')*16` to `192.168.15.255:9`), then poll SSH for
~60s — verified working. Note WOL wakes the Mac but the lid stays closed
(`AppleClamshellState` still `Yes`): the canary can only run once the lid is
physically opened. Gate the canary on BOTH
conditions, not just reachability: SSH reachable AND `AppleClamshellState` lid
open AND the `oracle serve` listener (port 9473) up. Then start a short
`caffeinate -dimsu` on the Mac immediately before the run. Pitfall when
probing the lid state over SSH: the remote awk command embedded in a
single-quoted bash script needs exactly ONE backslash before `$2`
(`print \$2`); double-escaping (`\\$2`) silently yields an empty value, so the
gate never fires and the monitor loops forever. Test the exact inner command
standalone before leaving a long-running monitor.

### Remote concurrency and recovery

- The Mac bridge admits concurrent HTTP runs; the browser lease registry permits at most three ChatGPT tabs. Additional runs wait for a lease instead of returning global `busy`. Queue order follows lease acquisition races, so the waiter is not necessarily the fourth process launched.
- Picker overlays can silently restore the old server-level single-flight guard even while the browser registry still reports `3 max`. Before deploying an overlay, require zero `let busy = false`/HTTP `busy` markers in `dist/src/remote/server.js`; after deployment, prove a peak of three established runs, three isolated results, and released leases.
- Before reinstalling or restarting the service, inspect established connections on port `9473` and identify their local Oracle PIDs/slugs. Do not interrupt an active Herdr manager run. Stage the package first, then restart only after the bridge is quiescent.
- A stale `chatgpt.com/` target with `document.readyState=loading` and no composer can cause `Page did not reach ready state in time`. Inspect every CDP target and close only the exact stale target; preserve completed conversations and the authenticated profile.
- ChatGPT can leave `[data-testid=stop-button]` active after the expected answer is already visible. Treat that as a provider-stream stall, not evidence that bridge concurrency failed. If the client becomes orphaned, identify the exact canary target by its unique marker, close only that target, and verify both the server-side failed-run/released-lease log and `/status` health before continuing.
- Capture service output with a private Screen logfile when debugging crashes, and redact the access token from every displayed command or log.

## Main use case (browser, ChatGPT Latest Extra High)

Use browser mode with ChatGPT Latest and Extra High for Gabriel's Oracle work. Model
and effort are separate invariants: use `--model gpt-6` (mapped to the localized
`Latest`/`Recente` picker option) and `--browser-thinking-time extra-high`. Pro is
not the default because it consumes a separate limited quota.

Recommended defaults:

- Engine: browser (`--engine browser`)
- Model: `--model gpt-6` → ChatGPT `Latest` / `Recente`
- Effort: `--browser-thinking-time extra-high`
- Exceptional-complexity escalation: `--browser-thinking-time pro`
- Attachments: directories/globs plus excludes; never attach secrets by default
- No fallback: do not switch models, use a paid API, or use a local browser; Pro is only the deliberate escalation above

Before long work, require a no-cost parser probe and one bounded live canary
proving the localized `Latest`/`Recente` model label plus Extra High effort. A
selected effort label alone is not model evidence. Do not use
`--browser-model-strategy current` to bypass model verification.

Use:

```bash
oracle --engine browser --model gpt-6 \
  --browser-thinking-time extra-high \
  -p "<task>" --file "src/**"
```

Do not infer an API model ID or Pro mapping from the browser label. Use an API
route only when Gabriel explicitly requests it and the provider exposes a
verified contract.

## Golden path

1. Pick the smallest file set that still contains the truth.
2. Preview the bundle with `--dry-run` and `--files-report`.
3. Use browser mode with ChatGPT Latest Extra High; use API only when explicitly intended.
4. If a run detaches or times out, reattach to the stored session instead of
   starting a duplicate.

## Commands

- Show help:
  - `npx -y @steipete/oracle --help --verbose`

- Preview without calling a model:
  - `npx -y @steipete/oracle --dry-run summary -p "<task>" --file "src/**" --file "!**/*.test.*"`

- Preview full bundle:
  - `npx -y @steipete/oracle --dry-run full -p "<task>" --file "src/**"`

- Inspect token usage:
  - `npx -y @steipete/oracle --dry-run summary --files-report -p "<task>" --file "src/**"`

- Browser run:
  - `oracle --engine browser --model gpt-6 --browser-thinking-time extra-high -p "<task>" --file "src/**"`

- Manual paste fallback:
  - `npx -y @steipete/oracle --render-markdown --copy-markdown -p "<task>" --file "src/**"`
  - `--render` is an alias for `--render-markdown`.

- Performance trace:
  - `npx -y @steipete/oracle --perf-trace --perf-trace-path /tmp/oracle-perf.json --dry-run summary -p "<task>" --file "src/**"`

## Attaching files

`--file` accepts files, directories, and globs. Pass it multiple times or use
comma-separated entries.

- Include: `--file "src/**"`, `--file src/index.ts`, `--file docs --file README.md`
- Exclude: prefix a pattern with `!`, for example `--file "!src/**/*.test.*"`
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
- For automated review pipelines, use `--browser-archive always` for disposable
  batch chats only after local artifacts are saved; keep synthesis chats on
  `never` when they remain useful. Require verified archive or already-archived
  UI evidence rather than trusting a click or navigation alone.

## Prompt template

Oracle starts with zero project knowledge. Include:

- Project briefing: stack, services, build commands, and platform constraints
- Where things live: entrypoints, configs, key modules, and dependency boundaries
- Exact question, prior attempts, and verbatim error text
- Constraints such as API compatibility, performance budgets, and files not to change
- Desired output such as a patch plan, tests, risk list, or tradeoff comparison

For a long investigation, make the prompt restorable: put a 6–30 sentence
briefing at the top, concrete reproduction and errors in the middle, and attach
all context files required by a fresh model at the bottom. Oracle runs are
one-shot; the model does not remember prior runs.
