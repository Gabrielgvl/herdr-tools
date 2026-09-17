---
name: authenticated-staging-smoke
description: "Validate Courier staging changes with real authentication and smoke evidence. Use for a staging cutover, rollout flag, feature path, regional deployment, or API/Studio behavior where health checks are insufficient."
---

# Authenticated Staging Smoke

## When to use

Use this skill for staging validation that must prove the real product path works:

- feature rollout or cutover validation
- staging deploy smoke tests
- backend REST/GraphQL or Studio behavior
- regional routing checks
- service-to-service read/write cutovers
- any request like "fully test it", "validate the cutover", or "test with auth"

Do not stop at health checks, direct database checks, or unauthenticated service calls when the user asked for cutover or feature validation.

## Core rule

A valid staging smoke must exercise the same authenticated public or service entrypoint customers or first-party clients use, then prove the expected downstream path was used.

Minimum evidence:

1. Authenticated request succeeded.
2. Feature-specific result was observed through the intended API/UI path.
3. Old-path/new-path ambiguity was ruled out when relevant.
4. Relevant logs/queues/health checks show no new errors.
5. Temporary credentials, tokens, and local secret files were cleaned up.

## Guardrails

- Use staging only unless the user explicitly authorizes production.
- Never print bearer tokens, API keys, cookies, passwords, or one-time codes.
- Store temporary secrets only in local temp files when needed; delete them before finishing.
- Confirm the tenant/workspace is non-production before mutating data.
- Capture previous config values before changing rollout flags or SSM parameters.
- If rollout/config changes are temporary, restore them unless the user asked to leave the cutover enabled.
- Prefer feature-native smoke scripts if they exist, but verify they actually cover the changed path.
- Do not rely on internal unauthenticated endpoints as the final validation unless that is the actual product contract.

## Standard workflow

### 1. Identify the target surface

Determine:

- repo and deployed branch/environment
- AWS profile and region
- API base URL, Studio URL, or service URL
- auth type required by the target path
- feature-specific success signal
- old path vs new path distinction, if this is a cutover

Start from [`../../../docs/staging-auth-and-release.md`](../../../docs/staging-auth-and-release.md) for Courier-wide staging URLs and auth rules.

### 2. Get real staging auth

Use the least-privileged staging-scoped auth that exercises the target path.

Common patterns:

- Studio/Cognito path: create a temporary staging Cognito smoke user and get an IdToken.
- Public API path: create or retrieve a staging workspace and use a staging API key.
- Service path: use the same internal auth mechanism the caller service uses, or call through the authenticated upstream API that triggers it.

For backend Cognito smoke auth, use the repo script when available:

```bash
cd backend
STAGE=staging AWS_PROFILE=staging AWS_REGION=us-east-1 \
  SMOKE_TEST_RUN_ID="$(date +%s)" \
  __smoke_tests__/scripts/get-cognito-token.sh
```

Do not echo the token. Capture it into an environment variable or temp file only.

If a workspace/API key is needed, use authenticated Studio/API setup against staging. Do not use production workspaces or customer data.

### 3. Apply staging rollout/config intentionally

If the validation requires feature flags, SSM parameters, environment variables, or rollout controls:

1. Read and record current values.
2. Set only the minimum staging-scoped values needed.
3. Prefer regional parameters for regional cutovers.
4. Account for Lambda/config cache windows before testing.
5. State whether values were restored or intentionally left enabled.

For cutovers, test at least one post-cutover entity whose timestamp/version/tenant selection should route to the new path.

### 4. Run the authenticated smoke

Exercise the real entrypoint. Examples:

- `POST /send` with a staging API key, then `GET /messages/{id}/history` with the same key.
- Studio API request with a Cognito bearer token and `tenantId` selection.
- GraphQL request through the staging router or public backend endpoint with the same auth client code uses.

Record only non-secret evidence:

- status codes
- request/message IDs
- tenant/workspace ID if safe
- observed response shape or event types
- timestamps

### 5. Prove the intended path was used

For cutovers, a successful response is not enough. Add a discriminating check:

- Query old storage/path and show the entity is absent there, if safe.
- Query new storage/path and show the entity exists there, if safe.
- Check logs/metrics for the new path being invoked.
- Use feature-specific response differences that only the new path can produce.

If you cannot disambiguate old vs new path, say so and keep testing until you can.

### 6. Check operational health

After the smoke, inspect relevant staging health signals:

- Lambda/service logs for non-deprecation errors
- DLQs/failover queues for nonzero counts
- target group or service health if deployment-related
- feature-specific metrics where available

Use context-mode for broad log or queue output. Summarize counts and samples, not secrets.

### 7. Cleanup

Before final response:

- Delete temporary Cognito users if they were created.
- Delete local temp files containing tokens/API keys.
- Restore temporary rollout/config values unless intentionally left enabled.
- Do not paste secrets into the final answer.

If cleanup is impossible or unsafe, state exactly what remains and why.

## Final response checklist

Include:

- What auth was used, without secret values.
- What endpoint/API/UI path was exercised.
- IDs/timestamps needed to audit the smoke.
- Evidence that the feature/cutover path worked.
- Evidence that old/new path ambiguity was ruled out.
- Health/log/queue checks.
- Cleanup performed.
- Any residual risks or untested surfaces.

## Anti-patterns

Avoid these as final validation:

- "Health endpoint returned 204" only.
- Direct database insert/query only.
- Unauthenticated internal GraphQL/service call only.
- Testing the writer but not the authenticated reader.
- Testing the new storage but not proving the product API uses it.
- Leaving temp tokens or local secret files behind.
