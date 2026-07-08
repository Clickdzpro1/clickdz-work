# 🚀 ClickDz Work Railway Deploy Guide

**Build Complete!** ✅ All jobs passed (Run #26, image-stable-25)

**Image:** `ghcr.io/clickdzpro1/clickdz-work:stable-46294a99d1a4`

---

## Quick Deploy (Web UI — 5 minutes)

### 1. Supabase Database (if not already set up)
- Vercel Dashboard → Storage/Marketplace → Supabase → Create project
- Supabase dashboard → Database → Extensions → **Enable "vector"**
- Copy the **Session pooler** connection string (port 5432, NOT 6543)
- This = `DATABASE_URL`

### 2. Railway Project

1. Go to **https://railway.com/new**
2. Click **"Deploy Docker Image"**
3. Paste:
   ```
   ghcr.io/clickdzpro1/clickdz-work:stable-46294a99d1a4
   ```
4. **Add Volume** → Mount path: `/root/.ClickDz Work`
5. **Add Redis** → New → Database → Redis (Railway auto-creates it)

### 3. Environment Variables

Go to Service → Variables, add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `postgresql://...` (Supabase session pooler) |
| `REDIS_SERVER_HOST` | `${{Redis.RAILWAY_PRIVATE_DOMAIN}}` |
| `REDIS_SERVER_PORT` | `6379` |
| `REDIS_SERVER_PASSWORD` | `${{Redis.REDIS_PASSWORD}}` |
| `AFFINE_SERVER_HTTPS` | `true` |
| `AFFINE_SERVER_HOST` | `work.clickdz.ai` |
| `COPILOT_OPENAI_API_KEY` | `sk-...` (for AI features) |
| `AFFINE_INDEXER_ENABLED` | `true` |

### 4. Custom Start Command

Service → Settings → Deploy → **Custom Start Command**:
```
sh -c "node ./scripts/self-host-predeploy.js && node ./dist/main.js"
```

### 5. Domain

Networking → Generate domain → Add custom domain: `work.clickdz.ai`

---

## CLI Deploy (Alternative)

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Run deploy script
chmod +x railway-deploy.sh
./railway-deploy.sh
```

---

## Files Created

| File | Description |
|---|---|
| `railway-deploy.sh` | Automated CLI deploy script |
| `railway-env.txt` | Environment variables template |
| `DEPLOY.md` | This guide |

---

## Post-Deploy Checklist

- [ ] Open `work.clickdz.ai` in browser
- [ ] Sign up with email → onboarding wizard appears
- [ ] Select niche (e.g., "Agence digitale")
- [ ] Verify AI chat, typewriter effect, Arabic/RTL
- [ ] Test image generation, document creation

**Build status:** https://github.com/Clickdzpro1/clickdz-work/actions/runs/28910335647
