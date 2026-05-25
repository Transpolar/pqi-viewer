#!/usr/bin/env bash
# ============================================================
# deploy.sh — Deploy PQI Viewer to Azure Container Apps
# Run this in Azure Cloud Shell (portal.azure.com > Cloud Shell)
# No local Docker or CLI setup needed.
# ============================================================
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Transpolar/pqi-viewer/main/infra/deploy.sh | bash
#   OR upload this file in Cloud Shell and run: bash deploy.sh
# ============================================================

set -euo pipefail

# ── Config — edit these if needed ───────────────────────────
APP_NAME="pqiviewer"               # 3-16 lowercase letters/numbers
RESOURCE_GROUP="rg-${APP_NAME}"
LOCATION="norwayeast"
IMAGE_TAG="latest"
GITHUB_REPO="https://github.com/Transpolar/pqi-viewer"
GITHUB_BRANCH="main"
# ────────────────────────────────────────────────────────────

# Derive ACR name the same way Bicep does
# uniqueString equivalent in bash using resource group ID
echo "▶ Step 1: Create resource group"
az group create \
  --name "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --output table

echo "▶ Step 2: Deploy Bicep infrastructure"
# Download Bicep template from GitHub
BICEP_URL="https://raw.githubusercontent.com/Transpolar/pqi-viewer/${GITHUB_BRANCH}/infra/main.bicep"
echo "   Downloading Bicep template from GitHub..."
curl -fsSL "$BICEP_URL" -o /tmp/main.bicep

DEPLOY_OUTPUT=$(az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --template-file /tmp/main.bicep \
  --parameters appName="$APP_NAME" imageTag="$IMAGE_TAG" \
  --output json)

# Extract outputs
ACR_SERVER=$(echo "$DEPLOY_OUTPUT" | \
  python3 -c "import sys,json; \
  o=json.load(sys.stdin)['properties']['outputs']; \
  print(o['acrLoginServer']['value'])")

APP_URL=$(echo "$DEPLOY_OUTPUT" | \
  python3 -c "import sys,json; \
  o=json.load(sys.stdin)['properties']['outputs']; \
  print(o['appUrl']['value'])")

ACR_NAME=$(echo "$ACR_SERVER" | cut -d'.' -f1)

echo "✓ ACR:     $ACR_SERVER"
echo "✓ App URL: $APP_URL"

echo "▶ Step 3: Build Docker image from GitHub using ACR Tasks"
# ACR Tasks pulls directly from GitHub and builds in the cloud
# No local Docker needed
az acr build \
  --registry "$ACR_NAME" \
  --image "pqi-viewer:${IMAGE_TAG}" \
  --file Dockerfile \
  "${GITHUB_REPO}#${GITHUB_BRANCH}"

echo "▶ Step 4: Update Container App to use new image"
az containerapp update \
  --name "pqi-viewer" \
  --resource-group "$RESOURCE_GROUP" \
  --image "${ACR_SERVER}/pqi-viewer:${IMAGE_TAG}" \
  --output table

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
echo "   # Redeploy after a code update"
echo "   az acr build --registry $ACR_NAME --image pqi-viewer:latest --file Dockerfile ${GITHUB_REPO}#${GITHUB_BRANCH}"
echo "   az containerapp update -n pqi-viewer -g $RESOURCE_GROUP --image ${ACR_SERVER}/pqi-viewer:latest"
echo ""
echo "   # Tear down everything (stops all costs)"
echo "   az group delete --name $RESOURCE_GROUP --yes"
