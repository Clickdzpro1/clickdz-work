# ClickDz ERP — ERPNext deploy kit (erp.clickdz.ai)

ERPNext v15 via the official frappe_docker production topology: 8 services
sharing one `sites` volume (backend, nginx frontend, websocket, 2 queue
workers, scheduler, MariaDB 10.6, 2x Redis).

**Why not Railway like ClickDz Work?** Frappe requires a SHARED volume
(`/home/frappe/frappe-bench/sites`) mounted into 6 services at once.
Railway volumes attach to a single service — the topology physically
doesn't map. A small VPS with Docker Compose is the supported, boring,
correct home for ERPNext. (Alternative: Frappe Cloud, managed, from
~$10/mo, zero ops.)

## VPS runbook (any Docker host, 2GB+ RAM recommended)

```bash
mkdir -p /opt/clickdz-erp && cd /opt/clickdz-erp
# copy compose.yml + .env.template from deploy/erpnext/
cp .env.template .env    # fill both passwords + site name
docker compose up -d db redis-cache redis-queue
docker compose up configurator      # one-shot, wait for exit 0
docker compose up create-site       # one-shot, ~2-4 min, wait for exit 0
docker compose up -d                # everything else
```

TLS: put Caddy in front (`erp.clickdz.ai { reverse_proxy :8080 }`) or any
panel proxy. DNS: `erp.clickdz.ai` A-record → VPS IP.

First login: `Administrator` / the `ERP_ADMIN_PASSWORD` you set.

## Notes

- The `Clickdzpro1/erpnext` fork is currently a VANILLA mirror of
  frappe/erpnext (develop). Production runs the official `frappe/erpnext:v15`
  image. When we add custom ClickDz apps, build a custom image from the fork
  (frappe_docker layered build) and change `ERPNEXT_VERSION`/image.
- ERPNext is GPLv3 — self-hosting and branding are fine; if we distribute a
  modified ERPNext to third parties, source must be offered under GPLv3.
  Internal/agency SaaS use = no obligation to publish customizations.
- Backups: `docker compose exec backend bench --site erp.clickdz.ai backup`
  (schedule via cron; volumes db-data + sites hold everything).
- ClickDz Work ↔ ClickDz ERP integration ideas (phase 2): shared SSO,
  ClickDz Work doc links inside ERP records, AI copilot against ERP data via
  ERPNext REST API + OpenAI.
