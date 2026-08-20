#!/bin/bash
set -euo pipefail

SSM_PREFIX="__SSM_PREFIX__"
DOMAIN="__DOMAIN__"
ECR_URI="__ECR_URI__"
ENVIRONMENT="__ENVIRONMENT__"
ALARM_TOPIC_ARN="__ALARM_TOPIC_ARN__"
REGION="__REGION__"
REQUIRED_ENV_VARS="__REQUIRED_ENV_VARS__"

APP_DIR="/opt/casemaster"
mkdir -p "$APP_DIR"

# --- AWS CLI v2 (not preinstalled on Amazon Linux 2023) ---------------------
# curl-minimal ships preinstalled and conflicts with the full curl package
# (dnf refuses to install both) — curl-minimal already supports everything
# this script needs, so only unzip is actually missing.
dnf install -y unzip
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install

# --- Docker + Docker Compose plugin -----------------------------------------
dnf install -y docker
systemctl enable --now docker
usermod -aG docker ec2-user

DOCKER_CONFIG_DIR="/usr/local/lib/docker/cli-plugins"
mkdir -p "$DOCKER_CONFIG_DIR"
curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64" \
  -o "$DOCKER_CONFIG_DIR/docker-compose"
chmod +x "$DOCKER_CONFIG_DIR/docker-compose"

# --- CodeDeploy agent --------------------------------------------------------
dnf install -y ruby wget
cd /tmp
wget "https://aws-codedeploy-${REGION}.s3.${REGION}.amazonaws.com/latest/install"
chmod +x ./install
./install auto
systemctl enable --now codedeploy-agent

# --- Pull secrets from SSM into an env file for docker compose --------------
IFS=',' read -ra ENV_VAR_ARRAY <<< "$REQUIRED_ENV_VARS"
ENV_FILE="$APP_DIR/.env"
: > "$ENV_FILE"
for var in "${ENV_VAR_ARRAY[@]}"; do
  value=$(aws ssm get-parameter --name "/${SSM_PREFIX}/${var}" --region "$REGION" --query 'Parameter.Value' --output text 2>/dev/null || echo "")
  echo "${var}=${value}" >> "$ENV_FILE"
done

# Redis runs as a container on this same box now (no ElastiCache).
cat >> "$ENV_FILE" <<EOF
REDIS_URL=redis://redis:6379/1
CELERY_BROKER_URL=redis://redis:6379/0
CELERY_RESULT_BACKEND=redis://redis:6379/0
CELERY_REDBEAT_REDIS_URL=redis://redis:6379/2
ENVIRONMENT=${ENVIRONMENT}
PROJECT_NAME=casemaster
EOF
chmod 600 "$ENV_FILE"

# --- docker-compose.yml (app + celery-worker + redis + caddy) ---------------
cat > "$APP_DIR/docker-compose.yml" <<COMPOSE
version: "3.9"
services:
  redis:
    image: redis:7-alpine
    restart: always
    command: ["redis-server", "--maxmemory", "256mb", "--maxmemory-policy", "allkeys-lru"]
    volumes:
      - redis-data:/data

  app:
    image: ${ECR_URI}:${ENVIRONMENT}
    restart: always
    env_file: .env
    depends_on:
      - redis
    expose:
      - "8000"
    volumes:
      - shared-data:/data

  celery-worker:
    image: ${ECR_URI}:${ENVIRONMENT}
    restart: always
    command: ["celery", "-A", "app.main:celery", "worker", "--loglevel=info", "--concurrency=2"]
    env_file: .env
    depends_on:
      - redis
    volumes:
      - shared-data:/data

  caddy:
    image: caddy:2-alpine
    restart: always
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      - app

volumes:
  redis-data:
  shared-data:
  caddy-data:
  caddy-config:
COMPOSE

# --- Caddyfile: TLS termination + reverse proxy -----------------------------
cat > "$APP_DIR/Caddyfile" <<CADDYFILE
${DOMAIN} {
    reverse_proxy app:8000
}
CADDYFILE

# --- Cert expiry check: daily, alerts via SNS if renewal ever silently fails
# Quoted heredoc: everything below is written byte-for-byte, so the
# $()/${} expressions run on the INSTANCE each time the timer fires, not
# once at boot time when this user-data script executes.
cat > /usr/local/bin/check-cert-expiry.sh <<'CERTCHECK'
#!/bin/bash
set -euo pipefail
DOMAIN="__CERT_DOMAIN__"
ALARM_TOPIC_ARN="__CERT_ALARM_TOPIC_ARN__"
REGION="__CERT_REGION__"
WARN_DAYS=10

expiry_date=$(echo | openssl s_client -servername "$DOMAIN" -connect "${DOMAIN}:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
if [[ -z "$expiry_date" ]]; then
  aws sns publish --region "$REGION" --topic-arn "$ALARM_TOPIC_ARN" \
    --subject "CaseMaster: TLS cert check failed" \
    --message "Could not read the TLS certificate for ${DOMAIN} at all. Caddy or the site may be down." || true
  exit 0
fi

expiry_epoch=$(date -d "$expiry_date" +%s)
now_epoch=$(date +%s)
days_left=$(( (expiry_epoch - now_epoch) / 86400 ))

if (( days_left < WARN_DAYS )); then
  aws sns publish --region "$REGION" --topic-arn "$ALARM_TOPIC_ARN" \
    --subject "CaseMaster: TLS cert expiring soon" \
    --message "TLS certificate for ${DOMAIN} expires in ${days_left} day(s) (${expiry_date}). Caddy's auto-renewal may have failed — check the caddy container logs." || true
fi
CERTCHECK
sed -i "s|__CERT_DOMAIN__|${DOMAIN}|g; s|__CERT_ALARM_TOPIC_ARN__|${ALARM_TOPIC_ARN}|g; s|__CERT_REGION__|${REGION}|g" /usr/local/bin/check-cert-expiry.sh
chmod +x /usr/local/bin/check-cert-expiry.sh

cat > /etc/systemd/system/check-cert-expiry.service <<'UNIT'
[Unit]
Description=Check CaseMaster TLS cert expiry and alert via SNS

[Service]
Type=oneshot
ExecStart=/usr/local/bin/check-cert-expiry.sh
UNIT

cat > /etc/systemd/system/check-cert-expiry.timer <<'TIMER'
[Unit]
Description=Daily CaseMaster TLS cert expiry check

[Timer]
OnCalendar=*-*-* 09:00:00
Persistent=true

[Install]
WantedBy=timers.target
TIMER

systemctl daemon-reload
systemctl enable --now check-cert-expiry.timer

# --- ECR login helper: systemd ExecStartPre doesn't support shell pipes,
# so the login step lives in its own script instead.
cat > /usr/local/bin/casemaster-ecr-login.sh <<LOGINSCRIPT
#!/bin/bash
set -euo pipefail
aws ecr get-login-password --region ${REGION} | docker login --username AWS --password-stdin ${ECR_URI}
LOGINSCRIPT
chmod +x /usr/local/bin/casemaster-ecr-login.sh

# --- systemd unit to manage the compose stack (so it restarts on reboot) ---
cat > /etc/systemd/system/casemaster.service <<UNIT
[Unit]
Description=CaseMaster docker compose stack
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=true
WorkingDirectory=${APP_DIR}
ExecStartPre=/usr/local/bin/casemaster-ecr-login.sh
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable casemaster.service
systemctl start casemaster.service
