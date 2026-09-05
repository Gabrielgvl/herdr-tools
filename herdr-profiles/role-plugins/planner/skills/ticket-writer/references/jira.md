# Jira Field Mapping

When filing a ticket in Jira, map the generic metadata fields as follows.

## Issue type hierarchy

Jira has a strict hierarchy. Match the ticket to the right level:

| Situation | Jira issue type |
|-----------|----------------|
| Child of an Epic | `Story` or `Task` |
| Child of a Story | `Subtask` |
| Standalone implementation work | `Task` |
| Defect | `Bug` |
| Exploratory / research work | `Task` (label as `spike`) |

## Field mapping

| Generic field | Jira field | Notes |
|---------------|-----------|-------|
| Type | Issue Type | See hierarchy table above |
| Estimate | Story Points | Map S=1–2, M=3–5, L=8–13 |
| Component | Component | Must match an existing component in the project; ask if unsure |
| Priority | Priority | Jira values: Blocker, Critical, Major, Minor, Trivial — map P0=Blocker, P1=Critical, P2=Major, P3=Minor |
| Parent | Epic Link / Parent | For Stories under an Epic: set `Epic Link` field. For Subtasks: set via parent issue key |

## Fix Version

If the team uses Fix Versions (release targets), ask the user whether to set one.
Default: leave unset.

## Filing steps (MCP)

1. Identify the project key (e.g. `ENG`, `PLAT`) from the parent issue or ask the user
2. Create the issue with `summary` (title), `description` (Jira wiki or Markdown), `issuetype`, `priority`, `story_points`
3. Link to parent: set `Epic Link` field for Stories, or use `parent` for Subtasks
4. Set `components` array if component is known
5. Return the issue URL (`https://[org].atlassian.net/browse/[KEY-123]`)
