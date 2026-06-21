#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# VG IR Delivery Dashboard — Teams Notifier Setup Script
# Creates an Azure AD App Registration with Microsoft Graph permissions
# for sending automated Teams DMs to ticket assignees.
#
# Run ONCE to provision. The credentials it prints go into .config.json
# (local) and App Service app settings (Azure).
#
# Usage: ./setup-teams.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

APP_NAME="app-ir-delivery-dashboard"
RESOURCE_GROUP="rg-ir-delivery"
APP_SERVICE_SUBSCRIPTION="ce263855-8d27-4202-8742-0a3b10bf0ebb"
APP_REG_NAME="VG IR Teams Notifier"
VG_TENANT_ID="b3ee2fac-c7a8-4e3d-a177-da6fcfc13573"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $1"; }
success() { echo -e "${GREEN}[OK]${NC}    $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Graph API application permission IDs (Microsoft Graph = 00000003-0000-0000-c000-000000000000)
GRAPH_APP_ID="00000003-0000-0000-c000-000000000000"
PERM_CHAT_CREATE="d9c48af6-9ad9-47ad-82c3-63757137b9af"       # Chat.Create
PERM_CHAT_READWRITE="294ce7c9-31ba-490a-ad7d-97a7d075e4ed"   # Chat.ReadWrite.All (app permission for sending messages)
PERM_USER_READ_ALL="df021288-bdef-4463-88db-98f22de89214"     # User.Read.All

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}   VG IR Teams Notifier — Azure AD App Setup            ${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── Resolve az ───────────────────────────────────────────────────────────────
if command -v az &>/dev/null; then AZ="az"
elif python3 -m azure.cli --version &>/dev/null 2>&1; then AZ="python3 -m azure.cli"
else pip3 install azure-cli --quiet || error "Azure CLI install failed."; AZ="python3 -m azure.cli"; fi
success "Azure CLI ready"

# ── Login to VG tenant ───────────────────────────────────────────────────────
info "Logging in to VG tenant (visiongroupretail.com)…"
VG_TENANT_CHECK=$($AZ account show --query "tenantId" -o tsv 2>/dev/null || true)
if [ "$VG_TENANT_CHECK" != "$VG_TENANT_ID" ]; then
  $AZ login --tenant "$VG_TENANT_ID" --use-device-code --allow-no-subscriptions
fi
success "Logged in as: $($AZ account show --query 'user.name' -o tsv 2>/dev/null)"

# ── Step 1: Create App Registration ─────────────────────────────────────────
info "Checking for existing App Registration '$APP_REG_NAME'…"
CLIENT_ID=$($AZ ad app list --display-name "$APP_REG_NAME" --query "[0].appId" -o tsv 2>/dev/null || true)

if [ -z "$CLIENT_ID" ]; then
  info "Creating App Registration '$APP_REG_NAME'…"
  CLIENT_ID=$($AZ ad app create \
    --display-name "$APP_REG_NAME" \
    --sign-in-audience "AzureADMyOrg" \
    --query "appId" -o tsv)
  success "App Registration created — Client ID: $CLIENT_ID"
else
  success "App Registration already exists — Client ID: $CLIENT_ID"
fi

# Get the service principal (create if missing)
SP_ID=$($AZ ad sp show --id "$CLIENT_ID" --query "id" -o tsv 2>/dev/null || true)
if [ -z "$SP_ID" ]; then
  info "Creating Service Principal…"
  SP_ID=$($AZ ad sp create --id "$CLIENT_ID" --query "id" -o tsv)
fi
success "Service Principal: $SP_ID"

# ── Step 2: Add Graph API application permissions ────────────────────────────
info "Adding Microsoft Graph application permissions…"
$AZ ad app permission add \
  --id "$CLIENT_ID" \
  --api "$GRAPH_APP_ID" \
  --api-permissions \
    "${PERM_CHAT_CREATE}=Role" \
    "${PERM_CHAT_READWRITE}=Role" \
    "${PERM_USER_READ_ALL}=Role" \
  2>/dev/null || warn "Permission add returned non-zero (may already exist)"
success "Permissions added: Chat.Create · Chat.ReadWrite.All · User.Read.All"

# ── Step 3: Grant admin consent ──────────────────────────────────────────────
info "Granting admin consent for Graph permissions…"
$AZ ad app permission admin-consent --id "$CLIENT_ID" 2>/dev/null || \
  warn "Admin consent via CLI failed — grant manually in Azure Portal > App Registrations > API Permissions > Grant admin consent"

# ── Step 4: Generate client secret ───────────────────────────────────────────
info "Generating client secret (valid 2 years)…"
CLIENT_SECRET=$($AZ ad app credential reset \
  --id "$CLIENT_ID" \
  --years 2 \
  --query "password" -o tsv 2>/dev/null)
success "Client secret generated."

# ── Step 5: Store credentials in App Service settings ────────────────────────
info "Switching to App Service subscription…"
$AZ account set --subscription "$APP_SERVICE_SUBSCRIPTION"

info "Storing Teams credentials in App Service environment variables…"
$AZ webapp config appsettings set \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --settings \
    TEAMS_TENANT_ID="$VG_TENANT_ID" \
    TEAMS_CLIENT_ID="$CLIENT_ID" \
    TEAMS_CLIENT_SECRET="$CLIENT_SECRET" \
  -o none
success "App Settings updated."

# ── Done — print local config snippet ────────────────────────────────────────
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}   Setup Complete!                                      ${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Add these fields to your LOCAL .config.json:"
echo ""
echo -e "  ${CYAN}\"teamsTenantId\":    \"${VG_TENANT_ID}\"${NC}"
echo -e "  ${CYAN}\"teamsClientId\":    \"${CLIENT_ID}\"${NC}"
echo -e "  ${CYAN}\"teamsClientSecret\":\"${CLIENT_SECRET}\"${NC}"
echo ""
echo "  The Azure App Service already has these as environment variables."
echo ""
echo -e "${YELLOW}  IMPORTANT: If admin consent failed above, go to:${NC}"
echo "  Azure Portal → Azure Active Directory → App Registrations"
echo "  → '$APP_REG_NAME' → API permissions → Grant admin consent"
echo ""
