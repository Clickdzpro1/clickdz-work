#!/usr/bin/env python3
"""Railway provisioning + ops for the ClickDz Work stack (work.clickdz.ai).

Auth: env RAILWAY_ACCOUNT_TOKEN (Account OR workspace token; workspace tokens
cannot query `me` — verify uses `projects`). GraphQL at backboard.railway.app/graphql/v2, Bearer.

Actions:
  verify                       auth check (me + project list)
  provision                    create the full stack: project clickdz-work,
                               postgres (pgvector/pgvector:pg16 + volume),
                               redis (redis:7-alpine), app (ghcr image +
                               volume + env vars + start command + domain).
                               Idempotent-ish: skips existing project by name.
  status --project-id ID       services + latest deployment states
  redeploy --service-id ID --environment-id ID
  set-var --project-id --environment-id --service-id --name N --value V
  provision output NEVER prints the generated DB password (stays in Railway).
"""
import argparse
import json
import os
import secrets
import string
import sys
import urllib.request

API = "https://backboard.railway.app/graphql/v2"
GHCR_IMAGE = "ghcr.io/clickdzpro1/clickdz-work:stable"
START_CMD = "sh -c 'node ./scripts/self-host-predeploy.js && node ./dist/main.js'"


def tok():
    t = os.environ.get("RAILWAY_ACCOUNT_TOKEN", "").strip()
    if not t:
        sys.exit("ERROR: RAILWAY_ACCOUNT_TOKEN not set (configure skill credential)")
    return t


def gql(query, variables=None):
    body = json.dumps({"query": query, "variables": variables or {}}).encode()
    req = urllib.request.Request(
        API, data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {tok()}",
                 "User-Agent": "clickdz-work-deploy/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            d = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        sys.exit(f"HTTP {e.code} from Railway API — token invalid or lacks scope")
    if d.get("errors"):
        raise RuntimeError("GQL: " + d["errors"][0].get("message", "?")[:300])
    return d["data"]


def find_project(name):
    d = gql("query { projects { edges { node { id name environments { edges { node { id name } } } } } } }")
    for e in d["projects"]["edges"]:
        if e["node"]["name"] == name:
            return e["node"]
    return None


def create_service(project_id, env_id, name, image, variables=None):
    d = gql(
        """mutation($in: ServiceCreateInput!) {
             serviceCreate(input: $in) { id name }
           }""",
        {"in": {"projectId": project_id, "name": name,
                "source": {"image": image},
                "variables": variables or {}}})
    return d["serviceCreate"]["id"]


def add_volume(project_id, env_id, service_id, mount):
    gql(
        """mutation($in: VolumeCreateInput!) {
             volumeCreate(input: $in) { id }
           }""",
        {"in": {"projectId": project_id, "environmentId": env_id,
                "serviceId": service_id, "mountPath": mount}})


def set_vars(project_id, env_id, service_id, kv):
    for k, v in kv.items():
        gql(
            """mutation($in: VariableUpsertInput!) {
                 variableUpsert(input: $in)
               }""",
            {"in": {"projectId": project_id, "environmentId": env_id,
                    "serviceId": service_id, "name": k, "value": v}})


def set_start_command(env_id, service_id, cmd):
    gql(
        """mutation($env: String!, $svc: String!, $in: ServiceInstanceUpdateInput!) {
             serviceInstanceUpdate(environmentId: $env, serviceId: $svc, input: $in)
           }""",
        {"env": env_id, "svc": service_id, "in": {"startCommand": cmd}})


def create_domain(env_id, service_id, port):
    d = gql(
        """mutation($in: ServiceDomainCreateInput!) {
             serviceDomainCreate(input: $in) { domain }
           }""",
        {"in": {"environmentId": env_id, "serviceId": service_id,
                "targetPort": port}})
    return d["serviceDomainCreate"]["domain"]


def provision():
    name = "clickdz-work"
    proj = find_project(name)
    if proj:
        print(f"project '{name}' already exists ({proj['id']}) — reusing")
    else:
        d = gql(
            """mutation($in: ProjectCreateInput!) {
                 projectCreate(input: $in) {
                   id name environments { edges { node { id name } } } }
               }""",
            {"in": {"name": name,
                    "description": "ClickDz Work — work.clickdz.ai production"}})
        proj = d["projectCreate"]
        print(f"project created: {proj['id']}")
    envs = {e["node"]["name"]: e["node"]["id"]
            for e in proj["environments"]["edges"]}
    env_id = envs.get("production") or next(iter(envs.values()))
    print(f"environment: {env_id}")

    pw = "".join(secrets.choice(string.ascii_letters + string.digits)
                 for _ in range(32))

    pg_id = create_service(proj["id"], env_id, "postgres",
                           "pgvector/pgvector:pg16",
                           {"POSTGRES_USER": "clickdzwork",
                            "POSTGRES_PASSWORD": pw,
                            "POSTGRES_DB": "clickdzwork",
                            "PGDATA": "/var/lib/postgresql/data/pgdata"})
    add_volume(proj["id"], env_id, pg_id, "/var/lib/postgresql/data")
    print(f"postgres service: {pg_id} (pgvector, volume attached)")

    redis_id = create_service(proj["id"], env_id, "redis", "redis:7-alpine")
    print(f"redis service: {redis_id} (private network only)")

    app_id = create_service(
        proj["id"], env_id, "app", GHCR_IMAGE,
        {"DATABASE_URL":
             f"postgresql://clickdzwork:{pw}@postgres.railway.internal:5432/clickdzwork",
         "REDIS_SERVER_HOST": "redis.railway.internal",
         "REDIS_SERVER_PORT": "6379",
         "AFFINE_INDEXER_ENABLED": "false",
         "AFFINE_SERVER_HTTPS": "true",
         "PORT": "3010"})
    add_volume(proj["id"], env_id, app_id, "/root/.affine")
    set_start_command(env_id, app_id, START_CMD)
    domain = create_domain(env_id, app_id, 3010)
    set_vars(proj["id"], env_id, app_id,
             {"AFFINE_SERVER_HOST": domain,
              "AFFINE_SERVER_EXTERNAL_URL": f"https://{domain}"})
    print(f"app service: {app_id}")
    print(f"domain: https://{domain}")
    print(json.dumps({"projectId": proj["id"], "environmentId": env_id,
                      "services": {"postgres": pg_id, "redis": redis_id,
                                   "app": app_id},
                      "domain": domain,
                      "note": "DB password stored only in Railway variables"}))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--action", required=True,
                    choices=["verify", "provision", "status", "redeploy",
                             "set-var"])
    ap.add_argument("--project-id")
    ap.add_argument("--environment-id")
    ap.add_argument("--service-id")
    ap.add_argument("--name")
    ap.add_argument("--value")
    a = ap.parse_args()

    if a.action == "verify":
        d = gql("query { projects { edges { node { id name } } } }")
        print(json.dumps(d))
    elif a.action == "provision":
        provision()
    elif a.action == "status":
        d = gql(
            """query($id: String!) {
                 project(id: $id) {
                   name
                   services { edges { node { id name } } }
                   environments { edges { node { id name } } }
                 }
               }""", {"id": a.project_id})
        print(json.dumps(d, indent=2))
    elif a.action == "redeploy":
        gql("""mutation($env: String!, $svc: String!) {
                 serviceInstanceRedeploy(environmentId: $env, serviceId: $svc)
               }""", {"env": a.environment_id, "svc": a.service_id})
        print("redeploy triggered")
    elif a.action == "set-var":
        set_vars(a.project_id, a.environment_id, a.service_id,
                 {a.name: a.value})
        print(f"variable {a.name} set")


if __name__ == "__main__":
    main()
