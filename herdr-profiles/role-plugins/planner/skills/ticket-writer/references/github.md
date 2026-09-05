# GitHub Issues Field Mapping

When filing a ticket in GitHub Issues, map the generic metadata fields as follows.

## Field mapping

| Generic field | GitHub field | Notes |
|---------------|-------------|-------|
| Type | Label | Create/apply labels like `type:feature`, `type:bug`, `type:chore`, `type:spike` |
| Estimate | Label or Project field | GitHub Issues has no native estimate field; use a label (e.g. `size:M`) or a custom Project field if the team has one |
| Component | Label | Use component labels like `component:auth`, `component:webhooks` |
| Priority | Label | Use labels like `priority:p0`–`priority:p3` |
| Parent | Tasklist or Project | If using GitHub Projects with tasklists, add as a sub-item; otherwise link the parent in the issue body under **Dependencies** |

## Sub-issue relationship

GitHub Issues does not have a native parent/child hierarchy outside of GitHub Projects
tasklists. Options:

1. **GitHub Projects tasklist** (preferred if team uses Projects): add this issue as a
   sub-item under the parent task
2. **Manual reference**: include "Part of #[parent-issue-number]" in the issue body
   under Dependencies

## Filing steps (MCP)

1. Identify the repo (`owner/repo`) from context or ask the user
2. Create the issue with `title`, `body` (Markdown), `labels`
3. Set `milestone` if the team uses milestones for releases
4. Assign to a GitHub Project and set parent tasklist item if applicable
5. Return the issue URL (`https://github.com/[owner]/[repo]/issues/[number]`)

## Body format note

GitHub renders Markdown natively. Use the ticket template as-is; headings, checklists,
and code blocks all render correctly.
