# CaseMaster Frontend Deploy — Status & Context (2026-08-14)

## Current live state

- **Frontend live at:** `https://casemaster.co.in` — S3 + CloudFront, healthy (200 OK). Apex
  domain move (see below) is complete.
- **Backend live at:** `https://api-dev.casemaster.co.in` — ECS Fargate, healthy.
- **Repo (frontend code):** `casemaster-code/casemaster-fe`, branch `master`, local clone at
  `/Users/kamakhya/casemaster-fe`.
- Frontend deploy pipeline auto-builds on push to `master` via CodePipeline
  (`casemaster-fe-frontend-dev-pipeline`).
- `app-dev.casemaster.co.in` no longer resolves — its DNS record and CloudFront alias were
  removed as part of the apex move. It was never re-added; this is intentional, not an oversight.
- `www.casemaster.co.in` still points at the **backend ALB**, not the frontend — leftover from
  before this project, not yet reconciled. Not currently causing any issue since nothing links
  to `www.casemaster.co.in`, but worth fixing eventually so it doesn't confuse anyone poking at
  DNS.

## What was built

Added AWS hosting for `casemaster-fe` (Vite/React, Clerk + Supabase + Razorpay) as a new
stack in this CDK repo — **S3 + CloudFront + CodeBuild + CodePipeline**, not AWS Amplify.

**Why not Amplify:** `AWS::Amplify::App` cannot reuse an existing AWS CodeConnections
connection — it only supports GitHub auth via a manually-created personal access token (PAT)
stored in Secrets Manager. This is a confirmed, long-standing AWS gap (tracked in
[aws/aws-cdk#30883](https://github.com/aws/aws-cdk/issues/30883) and
[aws-amplify/amplify-hosting#2215](https://github.com/aws-amplify/amplify-hosting/issues/2215)).
Chose to reuse the backend's existing `casemaster-github` CodeConnections connection instead,
avoiding any manual token. Cost is roughly a wash either way.

### New/changed files

- `lib/frontend/frontend-stack.ts` (new) — S3 bucket (private, Origin Access Control) +
  CloudFront distribution (SPA routing: 403/404 → `/index.html`) + CodeBuild project +
  CodePipeline. Mirrors `lib/pipeline/pipeline-stack.ts`'s IAM/pipeline patterns.
- `lib/shared/dns-stack.ts` — extended `DnsRecordConfig` to accept an optional `distribution`
  (CloudFront) alongside the existing `alb`, and to accept an empty `subdomain` string for
  apex/bare-domain records. One DNS stack now serves both ALB and CloudFront targets.
- `config/projects.json` — `casemaster.frontend` block: `githubRepo`, `githubBranch`
  (`master`), `domains.dev` (now `casemaster.co.in` — see apex move below), `frontendEnvVars`
  (the 5 `VITE_*` keys below).
- `bin/matrix.ts` — wires up `FrontendCertificateStack` (cert in `us-east-1`, required by
  CloudFront regardless of the app's home region `ap-south-1`), `CasemasterFrontendDevStack`,
  and the apex DNS record (empty `subdomain`).

### Build-time env vars

Vite bakes `VITE_*` vars into the JS bundle at `npm run build` time (not runtime). The
CodeBuild buildspec fetches them from SSM Parameter Store (same convention as the backend's
secrets) via explicit `aws ssm get-parameter` calls in the `pre_build` phase:

- `/casemaster/dev/VITE_API_BASE_URL` → `https://api-dev.casemaster.co.in`
- `/casemaster/dev/VITE_CLERK_PUBLISHABLE_KEY`
- `/casemaster/dev/VITE_SUPABASE_URL`
- `/casemaster/dev/VITE_SUPABASE_ANON_KEY`
- `/casemaster/dev/VITE_RAZORPAY_KEY_ID`

**Important:** these live under the shared `/casemaster/dev/*` prefix (same as the backend's
24 vars), NOT `/casemaster-fe/dev/*`. This was the cause of the first real bug — see below.
The `FrontendStack` construct takes an explicit `ssmParameterPrefix` prop (set to
`casemaster/dev` in `bin/matrix.ts`) rather than deriving it from the frontend's own
`projectName` (`casemaster-fe`), specifically to avoid this mismatch recurring.

Note: these values are NOT secret once built — they ship in the browser-visible JS bundle
regardless of SSM parameter type (`String` vs `SecureString`).

## Bugs hit and fixed during this deploy

1. **SSM prefix mismatch (fixed).** First pipeline build silently failed to fetch all 5
   `VITE_*` params (wrong prefix `/casemaster-fe/dev/*` instead of `/casemaster/dev/*`), so
   `npm run build` ran with empty env vars → blank white page in the browser (HTML/JS loaded
   fine, but Clerk/API/Supabase config was empty so the React app never rendered). Fixed by
   adding the explicit `ssmParameterPrefix` prop. Confirmed fixed by grepping the built JS
   bundle for the baked-in values after the corrected build.

2. **Wrong branch (fixed).** Pipeline was initially configured for a `dev` branch that
   doesn't exist on `casemaster-fe`'s GitHub remote (only `main`, `master`,
   `feat/credit-payment-system`, `redesign/paidfeature` existed). User chose `master`. Fixed
   via `githubBranch` in the `frontend` config block.

## Apex domain move — completed 2026-08-14

User asked to move the frontend from `app-dev.casemaster.co.in` to the bare `casemaster.co.in`.
First attempt (earlier the same day) hit two stacked AWS issues and was reverted. On retry,
the second issue turned out to no longer apply — see below.

### Issue 1: CDK cross-region reference bug (confirmed, unfixed upstream, worked around)

CloudFront's ACM cert must live in `us-east-1` regardless of the app's home region, so the
cert is a separate stack (`FrontendCertificateStack`) linked to `CasemasterFrontendDevStack`
via CDK's `crossRegionReferences: true` mechanism (a Lambda + SSM Parameter Store shim CDK
generates automatically). Changing the cert's domain name forces ACM to **replace** the
certificate (delete + create new — not an in-place update). CDK's cross-region export writer
has a bug where it unconditionally refuses to hand a **changed** value for an **unchanged**
export key to the consumer stack, throwing `Error: Some exports have changed!` — matches a
known, still-open issue: [aws/aws-cdk#30771](https://github.com/aws/aws-cdk/issues/30771).

**Workaround used:** temporarily broke the cross-region reference by importing the new cert's
ARN as a literal string via `acm.Certificate.fromCertificateArn(...)` in
`CasemasterFrontendDevStack`, and deployed `CasemasterFrontendDevStack` + `StagingDnsStack`
that way first. This let `FrontendCertificateStack`'s stuck `UPDATE_COMPLETE_CLEANUP_IN_PROGRESS`
state self-heal (its target export value stopped changing once nothing referenced the old
value anymore) — it settled to `UPDATE_COMPLETE` on its own within a minute of the swap.
Afterward, reverted `CasemasterFrontendDevStack` back to referencing
`frontendCertificateStack.certificate` via the normal `crossRegionReferences: true` path (now
safe since both stacks agree on the ARN) and redeployed — `cdk diff` across all stacks came
back clean (zero drift) after this.

### Issue 2: External CNAME conflict — retested, no longer reproduces

The first attempt hit `CNAMEAlreadyExists` when trying to attach `casemaster.co.in` to the
live CloudFront distribution. Before retrying the real move, this was independently retested
by manually attaching the new cert + apex alias to the live distribution via
`aws cloudfront update-distribution` — it succeeded immediately, with no conflict error.
Immediately reverted that manual test back to `app-dev.casemaster.co.in` (site confirmed back
to 200 OK within ~2 minutes) before doing the real move through CDK.

Root cause of the original conflict was not identified — confirmed it wasn't the old AWS
account (664251210614 has zero Amplify apps and zero CloudFront distributions, checked across
all 17 regions) or the current account (only ever had the one `app-dev` distribution).
Whatever externally held the alias appears to have released it on its own between the first
attempt and this retest. **No AWS Support case was needed.**

### Result

- `casemaster.co.in` A/ALIAS record created in Route53, `app-dev.casemaster.co.in` record
  deleted (CDK created the new record before deleting the old one, so there was no gap).
- Live CloudFront distribution (`EHU7H384LUL8L`) now aliases `casemaster.co.in` only, using
  cert `arn:aws:acm:us-east-1:604938577991:certificate/4da9306f-def2-4817-b0f5-c35e026b2b6e`.
- The old `app-dev` cert (`...97756efb...`) was fully cleaned up/deleted by ACM once nothing
  referenced it anymore — `aws acm list-certificates` now shows only the `casemaster.co.in` cert.
- `FrontendCertificateStack` and `CasemasterFrontendDevStack` are both `UPDATE_COMPLETE`, no
  stuck state. Full `cdk diff` across every stack in the app returns zero differences.
- `CORS_ORIGINS` SSM param (`/casemaster/dev/CORS_ORIGINS`) already included
  `https://casemaster.co.in` (added preemptively during the first attempt) — nothing further
  needed there.

## Next steps (in priority order)

1. Manually verify in a real browser (not just curl): Clerk sign-in flow, actual page
   rendering/routing, and that API calls succeed end-to-end against `https://casemaster.co.in`.
2. Fix `www.casemaster.co.in` — currently a stale CNAME to the backend ALB. Either point it at
   the frontend or remove it, whichever matches intent (not yet decided).
3. Consider adding CloudWatch alarms for the frontend pipeline (mirrors the
   `pipelineFailureAlarm` pattern already in `lib/pipeline/pipeline-stack.ts`) — not done, not
   requested yet.

## Related open items from the broader backend deploy (unaffected by any of the above)

See auto-memory `project_casemaster_aws_deploy.md` for full backend deploy history. Briefly:
- Old AWS account (664251210614) is recorded as "fully destroyed" 2026-08-14, but its IAM user
  credentials (`my-profile` in `~/.aws/config`) still authenticate successfully as of this
  session — worth reconciling, since one of those two facts is wrong.
- `WHATSAPP_CLOUD_TOKEN` in SSM is still a placeholder — WhatsApp OTP won't work until the real
  token is pushed and ECS restarted.
- End-to-end testing of Celery-dependent backend features (document upload, report/strategy
  generation) not yet done against the live deployment.
- Billing budget alert deliberately deferred by user, not yet set up.
