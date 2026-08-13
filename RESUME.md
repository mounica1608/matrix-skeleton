# CaseMaster Dev — Paused / Resume Guide

**Status: PAUSED (torn down for cost) as of 2026-07-18.**
Reason: account billing hold / cost reduction. Compute + networking removed; everything
recreatable from CDK code.

> ⚠️ **Revert works only while the AWS account stays active.** The account is billing-
> delinquent (CodeBuild is already blocked). If unpaid dues cause AWS to *fully suspend*
> the account, `cdk deploy` will not run until billing is resolved. After ~90 days of
> delinquency AWS may delete even the preserved resources below (ECR image, SSM params).
> **This pause buys time; it does not replace paying the bill.**

---

## What was TORN DOWN

| Resource | Stack | Notes |
|---|---|---|
| ECS Fargate service + cluster (CaseMaster app) | `CasemasterDevStack` | app + celery sidecar |
| Redis (ElastiCache `cache.t4g.micro`) | `CasemasterRedisStack` | cache only — no durable data lost |
| NAT Gateway + its Elastic IP | `NetworkingStack` | biggest hourly cost; EIP released (no orphan charge) |
| VPC (custom), subnets, route tables, IGW | `NetworkingStack` | |
| Shared ALB (`staging-shared-alb`) | `StagingAlbStack` | **was shared with staging** |
| Staging ACM certificate | `StagingCertificateStack` | |
| Staging Route53 records | `StagingDnsStack` | |

**Staging is also down** — this was shared infrastructure, not CaseMaster-only.

## What was PRESERVED (so resume needs no rebuild)

| Kept | Where | Why it matters |
|---|---|---|
| **ECR image tagged `dev`** (commit `c44b52b`) | `CasemasterSharedStack` (survives) | the app code to run — avoids a CodeBuild rebuild (which is blocked by billing). Old CI images were pruned 2026-07-18 to cut storage cost; only `dev` remains. |
| Artifacts S3 bucket | `CasemasterSharedStack` | |
| **23 SSM params** at `/casemaster/dev/*` | SSM (outside all stacks) | all config + secrets (Supabase, Gemini, Groq, Razorpay, WhatsApp, OTP, admin, embedding/rerank tuning) |
| CDK bootstrap | `CDKToolkit` | needed for any deploy |

Surviving CloudFormation stacks: `CasemasterSharedStack`, `CDKToolkit`. Cost ≈ pennies
(ECR + S3 storage).

---

## HOW TO RESUME

Prereqs: AWS CLI working, profile `my-profile` (account `664251210614`, region
`ap-south-1`), and **the billing hold cleared** (else deploy may fail on suspended account).

From the repo root (`/Users/kamakhya/matrix-skeleton`):

```bash
npm install            # if node_modules is missing
npm run build          # compile CDK TypeScript

# Recreate everything, in dependency order. CDK resolves order, but listing explicitly is clearest:
npx cdk deploy \
  NetworkingStack \
  StagingCertificateStack \
  StagingAlbStack \
  CasemasterRedisStack \
  CasemasterDevStack \
  StagingDnsStack \
  --profile my-profile
```

Answer `y` at the security-approval prompt (IAM + SSM secret access — same as the original
deploy). ~15–20 min total. This rebuilds VPC → NAT → ALB → Redis → ECS, wiring in the
preserved `dev` image and the 23 SSM params automatically.

- Drop `StagingDnsStack` from the list if you don't need the staging domain back yet.
- To bring back **only** the CaseMaster app (skip staging DNS/cert if unchanged), the
  minimum is: `NetworkingStack StagingCertificateStack StagingAlbStack CasemasterRedisStack CasemasterDevStack`.

### Verify resume succeeded

```bash
# ECS service should reach Running == Desired, rollout COMPLETED
aws ecs describe-services --cluster casemaster-dev-cluster --services casemaster-dev-service \
  --profile my-profile --region ap-south-1 \
  --query 'services[0].{Running:runningCount,Desired:desiredCount,Rollout:deployments[0].rolloutState}' --output table

# App health
curl -s https://api-dev.casemaster.co.in/health
```

---

## Notes / gotchas on resume

- **Autoscaling was manually pinned to 0** before teardown, but that target was destroyed
  with the ECS stack — a fresh `cdk deploy` restores the configured min/max (1/2 per
  `config/dev.json`). No manual scale-up needed after a full redeploy.
- **NAT/EIP** get new IDs and a new Elastic IP on recreate — fine, nothing external
  depends on the old ones.
- **ECR `:dev` tag** still points at commit `c44b52b`. To deploy newer code instead, the
  CodeBuild pipeline (`casemaster-dev-pipeline`) must build a new image — but that pipeline
  is **blocked by the billing hold** and builds from the **`dev` git branch**, so newer
  backend changes also need committing/merging to `dev` first.
- **Env-var config** (bge-small embedding model, rerank tuning, secrets) is already baked
  into `lib/pipeline/pipeline-stack.ts` + the SSM params — it comes back with the deploy.
  These edits are on branch `feat/casemaster-dev-env-sync`, **not yet committed to `main`**.

## Outstanding (pre-existing, unrelated to the pause)

- Uncommitted infra changes on branch `feat/casemaster-dev-env-sync` (config/projects.json,
  lib/pipeline/pipeline-stack.ts) — commit before relying on `main`.
- `WHATSAPP_CLOUD_TOKEN` was never set → WhatsApp OTP send won't work until added.
- Secrets in SSM are type `String` (not `SecureString`) to satisfy CloudFormation's
  parameter mechanism — consistent with existing repo convention.
