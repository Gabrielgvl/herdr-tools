# Foundation slice acceptance-invariant trace (working notes)

| Criterion | Test(s) | Must happen | Must not happen |
|---|---|---|---|
| Disabled extension is inert | `registration.test.ts` disabled factory | no registration/calls/resources | no Herdr CLI, timers, sockets, UI |
| Enabled registration is exact | `registration.test.ts` enabled factory | exactly inspect + communicate (foundation slice) registrations | no wait/launch/pane/tab/deferred registration |
| CLI authority is narrow and safe | `cli.test.ts` | `pi.exec("herdr", argv, {signal, timeout})`, explicit argv, bounded output | shell strings, guessed IDs, missing signal |
| CLI envelopes are strict | `cli.test.ts` | valid `{id,result}` parsed and bounded | malformed JSON, missing envelope, nonzero exit, stderr/exit evidence discarded |
| Context is explicit | `targets.test.ts` | current resolves injected caller pane; exact ID/label/name only | UI-focused pane, prefix/substring/case matching, inferred IDs |
| Target resolution fails closed | `targets.test.ts` | missing/ambiguous/wrong-kind stable errors | mutation/read after unresolved target |
| Inspect context/default target | `inspect.test.ts` | authoritative single snapshot + recent-unwrapped tail capped to 100 | unbounded transcript, focus/ownership mutation |
| Inspect target | `inspect.test.ts` | exact target resolved before read | fuzzy or wrong-kind target |
| Inspect collection | `inspect.test.ts` | compact authoritative records only | per-item transcript reads |
| Inspect health | `inspect.test.ts` | environment/client/server/socket presence and compatibility | secret/full socket exposure or mutation |
| Communicate prompt | `communicate.test.ts` | read state, refuse working, prompt idle target, verify working post-state | interrupt, confirmation, completion wait, optimistic success |
| Communicate steer | `communicate.test.ts` | named Escape first, prompt second, verify working | raw escape bytes, prompt-before-interrupt, confirmation |
| Communicate keys | `communicate.test.ts` | validate named keys, send only supported names | arbitrary/raw key sequences or confirmation |
| All tool results are truthful | `tui.test.ts` / tool tests | concise content + structured operation/target/outcome/details | raw JSON/transcripts/stderr leak, success-shaped errors |
| Settings foundation | `settings.test.ts` | extension-owned path/default/strict validation and snapshots | project/Pi/tool overrides, coercion/fallback |
| Changed implementation files covered | package coverage gate | 100% statements/branches/functions/lines | unreported uncovered implementation |
