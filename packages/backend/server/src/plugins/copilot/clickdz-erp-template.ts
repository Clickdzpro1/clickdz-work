/**
 * ClickDz mini-ERP — COMPLETE single-file business dashboard template (Clerk / WS3).
 *
 * A hash-routed vanilla-JS SPA (no framework, no external requests except the
 * ClickDz Data API) that PAIRS with the Ready Shop on the SAME data slug:
 * shared collections products / orders / customers / expenses / settings.
 *
 * Serve-time wiring: the Gatekeeper bridge substitutes these placeholder tokens
 * before serving (identical to generateApp, RECON A.2):
 *   __CLICKDZ_DATA_URL__    -> <externalBase>/api/v2/apps-data/<slug>
 *   __CLICKDZ_DATA_TOKEN__  -> dataWriteToken(slug)   (Bearer, gates writes/deletes)
 *   __CLICKDZ_SLUG__        -> the app slug (pairing key with the shop)
 * Plus two C5 customization tokens the paired ShopERP wizard threads through so
 * the dashboard matches its storefront at first paint (before shared settings
 * load from the common datastore):
 *   __CLICKDZ_STORE_NAME__  -> store name (fed to the <title>; default "Ma Boutique")
 *   __CLICKDZ_ACCENT__      -> accent #RRGGBB for the light-theme --brand (default "#2f6bff")
 * The runtime settings singleton (shared with the shop) still overrides the
 * store name in-app once loaded; the dark-theme brand shade is left untouched.
 *
 * Data API contract (clickdz-data.controller.ts):
 *   GET    {DATA_URL}/:collection?limit=N  -> records[] (newest-first, no token)
 *   POST   {DATA_URL}/:collection          -> creates {..,id,createdAt} (Bearer required)
 *   DELETE {DATA_URL}/:collection/:id      -> {deleted} (Bearer required)
 * There is NO update endpoint, so edits (status advance, stock +/-, notes) are
 * done delete-then-create; stable business keys (product sku, order orderedAt)
 * are preserved across re-creation. Caps: 8KB/record, 500/collection. Currency DZD.
 * Order.status enum: Nouvelle | Confirmee | Expediee | Livree | Retournee.
 *
 * MODULE FLAGS (WSF-6, R2): the nav + each section is gated by moduleOn(id),
 * reading the shared settings singleton the SAME way the shop template reads
 * settings.features (a CSV of enabled module ids). Canonical module ids come
 * from the registry (clickdz-features.ts ERP_FEATURES): apercu, commandes,
 * stock, clients, depenses, reglages — with apercu + reglages CORE (never
 * hidden). ABSENT settings.features means "every current module visible", so
 * an untouched ERP is BYTE-IDENTICAL to today. Four forward-ready module slots
 * (factures, fournisseurs, livraison, caisse) ship dormant: each renders only
 * when BOTH moduleOn('<id>') AND its backend flag is set in the singleton
 * (settings.erpBackends CSV) — both absent by default, so nothing new shows.
 * Their real UIs land in R3; v1 shows a tiny "Configurez depuis le studio"
 * placeholder. No new __CLICKDZ_*__ token is introduced (flags are pure runtime).
 *
 * STAFF LOGIN (WSE-13, R3): a second OPT-IN gate, also driven purely by the
 * shared settings singleton — key "staffAuth". When staffAuth==='1' the single
 * dashboard is placed behind a staff-token login screen: the owner mints a
 * per-employee token in the studio (Équipe page), the employee pastes it here,
 * and the app POSTs { slug, token } to /api/v1/apps-staff/verify (origin derived
 * from the Data URL) to learn its role + permissions. The token is cached in
 * localStorage ("cdz.erp.staff.<slug>") and auto-verified on load; the tabs are
 * role-gated client-side (owner=all, manager=all−reglages, staff=commandes-only)
 * ON TOP of moduleOn. A verify 404 (flag off / older server) or network failure
 * falls back SILENTLY to the legacy no-gate dashboard. When staffAuth is
 * absent/0 (the default) the entire mechanism is inert and the ERP renders
 * BYTE-IDENTICALLY to today. No new __CLICKDZ_*__ token is introduced.
 *
 * ESCAPE AUDIT: the HTML below is emitted with String.raw so the app can use
 * normal JS quotes freely. The source HTML is verified at build time to contain
 * ZERO backticks and ZERO dollar-brace sequences, so nothing inside can terminate
 * or interpolate this template literal. Do not add either without re-escaping.
 */

/* eslint-disable */
// prettier-ignore
export const CLICKDZ_ERP_TEMPLATE_HTML = String.raw`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>__CLICKDZ_STORE_NAME__ — ERP</title>
<style>
  :root{
    --bg:#f4f6fb; --surface:#ffffff; --surface-2:#f8fafc; --line:#e5e9f2;
    --ink:#1a2233; --ink-soft:#5b6577; --ink-faint:#8a93a5;
    --brand:__CLICKDZ_ACCENT__; --brand-soft:#e8effe; --brand-ink:#1d4fd0;
    --ok:#16a06a; --ok-soft:#e2f6ee; --warn:#d9822b; --warn-soft:#fdf0e0;
    --bad:#d64550; --bad-soft:#fdeaec; --info:#4b62d8; --info-soft:#e9edfb;
    --violet:#7b52d0; --violet-soft:#efe8fb;
    --shadow:0 1px 2px rgba(18,32,64,.06),0 8px 24px rgba(18,32,64,.06);
    --shadow-sm:0 1px 2px rgba(18,32,64,.08);
    --radius:14px; --radius-sm:10px;
    --sidebar-w:236px; --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,"Noto Sans Arabic",sans-serif;
  }
  html[data-theme="dark"]{
    --bg:#0e1320; --surface:#161d2e; --surface-2:#1b2437; --line:#28324a;
    --ink:#e7ecf5; --ink-soft:#a3adc2; --ink-faint:#6f7a92;
    --brand:#5c8bff; --brand-soft:#1d2942; --brand-ink:#93b4ff;
    --ok:#3fca90; --ok-soft:#123227; --warn:#efab57; --warn-soft:#33260f;
    --bad:#f0737e; --bad-soft:#331519; --info:#8298f0; --info-soft:#1a2140;
    --violet:#a07be6; --violet-soft:#241a3a;
    --shadow:0 1px 2px rgba(0,0,0,.3),0 10px 30px rgba(0,0,0,.35);
    --shadow-sm:0 1px 2px rgba(0,0,0,.3);
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{background:var(--bg);color:var(--ink);font-family:var(--font);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;transition:background .2s,color .2s}
  a{color:var(--brand-ink);text-decoration:none}
  a:hover{text-decoration:underline}
  button{font-family:inherit;cursor:pointer}
  input,select,textarea{font-family:inherit;font-size:14px}

  /* ===== Layout ===== */
  .app{display:flex;min-height:100vh}
  .sidebar{
    width:var(--sidebar-w);flex:0 0 var(--sidebar-w);background:var(--surface);
    border-right:1px solid var(--line);position:sticky;top:0;height:100vh;
    display:flex;flex-direction:column;gap:2px;padding:16px 12px;z-index:20;
  }
  .brand{display:flex;align-items:center;gap:10px;padding:6px 8px 14px}
  .brand .logo{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,var(--brand),var(--violet));display:grid;place-items:center;color:#fff;font-weight:800;font-size:15px;flex:0 0 30px}
  .brand .bt{font-weight:700;font-size:15px;letter-spacing:-.2px}
  .brand .bs{font-size:11px;color:var(--ink-faint);font-weight:500}
  .navlink{display:flex;align-items:center;gap:11px;padding:9px 11px;border-radius:var(--radius-sm);color:var(--ink-soft);font-weight:600;font-size:13.5px;border:none;background:transparent;width:100%;text-align:left;transition:background .12s,color .12s}
  .navlink .ico{font-size:16px;width:20px;text-align:center;flex:0 0 20px}
  .navlink:hover{background:var(--surface-2);color:var(--ink)}
  .navlink.active{background:var(--brand-soft);color:var(--brand-ink)}
  .navlink .badge{margin-left:auto;background:var(--bad);color:#fff;border-radius:999px;font-size:10.5px;font-weight:700;padding:1px 7px;min-width:18px;text-align:center}
  .nav-spacer{flex:1 1 auto}
  .side-foot{border-top:1px solid var(--line);padding-top:10px;margin-top:8px;display:flex;flex-direction:column;gap:4px}
  .theme-btn{display:flex;align-items:center;gap:9px;padding:8px 11px;border-radius:var(--radius-sm);border:1px solid var(--line);background:var(--surface-2);color:var(--ink-soft);font-weight:600;font-size:12.5px}
  .theme-btn:hover{color:var(--ink)}

  .main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}
  .topbar{position:sticky;top:0;z-index:15;background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line);padding:14px 26px;display:flex;align-items:center;gap:14px}
  .topbar h1{font-size:19px;margin:0;font-weight:750;letter-spacing:-.3px}
  .topbar .sub{color:var(--ink-faint);font-size:12.5px;margin-top:1px}
  .topbar .right{margin-left:auto;display:flex;align-items:center;gap:10px}
  .content{padding:22px 26px 60px;max-width:1180px;width:100%}

  /* ===== Bits ===== */
  .card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow-sm)}
  .btn{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:9px;padding:8px 13px;font-weight:600;font-size:13px;display:inline-flex;align-items:center;gap:7px;transition:background .12s,border-color .12s,transform .04s}
  .btn:hover{background:var(--surface-2)}
  .btn:active{transform:translateY(1px)}
  .btn.primary{background:var(--brand);border-color:var(--brand);color:#fff}
  .btn.primary:hover{filter:brightness(1.06)}
  .btn.ghost{border-color:transparent;background:transparent}
  .btn.ghost:hover{background:var(--surface-2)}
  .btn.sm{padding:5px 9px;font-size:12px;border-radius:8px}
  .btn.icon{padding:6px 9px}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .btn.danger{color:var(--bad);border-color:transparent}
  .btn.danger:hover{background:var(--bad-soft)}
  .input,.select,.textarea{width:100%;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:9px;padding:8px 11px;outline:none;transition:border-color .12s,box-shadow .12s}
  .input:focus,.select:focus,.textarea:focus{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
  .textarea{resize:vertical;min-height:56px}
  label.fld{display:block;font-size:12px;font-weight:600;color:var(--ink-soft);margin-bottom:5px}
  .row{display:flex;gap:10px;flex-wrap:wrap}
  .chip{border:1px solid var(--line);background:var(--surface);color:var(--ink-soft);border-radius:999px;padding:5px 12px;font-size:12.5px;font-weight:600}
  .chip:hover{background:var(--surface-2)}
  .chip.on{background:var(--brand);border-color:var(--brand);color:#fff}
  .pill{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:2px 9px;font-size:11.5px;font-weight:700;white-space:nowrap}
  .pill.s-Nouvelle{background:var(--info-soft);color:var(--info)}
  .pill.s-Confirmée{background:var(--brand-soft);color:var(--brand-ink)}
  .pill.s-Expédiée{background:var(--violet-soft);color:var(--violet)}
  .pill.s-Livrée{background:var(--ok-soft);color:var(--ok)}
  .pill.s-Retournée{background:var(--bad-soft);color:var(--bad)}
  .dot{width:7px;height:7px;border-radius:50%;display:inline-block;background:currentColor}

  /* ===== KPI ===== */
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:18px}
  .kpi{padding:16px 17px}
  .kpi .k-top{display:flex;align-items:center;gap:8px;color:var(--ink-faint);font-size:12px;font-weight:600}
  .kpi .k-ico{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;font-size:14px}
  .kpi .k-val{font-size:25px;font-weight:780;letter-spacing:-.5px;margin-top:9px}
  .kpi .k-sub{font-size:11.5px;color:var(--ink-faint);margin-top:3px}
  .kpi .k-val small{font-size:14px;font-weight:600;color:var(--ink-faint);margin-left:3px}

  /* ===== charts ===== */
  .charts{display:grid;grid-template-columns:1.4fr 1fr;gap:14px;margin-bottom:18px}
  .panel{padding:16px 18px}
  .panel h3{margin:0 0 2px;font-size:14.5px;font-weight:700}
  .panel .p-sub{color:var(--ink-faint);font-size:12px;margin-bottom:12px}
  .chart-wrap{width:100%;overflow:hidden}
  svg{display:block;width:100%;height:auto}
  .empty-chart{display:grid;place-items:center;height:170px;color:var(--ink-faint);font-size:13px;text-align:center;gap:6px;flex-direction:column}

  /* ===== table ===== */
  .tbl-wrap{overflow-x:auto;border-radius:var(--radius);border:1px solid var(--line);background:var(--surface)}
  table{border-collapse:collapse;width:100%;min-width:520px}
  th,td{text-align:left;padding:11px 14px;font-size:13px;border-bottom:1px solid var(--line);vertical-align:middle}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-faint);font-weight:700;background:var(--surface-2);position:sticky;top:0}
  tr:last-child td{border-bottom:none}
  tbody tr:hover{background:var(--surface-2)}
  tr.alert td{background:var(--bad-soft)}
  tr.alert:hover td{background:var(--bad-soft)}
  tr.exp-row td{background:var(--surface-2);padding:0}
  .num{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
  th.num{text-align:right}
  .muted{color:var(--ink-faint)}
  .stepper{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:8px;overflow:hidden}
  .stepper button{border:none;background:var(--surface);color:var(--ink);width:28px;height:28px;font-size:15px;font-weight:700;line-height:1}
  .stepper button:hover{background:var(--brand-soft);color:var(--brand-ink)}
  .stepper .val{min-width:34px;text-align:center;font-weight:700;font-variant-numeric:tabular-nums;font-size:13px}

  /* toolbar/section */
  .sec-head{display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap}
  .sec-head .grow{flex:1 1 auto}
  .search{position:relative;min-width:180px}
  .search input{padding-left:32px}
  .search .si{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--ink-faint);font-size:13px}
  .count-tag{font-size:12px;color:var(--ink-faint);font-weight:600}

  .items-box{padding:12px 16px}
  .items-box .it{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px dashed var(--line);font-size:13px}
  .items-box .it:last-child{border-bottom:none}
  .items-box .it .q{color:var(--ink-faint)}
  .adv-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}

  /* forms grid */
  .form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;align-items:end}
  .addbar{padding:16px 18px;margin-bottom:16px}
  .addbar h3{margin:0 0 12px;font-size:14px;font-weight:700}

  /* states */
  .state{display:grid;place-items:center;text-align:center;padding:52px 20px;gap:12px;color:var(--ink-soft)}
  .state .em{font-size:34px}
  .state .st-t{font-weight:700;font-size:15px;color:var(--ink)}
  .state .st-s{font-size:13px;color:var(--ink-faint);max-width:360px}
  .spin{width:34px;height:34px;border-radius:50%;border:3px solid var(--line);border-top-color:var(--brand);animation:sp .7s linear infinite}
  @keyframes sp{to{transform:rotate(360deg)}}
  .banner{border-radius:var(--radius-sm);padding:11px 14px;font-size:13px;font-weight:500;display:flex;gap:10px;align-items:flex-start}
  .banner.err{background:var(--bad-soft);color:var(--bad)}
  .banner.warn{background:var(--warn-soft);color:var(--warn)}
  .banner.info{background:var(--info-soft);color:var(--info)}

  /* toast */
  .toasts{position:fixed;bottom:18px;right:18px;display:flex;flex-direction:column;gap:8px;z-index:200}
  .toast{background:var(--ink);color:#fff;padding:10px 15px;border-radius:10px;font-size:13px;font-weight:600;box-shadow:var(--shadow);animation:tin .2s ease;max-width:300px}
  html[data-theme="dark"] .toast{background:var(--surface);border:1px solid var(--line);color:var(--ink)}
  .toast.ok{border-left:3px solid var(--ok)}
  .toast.bad{border-left:3px solid var(--bad)}
  @keyframes tin{from{opacity:0;transform:translateY(8px)}}

  /* settings */
  .kv{display:grid;grid-template-columns:auto 1fr;gap:8px 18px;font-size:13.5px;align-items:center}
  .kv dt{color:var(--ink-faint);font-weight:600}
  .kv dd{margin:0;font-weight:600}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;background:var(--surface-2);border:1px solid var(--line);border-radius:7px;padding:2px 7px}

  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:1080px){.charts{grid-template-columns:1fr}.grid2{grid-template-columns:1fr}}

  /* ===== mobile: sidebar -> bottom tabs ===== */
  .mtabs{display:none}
  @media(max-width:760px){
    .sidebar{display:none}
    .content{padding:16px 14px 90px}
    .topbar{padding:12px 16px}
    .mtabs{
      display:flex;position:fixed;bottom:0;left:0;right:0;z-index:60;background:var(--surface);
      border-top:1px solid var(--line);padding:6px 4px calc(6px + env(safe-area-inset-bottom));justify-content:space-around
    }
    .mtabs button{border:none;background:transparent;color:var(--ink-faint);display:flex;flex-direction:column;align-items:center;gap:2px;font-size:10px;font-weight:600;padding:5px 8px;border-radius:9px;flex:1}
    .mtabs button .mi{font-size:19px}
    .mtabs button.active{color:var(--brand-ink)}
    .mtabs button.active .mi{transform:translateY(-1px)}
    .kpis{grid-template-columns:1fr 1fr}
    .kpi .k-val{font-size:21px}
  }
  @media(max-width:400px){.kpis{grid-template-columns:1fr}}
</style>
</head>
<body>
<div id="root" class="app"></div>
<div class="toasts" id="toasts"></div>

<script>
"use strict";
(function(){
  /* ============================================================
     Config (placeholders substituted by Gatekeeper at serve time)
     ============================================================ */
  var DATA_URL = "__CLICKDZ_DATA_URL__";
  var DATA_TOKEN = "__CLICKDZ_DATA_TOKEN__";
  var SLUG = "__CLICKDZ_SLUG__";
  /* Bridge API origin, derived from DATA_URL (which is
     <externalBase>/api/v2/apps-data/<slug>) by stripping that suffix. Used ONLY
     by the optional staff-token login (WSE-13) to reach the @Public verify
     route; when staff auth is off nothing here runs. No new serve-time token. */
  var API_BASE = String(DATA_URL || "").replace(/\/api\/v2\/apps-data\/[^\/]*\/?$/, "");
  var STAFF_KEY = "cdz.erp.staff." + SLUG;
  /* French role labels + descending privilege order (mirrors StaffRole in
     cdz-data-token.ts: owner|manager|staff). */
  var ROLE_LABELS = { owner:"Propriétaire", manager:"Gérant", staff:"Employé" };
  /* Staff-auth session state. Inert unless the shared settings singleton has
     staffAuth==='1' (see staffGateActive): every field below is ignored and the
     app renders EXACTLY like today (legacy no-gate path). */
  var auth = {
    token: null,      // the stored staff token (localStorage), if any
    ok: false,        // a verify call succeeded this session
    verifying: false, // a verify call is in flight
    checked: false,   // an auto-verify has completed (success or failure)
    role: null,       // 'owner' | 'manager' | 'staff'
    staffId: null,    // the verified staff record id (display only)
    perms: [],        // permission strings from the verify response
    error: null       // last login error message (FR), if any
  };

  var STATUSES = ["Nouvelle","Confirmée","Expédiée","Livrée","Retournée"];
  var STATUS_NEXT = { "Nouvelle":"Confirmée", "Confirmée":"Expédiée", "Expédiée":"Livrée" };
  var EXP_CATS = ["Publicité","Achat stock","Livraison","Salaire","Loyer","Autre"];

  /* ============================================================
     Tiny helpers
     ============================================================ */
  function $(sel, root){ return (root||document).querySelector(sel); }
  function el(tag, attrs, kids){
    var n = document.createElement(tag);
    if(attrs) for(var k in attrs){
      if(k==="class") n.className = attrs[k];
      else if(k==="html") n.innerHTML = attrs[k];
      else if(k.slice(0,2)==="on" && typeof attrs[k]==="function") n.addEventListener(k.slice(2), attrs[k]);
      else if(attrs[k]!=null && attrs[k]!==false) n.setAttribute(k, attrs[k]);
    }
    if(kids!=null){
      if(!Array.isArray(kids)) kids=[kids];
      kids.forEach(function(c){ if(c==null||c===false) return; n.appendChild(typeof c==="object"?c:document.createTextNode(String(c))); });
    }
    return n;
  }
  function num(v){ var n = Number(v); return isFinite(n)?n:0; }
  function fmtDZD(v){
    var n = Math.round(num(v));
    return n.toLocaleString("fr-DZ").replace(/ /g," ") + " DZD";
  }
  function fmtInt(v){ return Math.round(num(v)).toLocaleString("fr-DZ").replace(/ /g," "); }
  function todayISO(){ return new Date().toISOString().slice(0,10); }
  function monthKey(iso){ return String(iso||"").slice(0,7); }
  function dayKey(iso){ return String(iso||"").slice(0,10); }
  function nowMonth(){ return todayISO().slice(0,7); }
  function parseDate(r){
    // prefer business date field, fall back to server createdAt
    return String(r.orderedAt || r.date || r.createdAt || "").slice(0,10) || todayISO();
  }
  function frDate(iso){
    var s = String(iso||"").slice(0,10); if(!s) return "—";
    var p = s.split("-"); if(p.length!==3) return s;
    return p[2]+"/"+p[1]+"/"+p[0];
  }
  function digits(s){ return String(s||"").replace(/[^0-9]/g,""); }
  function waLink(phone){
    var d = digits(phone);
    if(!d) return null;
    if(d.charAt(0)==="0") d = "213" + d.slice(1);
    return "https://wa.me/" + d;
  }
  function uid(p){ return (p||"k") + "_" + Math.random().toString(36).slice(2,8) + Date.now().toString(36).slice(-3); }

  function toast(msg, kind){
    var box = $("#toasts");
    var t = el("div", {class:"toast "+(kind||"")}, msg);
    box.appendChild(t);
    setTimeout(function(){ t.style.opacity="0"; t.style.transition="opacity .3s"; setTimeout(function(){ if(t.parentNode) t.parentNode.removeChild(t); }, 320); }, 2600);
  }

  /* ============================================================
     Data layer (ClickDz Data API)
     ============================================================ */
  function apiHeaders(){
    var h = { "Content-Type":"application/json" };
    if(DATA_TOKEN) h["Authorization"] = "Bearer " + DATA_TOKEN;
    return h;
  }
  function listColl(coll){
    return fetch(DATA_URL + "/" + coll + "?limit=500", { headers:{ "Content-Type":"application/json" } })
      .then(function(r){ if(!r.ok) throw new Error("HTTP "+r.status); return r.json(); })
      .then(function(arr){ return Array.isArray(arr)?arr:[]; });
  }
  function createRec(coll, body){
    return fetch(DATA_URL + "/" + coll, { method:"POST", headers:apiHeaders(), body:JSON.stringify(body) })
      .then(function(r){ if(!r.ok) return r.text().then(function(t){ throw new Error(t||("HTTP "+r.status)); }); return r.json(); });
  }
  function deleteRec(coll, id){
    return fetch(DATA_URL + "/" + coll + "/" + encodeURIComponent(id), { method:"DELETE", headers:apiHeaders() })
      .then(function(r){ if(!r.ok) throw new Error("HTTP "+r.status); return r.json(); });
  }
  // The Data API has no update: replace = delete old id then create merged body.
  function replaceRec(coll, oldId, body){
    var chain = oldId ? deleteRec(coll, oldId) : Promise.resolve();
    return chain.then(function(){ return createRec(coll, body); });
  }

  /* ============================================================
     Staff auth (WSE-13) — OPT-IN via shared settings staffAuth==='1'.
     When absent/0 (the default), staffGateActive() is false and EVERY function
     below short-circuits so the app is byte-identical to the legacy no-gate ERP.
     When '1', the single dashboard is placed behind a staff-token login: the
     owner mints a per-employee token in the studio (Équipe), the employee pastes
     it here, we POST /api/v1/apps-staff/verify {slug,token} to learn role +
     permissions, persist the token in localStorage, and role-gate the tabs. A
     404/network failure (flag flipped off, older server) falls back to the
     legacy screen silently — the dashboard renders as today.
     ============================================================ */
  function staffGateActive(){
    var s = store.settings || {};
    return String(s.staffAuth) === "1";
  }
  function loadStoredToken(){
    if(auth.token != null) return auth.token;
    var t = null;
    try{ t = localStorage.getItem(STAFF_KEY); }catch(e){}
    auth.token = t || "";
    return auth.token;
  }
  function storeToken(t){
    auth.token = t || "";
    try{ if(t) localStorage.setItem(STAFF_KEY, t); else localStorage.removeItem(STAFF_KEY); }catch(e){}
  }
  function roleLabel(role){ return ROLE_LABELS[role] || role || "—"; }
  /* Client-side tab gate (defence-in-depth is on the bridge; this only hides
     chrome). Gate INACTIVE or unknown role ⇒ allow everything (byte-identical).
       staff   → commandes only
       manager → all except reglages
       owner   → all */
  function roleAllowsTab(id){
    if(!staffGateActive() || !auth.ok) return true;
    if(auth.role === "owner") return true;
    if(auth.role === "manager") return id !== "reglages";
    if(auth.role === "staff") return id === "commandes";
    return true;
  }
  /* Apply the token → role verification against the bridge. Resolves to a plain
     result object; NEVER rejects (network/404 handled as a graceful fallback so
     the caller can drop to the legacy dashboard). */
  function verifyToken(tok){
    if(!tok || !API_BASE){ return Promise.resolve({ ok:false, fallback:!API_BASE }); }
    return fetch(API_BASE + "/api/v1/apps-staff/verify", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ slug:SLUG, token:tok })
    }).then(function(r){
      // 404 = staff auth disabled on this server (flag off / older build) →
      // signal a silent fallback to the legacy dashboard, never an error toast.
      if(r.status === 404){ return { ok:false, fallback:true }; }
      if(!r.ok){ return { ok:false }; }
      return r.json().then(function(j){ return j || { ok:false }; });
    }).catch(function(){ return { ok:false, fallback:true }; });
  }
  /* Auto-verify a stored token on boot (called once settings confirm the gate is
     on). On success populates auth + renders the dashboard; on a soft failure
     (fallback:true) marks the gate as passed so the legacy dashboard shows. */
  function autoVerify(){
    if(auth.checked || auth.verifying) return;
    var tok = loadStoredToken();
    if(!tok){ auth.checked = true; render(); return; }
    auth.verifying = true; render();
    verifyToken(tok).then(function(res){
      auth.verifying = false; auth.checked = true;
      if(res && res.ok){
        auth.ok = true; auth.role = res.role || null; auth.staffId = res.staffId || null;
        auth.perms = Array.isArray(res.permissions) ? res.permissions : [];
        auth.error = null;
      } else if(res && res.fallback){
        // Server says staff auth is off — behave like the legacy app.
        auth.ok = true; auth.role = null; auth.staffId = null; auth.perms = []; auth.error = null;
      } else {
        // A real bad/expired/revoked token — clear it and show the login.
        auth.ok = false; auth.role = null; auth.staffId = null; auth.perms = [];
        storeToken("");
      }
      render();
    });
  }
  /* Manual login from the token field on the staff screen. */
  function submitStaffToken(tok){
    tok = String(tok || "").trim();
    if(!tok){ auth.error = "Collez votre jeton d'accès."; render(); return; }
    auth.verifying = true; auth.error = null; render();
    verifyToken(tok).then(function(res){
      auth.verifying = false; auth.checked = true;
      if(res && res.ok){
        storeToken(tok);
        auth.ok = true; auth.role = res.role || null; auth.staffId = res.staffId || null;
        auth.perms = Array.isArray(res.permissions) ? res.permissions : [];
        auth.error = null;
        toast("Bienvenue — " + roleLabel(auth.role), "ok");
      } else if(res && res.fallback){
        // Staff auth turned off server-side → let them straight through.
        auth.ok = true; auth.role = null; auth.staffId = null; auth.perms = []; auth.error = null;
      } else {
        auth.ok = false;
        auth.error = "Jeton invalide, expiré ou révoqué. Demandez-en un nouveau au propriétaire.";
      }
      render();
    });
  }
  function logoutStaff(){
    storeToken("");
    auth.ok = false; auth.role = null; auth.staffId = null; auth.perms = []; auth.error = null; auth.checked = true;
    toast("Déconnecté", "ok");
    render();
  }

  /* ============================================================
     Global store
     ============================================================ */
  var store = {
    products:[], orders:[], customers:[], expenses:[], settings:null,
    loaded:false, loading:false, error:null
  };

  function loadAll(){
    store.loading = true; store.error = null; render();
    return Promise.all([
      listColl("orders"), listColl("products"), listColl("customers"),
      listColl("expenses"), listColl("settings")
    ]).then(function(res){
      store.orders    = res[0];
      store.products  = res[1];
      store.customers = res[2];
      store.expenses  = res[3];
      store.settings  = (res[4] && res[4][0]) || null;
      store.loaded = true; store.loading = false; store.error = null;
      // WSE-13: once settings confirm the staff gate is on, verify any stored
      // token (one-shot). No-op when staffAuth is absent/0 → legacy behaviour.
      if(staffGateActive()) autoVerify();
    }).catch(function(e){
      store.loading = false;
      store.error = (e && e.message) || "Erreur réseau";
    }).then(render);
  }

  /* ============================================================
     Derived metrics
     ============================================================ */
  function orderTotal(o){
    if(o.total!=null && isFinite(Number(o.total))) return num(o.total);
    var items = Array.isArray(o.items)?o.items:[];
    return items.reduce(function(s,it){ return s + num(it.price)*num(it.qty!=null?it.qty:1); }, 0);
  }
  function metrics(){
    var m = nowMonth();
    var caMonth=0, deliveredMonthCount=0, pending=0, expMonth=0, deliveredAllTotal=0, deliveredAllCount=0;
    store.orders.forEach(function(o){
      var t = orderTotal(o), inMonth = monthKey(parseDate(o))===m;
      if(o.status==="Livrée"){ deliveredAllTotal+=t; deliveredAllCount++; if(inMonth) caMonth+=t; if(inMonth) deliveredMonthCount++; }
      if(o.status==="Nouvelle" || o.status==="Confirmée") pending++;
    });
    store.expenses.forEach(function(x){ if(monthKey(parseDate(x))===m) expMonth += num(x.montant!=null?x.montant:x.amount); });
    var avg = deliveredAllCount ? deliveredAllTotal/deliveredAllCount : 0;
    var margin = caMonth - expMonth;
    return { caMonth:caMonth, pending:pending, avg:avg, expMonth:expMonth, margin:margin, deliveredMonthCount:deliveredMonthCount };
  }
  function reorderCount(){
    return store.products.filter(function(p){ return num(p.stock) <= num(p.reorderAt) && (p.reorderAt!=null); }).length;
  }

  /* Customers derived: unique phone from orders merged with customers coll (notes). */
  function deriveCustomers(){
    var map = {};
    store.orders.forEach(function(o){
      var ph = digits(o.phone);
      var key = ph || ("_"+ (o.customer||"anon"));
      if(!map[key]) map[key] = { phone:o.phone||"", name:o.customer||"", orders:0, spent:0, wilaya:o.wilaya||"", lastDate:"" };
      var c = map[key];
      c.orders++;
      if(o.status==="Livrée") c.spent += orderTotal(o);
      if(!c.name && o.customer) c.name = o.customer;
      if(!c.wilaya && o.wilaya) c.wilaya = o.wilaya;
      var d = parseDate(o); if(d>c.lastDate) c.lastDate = d;
    });
    // merge notes from customers collection (keyed by phone digits)
    var notesByPhone = {};
    store.customers.forEach(function(cust){
      var ph = digits(cust.phone);
      if(ph) notesByPhone[ph] = cust;
    });
    var out = Object.keys(map).map(function(k){
      var c = map[k]; var ph = digits(c.phone);
      var rec = ph ? notesByPhone[ph] : null;
      c.note = rec ? (rec.note||"") : "";
      c.custId = rec ? rec.id : null;
      if(rec && rec.name && !c.name) c.name = rec.name;
      return c;
    });
    // include customers-collection entries that have no order (pure contacts)
    store.customers.forEach(function(cust){
      var ph = digits(cust.phone);
      var exists = out.some(function(c){ return digits(c.phone)===ph && ph; });
      if(!exists){
        out.push({ phone:cust.phone||"", name:cust.name||"", orders:0, spent:0, wilaya:cust.wilaya||"", lastDate:"", note:cust.note||"", custId:cust.id });
      }
    });
    out.sort(function(a,b){ return b.spent-a.spent || b.orders-a.orders; });
    return out;
  }

  /* ============================================================
     SVG charts (hand-drawn, no libs, empty-safe)
     ============================================================ */
  function svgEl(name, attrs){
    var n = document.createElementNS("http://www.w3.org/2000/svg", name);
    if(attrs) for(var k in attrs){ if(attrs[k]!=null) n.setAttribute(k, attrs[k]); }
    return n;
  }
  function emptyChart(msg){
    return el("div", {class:"empty-chart"}, [ el("div",{html:"📭"}), el("div",{}, msg||"Aucune donnée pour l'instant") ]);
  }

  // Revenue by day (last 14 days) — area + line
  function chartRevenue(){
    var days = 14, W=520, H=190, padL=40, padR=12, padT=14, padB=26;
    var today = new Date();
    var keys=[], labels=[], vals=[];
    for(var i=days-1;i>=0;i--){
      var d = new Date(today.getFullYear(), today.getMonth(), today.getDate()-i);
      var k = d.toISOString().slice(0,10);
      keys.push(k); labels.push(d.getDate());
      vals.push(0);
    }
    var idx = {}; keys.forEach(function(k,j){ idx[k]=j; });
    var any=false;
    store.orders.forEach(function(o){
      if(o.status!=="Livrée") return;
      var k = parseDate(o);
      if(idx[k]!=null){ vals[idx[k]] += orderTotal(o); any=true; }
    });
    if(!any) return emptyChart("Aucune vente livrée sur 14 jours");
    var max = Math.max.apply(null, vals.concat([1]));
    var iw = W-padL-padR, ih = H-padT-padB;
    function X(j){ return padL + (days<=1?iw/2:(j/(days-1))*iw); }
    function Y(v){ return padT + ih - (v/max)*ih; }
    var svg = svgEl("svg", {viewBox:"0 0 "+W+" "+H, preserveAspectRatio:"none", role:"img", "aria-label":"Revenu par jour"});
    // grid + y labels (3 lines)
    for(var g=0; g<=2; g++){
      var gv = max*g/2, gy = Y(gv);
      svg.appendChild(svgEl("line",{x1:padL,y1:gy,x2:W-padR,y2:gy,stroke:"var(--line)","stroke-width":1}));
      var tx = svgEl("text",{x:padL-6,y:gy+3,"text-anchor":"end","font-size":9,fill:"var(--ink-faint)"}); tx.textContent = gv>=1000?Math.round(gv/1000)+"k":Math.round(gv); svg.appendChild(tx);
    }
    // area path
    var dLine="", dArea="";
    vals.forEach(function(v,j){ var x=X(j),y=Y(v); dLine += (j?" L":"M")+x.toFixed(1)+" "+y.toFixed(1); });
    dArea = dLine + " L"+X(days-1).toFixed(1)+" "+(padT+ih)+" L"+X(0).toFixed(1)+" "+(padT+ih)+" Z";
    svg.appendChild(svgEl("path",{d:dArea, fill:"var(--brand-soft)", stroke:"none"}));
    svg.appendChild(svgEl("path",{d:dLine, fill:"none", stroke:"var(--brand)","stroke-width":2,"stroke-linejoin":"round","stroke-linecap":"round"}));
    // points + x labels every ~3
    vals.forEach(function(v,j){
      if(v>0) svg.appendChild(svgEl("circle",{cx:X(j),cy:Y(v),r:2.6,fill:"var(--brand)"}));
      if(j%3===0 || j===days-1){
        var tx2 = svgEl("text",{x:X(j),y:H-8,"text-anchor":"middle","font-size":9,fill:"var(--ink-faint)"}); tx2.textContent=labels[j]; svg.appendChild(tx2);
      }
    });
    var wrap = el("div",{class:"chart-wrap"}); wrap.appendChild(svg); return wrap;
  }

  // Orders by status — bar chart
  function chartStatus(){
    var counts = {}; STATUSES.forEach(function(s){ counts[s]=0; });
    var any=false;
    store.orders.forEach(function(o){ if(counts[o.status]!=null){ counts[o.status]++; any=true; } });
    if(!any) return emptyChart("Aucune commande");
    var W=360, H=190, padL=12, padR=12, padT=14, padB=30;
    var iw=W-padL-padR, ih=H-padT-padB;
    var max = Math.max.apply(null, STATUSES.map(function(s){return counts[s];}).concat([1]));
    var n = STATUSES.length, gap=14, bw=(iw-gap*(n-1))/n;
    var colors = {"Nouvelle":"var(--info)","Confirmée":"var(--brand)","Expédiée":"var(--violet)","Livrée":"var(--ok)","Retournée":"var(--bad)"};
    var svg = svgEl("svg",{viewBox:"0 0 "+W+" "+H, role:"img", "aria-label":"Commandes par statut"});
    STATUSES.forEach(function(s,j){
      var v=counts[s], x=padL+j*(bw+gap), h=(v/max)*ih, y=padT+ih-h;
      svg.appendChild(svgEl("rect",{x:x,y:padT,width:bw,height:ih,rx:5,fill:"var(--surface-2)"}));
      if(v>0) svg.appendChild(svgEl("rect",{x:x,y:y,width:bw,height:Math.max(h,3),rx:5,fill:colors[s]}));
      var vt=svgEl("text",{x:x+bw/2,y:y-4,"text-anchor":"middle","font-size":11,"font-weight":700,fill:"var(--ink)"}); vt.textContent=v; if(v>0) svg.appendChild(vt);
      var lt=svgEl("text",{x:x+bw/2,y:H-16,"text-anchor":"middle","font-size":8.5,fill:"var(--ink-faint)"}); lt.textContent = s.length>7?s.slice(0,6)+"…":s; svg.appendChild(lt);
      var sw=svgEl("rect",{x:x+bw/2-3,y:H-9,width:6,height:6,rx:1.5,fill:colors[s]}); svg.appendChild(sw);
    });
    var wrap = el("div",{class:"chart-wrap"}); wrap.appendChild(svg); return wrap;
  }

  /* ============================================================
     UI state (router + filters + expanded rows)
     ============================================================ */
  var ui = {
    tab: (location.hash||"#apercu").replace("#",""),
    orderFilter: "Toutes",
    orderSearch: "",
    prodSearch: "",
    clientSearch: "",
    expanded: {},
    busy: {}   // per-record busy flags
  };
  /* Module registry mirror (canonical ids = clickdz-features.ts ERP_FEATURES).
     core:true    -> apercu + reglages, never hidden by moduleOn.
     future:true  -> R2/R3 forward-ready slots: shown only when moduleOn(id) AND
                     the backend for that module is flagged present in settings
                     (settings.erpBackends CSV). Both absent by default = dormant. */
  var TABS = [
    { id:"apercu",     label:"Aperçu",       ico:"📈", core:true },
    { id:"commandes",  label:"Commandes",    ico:"🧾" },
    { id:"stock",      label:"Stock",        ico:"📦" },
    { id:"clients",    label:"Clients",      ico:"👥" },
    { id:"depenses",   label:"Dépenses",     ico:"💸" },
    { id:"factures",   label:"Factures",     ico:"🧮", future:true },
    { id:"fournisseurs",label:"Fournisseurs",ico:"🚚", future:true },
    { id:"livraison",  label:"Livraison",    ico:"📮", future:true },
    { id:"caisse",     label:"Caisse",       ico:"💵", future:true },
    { id:"reglages",   label:"Réglages",     ico:"⚙️", core:true }
  ];
  var FUTURE_IDS = ["factures","fournisseurs","livraison","caisse"];
  /* ---- Module flags (WSF-6) -------------------------------------------------
     moduleOn(id): mirrors the shop template's featureOn/sectionOn approach over
     the shared settings singleton. settings.features is a CSV of enabled module
     ids (same key + mechanism as the registry's ERP module entries). ABSENT/null
     features = "all current modules visible" (byte-identical to today). Core
     modules (apercu, reglages) are ALWAYS on. A present-but-empty CSV keeps only
     the core modules. Forward-ready slots additionally require their backend to
     be flagged present (moduleBackendOn) so a bare flag never surfaces an empty
     screen. */
  function csvHas(raw, id){
    var list = Array.isArray(raw) ? raw : String(raw==null?"":raw).split(",");
    for(var i=0;i<list.length;i++){ if(String(list[i]).trim()===id) return true; }
    return false;
  }
  function isCoreModule(id){ return id==="apercu" || id==="reglages"; }
  function moduleBackendOn(id){
    var s = store.settings || {};
    return csvHas(s.erpBackends, id);
  }
  function moduleOn(id){
    if(isCoreModule(id)) return true;
    var s = store.settings || {};
    var raw = s.features;
    // Absent settings singleton OR unset features CSV = every current module on
    // (the byte-identical default: an untouched ERP shows all modules like today).
    var enabled = (raw===undefined || raw===null) ? true : csvHas(raw, id);
    if(!enabled) return false;
    // Forward-ready slots stay hidden until their backend is provisioned.
    if(FUTURE_IDS.indexOf(id)>=0) return moduleBackendOn(id);
    return true;
  }
  /* The nav/tabs actually rendered right now (order preserved). moduleOn gating
     is joined with the staff role gate (roleAllowsTab): a tab shows only when
     BOTH pass. When staff auth is off, roleAllowsTab is always true, so this is
     byte-identical to the module-only filter. */
  function activeTabs(){ return TABS.filter(function(t){ return moduleOn(t.id) && roleAllowsTab(t.id); }); }
  function go(tab){ ui.tab=tab; if(location.hash!=="#"+tab) location.hash=tab; render(); }
  window.addEventListener("hashchange", function(){
    var t=(location.hash||"#apercu").replace("#","");
    if(t!==ui.tab){ ui.tab=t; render(); }
  });

  /* ============================================================
     Theme
     ============================================================ */
  var THEME_KEY = "clickdz.erp.theme";
  function initTheme(){
    var t = null;
    try{ t = localStorage.getItem(THEME_KEY); }catch(e){}
    if(!t) t = (window.matchMedia && window.matchMedia("(prefers-color-scheme:dark)").matches) ? "dark":"light";
    document.documentElement.setAttribute("data-theme", t);
  }
  function toggleTheme(){
    var cur = document.documentElement.getAttribute("data-theme")==="dark"?"dark":"light";
    var nxt = cur==="dark"?"light":"dark";
    document.documentElement.setAttribute("data-theme", nxt);
    try{ localStorage.setItem(THEME_KEY, nxt); }catch(e){}
    render();
  }
  function isDark(){ return document.documentElement.getAttribute("data-theme")==="dark"; }

  /* ============================================================
     Mutations
     ============================================================ */
  function withBusy(key, fn){
    ui.busy[key]=true; render();
    return fn().catch(function(e){ toast((e&&e.message)?("Échec : "+e.message.slice(0,60)):"Échec de l'opération","bad"); })
      .then(function(){ delete ui.busy[key]; });
  }

  function advanceStatus(o, target){
    var body = {};
    // copy business fields, drop server-managed id/createdAt
    for(var k in o){ if(k!=="id" && k!=="createdAt") body[k]=o[k]; }
    body.status = target;
    if(!body.orderedAt) body.orderedAt = parseDate(o);
    return withBusy("ord:"+o.id, function(){
      return replaceRec("orders", o.id, body).then(function(){ toast("Commande → "+target,"ok"); return loadAll(); });
    });
  }

  function changeStock(p, delta){
    var next = Math.max(0, num(p.stock)+delta);
    if(next===num(p.stock)) return;
    var body={}; for(var k in p){ if(k!=="id" && k!=="createdAt") body[k]=p[k]; }
    body.stock = next;
    return withBusy("prod:"+p.id, function(){
      return replaceRec("products", p.id, body).then(function(){ return loadAll(); });
    });
  }

  function addProduct(data){
    var body = { sku:data.sku||uid("sku"), name:data.name, price:num(data.price), stock:num(data.stock), reorderAt:num(data.reorderAt) };
    return withBusy("addprod", function(){
      return createRec("products", body).then(function(){ toast("Produit ajouté","ok"); return loadAll(); });
    });
  }
  function deleteProduct(p){
    if(!window.confirm("Supprimer le produit « "+p.name+" » ?")) return;
    return withBusy("prod:"+p.id, function(){ return deleteRec("products", p.id).then(function(){ toast("Produit supprimé","ok"); return loadAll(); }); });
  }

  function addExpense(data){
    var body = { label:data.label, montant:num(data.montant), categorie:data.categorie, date:data.date||todayISO() };
    return withBusy("addexp", function(){ return createRec("expenses", body).then(function(){ toast("Dépense ajoutée","ok"); return loadAll(); }); });
  }
  function deleteExpense(x){
    return withBusy("exp:"+x.id, function(){ return deleteRec("expenses", x.id).then(function(){ toast("Dépense supprimée","ok"); return loadAll(); }); });
  }

  function saveNote(c, note){
    var body = { phone:c.phone||"", name:c.name||"", note:note, wilaya:c.wilaya||"" };
    return withBusy("cust:"+(digits(c.phone)||c.name), function(){
      return replaceRec("customers", c.custId, body).then(function(){ toast("Note enregistrée","ok"); return loadAll(); });
    });
  }

  /* ============================================================
     Views
     ============================================================ */
  function kpiCard(icoBg, icoColor, ico, label, val, sub){
    return el("div",{class:"card kpi"},[
      el("div",{class:"k-top"},[ el("span",{class:"k-ico",style:"background:"+icoBg+";color:"+icoColor}, ico), el("span",{}, label) ]),
      el("div",{class:"k-val",html:val}),
      sub?el("div",{class:"k-sub"}, sub):null
    ]);
  }

  function viewApercu(){
    var m = metrics();
    var wrap = el("div",{});
    wrap.appendChild(el("div",{class:"kpis"},[
      kpiCard("var(--ok-soft)","var(--ok)","💰","CA du mois", fmtDZD(m.caMonth), m.deliveredMonthCount+" commande(s) livrée(s)"),
      kpiCard("var(--info-soft)","var(--info)","⏳","En attente", fmtInt(m.pending)+" <small>cmd</small>", "Nouvelles + confirmées"),
      kpiCard("var(--brand-soft)","var(--brand-ink)","🧺","Panier moyen", fmtDZD(m.avg), "Sur commandes livrées"),
      kpiCard("var(--warn-soft)","var(--warn)","💸","Dépenses du mois", fmtDZD(m.expMonth), nowMonth()),
      kpiCard(m.margin>=0?"var(--ok-soft)":"var(--bad-soft)", m.margin>=0?"var(--ok)":"var(--bad)","📊","Marge estimée", fmtDZD(m.margin), "CA livré − dépenses")
    ]));
    var ro = reorderCount();
    if(ro>0) wrap.appendChild(el("div",{class:"banner warn",style:"margin-bottom:16px"},[ el("span",{html:"⚠️"}), el("span",{},[document.createTextNode(ro+" produit(s) sous le seuil de réappro. "), el("a",{href:"#stock",onclick:function(){go("stock");}},"Voir le stock →")]) ]));
    wrap.appendChild(el("div",{class:"charts"},[
      el("div",{class:"card panel"},[ el("h3",{},"Revenu (14 derniers jours)"), el("div",{class:"p-sub"},"Total livré par jour, en DZD"), chartRevenue() ]),
      el("div",{class:"card panel"},[ el("h3",{},"Commandes par statut"), el("div",{class:"p-sub"},"Répartition actuelle"), chartStatus() ])
    ]));
    return wrap;
  }

  function itemsBox(o){
    var items = Array.isArray(o.items)?o.items:[];
    var box = el("div",{class:"items-box"});
    if(!items.length){ box.appendChild(el("div",{class:"muted",style:"font-size:12.5px"},"Aucun article détaillé.")); }
    items.forEach(function(it){
      box.appendChild(el("div",{class:"it"},[
        el("span",{},[ el("span",{class:"q"}, num(it.qty!=null?it.qty:1)+"× "), (it.name||it.product||"Article") ]),
        el("span",{class:"num"}, fmtDZD(num(it.price)*num(it.qty!=null?it.qty:1)))
      ]));
    });
    // status advance controls
    var adv = el("div",{class:"adv-row"});
    var busy = ui.busy["ord:"+o.id];
    var nxt = STATUS_NEXT[o.status];
    if(nxt) adv.appendChild(el("button",{class:"btn sm primary",disabled:busy,onclick:function(){advanceStatus(o,nxt);}}, busy?"…":("→ "+nxt)));
    if(o.status!=="Retournée" && o.status!=="Livrée") adv.appendChild(el("button",{class:"btn sm",disabled:busy,onclick:function(){advanceStatus(o,"Retournée");}},"↩︎ Marquer retournée"));
    if(o.status==="Livrée") adv.appendChild(el("button",{class:"btn sm",disabled:busy,onclick:function(){advanceStatus(o,"Retournée");}},"↩︎ Retour"));
    var w = waLink(o.phone);
    if(w) adv.appendChild(el("a",{class:"btn sm",href:w,target:"_blank",rel:"noopener"},"💬 WhatsApp"));
    box.appendChild(adv);
    var d = el("div",{style:"padding:10px 16px 14px"});
    d.appendChild(box);
    return d;
  }

  function viewCommandes(){
    var wrap = el("div",{});
    var head = el("div",{class:"sec-head"});
    var chips = el("div",{class:"row"});
    var filters = ["Toutes"].concat(STATUSES);
    filters.forEach(function(f){
      var c=0; if(f==="Toutes") c=store.orders.length; else c=store.orders.filter(function(o){return o.status===f;}).length;
      chips.appendChild(el("button",{class:"chip"+(ui.orderFilter===f?" on":""),onclick:function(){ui.orderFilter=f;render();}}, f+" ("+c+")"));
    });
    head.appendChild(chips);
    head.appendChild(el("div",{class:"grow"}));
    var search = el("div",{class:"search"});
    search.appendChild(el("span",{class:"si"},"🔎"));
    search.appendChild(el("input",{class:"input",placeholder:"Client ou téléphone…",value:ui.orderSearch,oninput:function(e){ui.orderSearch=e.target.value;renderList();}}));
    head.appendChild(search);
    wrap.appendChild(head);

    var listMount = el("div",{});
    wrap.appendChild(listMount);

    function renderList(){
      listMount.innerHTML="";
      var q = ui.orderSearch.trim().toLowerCase();
      var rows = store.orders.filter(function(o){
        if(ui.orderFilter!=="Toutes" && o.status!==ui.orderFilter) return false;
        if(q){ var hay=((o.customer||"")+" "+(o.phone||"")+" "+(o.wilaya||"")).toLowerCase(); if(hay.indexOf(q)<0) return false; }
        return true;
      });
      rows.sort(function(a,b){ return String(parseDate(b)).localeCompare(String(parseDate(a))); });
      if(!store.orders.length){ listMount.appendChild(stateBox("🧾","Aucune commande","Les commandes passées depuis votre Ready Shop apparaîtront ici.")); return; }
      if(!rows.length){ listMount.appendChild(stateBox("🔍","Aucun résultat","Ajustez le filtre ou la recherche.")); return; }
      var twrap = el("div",{class:"tbl-wrap"});
      var t = el("table",{});
      t.appendChild(el("thead",{},el("tr",{},[
        el("th",{},"Client"), el("th",{},"Téléphone"), el("th",{},"Wilaya"), el("th",{},"Date"),
        el("th",{class:"num"},"Total"), el("th",{},"Statut"), el("th",{},"")
      ])));
      var tb = el("tbody",{});
      rows.forEach(function(o){
        var open = !!ui.expanded[o.id];
        var tr = el("tr",{style:"cursor:pointer",onclick:function(ev){ if(ev.target.closest("a,button")) return; ui.expanded[o.id]=!open; renderList(); }});
        tr.appendChild(el("td",{},el("strong",{}, o.customer||"—")));
        var w=waLink(o.phone);
        tr.appendChild(el("td",{}, w?el("a",{href:w,target:"_blank",rel:"noopener",onclick:function(e){e.stopPropagation();}}, o.phone):el("span",{class:"muted"}, o.phone||"—")));
        tr.appendChild(el("td",{class:"muted"}, o.wilaya||"—"));
        tr.appendChild(el("td",{class:"muted"}, frDate(parseDate(o))));
        tr.appendChild(el("td",{class:"num"}, fmtDZD(orderTotal(o))));
        tr.appendChild(el("td",{}, el("span",{class:"pill s-"+o.status},[el("span",{class:"dot"}),o.status])));
        tr.appendChild(el("td",{}, el("span",{class:"muted",style:"font-size:15px"}, open?"▾":"▸")));
        tb.appendChild(tr);
        if(open){
          var er = el("tr",{class:"exp-row"});
          var td = el("td",{colspan:7});
          td.appendChild(itemsBox(o));
          er.appendChild(td); tb.appendChild(er);
        }
      });
      t.appendChild(tb); twrap.appendChild(t); listMount.appendChild(twrap);
      listMount.appendChild(el("div",{class:"count-tag",style:"margin-top:10px"}, rows.length+" commande(s) affichée(s)"));
    }
    renderList();
    wrap._renderList = renderList;
    return wrap;
  }

  function viewStock(){
    var wrap = el("div",{});
    // quick add form
    var f = { sku:"", name:"", price:"", stock:"", reorderAt:"" };
    var addbar = el("div",{class:"card addbar"});
    addbar.appendChild(el("h3",{},"➕ Ajouter un produit"));
    var grid = el("div",{class:"form-grid"});
    function fld(label, key, ph, type){
      var input = el("input",{class:"input",placeholder:ph||"",type:type||"text",value:f[key],oninput:function(e){f[key]=e.target.value;}});
      return el("div",{},[ el("label",{class:"fld"}, label), input ]);
    }
    grid.appendChild(fld("Nom","name","Ex : T-shirt col rond"));
    grid.appendChild(fld("Prix (DZD)","price","0","number"));
    grid.appendChild(fld("Stock","stock","0","number"));
    grid.appendChild(fld("Seuil réappro","reorderAt","5","number"));
    var addBtn = el("button",{class:"btn primary",disabled:!!ui.busy["addprod"],onclick:function(){
      if(!f.name.trim()){ toast("Le nom est requis","bad"); return; }
      addProduct(f);
    }}, ui.busy["addprod"]?"Ajout…":"Ajouter");
    grid.appendChild(el("div",{},[ el("label",{class:"fld",style:"visibility:hidden"},"."), addBtn ]));
    addbar.appendChild(grid);
    wrap.appendChild(addbar);

    var head = el("div",{class:"sec-head"});
    var search = el("div",{class:"search"});
    search.appendChild(el("span",{class:"si"},"🔎"));
    search.appendChild(el("input",{class:"input",placeholder:"Nom ou SKU…",value:ui.prodSearch,oninput:function(e){ui.prodSearch=e.target.value;render();}}));
    head.appendChild(search);
    head.appendChild(el("div",{class:"grow"}));
    var ro = reorderCount();
    head.appendChild(el("span",{class:"count-tag"}, store.products.length+" produit(s)" + (ro?(" · "+ro+" à réapprovisionner"):"")));
    wrap.appendChild(head);

    if(!store.products.length){ wrap.appendChild(stateBox("📦","Aucun produit","Ajoutez votre premier produit avec le formulaire ci-dessus.")); return wrap; }
    var q=ui.prodSearch.trim().toLowerCase();
    var rows = store.products.filter(function(p){ return !q || ((p.name||"")+" "+(p.sku||"")).toLowerCase().indexOf(q)>=0; });
    rows.sort(function(a,b){ return (a.name||"").localeCompare(b.name||""); });
    if(!rows.length){ wrap.appendChild(stateBox("🔍","Aucun résultat","Aucun produit ne correspond.")); return wrap; }

    var twrap = el("div",{class:"tbl-wrap"});
    var t = el("table",{});
    t.appendChild(el("thead",{},el("tr",{},[
      el("th",{},"Produit"), el("th",{},"SKU"), el("th",{class:"num"},"Prix"),
      el("th",{},"Stock"), el("th",{class:"num"},"Seuil"), el("th",{},"")
    ])));
    var tb = el("tbody",{});
    rows.forEach(function(p){
      var low = p.reorderAt!=null && num(p.stock)<=num(p.reorderAt);
      var busy = ui.busy["prod:"+p.id];
      var tr = el("tr",{class:low?"alert":""});
      tr.appendChild(el("td",{},[ el("strong",{},p.name||"—"), low?el("span",{class:"pill s-Retournée",style:"margin-left:8px"},"réappro"):null ]));
      tr.appendChild(el("td",{class:"muted mono",style:"font-size:11.5px"}, (p.sku||"—")));
      tr.appendChild(el("td",{class:"num"}, fmtDZD(p.price)));
      var stepper = el("div",{class:"stepper"});
      stepper.appendChild(el("button",{disabled:busy,title:"−1",onclick:function(){changeStock(p,-1);}},"−"));
      stepper.appendChild(el("span",{class:"val"}, busy?"…":fmtInt(p.stock)));
      stepper.appendChild(el("button",{disabled:busy,title:"+1",onclick:function(){changeStock(p,1);}},"+"));
      tr.appendChild(el("td",{}, stepper));
      tr.appendChild(el("td",{class:"num muted"}, p.reorderAt!=null?fmtInt(p.reorderAt):"—"));
      tr.appendChild(el("td",{}, el("button",{class:"btn sm danger",disabled:busy,onclick:function(){deleteProduct(p);}},"Suppr")));
      tb.appendChild(tr);
    });
    t.appendChild(tb); twrap.appendChild(t); wrap.appendChild(twrap);
    return wrap;
  }

  function viewClients(){
    var wrap = el("div",{});
    var list = deriveCustomers();
    var head = el("div",{class:"sec-head"});
    var search = el("div",{class:"search"});
    search.appendChild(el("span",{class:"si"},"🔎"));
    search.appendChild(el("input",{class:"input",placeholder:"Nom ou téléphone…",value:ui.clientSearch,oninput:function(e){ui.clientSearch=e.target.value;render();}}));
    head.appendChild(search);
    head.appendChild(el("div",{class:"grow"}));
    head.appendChild(el("span",{class:"count-tag"}, list.length+" client(s)"));
    wrap.appendChild(head);

    if(!list.length){ wrap.appendChild(stateBox("👥","Aucun client","Les clients sont dérivés automatiquement de vos commandes.")); return wrap; }
    var q=ui.clientSearch.trim().toLowerCase();
    var rows = list.filter(function(c){ return !q || ((c.name||"")+" "+(c.phone||"")).toLowerCase().indexOf(q)>=0; });
    if(!rows.length){ wrap.appendChild(stateBox("🔍","Aucun résultat","Aucun client ne correspond.")); return wrap; }

    var twrap = el("div",{class:"tbl-wrap"});
    var t = el("table",{});
    t.appendChild(el("thead",{},el("tr",{},[
      el("th",{},"Client"), el("th",{},"Téléphone"), el("th",{},"Wilaya"),
      el("th",{class:"num"},"Cmd"), el("th",{class:"num"},"Total dépensé"), el("th",{},"Note")
    ])));
    var tb = el("tbody",{});
    rows.forEach(function(c){
      var busyKey="cust:"+(digits(c.phone)||c.name), busy=ui.busy[busyKey];
      var tr = el("tr",{});
      tr.appendChild(el("td",{},el("strong",{}, c.name||"(sans nom)")));
      var w=waLink(c.phone);
      tr.appendChild(el("td",{}, w?el("a",{href:w,target:"_blank",rel:"noopener"}, c.phone):el("span",{class:"muted"}, c.phone||"—")));
      tr.appendChild(el("td",{class:"muted"}, c.wilaya||"—"));
      tr.appendChild(el("td",{class:"num"}, fmtInt(c.orders)));
      tr.appendChild(el("td",{class:"num"}, fmtDZD(c.spent)));
      var noteInput = el("input",{class:"input",style:"min-width:150px",placeholder:"Ajouter une note…",value:c.note||""});
      var saveBtn = el("button",{class:"btn sm",disabled:busy,onclick:function(){ saveNote(c, noteInput.value.trim()); }}, busy?"…":"💾");
      var noteCell = el("td",{}, el("div",{style:"display:flex;gap:6px;align-items:center"},[ noteInput, saveBtn ]));
      tr.appendChild(noteCell);
      tb.appendChild(tr);
    });
    t.appendChild(tb); twrap.appendChild(t); wrap.appendChild(twrap);
    return wrap;
  }

  function viewDepenses(){
    var wrap = el("div",{});
    var f = { label:"", montant:"", categorie:EXP_CATS[0], date:todayISO() };
    var addbar = el("div",{class:"card addbar"});
    addbar.appendChild(el("h3",{},"➕ Nouvelle dépense"));
    var grid = el("div",{class:"form-grid"});
    var labelInput = el("input",{class:"input",placeholder:"Ex : Pub Facebook",value:f.label,oninput:function(e){f.label=e.target.value;}});
    grid.appendChild(el("div",{},[ el("label",{class:"fld"},"Libellé"), labelInput ]));
    var montantInput = el("input",{class:"input",type:"number",placeholder:"0",value:f.montant,oninput:function(e){f.montant=e.target.value;}});
    grid.appendChild(el("div",{},[ el("label",{class:"fld"},"Montant (DZD)"), montantInput ]));
    var catSel = el("select",{class:"select",onchange:function(e){f.categorie=e.target.value;}});
    EXP_CATS.forEach(function(cat){ catSel.appendChild(el("option",{value:cat}, cat)); });
    grid.appendChild(el("div",{},[ el("label",{class:"fld"},"Catégorie"), catSel ]));
    var dateInput = el("input",{class:"input",type:"date",value:f.date,oninput:function(e){f.date=e.target.value;}});
    grid.appendChild(el("div",{},[ el("label",{class:"fld"},"Date"), dateInput ]));
    var addBtn = el("button",{class:"btn primary",disabled:!!ui.busy["addexp"],onclick:function(){
      if(!f.label.trim()){ toast("Le libellé est requis","bad"); return; }
      if(!(num(f.montant)>0)){ toast("Montant invalide","bad"); return; }
      addExpense(f);
    }}, ui.busy["addexp"]?"Ajout…":"Ajouter");
    grid.appendChild(el("div",{},[ el("label",{class:"fld",style:"visibility:hidden"},"."), addBtn ]));
    addbar.appendChild(grid);
    wrap.appendChild(addbar);

    if(!store.expenses.length){ wrap.appendChild(stateBox("💸","Aucune dépense","Enregistrez vos dépenses pour suivre votre marge.")); return wrap; }

    // group by month
    var groups = {};
    store.expenses.forEach(function(x){ var mk=monthKey(parseDate(x)); (groups[mk]=groups[mk]||[]).push(x); });
    var keys = Object.keys(groups).sort().reverse();
    var grand = store.expenses.reduce(function(s,x){ return s+num(x.montant!=null?x.montant:x.amount); },0);
    wrap.appendChild(el("div",{class:"banner info",style:"margin-bottom:16px"},[ el("span",{html:"Σ"}), el("span",{},"Total dépenses (tout) : "), el("strong",{style:"margin-left:auto"}, fmtDZD(grand)) ]));

    keys.forEach(function(mk){
      var items = groups[mk].slice().sort(function(a,b){ return String(parseDate(b)).localeCompare(String(parseDate(a))); });
      var subtotal = items.reduce(function(s,x){ return s+num(x.montant!=null?x.montant:x.amount); },0);
      var monthLabel = mk ? new Date(mk+"-01T00:00:00").toLocaleDateString("fr-FR",{month:"long",year:"numeric"}) : "Sans date";
      wrap.appendChild(el("div",{class:"sec-head",style:"margin-top:8px;margin-bottom:8px"},[
        el("h3",{style:"margin:0;font-size:14px;text-transform:capitalize"}, monthLabel),
        el("div",{class:"grow"}),
        el("span",{class:"count-tag"}, fmtDZD(subtotal))
      ]));
      var twrap = el("div",{class:"tbl-wrap",style:"margin-bottom:16px"});
      var t = el("table",{});
      t.appendChild(el("thead",{},el("tr",{},[ el("th",{},"Date"), el("th",{},"Libellé"), el("th",{},"Catégorie"), el("th",{class:"num"},"Montant"), el("th",{},"") ])));
      var tb = el("tbody",{});
      items.forEach(function(x){
        var busy=ui.busy["exp:"+x.id];
        var tr = el("tr",{});
        tr.appendChild(el("td",{class:"muted"}, frDate(parseDate(x))));
        tr.appendChild(el("td",{},el("strong",{}, x.label||"—")));
        tr.appendChild(el("td",{}, el("span",{class:"chip",style:"font-size:11px;padding:2px 9px"}, x.categorie||"Autre")));
        tr.appendChild(el("td",{class:"num"}, fmtDZD(x.montant!=null?x.montant:x.amount)));
        tr.appendChild(el("td",{}, el("button",{class:"btn sm danger",disabled:busy,onclick:function(){deleteExpense(x);}}, busy?"…":"Suppr")));
        tb.appendChild(tr);
      });
      t.appendChild(tb); twrap.appendChild(t); wrap.appendChild(twrap);
    });
    return wrap;
  }

  function viewReglages(){
    var wrap = el("div",{});
    var s = store.settings || {};
    var shopName = s.shopName || s.name || SLUG;
    var card = el("div",{class:"card panel",style:"max-width:560px"});
    card.appendChild(el("h3",{},"🔗 Appairage boutique"));
    card.appendChild(el("div",{class:"p-sub"},"Ce tableau de bord partage ses données avec votre Ready Shop."));
    var kv = el("dl",{class:"kv"});
    function pair(k,v){ kv.appendChild(el("dt",{},k)); kv.appendChild(el("dd",{}, typeof v==="object"?v:document.createTextNode(String(v)))); }
    pair("Boutique", el("span",{}, shopName));
    pair("Identifiant (slug)", el("span",{class:"mono"}, SLUG));
    pair("Devise", "DZD");
    pair("WhatsApp", s.whatsapp?el("a",{href:waLink(s.whatsapp),target:"_blank",rel:"noopener"}, s.whatsapp):el("span",{class:"muted"},"non configuré"));
    card.appendChild(kv);
    wrap.appendChild(card);

    var hint = el("div",{class:"card panel",style:"max-width:560px;margin-top:14px"});
    hint.appendChild(el("h3",{},"🛍️ Gérer la vitrine"));
    hint.appendChild(el("div",{class:"p-sub",style:"margin-bottom:10px"},"Produits, réglages et coordonnées WhatsApp se modifient depuis l'admin de votre Ready Shop (même slug)."));
    hint.appendChild(el("div",{class:"banner info"},[ el("span",{html:"💡"}), el("span",{},[document.createTextNode("Ouvrez votre boutique et ajoutez "), el("span",{class:"mono"},"#admin"), document.createTextNode(" à l'URL pour accéder au panneau d'administration (même jeton de données).")]) ]));
    wrap.appendChild(hint);

    var data = el("div",{class:"card panel",style:"max-width:560px;margin-top:14px"});
    data.appendChild(el("h3",{},"📊 Données"));
    var counts = el("dl",{class:"kv"});
    function c2(k,v){ counts.appendChild(el("dt",{},k)); counts.appendChild(el("dd",{},String(v))); }
    c2("Commandes", store.orders.length);
    c2("Produits", store.products.length);
    c2("Clients", deriveCustomers().length);
    c2("Dépenses", store.expenses.length);
    data.appendChild(counts);
    data.appendChild(el("div",{style:"margin-top:14px"}, el("button",{class:"btn",onclick:function(){loadAll();}},"↻ Rafraîchir les données")));
    wrap.appendChild(data);

    wrap.appendChild(el("div",{class:"count-tag",style:"margin-top:18px;display:block"},"ClickDz mini-ERP · données via API partagée (cap 8 Ko/enregistrement, 500/collection)"));
    return wrap;
  }

  /* WSF-6 — forward-ready module placeholder. Rendered for factures /
     fournisseurs / livraison / caisse once their nav slot is unlocked (module on
     AND backend provisioned) but before their real R3 UI ships. Kept tiny.
     dir="auto" keeps the copy correct if the shared UI later runs in darja/RTL. */
  function viewFutureModule(id){
    var meta = TABS.filter(function(t){ return t.id===id; })[0] || { ico:"🧩", label:id };
    var wrap = el("div",{dir:"auto"});
    wrap.appendChild(el("div",{class:"card"}, el("div",{class:"state"},[
      el("div",{class:"em"}, meta.ico),
      el("div",{class:"st-t"}, meta.label),
      el("div",{class:"st-s"}, "Ce module est activé mais pas encore configuré. Configurez-le depuis le studio ClickDz pour l'utiliser ici.")
    ])));
    return wrap;
  }

  function stateBox(em, title, sub){
    return el("div",{class:"card"}, el("div",{class:"state"},[
      el("div",{class:"em"}, em),
      el("div",{class:"st-t"}, title),
      sub?el("div",{class:"st-s"}, sub):null
    ]));
  }

  /* ============================================================
     Render
     ============================================================ */
  /* A tab is valid only if it is a KNOWN module that is currently visible
     (moduleOn) AND allowed for the signed-in role (roleAllowsTab). An unknown
     hash, a dormant module id, or a tab the role can't see falls back to the
     first visible tab. When staff auth is off, roleAllowsTab is always true and
     the fallback is the Aperçu core — same effect as today for any non-tab hash. */
  function fallbackTab(){
    var vis = activeTabs();
    // Prefer apercu when it is visible (today's default), else the first tab.
    for(var i=0;i<vis.length;i++){ if(vis[i].id==="apercu") return "apercu"; }
    return vis.length ? vis[0].id : "apercu";
  }
  function currentTab(){
    var known = TABS.some(function(t){ return t.id===ui.tab; });
    return (known && moduleOn(ui.tab) && roleAllowsTab(ui.tab)) ? ui.tab : fallbackTab();
  }

  function sidebar(){
    var side = el("div",{class:"sidebar"});
    side.appendChild(el("div",{class:"brand"},[
      el("div",{class:"logo"},"Dz"),
      el("div",{},[ el("div",{class:"bt"},"ClickDz ERP"), el("div",{class:"bs"}, SLUG) ])
    ]));
    var pending = metrics().pending, ro = reorderCount();
    activeTabs().forEach(function(t){
      var link = el("button",{class:"navlink"+(currentTab()===t.id?" active":""),onclick:function(){go(t.id);}},[
        el("span",{class:"ico"}, t.ico), el("span",{}, t.label)
      ]);
      if(t.id==="commandes" && pending>0) link.appendChild(el("span",{class:"badge"}, pending));
      if(t.id==="stock" && ro>0) link.appendChild(el("span",{class:"badge"}, ro));
      side.appendChild(link);
    });
    side.appendChild(el("div",{class:"nav-spacer"}));
    side.appendChild(el("div",{class:"side-foot"},[
      el("button",{class:"theme-btn",onclick:toggleTheme},[ el("span",{},isDark()?"☀️":"🌙"), el("span",{}, isDark()?"Mode clair":"Mode sombre") ])
    ]));
    return side;
  }

  function mobileTabs(){
    var bar = el("div",{class:"mtabs"});
    activeTabs().forEach(function(t){
      var b = el("button",{class:(currentTab()===t.id?"active":""),onclick:function(){go(t.id);}},[
        el("span",{class:"mi"}, t.ico), el("span",{}, t.label)
      ]);
      bar.appendChild(b);
    });
    return bar;
  }

  /* WSE-13 — the staff-token login screen. Rendered ONLY when the shared
     settings enable the gate (staffAuth==='1') and no verified session exists.
     dir="auto" keeps the copy correct should the shared chrome ever run RTL. */
  function staffLogin(){
    var val = "";
    var root = $("#root");
    root.innerHTML="";
    var wrap = el("div",{style:"min-height:100vh;display:grid;place-items:center;padding:24px",dir:"auto"});
    var card = el("div",{class:"card panel",style:"max-width:400px;width:100%;text-align:center;padding:30px 26px"});
    card.appendChild(el("div",{style:"font-size:42px;margin-bottom:10px"},"🔐"));
    card.appendChild(el("h1",{style:"font-size:20px;font-weight:750;margin:0 0 4px"},"Espace équipe"));
    card.appendChild(el("div",{class:"p-sub",style:"margin-bottom:18px"},"Collez votre jeton d'accès pour ouvrir le tableau de bord."));
    if(auth.error) card.appendChild(el("div",{class:"banner err",style:"margin-bottom:14px;text-align:start"},[ el("span",{html:"⚠️"}), el("span",{}, auth.error) ]));
    var input = el("input",{class:"input",type:"password",placeholder:"Jeton d'accès",autocomplete:"off",style:"text-align:center;letter-spacing:.5px",value:"",oninput:function(e){ val=e.target.value; }});
    var go = function(){ submitStaffToken(input.value); };
    input.addEventListener("keydown", function(e){ if(e.key==="Enter") go(); });
    card.appendChild(el("div",{style:"margin-bottom:12px;text-align:start"}, input));
    var btn = el("button",{class:"btn primary",style:"width:100%",disabled:!!auth.verifying,onclick:go}, auth.verifying?"Vérification…":"Se connecter");
    card.appendChild(btn);
    card.appendChild(el("div",{class:"count-tag",style:"display:block;margin-top:16px"},"Le propriétaire crée les jetons depuis le studio ClickDz (onglet Équipe)."));
    wrap.appendChild(card);
    root.appendChild(wrap);
    // Auto-focus the field so a paste can happen immediately.
    try{ input.focus(); }catch(e){}
  }

  function render(){
    var root = $("#root");

    // WSE-13 gate: when staff auth is ON and this session is not verified yet,
    // show the login screen (or a verifying spinner) instead of the dashboard.
    // This whole block is inert when staffAuth is absent/0 → byte-identical.
    if(staffGateActive() && !auth.ok){
      if(auth.verifying && !auth.checked){
        root.innerHTML="";
        root.appendChild(el("div",{style:"min-height:100vh;display:grid;place-items:center",dir:"auto"},
          el("div",{class:"state"},[ el("div",{class:"spin"}), el("div",{class:"st-t"},"Vérification…"), el("div",{class:"st-s"},"Connexion à votre espace") ])));
        return;
      }
      staffLogin();
      return;
    }

    root.innerHTML="";

    root.appendChild(sidebar());

    var main = el("div",{class:"main"});
    var tab = currentTab();
    var tabMeta = TABS.filter(function(t){return t.id===tab;})[0];

    // topbar
    var topbar = el("div",{class:"topbar"});
    topbar.appendChild(el("div",{},[
      el("h1",{}, tabMeta.ico + " " + tabMeta.label),
      el("div",{class:"sub"}, subForTab(tab))
    ]));
    var right = el("div",{class:"right"});
    right.appendChild(el("button",{class:"btn icon ghost",title:"Rafraîchir",onclick:function(){loadAll();}}, store.loading?"…":"↻"));
    // WSE-13: signed-in staff identity + logout — only when the gate is active
    // and a session is verified with an actual role (fallback pass = no chip).
    if(staffGateActive() && auth.ok && auth.role){
      right.appendChild(el("span",{class:"chip",title:"Identifiant : "+(auth.staffId||"—"),style:"font-size:11.5px"},[
        el("span",{html:"👤"}), document.createTextNode(" " + roleLabel(auth.role))
      ]));
      right.appendChild(el("button",{class:"btn sm",title:"Se déconnecter",onclick:logoutStaff}, "Déconnexion"));
    }
    topbar.appendChild(right);
    main.appendChild(topbar);

    var content = el("div",{class:"content"});

    if(store.loading && !store.loaded){
      content.appendChild(el("div",{class:"state"},[ el("div",{class:"spin"}), el("div",{class:"st-t"},"Chargement…"), el("div",{class:"st-s"},"Récupération de vos données") ]));
    } else if(store.error && !store.loaded){
      content.appendChild(el("div",{class:"card"}, el("div",{class:"state"},[
        el("div",{class:"em"},"🚫"),
        el("div",{class:"st-t"},"Impossible de charger les données"),
        el("div",{class:"st-s"}, store.error),
        el("button",{class:"btn primary",onclick:function(){loadAll();}},"Réessayer")
      ])));
    } else {
      if(store.error) content.appendChild(el("div",{class:"banner err",style:"margin-bottom:14px"},[ el("span",{html:"⚠️"}), el("span",{}, "Certaines données n'ont pas pu être actualisées : "+store.error) ]));
      var view;
      if(tab==="apercu") view=viewApercu();
      else if(tab==="commandes") view=viewCommandes();
      else if(tab==="stock") view=viewStock();
      else if(tab==="clients") view=viewClients();
      else if(tab==="depenses") view=viewDepenses();
      else if(tab==="reglages") view=viewReglages();
      else if(FUTURE_IDS.indexOf(tab)>=0) view=viewFutureModule(tab);
      else view=viewApercu();
      content.appendChild(view);
    }
    main.appendChild(content);
    root.appendChild(main);
    root.appendChild(mobileTabs());
  }

  function subForTab(tab){
    if(tab==="apercu") return "Vue d'ensemble de votre activité";
    if(tab==="commandes") return store.orders.length + " commande(s) au total";
    if(tab==="stock") return store.products.length + " produit(s) · " + reorderCount() + " à réapprovisionner";
    if(tab==="clients") return "Clients dérivés des commandes";
    if(tab==="depenses") return "Suivi des dépenses par mois";
    if(tab==="reglages") return "Appairage & informations";
    if(tab==="factures") return "Devis, bons de livraison & factures";
    if(tab==="fournisseurs") return "Fournisseurs & bons d'achat";
    if(tab==="livraison") return "Transporteurs & frais par wilaya";
    if(tab==="caisse") return "Encaissements & rapprochement";
    return "";
  }

  /* ============================================================
     Boot
     ============================================================ */
  initTheme();
  render();
  loadAll();

  // expose a tiny hook for smoke tests (no-op in production use)
  window.__CDZ_ERP__ = { store:store, metrics:metrics, deriveCustomers:deriveCustomers,
    chartRevenue:chartRevenue, chartStatus:chartStatus, loadAll:loadAll, advanceStatus:advanceStatus,
    changeStock:changeStock, ui:ui, moduleOn:moduleOn, activeTabs:activeTabs, render:render, TABS:TABS,
    auth:auth, staffGateActive:staffGateActive, roleAllowsTab:roleAllowsTab, logoutStaff:logoutStaff };
})();
</script>
</body>
</html>
`;
