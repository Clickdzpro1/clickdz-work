#!/usr/bin/env bash
#
# scripts/rollback.sh — Rollback the ClickDz Work canary deployment to a prior
# good image tag by setting BASE_IMAGE on Railway and triggering a redeploy.
#
# Usage:
#   RAILWAY_API_TOKEN=raf_xxx ./scripts/rollback.sh
#
# Requirements:
#   - RAILWAY_API_TOKEN env var set (Railway account token with project access)
#   - curl, jq, git installed
#   - Run from the clickdz-work repo root (or any git repo with canary history)
#
# Make executable: chmod +x scripts/rollback.sh
#
set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────
RAILWAY_PROJECT_ID="2db22118-85ba-4f0c-bdde-70afb29bb41f"
RAILWAY_ENV_ID="e20e157a-7465-4896-a728-d85c01615541"
RAILWAY_SERVICE_ID="f080c2b7-55ee-4f6f-999a-f58f99f27841"
GHCR_REGISTRY="ghcr.io/clickdzpro1/clickdz-work"
NUM_TAGS=20  # how many recent SHAs to list

# ─── Pre-flight checks ───────────────────────────────────────────────────────
if [[ -z "${RAILWAY_API_TOKEN:-}" ]]; then
  echo "ERROR: RAILWAY_API_TOKEN env var is not set."
  echo "  Get it from: Railway Dashboard → Account Settings → Tokens"
  echo "  Usage: RAILWAY_API_TOKEN=raf_xxx ./scripts/rollback.sh"
  exit 1
fi

for cmd in curl jq git; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: '$cmd' is not installed. Please install it first."
    exit 1
  fi
done

# ─── Step 1: List recent canary SHA9 tags ────────────────────────────────────
echo ""
echo "=== Recent canary commits (last $NUM_TAGS) ==="
echo ""

# Get the last N commit SHAs from canary branch, extract 9-char short SHA
# The image tag format is: canary-<SHA9> where SHA9 is the first 9 chars of the full SHA
mapfile -t SHAS < <(git log --format='%H' -"$NUM_TAGS" -- 2>/dev/null | cut -c1-9)

if [[ ${#SHAS[@]} -eq 0 ]]; then
  echo "ERROR: No commits found. Are you in the clickdz-work repo?"
  exit 1
fi

for i in "${!SHAS[@]}"; do
  sha9="${SHAS[$i]}"
  if [[ "$i" -eq 0 ]]; then
    echo "  [$i] $sha9  (current HEAD)"
  else
    echo "  [$i] $sha9"
  fi
done

# ─── Step 2: Prompt user to pick a tag ───────────────────────────────────────
echo ""
read -rp "Select a tag to rollback to (0-$(( ${#SHAS[@]} - 1 ))), or 'q' to quit: " SELECTION

if [[ "$SELECTION" == "q" || "$SELECTION" == "Q" ]]; then
  echo "Rollback cancelled."
  exit 0
fi

if ! [[ "$SELECTION" =~ ^[0-9]+$ ]] || [[ "$SELECTION" -ge "${#SHAS[@]}" ]]; then
  echo "ERROR: Invalid selection '$SELECTION'."
  exit 1
fi

SHA9="${SHAS[$SELECTION]}"
NEW_BASE_IMAGE="${GHCR_REGISTRY}:canary-${SHA9}"

echo ""
echo "=== Rollback plan ==="
echo "  New BASE_IMAGE: $NEW_BASE_IMAGE"
echo "  Railway project:  $RAILWAY_PROJECT_ID"
echo "  Environment:      $RAILWAY_ENV_ID"
echo "  Service:          $RAILWAY_SERVICE_ID"
echo ""
read -rp "Confirm rollback? (yes/no): " CONFIRM

if [[ "$CONFIRM" != "yes" ]]; then
  echo "Rollback cancelled."
  exit 0
fi

# ─── Step 3: Set BASE_IMAGE via Railway GraphQL API ──────────────────────────
# Railway API: https://api.railway.app/graphql/v2
# We use the variableCollectionUpsert mutation to set a service variable.
# Setting a variable auto-triggers a redeploy — no separate redeploy call needed.

RAILWAY_API_URL="https://api.railway.app/graphql/v2"

# GraphQL mutation to upsert a variable on a specific service + environment
# This sets BASE_IMAGE and triggers an automatic redeploy
GRAPHQL_PAYLOAD=$(jq -n \
  --arg projectId "$RAILWAY_PROJECT_ID" \
  --arg envId "$RAILWAY_ENV_ID" \
  --arg serviceId "$RAILWAY_SERVICE_ID" \
  --arg name "BASE_IMAGE" \
  --arg value "$NEW_BASE_IMAGE" \
  '{
    query: "mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) { id } }",
    variables: {
      input: {
        projectId: $projectId,
        environmentId: $envId,
        serviceId: $serviceId,
        variables: {
          ($name): $value
        }
      }
    }
  }')

echo ""
echo "Setting BASE_IMAGE=$NEW_BASE_IMAGE on Railway..."

# Make the API call to Railway
HTTP_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$RAILWAY_API_URL" \
  -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "User-Agent: clickdz-rollback/1.0" \
  -d "$GRAPHQL_PAYLOAD")

HTTP_CODE=$(echo "$HTTP_RESPONSE" | tail -1)
RESPONSE_BODY=$(echo "$HTTP_RESPONSE" | head -n -1)

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "ERROR: Railway API returned HTTP $HTTP_CODE"
  echo "Response: $RESPONSE_BODY"
  exit 1
fi

# Check for GraphQL errors
ERRORS=$(echo "$RESPONSE_BODY" | jq -r '.errors // empty')
if [[ -n "$ERRORS" ]]; then
  echo "ERROR: Railway GraphQL returned errors:"
  echo "$ERRORS" | jq .
  exit 1
fi

echo ""
echo "✅ BASE_IMAGE set to $NEW_BASE_IMAGE"
echo "   Railway will auto-redeploy the humanizily-backend service."
echo ""
echo "=== Post-rollback verification ==="
echo "  1. Wait ~2-5 min for the redeploy to complete."
echo "  2. Check the site: data-version should show $SHA9"
echo "  3. Check Railway boot logs for UnknownDependenciesException or DI errors."
echo "  4. Verify the app is functional (login, chat, etc.)."
echo ""
echo "Rollback complete."
