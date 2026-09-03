#!/usr/bin/env bash
set -euo pipefail

# Pushes CaseMaster's required env vars from a local .env file into SSM
# Parameter Store for the given AWS profile/environment. Run this yourself —
# it never prints or transmits secret values anywhere except to AWS.
#
# Usage:
#   ./scripts/push-ssm-secrets.sh /path/to/.env casemaster-prod dev

ENV_FILE="${1:-}"
PROFILE="${2:-casemaster-prod}"
ENVIRONMENT="${3:-dev}"
PROJECT_NAME="casemaster"

if [[ -z "$ENV_FILE" || ! -f "$ENV_FILE" ]]; then
  echo "Usage: $0 <path-to-.env> [aws-profile] [environment]" >&2
  exit 1
fi

REQUIRED_VARS=(
  LLM_PROVIDER
  LLM_MODEL
  GEMINI_API_KEY
  SUPABASE_URL
  SUPABASE_ANON_KEY
  SUPABASE_STORAGE_BUCKET
  INDIAN_KANOON_API_TOKEN
  CORS_ORIGINS
  RESULTS_DIR
  FAISS_DIR
  CHUNK_PAGES
  EMBED_MODEL
  PDF_WATERMARK
  CLERK_DOMAIN
  SUPABASE_SERVICE_KEY
  SUPABASE_DB_URL
  GROQ_API_KEY
  RAZORPAY_KEY_ID
  RAZORPAY_KEY_SECRET
  RAZORPAY_WEBHOOK_SECRET
  ADMIN_API_KEY
  OTP_HASH_SECRET
  WHATSAPP_PHONE_NUMBER_ID
  WHATSAPP_OTP_TEMPLATE
  WHATSAPP_CLOUD_TOKEN
  CLERK_SECRET_KEY
)

# bash 3.2 (macOS default) has no associative arrays, so look up each
# required var directly from the .env file instead of pre-loading a map.
lookup_env_value() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" | tail -1 | cut -d'=' -f2-
}

MISSING=()
PUSHED=0

for var in "${REQUIRED_VARS[@]}"; do
  value="$(lookup_env_value "$var")"
  if [[ -z "$value" ]]; then
    MISSING+=("$var")
    continue
  fi

  param_path="/${PROJECT_NAME}/${ENVIRONMENT}/${var}"

  # Plain String, not SecureString: pipeline-stack.ts resolves these via
  # ssm.StringParameter.fromStringParameterName, which CloudFormation only
  # supports for String-type parameters (SecureString isn't a supported
  # AWS::SSM::Parameter::Value template parameter type).
  aws ssm put-parameter \
    --name "$param_path" \
    --value "$value" \
    --type "String" \
    --overwrite \
    --profile "$PROFILE" \
    --output text > /dev/null

  echo "pushed: $param_path"
  PUSHED=$((PUSHED + 1))
done

echo ""
echo "Done: $PUSHED/${#REQUIRED_VARS[@]} parameters pushed to SSM under /${PROJECT_NAME}/${ENVIRONMENT}/*"

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo ""
  echo "WARNING: missing values in $ENV_FILE for:"
  for m in "${MISSING[@]}"; do
    echo "  - $m"
  done
  exit 1
fi
