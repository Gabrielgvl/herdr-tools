---
name: executor
description: "Use before calling Executor or any configured MCP integration through the Executor gateway."
---

Treat Executor as the MCP gateway. Configured integrations are not limited to direct namespaces exposed by the host; discover and call them through `executor_execute`.

Before using a domain-specific integration, load the matching local guidance when it exists:

- [Linear MCP](../linear-mcp/SKILL.md) for Linear
- [Notion CLI](../notion-cli/SKILL.md) for Notion
- [Datadog Pup](../datadog-pup/SKILL.md) for Datadog
- [Inbox](../inbox/SKILL.md) for messaging, subscriptions, Redis, or gRPC
- [Send pipeline](../send-pipeline/SKILL.md) for Kinesis, Firehose, event logs, or ClickHouse publishing
- [Courier AWS production](../courier-aws-production/SKILL.md) for production AWS

If no matching skill exists, use the Executor tool description and the normal project gates.

## Discover

Call `executor_skills` with `{ name: "execute" }` before writing Executor code. Inside `executor_execute`, use the lazy `tools` proxy:

```ts
const { items, total, hasMore } = await tools.search({
  query: "github pull requests",
  limit: 12,
});
```

Use short intent-based queries. If `hasMore` is true, search again with the returned `nextOffset`. Use the exact returned `path`; do not guess tool names.

Inspect a candidate before calling it:

```ts
const details = await tools.describe.tool({ path: items[0].path });
```

The descriptor provides the input and output TypeScript shapes. Call the exact path dynamically:

```ts
const result = await tools[items[0].path](input);
if (!result.ok) return { ok: false, error: result.error };
return result.data;
```

## Check availability

For the configured MCP inventory, call:

```ts
const result = await tools["executor.coreTools.connections.list"]({});
```

This returns saved connections and health status without credential values. Use `executor.coreTools.integrations.list` to inspect the catalog. A catalog entry without a connection is not necessarily callable.

## Rules

- Route external-system work through Executor first; use CLI or direct SDK only when the required Executor capability is unavailable, and disclose that fallback.
- Never use `fetch`; all external API calls go through `tools.*`.
- Never print, request, or persist credentials. Connection tools handle authentication.
- Do not enumerate `tools` with `Object.keys`, spread, or `for...in`; it is a lazy proxy and enumeration fails.
- For large collections, filter and summarize in the Executor runtime before returning results.
- Check the `{ ok, data, error }` result union and return bounded output.
- For files, emit `ToolFile` or MCP content with `emit(...)`; do not decode base64 manually.
- If execution returns a resume payload, continue with `executor_resume` using that payload.
- Mutating actions still require normal user authorization and project-specific gates; Executor availability is not permission to act.

When the required integration is absent or unhealthy, report the exact integration/tool and use the narrowest approved fallback rather than guessing.
