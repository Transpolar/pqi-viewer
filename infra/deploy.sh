#!/usr/bin/env bash
# ============================================================
# deploy.sh — Deploy PQI Viewer (Azure branch) to Container Apps
# Run this in Azure Cloud Shell (portal.azure.com > Cloud Shell)
# No local Docker or CLI setup needed.
# ============================================================
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Transpolar/pqi-viewer/azure/infra/deploy.sh | bash
# ============================================================

set -euo pipefail

# ── Config ──────────────────────────────────────────────────
APP_NAME="pqiviewer"               # 3-16 lowercase letters/numbers
RESOURCE_GROUP="rg-${APP_NAME}"
LOCATION="norwayeast"
IMAGE_TAG="latest"
GITHUB_REPO="https://github.com/Transpolar/pqi-viewer"
GITHUB_BRANCH="azure"              # ← Azure-flavoured branch
# ────────────────────────────────────────────────────────────

echo "▶ Step 1: Create resource group"
az group create \
  --name "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --output table

BICEP_URL="https://raw.githubusercontent.com/Transpolar/pqi-viewer/${GITHUB_BRANCH}/infra/main.bicep"
echo "▶ Step 2: Download Bicep template from GitHub (branch: ${GITHUB_BRANCH})"
curl -fsSL "$BICEP_URL" -o /tmp/main.bicep

echo "▶ Step 3: Deploy infrastructure (ACR + Log Analytics + Postgres + Env)"
PRE_OUTPUT=$(az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --name pqi-pre \
  --template-file /tmp/main.bicep \
  --parameters appName="$APP_NAME" imageTag="$IMAGE_TAG" deployContainerApp=false \
  --output json)

ACR_NAME=$(echo "$PRE_OUTPUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['properties']['outputs']['acrName']['value'])")
ACR_SERVER=$(echo "$PRE_OUTPUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['properties']['outputs']['acrLoginServer']['value'])")
PG_FQDN=$(echo "$PRE_OUTPUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['properties']['outputs']['pgFqdn']['value'])")
echo "✓ ACR:      $ACR_SERVER"
echo "✓ Postgres: $PG_FQDN"

echo "▶ Step 4: Build Docker image from GitHub using ACR Tasks"
az acr build \
  --registry "$ACR_NAME" \
  --image "pqi-viewer:${IMAGE_TAG}" \
  --file Dockerfile \
  "${GITHUB_REPO}#${GITHUB_BRANCH}"

echo "▶ Step 5: Remove any prior failed Container App (idempotent)"
az containerapp delete \
  --name pqi-viewer \
  --resource-group "$RESOURCE_GROUP" \
  --yes \
  --output none 2>/dev/null || true

echo "▶ Step 6: Deploy Container App (image now exists in ACR)"
APP_OUTPUT=$(az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --name pqi-app \
  --template-file /tmp/main.bicep \
  --parameters appName="$APP_NAME" imageTag="$IMAGE_TAG" deployContainerApp=true \
  --output json)

APP_URL=$(echo "$APP_OUTPUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['properties']['outputs']['appUrl']['value'])")

echo ""
echo "✅ Deployment complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   🌍 App URL:  $APP_URL"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "   Note: First visit may be slow (cold start)."
echo ""
echo "   Useful commands:"
echo "   # Stream live logs"
echo "   az containerapp logs show -n pqi-viewer -g $RESOURCE_GROUP --follow"
echo ""
echo "   # Redeploy after a code update on the ${GITHUB_BRANCH} branch"
echo "   az acr build --registry $ACR_NAME --image pqi-viewer:latest --file Dockerfile ${GITHUB_REPO}#${GITHUB_BRANCH}"
echo "   az containerapp update -n pqi-viewer -g $RESOURCE_GROUP --image ${ACR_SERVER}/pqi-viewer:latest"
echo ""
echo "   # Connect to the DB (psql in Cloud Shell)"
echo "   az postgres flexible-server connect -n ${APP_NAME}-pg -u pqiadmin -d pqi"
echo ""
echo "   # Tear down everything (stops all costs)"
echo "   az group delete --name $RESOURCE_GROUP --yes"
