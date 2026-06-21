#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# VG IR Delivery Dashboard — Azure Deployment Script
# Usage: ./deploy.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

APP_NAME="app-ir-delivery-dashboard"
RESOURCE_GROUP="rg-ir-delivery"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ZIP_FILE="$SCRIPT_DIR/deploy.zip"

# ── Colours ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $1"; }
success() { echo -e "${GREEN}[OK]${NC}    $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}   VG IR Delivery Dashboard — Deploying to Azure        ${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── Step 1: Resolve the 'az' command ─────────────────────────────────────────
info "Locating Azure CLI…"
if command -v az &>/dev/null; then
  AZ="az"
elif python3 -m azure.cli --version &>/dev/null 2>&1; then
  AZ="python3 -m azure.cli"
else
  warn "Azure CLI not found. Installing via pip3…"
  pip3 install azure-cli --quiet || error "Failed to install Azure CLI. Run: pip3 install azure-cli"
  AZ="python3 -m azure.cli"
fi
success "Azure CLI ready  ($($AZ --version 2>&1 | head -1))"

# ── Step 2: Check Azure login ─────────────────────────────────────────────────
info "Checking Azure login…"
ACCOUNT=$($AZ account show --query "user.name" -o tsv 2>/dev/null || true)
if [ -z "$ACCOUNT" ]; then
  warn "Not logged in. Starting device-code login…"
  $AZ login --use-device-code
  ACCOUNT=$($AZ account show --query "user.name" -o tsv)
fi
success "Logged in as: $ACCOUNT"

# ── Step 3: Confirm App Service is reachable ──────────────────────────────────
info "Verifying App Service '$APP_NAME'…"
STATE=$($AZ webapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --query "state" -o tsv 2>/dev/null || true)
[ "$STATE" = "Running" ] || error "App Service not found or not running (state: $STATE). Check the name/resource group."
success "App Service is Running"

# ── Step 4: Build deployment ZIP ─────────────────────────────────────────────
info "Building deployment package…"
cd "$SCRIPT_DIR"
[ -f "$ZIP_FILE" ] && rm "$ZIP_FILE"

zip -r "$ZIP_FILE" . \
  --exclude "*.config.json" \
  --exclude ".config.example.json" \
  --exclude "node_modules/*" \
  --exclude "reports/*" \
  --exclude ".DS_Store" \
  --exclude "deploy.zip" \
  --exclude "deploy.sh" \
  --exclude ".git/*" \
  --exclude ".claude/*" \
  --exclude "publish-profile.xml" \
  -q

ZIP_SIZE=$(du -sh "$ZIP_FILE" | cut -f1)
success "Package ready — $ZIP_SIZE"

# ── Step 5: Deploy ────────────────────────────────────────────────────────────
info "Deploying to https://${APP_NAME}.azurewebsites.net …"
$AZ webapp deploy \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --src-path "$ZIP_FILE" \
  --type zip \
  --async false \
  -o none 2>&1 | grep -v "^WARNING: Note:" || true

# ── Step 6: Clean up ─────────────────────────────────────────────────────────
rm -f "$ZIP_FILE"
success "Local package cleaned up"

# ── Step 7: Health check ──────────────────────────────────────────────────────
info "Running health check…"
sleep 3
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://${APP_NAME}.azurewebsites.net/" || true)
if [ "$HTTP_CODE" = "200" ]; then
  success "App is live — HTTP $HTTP_CODE"
else
  warn "App returned HTTP $HTTP_CODE — it may still be warming up, try again in 30s"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}   Deployment complete!                                 ${NC}"
echo -e "${GREEN}   https://${APP_NAME}.azurewebsites.net               ${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
