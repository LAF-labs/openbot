#!/usr/bin/env bash
# M0 단일 VM 셋업 — Ubuntu 24.04 aarch64 (OCI A1.Flex) 기준.
# 멱등하게 다시 돌려도 안전하도록, 각 단계는 이미 되어 있으면 지나간다.
set -Eeuo pipefail

LAF_DIR=/opt/laf
REPO=https://github.com/LAF-labs/openbot.git
BRANCH=laf/m0

log() { printf '\n== %s\n' "$*"; }

# ── 1. 시스템 ────────────────────────────────────────────────────────────
log "apt 기본"
sudo apt-get update -y
# openssl(KEK 생성)과 cron(야간 백업)은 Ubuntu Minimal 이미지에 없다 —
# aarch64 24.04는 Minimal판만 제공되므로 명시적으로 깐다.
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl git ufw fail2ban unattended-upgrades unzip \
  openssl cron

log "스왑 4G (없으면)"
if ! swapon --show | grep -q '/swapfile'; then
  sudo fallocate -l 4G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

log "방화벽: 22만"
sudo ufw allow OpenSSH >/dev/null
sudo ufw --force enable >/dev/null

# ── 2. 런타임 ────────────────────────────────────────────────────────────
log "bun"
if ! command -v bun >/dev/null; then
  curl -fsSL https://bun.sh/install | bash
  sudo ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
fi
bun --version

log "docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi
sudo docker --version

# ── 3. 앱 ────────────────────────────────────────────────────────────────
log "레포"
sudo mkdir -p "$LAF_DIR"
sudo chown "$USER" "$LAF_DIR"
if [ ! -d "$LAF_DIR/openbot/.git" ]; then
  git clone --branch "$BRANCH" "$REPO" "$LAF_DIR/openbot"
else
  git -C "$LAF_DIR/openbot" fetch origin "$BRANCH"
  git -C "$LAF_DIR/openbot" checkout "$BRANCH"
  git -C "$LAF_DIR/openbot" pull --ff-only origin "$BRANCH"
fi
cd "$LAF_DIR/openbot"
bun install

log ".env (없으면 생성 — 비밀은 사람이 채운다)"
if [ ! -f .env ]; then
  KEK=$(openssl rand -base64 32)
  cat > .env <<ENV
DATABASE_URL=postgres://openbot:openbot@localhost:55432/openbot
POSTGRES_PORT=55432
KEY_ENCRYPTION_KEY=$KEK
PORT=3001
TENANT_PACKAGE_DIR=../tenant/laf
# AUTH(M1-2) 전까지: 서비스는 localhost 바인딩 + SSH 터널 전용. 공개 금지.
OPENBOT_DEV_NO_AUTH=true
TRUSTED_ORIGINS=http://localhost:3010
AGENT_STALL_TIMEOUT_MS=60000
MANAGED_AGENT_AG_UI_URL=http://localhost:4200/ag-ui
# ── 사람이 채울 것 ──
# agent-bot의 모델 키 (DeepSeek: https://api.deepseek.com)
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.deepseek.com
BOT_MODEL=deepseek-v4-flash
# 선택: 다이제스트/승인 버즈 웹훅
#LAF_DIGEST_WEBHOOK_URL=
#LAF_NOTIFY_WEBHOOK_URL=
ENV
  echo "  -> .env 생성됨. OPENAI_API_KEY를 채운 뒤 유닛을 재시작할 것."
fi

log "postgres + 마이그레이션"
sudo docker compose up -d postgres
for i in $(seq 1 30); do
  sudo docker compose exec -T postgres pg_isready -U openbot -d openbot >/dev/null 2>&1 && break
  sleep 1
done
(cd server && bun run db:migrate)

log "앱 설정 생성 + 프론트 빌드"
bun run generate:app-config
(cd app && bun run build)

# ── 4. systemd ──────────────────────────────────────────────────────────
log "systemd 유닛"
sudo tee /etc/systemd/system/laf-server.service >/dev/null <<UNIT
[Unit]
Description=LAF Agent server (localhost only until AUTH lands)
After=network.target docker.service
[Service]
User=$USER
WorkingDirectory=$LAF_DIR/openbot/server
ExecStart=/usr/local/bin/bun --env-file=../.env src/index.ts
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/laf-agent-bot.service >/dev/null <<UNIT
[Unit]
Description=LAF managed AG-UI bot (model API)
After=network.target
[Service]
User=$USER
WorkingDirectory=$LAF_DIR/openbot/agent-bot
EnvironmentFile=$LAF_DIR/openbot/.env
Environment=PORT=4200
ExecStart=/usr/local/bin/bun src/index.ts
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/laf-app.service >/dev/null <<UNIT
[Unit]
Description=LAF web app (static preview, localhost only)
After=network.target
[Service]
User=$USER
WorkingDirectory=$LAF_DIR/openbot/app
ExecStart=/usr/local/bin/bun x vite preview --host 127.0.0.1 --port 3010
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now laf-server laf-agent-bot laf-app

# ── 5. 백업 ─────────────────────────────────────────────────────────────
log "pg_dump 백업 (매일 04:00, 14벌)"
sudo mkdir -p /var/backups/laf
sudo tee /usr/local/sbin/laf-backup-db >/dev/null <<'BK'
#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
out="/var/backups/laf/laf-$(date +%Y%m%d-%H%M).sql.gz"
docker compose -f /opt/laf/openbot/docker-compose.yml exec -T postgres \
  pg_dump -U openbot openbot | gzip > "$out"
ls -1t /var/backups/laf/laf-*.sql.gz | tail -n +15 | xargs -r rm --
logger -t laf-backup "wrote $out"
BK
sudo chmod +x /usr/local/sbin/laf-backup-db
echo '0 4 * * * root /usr/bin/flock -n /run/lock/laf-backup.lock /usr/local/sbin/laf-backup-db' \
  | sudo tee /etc/cron.d/laf-db-backup >/dev/null

log "완료"
echo "상태 확인:  systemctl status laf-server laf-agent-bot laf-app"
echo "터널 접속:  ssh -N -L 3010:127.0.0.1:3010 -L 3001:127.0.0.1:3001 $USER@<VM-IP>"
echo "남은 일:    $LAF_DIR/openbot/.env 의 OPENAI_API_KEY 채우고: sudo systemctl restart laf-agent-bot"
