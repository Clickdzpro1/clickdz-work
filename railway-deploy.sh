#!/bin/bash
# ClickDz Work Railway Deploy Script
# Run: chmod +x railway-deploy.sh && ./railway-deploy.sh

set -e

IMAGE="ghcr.io/clickdzpro1/clickdz-work:stable-46294a99d1a4"
PROJECT_NAME="clickdz-work"

echo "🚀 ClickDz Work Railway Deploy"
echo "==============================="
echo ""
echo "Image: $IMAGE"
echo ""

# Check if railway CLI is installed
if ! command -v railway &> /dev/null; then
    echo "❌ Railway CLI not found. Install it:"
    echo "   npm install -g @railway/cli"
    echo "   or: brew install railway"
    echo ""
    echo "Then run: railway login"
    echo ""
    echo "Or deploy manually via Railway web UI:"
    echo "1. Go to https://railway.com/new"
    echo "2. Click 'Deploy Docker Image'"
    echo "3. Paste: $IMAGE"
    echo "4. Add a Volume (mount: /root/.ClickDz Work)"
    echo "5. Add Redis service (New → Database → Redis)"
    echo "6. Set env vars (see railway-env.txt)"
    echo "7. Set start command: sh -c 'node ./scripts/self-host-predeploy.js && node ./dist/main.js'"
    exit 1
fi

echo "✅ Railway CLI found"
echo ""

# Check login
if ! railway whoami &> /dev/null; then
    echo "🔐 Please login: railway login"
    railway login
fi

echo "✅ Logged in as: $(railway whoami)"
echo ""

# Create or link project
echo "📁 Creating project..."
if railway link --name "$PROJECT_NAME" 2>/dev/null; then
    echo "✅ Linked to existing project: $PROJECT_NAME"
else
    echo "🆕 Creating new project..."
    railway init --name "$PROJECT_NAME"
fi

echo ""
echo "🐳 Deploying Docker image..."
railway add --docker-image "$IMAGE"

echo ""
echo "📦 Adding Redis..."
railway add --redis

echo ""
echo "💾 Adding Volume..."
# Note: Volume must be added via Railway dashboard for now
echo "⚠️  Please add a Volume via Railway dashboard:"
echo "   Service → Settings → Volumes → Add Volume"
echo "   Mount Path: /root/.ClickDz Work"

echo ""
echo "🔧 Setting environment variables..."
echo "   (Please set these in Railway dashboard → Variables)"
cat railway-env.txt

echo ""
echo "🚀 Deploying..."
railway up

echo ""
echo "✅ Deploy complete!"
echo "🌐 Add custom domain: work.clickdz.ai"
echo "📊 Monitor: https://railway.com/project/$(railway project)"
