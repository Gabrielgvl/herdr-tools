# Linear Field Mapping

When filing a ticket in Linear, map the generic metadata fields as follows.

**Do not set an estimate.** Omit Linear's `estimate` field entirely when creating the issue so it remains unestimated.

## Field mapping

| Generic field | Linear field | Notes |
|---------------|-------------|-------|
| Type | Label | Use team's label set; common values: `feature`, `bug`, `chore`, `spike` |
| Component | Label or Project | Use a component label if the team has them; otherwise assign to the relevant Project |
| Priority | Priority | Linear values: Urgent, High, Medium, Low — map P0=Urgent, P1=High, P2=Medium, P3=Low |
| Parent | Parent issue | Set via "Set parent" on the issue; use the parent issue identifier (e.g. `ENG-123`) |

## Cycle assignment

If the team uses cycles (sprints), ask the user whether to assign this ticket to the current
cycle or leave it in the backlog. Default: backlog unless the user specifies otherwise.

## Filing steps (MCP)

1. Identify the team ID from the parent issue or ask the user
2. Create the issue with `title`, `description` (Markdown body), `teamId`, and `priority`; omit `estimate`
3. Set the parent with `parentId` from the parent issue
4. Apply labels by label name
5. Optionally assign to a cycle with `cycleId`
6. Return the issue URL (`https://linear.app/[org]/issue/[identifier]`)
