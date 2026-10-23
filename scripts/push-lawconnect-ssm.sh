#!/usr/bin/env bash
set -euo pipefail

# Pushes Law Connect's settings from a local .env.lawconnect file into SSM
# Parameter Store under /lawconnect/<environment>/*. The CaseMaster
# CodeDeploy BeforeInstall hook reads that whole path on every deploy and
# writes it to .env.lawconnect on the instance, so changes take effect on
# the next deploy. Run this yourself — it never prints or transmits secret
# values anywhere except to AWS.
#
# Every non-empty LC_* line is pushed; empty ones are skipped (the app falls
# back to its defaults). Nothing is deleted from SSM.
#
# Usage:
#   ./scripts/push-lawconnect-ssm.sh /path/to/.env.lawconnect casemaster-prod dev
#   ./scripts/push-lawconnect-ssm.sh /path/to/.env.lawconnect casemaster-prod dev LC_PAYMENTS_ENABLED LC_RAZORPAY_KEY_ID
#     (trailing names push only those variables)

ENV_FILE="${1:-}"
PROFILE="${2:-casemaster-prod}"
ENVIRONMENT="${3:-dev}"
shift $(( $# < 3 ? $# : 3 ))
ONLY_VARS=("$@")
REGION="ap-south-1"
PREFIX="lawconnect"

if [[ -z "$ENV_FILE" || ! -f "$ENV_FILE" ]]; then
  echo "Usage: $0 <path-to-.env.lawconnect> [aws-profile] [environment] [LC_VAR ...]" >&2
  exit 1
fi

# Law Connect won't start on the server without these.
REQUIRED_VARS=(
  LC_ENABLED
  LC_DATABASE_URL
  LC_SUPABASE_URL
  LC_SUPABASE_SERVICE_KEY
  LC_ADMIN_EMAILS
  LC_APP_BASE_URL
)

# Stored as SecureString. Unlike /casemaster/<env>/*, nothing resolves these
# through CloudFormation — only the BeforeInstall hook reads them, with
# --with-decryption — so SecureString is safe here.
SECRET_VARS=" LC_DATABASE_URL LC_SUPABASE_SERVICE_KEY LC_ADMIN_API_KEY LC_RAZORPAY_KEY_SECRET LC_RAZORPAY_WEBHOOK_SECRET LC_TURN_SECRET LC_CLOUDFLARE_TURN_API_TOKEN LC_WHATSAPP_TOKEN LC_SMTP_PASSWORD "

lookup_env_value() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" | tail -1 | cut -d'=' -f2-
}

MISSING=()
for var in "${REQUIRED_VARS[@]}"; do
  [[ -n "$(lookup_env_value "$var")" ]] || MISSING+=("$var")
done
if [[ ${#MISSING[@]} -gt 0 && ${#ONLY_VARS[@]} -eq 0 ]]; then
  echo "ERROR: required values missing in $ENV_FILE:" >&2
  printf '  - %s\n' "${MISSING[@]}" >&2
  exit 1
fi

# A local database or storage URL must never reach a server.
for var in LC_DATABASE_URL LC_SUPABASE_URL; do
  if lookup_env_value "$var" | grep -qE "localhost|127\.0\.0\.1|host\.docker\.internal"; then
    echo "ERROR: $var in $ENV_FILE points at a local machine; refusing to push." >&2
    exit 1
  fi
done

if [[ ${#ONLY_VARS[@]} -gt 0 ]]; then
  VARS=("${ONLY_VARS[@]}")
else
  # bash 3.2 (macOS default) has no mapfile.
  VARS=()
  while IFS= read -r name; do VARS+=("$name"); done < <(grep -oE "^LC_[A-Z0-9_]+=" "$ENV_FILE" | tr -d '=' | sort -u)
fi

PUSHED=0
SKIPPED=()
for var in "${VARS[@]}"; do
  value="$(lookup_env_value "$var")"
  if [[ -z "$value" ]]; then
    SKIPPED+=("$var")
    continue
  fi

  type="String"
  [[ "$SECRET_VARS" == *" $var "* ]] && type="SecureString"
  param_path="/${PREFIX}/${ENVIRONMENT}/${var}"

  aws ssm put-parameter \
    --name "$param_path" \
    --value "$value" \
    --type "$type" \
    --overwrite \
    --profile "$PROFILE" \
    --region "$REGION" \
    --output text > /dev/null

  echo "pushed: $param_path ($type)"
  PUSHED=$((PUSHED + 1))
done

echo ""
echo "Done: $PUSHED parameters pushed to SSM under /${PREFIX}/${ENVIRONMENT}/*"
echo "They take effect on the next CaseMaster deploy."
if [[ ${#SKIPPED[@]} -gt 0 ]]; then
  echo ""
  echo "Skipped (empty in $ENV_FILE):"
  printf '  - %s\n' "${SKIPPED[@]}"
fi
