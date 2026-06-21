#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# VG IR Delivery Dashboard — Azure AD SSO Setup Script
# Run this ONCE (or to re-apply SSO config after a resource recreation).
# Usage: ./setup-auth.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

APP_NAME="app-ir-delivery-dashboard"
RESOURCE_GROUP="rg-ir-delivery"
APP_SERVICE_SUBSCRIPTION="ce263855-8d27-4202-8742-0a3b10bf0ebb"  # eBest (hosts the App Service)
APP_REG_NAME="VG IR Delivery Dashboard"
APP_URL="https://${APP_NAME}.azurewebsites.net"
VG_TENANT_ID="b3ee2fac-c7a8-4e3d-a177-da6fcfc13573"              # visiongroupretail.com tenant

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $1"; }
success() { echo -e "${GREEN}[OK]${NC}    $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}   VG IR Delivery Dashboard — SSO Setup                 ${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── Resolve az command ────────────────────────────────────────────────────────
if command -v az &>/dev/null; then
  AZ="az"
elif python3 -m azure.cli --version &>/dev/null 2>&1; then
  AZ="python3 -m azure.cli"
else
  pip3 install azure-cli --quiet || error "Azure CLI install failed."
  AZ="python3 -m azure.cli"
fi
success "Azure CLI ready"

# ── Step 1: Login to VG tenant (visiongroupretail.com) for App Registration ──
info "Checking login for VG tenant (visiongroupretail.com)…"
$AZ account set --subscription "$VG_TENANT_ID" 2>/dev/null || true
VG_TENANT_CHECK=$($AZ account show --query "tenantId" -o tsv 2>/dev/null || true)

if [ "$VG_TENANT_CHECK" != "$VG_TENANT_ID" ]; then
  warn "Not logged into VG tenant. Starting device-code login…"
  $AZ login --tenant "$VG_TENANT_ID" --use-device-code --allow-no-subscriptions
fi
success "Logged into VG tenant as: $($AZ account show --query 'user.name' -o tsv 2>/dev/null)"

# ── Step 2: Create/update App Registration in VG tenant ──────────────────────
info "Checking for existing App Registration '$APP_REG_NAME' in VG tenant…"
CLIENT_ID=$($AZ ad app list --display-name "$APP_REG_NAME" --query "[0].appId" -o tsv 2>/dev/null || true)

if [ -z "$CLIENT_ID" ]; then
  info "Creating new Azure AD App Registration in VG tenant…"
  CLIENT_ID=$($AZ ad app create \
    --display-name "$APP_REG_NAME" \
    --sign-in-audience "AzureADMyOrg" \
    --web-redirect-uris "${APP_URL}/.auth/login/aad/callback" \
    --query "appId" -o tsv)
  success "App Registration created — Client ID: $CLIENT_ID"
else
  info "App Registration exists — Client ID: $CLIENT_ID"
  $AZ ad app update \
    --id "$CLIENT_ID" \
    --web-redirect-uris "${APP_URL}/.auth/login/aad/callback" 2>/dev/null || true
fi

# ── Step 3: Enable ID token issuance (required for Easy Auth hybrid flow) ────
info "Enabling ID token issuance…"
$AZ ad app update --id "$CLIENT_ID" --enable-id-token-issuance true 2>/dev/null || true
success "ID token issuance enabled."

# ── Step 4: Generate client secret ───────────────────────────────────────────
info "Generating client secret (valid 2 years)…"
CLIENT_SECRET=$($AZ ad app credential reset \
  --id "$CLIENT_ID" \
  --years 2 \
  --query "password" -o tsv 2>/dev/null)
success "Client secret generated."

# ── Step 5: Switch to eBest subscription (App Service lives here) ─────────────
info "Switching to App Service subscription (eBest)…"
$AZ account set --subscription "$APP_SERVICE_SUBSCRIPTION"
success "Switched — now on App Service subscription."

# ── Step 6: Store secret in App Settings ─────────────────────────────────────
info "Storing client secret in App Service settings…"
$AZ webapp config appsettings set \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --settings MICROSOFT_PROVIDER_AUTHENTICATION_SECRET="$CLIENT_SECRET" \
  -o none
success "Secret stored securely in App Settings."

# ── Step 7: Enable Easy Auth pointing at VG tenant ───────────────────────────
info "Enabling Azure AD Easy Auth (issuer: visiongroupretail.com tenant)…"
$AZ webapp auth update \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --enabled true \
  --action LoginWithAzureActiveDirectory \
  --aad-client-id "$CLIENT_ID" \
  --aad-client-secret "$CLIENT_SECRET" \
  --aad-token-issuer-url "https://sts.windows.net/${VG_TENANT_ID}/" \
  -o none
success "Easy Auth enabled — only @visiongroupretail.com accounts can sign in."

# ── Step 8: Restart app to apply changes ─────────────────────────────────────
info "Restarting App Service…"
$AZ webapp restart --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" -o none
success "App restarted."

# ── Step 9: Verify ────────────────────────────────────────────────────────────
info "Running verification…"
sleep 5
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Accept: text/html,application/xhtml+xml" \
  -H "User-Agent: Mozilla/5.0" \
  --max-redirs 0 \
  "$APP_URL/" 2>/dev/null || true)

REDIRECT_URL=$(curl -s -o /dev/null -w "%{redirect_url}" \
  -H "Accept: text/html,application/xhtml+xml" \
  -H "User-Agent: Mozilla/5.0" \
  --max-redirs 0 \
  "$APP_URL/" 2>/dev/null || true)

if [ "$HTTP_CODE" = "302" ] && echo "$REDIRECT_URL" | grep -q "$VG_TENANT_ID"; then
  success "SSO verified — browser requests redirect to VG Microsoft login (HTTP 302)"
elif [ "$HTTP_CODE" = "302" ]; then
  warn "Got 302 but redirect tenant may differ. Check: $REDIRECT_URL"
else
  warn "Got HTTP $HTTP_CODE — may still be warming up. Try again in 30s."
fi

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}   SSO Setup Complete                                         ${NC}"
echo -e "${GREEN}   URL    : ${APP_URL}                                        ${NC}"
echo -e "${GREEN}   Auth   : Microsoft Entra ID — visiongroupretail.com        ${NC}"
echo -e "${GREEN}   Access : VG organisation accounts only                     ${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
