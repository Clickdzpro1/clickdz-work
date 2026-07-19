// ClickDz Ready Shop — complete single-file storefront + admin template.
//
// This constant is a COMPLETE, self-contained HTML application (hash-routed
// vanilla-JS SPA, all CSS inline). The Gatekeeper substitutes these tokens at
// serve time before deploying it:
//   __CLICKDZ_DATA_URL__     → `${externalBase}/api/v2/apps-data/${slug}`
//   __CLICKDZ_DATA_TOKEN__   → dataWriteToken(slug)   (bearer for v2 writes)
//   __CLICKDZ_SLUG__         → the app slug
// Plus the C5 customization tokens (defaults = the values that were hardcoded
// here before, so a template minted WITHOUT `settings` is byte-identical):
//   __CLICKDZ_STORE_NAME__   → store name          (default "Ma Boutique")
//   __CLICKDZ_WHATSAPP__     → WhatsApp digits      (default "213600000000")
//   __CLICKDZ_ACCENT__       → accent #RRGGBB       (default "#0f766e")
//   __CLICKDZ_PIN__          → admin PIN 4–8 digits (default "1234")
// These feed the settings-singleton defaults, the runtime fallbacks and the
// <title>; the runtime settings form still lets the owner edit them post-launch.
//
// Data model (ClickDz Data API — GET/POST/DELETE only, no PUT): collections
// `products`, `orders`, `settings` (singleton). "Update" = DELETE + re-create
// (the client tracks each record's server-assigned id). Caps: 8KB/record,
// 500/collection — images are stored as URLs only. Checkout = cash-on-delivery
// + a wa.me WhatsApp deep link. All 58 Algerian wilayas are embedded.
//
// C7 — Appearance (theme / layout / font) is driven entirely by the settings
// singleton at runtime (never baked into :root as raw CSS — only ids are stored,
// well within the 8KB cap). The singleton gains three OPTIONAL id fields, each
// with a default that reproduces today's exact look, so a shop with no
// appearance settings renders byte-identically to before:
//   settings.theme    → THEMES id      ('classic' [default] | 'dark' | 'vibrant' | 'minimal')
//   settings.template → LAYOUTS id     ('standard' [default] | 'boutique')
//   settings.font     → FONTS id       ('system'  [default] | 'inter' | 'poppins' | 'playfair')
// At runtime applyTheme(settings) writes the chosen preset's CSS custom props
// onto :root (mirroring applyAccent, which still runs AFTER so settings.accent
// overrides the preset accent). 'classic' writes the SAME values already present
// in the static :root block (a visual no-op); 'standard' branches emit markup
// identical to today; 'system' keeps the current --font stack and loads no font
// <link>. The Shop Appearance editor (SHOP-UX) and the ERP settings allowlist
// (BRIDGE-BE normalizeErpSettings / POST /erp/settings) validate these ids.
//
// String.raw is used so any backslashes in the HTML/CSS/JS survive verbatim;
// the inner content is authored to contain no backtick or ${ sequences, so no
// escaping is required inside the literal.

export const CLICKDZ_SHOP_TEMPLATE_HTML: string = String.raw`<!doctype html>
<html lang="fr" dir="ltr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#111827" />
<title>__CLICKDZ_STORE_NAME__ — ClickDz</title>
<style>
  :root{
    --accent:__CLICKDZ_ACCENT__;
    --accent-d:#0b5b54;
    --accent-l:#ccfbf1;
    --ink:#0f172a;
    --ink-soft:#475569;
    --ink-mute:#94a3b8;
    --line:#e5e7eb;
    --bg:#f6f7f9;
    --card:#ffffff;
    --ok:#16a34a;
    --ok-bg:#dcfce7;
    --warn:#b45309;
    --warn-bg:#fef3c7;
    --danger:#dc2626;
    --danger-bg:#fee2e2;
    --info:#1d4ed8;
    --info-bg:#dbeafe;
    --shadow:0 1px 2px rgba(15,23,42,.06),0 8px 24px rgba(15,23,42,.06);
    --shadow-lg:0 12px 40px rgba(15,23,42,.16);
    --r:14px;
    --r-sm:10px;
    --maxw:1120px;
    --font:'Segoe UI',system-ui,-apple-system,'Helvetica Neue',Arial,'Noto Sans Arabic',sans-serif;
  }
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{
    font-family:var(--font);
    color:var(--ink);
    background:var(--bg);
    line-height:1.5;
    -webkit-font-smoothing:antialiased;
    text-rendering:optimizeLegibility;
    min-height:100vh;
  }
  img{max-width:100%;display:block}
  button{font-family:inherit;cursor:pointer}
  input,select,textarea{font-family:inherit;font-size:15px}
  a{color:inherit;text-decoration:none}
  h1,h2,h3,h4{margin:0;line-height:1.2}
  [hidden]{display:none!important}

  /* ---------- layout ---------- */
  .wrap{max-width:var(--maxw);margin:0 auto;padding:0 16px}
  .app-shell{min-height:100vh;display:flex;flex-direction:column}
  main{flex:1;padding-bottom:48px}

  /* ---------- top bar ---------- */
  .topbar{position:sticky;top:0;z-index:40;background:rgba(255,255,255,.92);backdrop-filter:saturate(1.4) blur(10px);border-bottom:1px solid var(--line)}
  .topbar-inner{display:flex;align-items:center;gap:14px;height:60px}
  .brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:19px;letter-spacing:-.02em;color:var(--ink)}
  .brand .logo{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,var(--accent),var(--accent-d));display:grid;place-items:center;color:#fff;font-size:17px;box-shadow:0 4px 12px rgba(15,118,110,.35)}
  .brand small{display:block;font-weight:500;font-size:11px;color:var(--ink-mute);letter-spacing:0}
  .top-actions{margin-inline-start:auto;display:flex;align-items:center;gap:8px}
  .icon-btn{position:relative;display:inline-grid;place-items:center;width:42px;height:42px;border-radius:11px;border:1px solid var(--line);background:#fff;color:var(--ink);font-size:19px;transition:.15s}
  .icon-btn:hover{background:var(--bg);border-color:var(--ink-mute)}
  .cart-count{position:absolute;top:-5px;inset-inline-end:-5px;min-width:19px;height:19px;padding:0 4px;border-radius:10px;background:var(--accent);color:#fff;font-size:11px;font-weight:700;display:grid;place-items:center;border:2px solid #fff}

  /* ---------- buttons ---------- */
  .btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:1px solid transparent;border-radius:var(--r-sm);padding:11px 18px;font-weight:600;font-size:15px;transition:.15s;line-height:1;white-space:nowrap}
  .btn:disabled{opacity:.55;cursor:not-allowed}
  .btn.primary{background:var(--accent);color:#fff;box-shadow:0 6px 16px rgba(15,118,110,.28)}
  .btn.primary:hover:not(:disabled){background:var(--accent-d)}
  .btn.ghost{background:#fff;border-color:var(--line);color:var(--ink)}
  .btn.ghost:hover:not(:disabled){background:var(--bg);border-color:var(--ink-mute)}
  .btn.soft{background:var(--accent-l);color:var(--accent-d)}
  .btn.soft:hover:not(:disabled){filter:brightness(.97)}
  .btn.danger{background:var(--danger-bg);color:var(--danger)}
  .btn.danger:hover:not(:disabled){background:#fecaca}
  .btn.block{width:100%}
  .btn.lg{padding:15px 22px;font-size:16px}
  .btn.sm{padding:8px 12px;font-size:13px;border-radius:9px}
  .btn.wa{background:#25d366;color:#062e14;box-shadow:0 8px 22px rgba(37,211,102,.4);font-weight:800}
  .btn.wa:hover:not(:disabled){background:#1fbe5a}

  /* ---------- hero ---------- */
  .hero{position:relative;overflow:hidden;background:linear-gradient(135deg,var(--accent),var(--accent-d));color:#fff}
  .hero::after{content:"";position:absolute;inset:0;background:radial-gradient(1000px 400px at 85% -20%,rgba(255,255,255,.22),transparent 60%);pointer-events:none}
  .hero-inner{position:relative;z-index:1;padding:52px 0 60px;text-align:center}
  .hero h1{font-size:clamp(28px,6vw,46px);font-weight:900;letter-spacing:-.03em;margin-bottom:12px}
  .hero p{max-width:560px;margin:0 auto 22px;font-size:clamp(15px,2.5vw,18px);opacity:.92}
  .hero .cta-row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
  .hero .btn.ghost{background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.38);color:#fff;backdrop-filter:blur(4px)}
  .hero .btn.ghost:hover{background:rgba(255,255,255,.24)}
  .hero .btn.light{background:#fff;color:var(--accent-d)}
  .cod-pill{display:inline-flex;align-items:center;gap:7px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.28);padding:6px 14px;border-radius:999px;font-size:13px;font-weight:600;margin-bottom:18px}

  /* ---------- trust strip ---------- */
  .trust{background:#fff;border-bottom:1px solid var(--line)}
  .trust-inner{display:flex;gap:8px;overflow-x:auto;padding:14px 16px;scrollbar-width:none}
  .trust-inner::-webkit-scrollbar{display:none}
  .trust-item{flex:0 0 auto;display:flex;align-items:center;gap:9px;font-size:13px;font-weight:600;color:var(--ink-soft);white-space:nowrap;padding-inline-end:8px}
  .trust-item .ic{font-size:18px}

  /* ---------- filter chips ---------- */
  .section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:28px 0 14px}
  .section-head h2{font-size:22px;font-weight:800;letter-spacing:-.02em}
  .section-head .muted{color:var(--ink-mute);font-size:14px}
  .chips{display:flex;gap:8px;overflow-x:auto;padding:4px 0 10px;scrollbar-width:none;-webkit-overflow-scrolling:touch}
  .chips::-webkit-scrollbar{display:none}
  .chip{flex:0 0 auto;border:1px solid var(--line);background:#fff;color:var(--ink-soft);border-radius:999px;padding:8px 15px;font-size:14px;font-weight:600;transition:.15s}
  .chip:hover{border-color:var(--accent)}
  .chip.active{background:var(--accent);border-color:var(--accent);color:#fff}

  /* ---------- product grid ---------- */
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px}
  @media(min-width:560px){.grid{grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:18px}}
  .card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);overflow:hidden;box-shadow:var(--shadow);transition:.18s;display:flex;flex-direction:column}
  .card:hover{transform:translateY(-3px);box-shadow:var(--shadow-lg);border-color:#dbe1e8}
  .card .thumb{position:relative;aspect-ratio:1/1;background:var(--bg);overflow:hidden}
  .card .thumb img{width:100%;height:100%;object-fit:cover;transition:.3s}
  .card:hover .thumb img{transform:scale(1.05)}
  .card .thumb .ph{width:100%;height:100%;display:grid;place-items:center;color:var(--ink-mute);font-size:38px;background:linear-gradient(135deg,#eef1f4,#e2e7ec)}
  .badge{position:absolute;top:10px;font-size:11px;font-weight:800;padding:4px 9px;border-radius:999px;letter-spacing:.02em;text-transform:uppercase}
  .badge.stock-in{inset-inline-start:10px;background:var(--ok-bg);color:var(--ok)}
  .badge.stock-low{inset-inline-start:10px;background:var(--warn-bg);color:var(--warn)}
  .badge.stock-out{inset-inline-start:10px;background:var(--danger-bg);color:var(--danger)}
  .badge.cat{inset-inline-end:10px;background:rgba(15,23,42,.72);color:#fff;text-transform:none;font-weight:600}
  .card .body{padding:12px 13px 14px;display:flex;flex-direction:column;gap:6px;flex:1}
  .card .title{font-weight:700;font-size:15px;color:var(--ink);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.4em}
  .card .price{font-weight:900;font-size:18px;color:var(--accent-d);letter-spacing:-.01em}
  .card .price .cur{font-size:12px;font-weight:700;color:var(--ink-soft)}
  .card .add{margin-top:6px}

  /* ---------- skeleton ---------- */
  .sk{background:linear-gradient(90deg,#eef1f4 25%,#e2e7ec 37%,#eef1f4 63%);background-size:400% 100%;animation:sk 1.3s ease infinite;border-radius:8px}
  @keyframes sk{0%{background-position:100% 0}100%{background-position:-100% 0}}
  .sk-card{background:#fff;border:1px solid var(--line);border-radius:var(--r);overflow:hidden}
  .sk-card .sk-thumb{aspect-ratio:1/1}
  .sk-card .sk-b{padding:12px 13px}
  .sk-line{height:12px;margin-bottom:8px}

  /* ---------- product detail ---------- */
  .pd{display:grid;gap:22px;margin-top:22px}
  @media(min-width:768px){.pd{grid-template-columns:1fr 1fr;align-items:start;gap:36px}}
  .pd .gallery{position:relative;border-radius:var(--r);overflow:hidden;border:1px solid var(--line);background:#fff;box-shadow:var(--shadow)}
  .pd .gallery .main{aspect-ratio:1/1}
  .pd .gallery img{width:100%;height:100%;object-fit:cover}
  .pd .gallery .ph{width:100%;height:100%;display:grid;place-items:center;font-size:64px;color:var(--ink-mute);background:linear-gradient(135deg,#eef1f4,#e2e7ec)}
  .pd .info h1{font-size:26px;font-weight:800;letter-spacing:-.02em;margin-bottom:10px}
  .pd .info .price{font-size:30px;font-weight:900;color:var(--accent-d);margin-bottom:6px}
  .pd .info .price .cur{font-size:16px;color:var(--ink-soft)}
  .pd .desc{color:var(--ink-soft);font-size:15px;margin:14px 0 18px;white-space:pre-wrap}
  .qtyrow{display:flex;align-items:center;gap:14px;margin:18px 0}
  .qty{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:var(--r-sm);overflow:hidden;background:#fff}
  .qty button{width:44px;height:44px;border:0;background:#fff;font-size:20px;color:var(--ink);display:grid;place-items:center}
  .qty button:hover{background:var(--bg)}
  .qty input{width:52px;height:44px;border:0;border-inline:1px solid var(--line);text-align:center;font-weight:700;font-size:16px;-moz-appearance:textfield}
  .qty input::-webkit-outer-spin-button,.qty input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
  .meta-list{display:flex;flex-direction:column;gap:9px;margin-top:20px;border-top:1px solid var(--line);padding-top:18px}
  .meta-list .row{display:flex;align-items:center;gap:10px;font-size:14px;color:var(--ink-soft)}
  .meta-list .row .ic{font-size:18px;width:24px;text-align:center}

  /* ---------- cart ---------- */
  .panel{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);overflow:hidden}
  .cart-item{display:flex;gap:13px;padding:14px 16px;border-bottom:1px solid var(--line);align-items:center}
  .cart-item:last-child{border-bottom:0}
  .cart-item .ci-thumb{width:64px;height:64px;border-radius:10px;overflow:hidden;flex:0 0 auto;background:var(--bg)}
  .cart-item .ci-thumb img{width:100%;height:100%;object-fit:cover}
  .cart-item .ci-thumb .ph{width:100%;height:100%;display:grid;place-items:center;color:var(--ink-mute);font-size:24px}
  .cart-item .ci-main{flex:1;min-width:0}
  .cart-item .ci-title{font-weight:700;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cart-item .ci-price{color:var(--ink-soft);font-size:13px;margin-top:2px}
  .cart-item .ci-right{text-align:end;display:flex;flex-direction:column;align-items:flex-end;gap:6px}
  .cart-item .ci-sub{font-weight:800;color:var(--accent-d)}
  .link-x{background:none;border:0;color:var(--danger);font-size:13px;font-weight:600;padding:2px}
  .miniqty{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:8px;overflow:hidden}
  .miniqty button{width:30px;height:30px;border:0;background:#fff;font-size:15px}
  .miniqty span{min-width:30px;text-align:center;font-weight:700;font-size:14px}
  .summary{display:flex;flex-direction:column;gap:10px;padding:16px}
  .summary .line{display:flex;justify-content:space-between;font-size:15px;color:var(--ink-soft)}
  .summary .line.total{font-size:19px;font-weight:900;color:var(--ink);border-top:1px dashed var(--line);padding-top:12px;margin-top:4px}
  .summary .line.total .cur{font-size:14px;color:var(--ink-soft)}

  /* ---------- forms ---------- */
  .form{display:flex;flex-direction:column;gap:15px}
  .field{display:flex;flex-direction:column;gap:6px}
  .field label{font-weight:600;font-size:14px;color:var(--ink)}
  .field label .req{color:var(--danger)}
  .field .hint{font-size:12px;color:var(--ink-mute)}
  .control{width:100%;padding:12px 13px;border:1px solid var(--line);border-radius:var(--r-sm);background:#fff;color:var(--ink);transition:.15s}
  .control:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-l)}
  .control.err{border-color:var(--danger);box-shadow:0 0 0 3px var(--danger-bg)}
  textarea.control{resize:vertical;min-height:78px}
  select.control{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath fill='%23475569' d='M6 8 0 0h12z'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 14px center;padding-inline-end:34px}
  html[dir=rtl] select.control{background-position:left 14px center}
  .err-msg{color:var(--danger);font-size:12.5px;font-weight:600}
  .grid2{display:grid;gap:15px}
  @media(min-width:560px){.grid2{grid-template-columns:1fr 1fr}}

  /* ---------- success ---------- */
  .success{text-align:center;padding:26px 18px;max-width:520px;margin:26px auto 0}
  .success .check{width:82px;height:82px;border-radius:50%;background:var(--ok-bg);color:var(--ok);display:grid;place-items:center;font-size:44px;margin:0 auto 18px;animation:pop .4s cubic-bezier(.2,1.4,.4,1)}
  @keyframes pop{0%{transform:scale(.4);opacity:0}100%{transform:scale(1);opacity:1}}
  .success h1{font-size:26px;font-weight:900;margin-bottom:8px}
  .success p{color:var(--ink-soft);margin-bottom:6px}
  .ref-chip{display:inline-block;background:var(--bg);border:1px dashed var(--ink-mute);border-radius:10px;padding:8px 16px;font-weight:800;letter-spacing:.03em;color:var(--ink);margin:12px 0 18px;font-size:17px}

  /* ---------- empty ---------- */
  .empty{text-align:center;padding:56px 20px;color:var(--ink-mute)}
  .empty .ic{font-size:52px;margin-bottom:14px;opacity:.7}
  .empty h3{font-size:19px;color:var(--ink-soft);font-weight:700;margin-bottom:6px}
  .empty p{font-size:14px;margin-bottom:18px}

  /* ---------- toast ---------- */
  .toasts{position:fixed;left:50%;transform:translateX(-50%);bottom:22px;z-index:1000;display:flex;flex-direction:column;gap:8px;width:calc(100% - 32px);max-width:380px;pointer-events:none}
  .toast{pointer-events:auto;background:var(--ink);color:#fff;border-radius:12px;padding:13px 16px;font-size:14px;font-weight:600;box-shadow:var(--shadow-lg);display:flex;align-items:center;gap:10px;animation:slideup .3s ease;border-inline-start:4px solid var(--accent)}
  .toast.ok{border-inline-start-color:var(--ok)}
  .toast.err{border-inline-start-color:var(--danger)}
  .toast .ic{font-size:18px}
  @keyframes slideup{from{transform:translateY(16px);opacity:0}to{transform:translateY(0);opacity:1}}

  /* ---------- modal / sheet ---------- */
  .backdrop{position:fixed;inset:0;background:rgba(15,23,42,.5);z-index:200;display:flex;align-items:flex-end;justify-content:center;animation:fade .2s ease}
  @media(min-width:640px){.backdrop{align-items:center}}
  @keyframes fade{from{opacity:0}to{opacity:1}}
  .sheet{background:#fff;width:100%;max-width:560px;max-height:92vh;overflow:auto;border-radius:18px 18px 0 0;box-shadow:var(--shadow-lg);animation:sheetup .28s cubic-bezier(.2,.9,.3,1)}
  @media(min-width:640px){.sheet{border-radius:18px}}
  @keyframes sheetup{from{transform:translateY(40px);opacity:.4}to{transform:translateY(0);opacity:1}}
  .sheet-head{position:sticky;top:0;background:#fff;display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid var(--line);z-index:2}
  .sheet-head h3{font-size:18px;font-weight:800}
  .sheet-body{padding:18px}
  .sheet-foot{position:sticky;bottom:0;background:#fff;border-top:1px solid var(--line);padding:14px 18px;display:flex;gap:10px}
  .x-btn{width:36px;height:36px;border-radius:9px;border:1px solid var(--line);background:#fff;font-size:17px;display:grid;place-items:center;color:var(--ink-soft)}
  .x-btn:hover{background:var(--bg)}

  /* ---------- admin ---------- */
  .admin-nav{display:flex;gap:6px;background:#fff;border:1px solid var(--line);border-radius:14px;padding:6px;margin-top:18px;box-shadow:var(--shadow);overflow-x:auto;scrollbar-width:none}
  .admin-nav::-webkit-scrollbar{display:none}
  .admin-nav button{flex:1 0 auto;border:0;background:none;padding:10px 14px;border-radius:9px;font-weight:700;font-size:14px;color:var(--ink-soft);white-space:nowrap;transition:.15s}
  .admin-nav button.active{background:var(--accent);color:#fff}
  .admin-nav button:not(.active):hover{background:var(--bg)}
  .stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-top:16px}
  .stat{background:#fff;border:1px solid var(--line);border-radius:12px;padding:15px;box-shadow:var(--shadow)}
  .stat .k{font-size:12px;font-weight:700;color:var(--ink-mute);text-transform:uppercase;letter-spacing:.03em}
  .stat .v{font-size:24px;font-weight:900;margin-top:4px;color:var(--ink)}
  .stat .v .cur{font-size:13px;color:var(--ink-soft);font-weight:700}

  .adm-list{display:flex;flex-direction:column;gap:10px;margin-top:16px}
  .adm-item{background:#fff;border:1px solid var(--line);border-radius:12px;padding:13px 14px;display:flex;gap:12px;align-items:center;box-shadow:var(--shadow)}
  .adm-item .ai-thumb{width:52px;height:52px;border-radius:9px;overflow:hidden;flex:0 0 auto;background:var(--bg)}
  .adm-item .ai-thumb img{width:100%;height:100%;object-fit:cover}
  .adm-item .ai-thumb .ph{width:100%;height:100%;display:grid;place-items:center;color:var(--ink-mute);font-size:20px}
  .adm-item .ai-main{flex:1;min-width:0}
  .adm-item .ai-title{font-weight:700;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .adm-item .ai-sub{font-size:13px;color:var(--ink-soft);margin-top:2px;display:flex;gap:10px;flex-wrap:wrap}
  .adm-item .ai-actions{display:flex;gap:6px;align-items:center;flex:0 0 auto}
  .pillbtn{border:1px solid var(--line);background:#fff;border-radius:8px;width:34px;height:34px;display:grid;place-items:center;font-size:15px;color:var(--ink-soft)}
  .pillbtn:hover{background:var(--bg)}
  .pillbtn.on{background:var(--ok-bg);color:var(--ok);border-color:transparent}
  .pillbtn.off{background:var(--bg);color:var(--ink-mute)}

  .tag{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:800;padding:3px 9px;border-radius:999px;text-transform:uppercase;letter-spacing:.02em}
  .tag.nouvelle{background:var(--info-bg);color:var(--info)}
  .tag.confirmee{background:var(--accent-l);color:var(--accent-d)}
  .tag.expediee{background:#ede9fe;color:#6d28d9}
  .tag.livree{background:var(--ok-bg);color:var(--ok)}
  .tag.retournee{background:var(--danger-bg);color:var(--danger)}

  .order-card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px;box-shadow:var(--shadow)}
  .order-card .oc-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:8px}
  .order-card .oc-ref{font-weight:800;font-size:15px}
  .order-card .oc-meta{font-size:12.5px;color:var(--ink-mute);margin-top:2px}
  .order-card .oc-items{font-size:13.5px;color:var(--ink-soft);margin:8px 0;border-top:1px dashed var(--line);border-bottom:1px dashed var(--line);padding:8px 0}
  .order-card .oc-items .li{display:flex;justify-content:space-between;gap:8px;padding:2px 0}
  .order-card .oc-foot{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap}
  .order-card .oc-total{font-weight:900;color:var(--accent-d)}
  .adv-row{display:flex;gap:6px;flex-wrap:wrap}

  .callout{background:var(--accent-l);border:1px solid transparent;border-radius:12px;padding:13px 15px;font-size:13.5px;color:var(--accent-d);display:flex;gap:10px;align-items:flex-start;margin-top:6px}
  .callout .ic{font-size:18px;flex:0 0 auto}

  .gate{max-width:380px;margin:60px auto 0;text-align:center;background:#fff;border:1px solid var(--line);border-radius:16px;padding:34px 26px;box-shadow:var(--shadow-lg)}
  .gate .ic{font-size:46px;margin-bottom:14px}
  .gate h2{font-size:21px;font-weight:800;margin-bottom:6px}
  .gate p{color:var(--ink-soft);font-size:14px;margin-bottom:18px}

  .colorrow{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}
  .swatch{width:34px;height:34px;border-radius:9px;border:2px solid #fff;box-shadow:0 0 0 1px var(--line);cursor:pointer;transition:.15s}
  .swatch:hover{transform:scale(1.08)}
  .swatch.sel{box-shadow:0 0 0 2px var(--ink)}

  /* ---------- footer ---------- */
  footer{background:#111827;color:#cbd5e1;margin-top:auto;padding:32px 0 26px}
  footer .f-inner{display:flex;flex-direction:column;gap:14px;text-align:center}
  footer .f-brand{font-weight:800;font-size:18px;color:#fff;display:flex;align-items:center;gap:9px;justify-content:center}
  footer .f-brand .ar{font-family:'Noto Sans Arabic',sans-serif;font-size:16px;color:var(--accent-l);font-weight:700}
  footer .f-links{display:flex;gap:16px;justify-content:center;flex-wrap:wrap;font-size:14px}
  footer .f-links a{color:#94a3b8}
  footer .f-links a:hover{color:#fff}
  footer .f-cod{font-size:13px;color:#94a3b8}
  footer .f-made{font-size:12px;color:#64748b;border-top:1px solid #1f2937;padding-top:14px;margin-top:4px}
  footer .f-made a{color:#94a3b8;font-weight:600}

  /* ---------- misc ---------- */
  .back-link{display:inline-flex;align-items:center;gap:6px;color:var(--ink-soft);font-weight:600;font-size:14px;margin-top:18px}
  .back-link:hover{color:var(--accent)}
  html[dir=rtl] .back-link .arw{transform:scaleX(-1)}
  .center-load{display:grid;place-items:center;padding:60px 20px;color:var(--ink-mute);gap:14px}
  .spinner{width:34px;height:34px;border:3px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);border:0}

  /* ---------- layout: boutique (settings.template='boutique') ----------
     An asymmetric editorial hero + a roomier product grid. Only used when the
     merchant opts into the 'boutique' template; the default 'standard' layout
     is untouched above so it renders identically to before. */
  .hero-boutique{position:relative;overflow:hidden;background:linear-gradient(120deg,var(--accent-d),var(--accent))}
  .hero-boutique::after{content:"";position:absolute;inset:0;background:radial-gradient(680px 320px at 12% 8%,rgba(255,255,255,.22),transparent 62%);pointer-events:none}
  .hero-boutique .hb-inner{position:relative;z-index:1;display:flex;flex-direction:column;gap:16px;align-items:flex-start;text-align:start;color:#fff;padding:56px 0 62px;max-width:640px}
  .hero-boutique .hb-kicker{display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.3);border-radius:999px;padding:6px 14px;font-size:12.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
  .hero-boutique h1{font-size:clamp(30px,6.6vw,54px);font-weight:900;letter-spacing:-.035em;line-height:1.03}
  .hero-boutique p{font-size:clamp(15px,2.4vw,19px);opacity:.94;max-width:520px;margin:0}
  .hero-boutique .cta-row{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px}
  .hero-boutique .btn.light{background:#fff;color:var(--accent-d)}
  .hero-boutique .btn.ghost{background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.4);color:#fff}
  .hero-boutique .btn.ghost:hover{background:rgba(255,255,255,.24)}
  .grid-boutique{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:14px}
  @media(min-width:560px){.grid-boutique{grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:22px}}
  .grid-boutique .card{border-radius:calc(var(--r) + 4px)}
  .grid-boutique .card .thumb{aspect-ratio:4/5}
  .grid-boutique .card .body{padding:14px 15px 16px;gap:8px}
  .grid-boutique .card .title{font-size:15.5px}
  .grid-boutique .card .price{font-size:19px}
  .feature-boutique{display:grid;gap:16px;margin-top:22px}
  @media(min-width:760px){.feature-boutique{grid-template-columns:1.4fr 1fr;align-items:stretch}}
  .feature-boutique .fb-hero{position:relative;border-radius:calc(var(--r) + 6px);overflow:hidden;min-height:260px;background:var(--card);border:1px solid var(--line);box-shadow:var(--shadow)}
  .feature-boutique .fb-hero img{width:100%;height:100%;object-fit:cover;position:absolute;inset:0}
  .feature-boutique .fb-hero .fb-ph{position:absolute;inset:0;display:grid;place-items:center;font-size:64px;color:var(--ink-mute);background:linear-gradient(135deg,#eef1f4,#e2e7ec)}
  .feature-boutique .fb-hero .fb-cap{position:absolute;inset-inline:0;bottom:0;padding:18px;background:linear-gradient(0deg,rgba(0,0,0,.62),transparent);color:#fff}
  .feature-boutique .fb-hero .fb-cap .t{font-weight:800;font-size:19px}
  .feature-boutique .fb-hero .fb-cap .p{font-weight:900;font-size:16px;margin-top:2px}
  .feature-boutique .fb-side{display:flex;flex-direction:column;gap:12px}
</style>
</head>
<body>
<div id="app" class="app-shell"><div class="center-load"><div class="spinner"></div><span>Chargement…</span></div></div>
<div class="toasts" id="toasts" aria-live="polite"></div>
<script>
'use strict';
/* =========================================================================
   ClickDz Ready Shop — vanilla-JS hash-routed storefront + admin.
   Zero external requests except the ClickDz Data API.
   ========================================================================= */

/* ---- wiring (substituted at serve time) ---- */
var DATA_URL = '__CLICKDZ_DATA_URL__';   // e.g. https://work.clickdz.ai/api/v2/apps-data/<slug>
var DATA_TOKEN = '__CLICKDZ_DATA_TOKEN__';
var SLUG = '__CLICKDZ_SLUG__';

/* ---- constants ---- */
var STATUSES = ['Nouvelle', 'Confirmée', 'Expédiée', 'Livrée', 'Retournée'];
var STATUS_CLASS = { 'Nouvelle': 'nouvelle', 'Confirmée': 'confirmee', 'Expédiée': 'expediee', 'Livrée': 'livree', 'Retournée': 'retournee' };
/* forward flow + the return branch */
var NEXT_STATUS = { 'Nouvelle': 'Confirmée', 'Confirmée': 'Expédiée', 'Expédiée': 'Livrée' };
var CART_KEY = 'clickdz.shop.cart.' + SLUG;
var ADMIN_KEY = 'clickdz.shop.admin.' + SLUG;

/* The 58 Algerian wilayas (official numbering). */
var WILAYAS = [
  '01 - Adrar', '02 - Chlef', '03 - Laghouat', '04 - Oum El Bouaghi', '05 - Batna',
  '06 - Béjaïa', '07 - Biskra', '08 - Béchar', '09 - Blida', '10 - Bouira',
  '11 - Tamanrasset', '12 - Tébessa', '13 - Tlemcen', '14 - Tiaret', '15 - Tizi Ouzou',
  '16 - Alger', '17 - Djelfa', '18 - Jijel', '19 - Sétif', '20 - Saïda',
  '21 - Skikda', '22 - Sidi Bel Abbès', '23 - Annaba', '24 - Guelma', '25 - Constantine',
  '26 - Médéa', '27 - Mostaganem', '28 - M\'Sila', '29 - Mascara', '30 - Ouargla',
  '31 - Oran', '32 - El Bayadh', '33 - Illizi', '34 - Bordj Bou Arréridj', '35 - Boumerdès',
  '36 - El Tarf', '37 - Tindouf', '38 - Tissemsilt', '39 - El Oued', '40 - Khenchela',
  '41 - Souk Ahras', '42 - Tipaza', '43 - Mila', '44 - Aïn Defla', '45 - Naâma',
  '46 - Aïn Témouchent', '47 - Ghardaïa', '48 - Relizane', '49 - Timimoun', '50 - Bordj Badji Mokhtar',
  '51 - Ouled Djellal', '52 - Béni Abbès', '53 - In Salah', '54 - In Guezzam', '55 - Touggourt',
  '56 - Djanet', '57 - El M\'Ghair', '58 - El Meniaa'
];

/* ---- default settings singleton ----
   theme/template/font default to the ids that reproduce today's exact look, so
   a legacy singleton (or none) renders byte-identically. They are validated
   against THEMES/LAYOUTS/FONTS at read time, never trusted blindly. */
function defaultSettings() {
  return {
    key: 'settings',
    shopName: '__CLICKDZ_STORE_NAME__',
    tagline: 'Produits de qualité, livrés partout en Algérie — paiement à la livraison.',
    whatsapp: '__CLICKDZ_WHATSAPP__',
    deliveryFee: 500,
    adminPin: '__CLICKDZ_PIN__',
    accent: '__CLICKDZ_ACCENT__',
    currency: 'DZD',
    theme: 'classic',
    template: 'standard',
    font: 'system'
  };
}

/* Six tasteful demo products seeded on first run. */
function demoProducts() {
  return [
    { title: 'Montre Élégance Classic', price: 4900, category: 'Accessoires', stock: 24, reorderAt: 5, active: true, imageUrl: 'https://images.unsplash.com/photo-1524592094714-0f0654e20314?w=600&q=70&auto=format&fit=crop', description: 'Montre à quartz, bracelet acier inoxydable, résistante à l\'eau. Un accessoire intemporel pour le quotidien.' },
    { title: 'Sac à Main Cuir Premium', price: 6500, category: 'Mode', stock: 12, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1584917865442-de89df76afd3?w=600&q=70&auto=format&fit=crop', description: 'Sac en cuir véritable, finitions soignées, plusieurs compartiments. Élégance et robustesse au rendez-vous.' },
    { title: 'Écouteurs Sans Fil Pro', price: 3200, category: 'Électronique', stock: 3, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=600&q=70&auto=format&fit=crop', description: 'Son immersif, réduction de bruit, autonomie 24h avec le boîtier. Compatibles tous smartphones.' },
    { title: 'Parfum Oud Intense 50ml', price: 5800, category: 'Beauté', stock: 18, reorderAt: 5, active: true, imageUrl: 'https://images.unsplash.com/photo-1541643600914-78b084683601?w=600&q=70&auto=format&fit=crop', description: 'Fragrance orientale boisée, tenue longue durée. Un sillage raffiné qui vous accompagne toute la journée.' },
    { title: 'Baskets Urban Confort', price: 4200, category: 'Mode', stock: 0, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?w=600&q=70&auto=format&fit=crop', description: 'Semelle amortissante, mesh respirant, style moderne. Idéales pour la ville comme pour le sport léger.' },
    { title: 'Lampe LED Design Bureau', price: 2400, category: 'Maison', stock: 30, reorderAt: 8, active: true, imageUrl: 'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?w=600&q=70&auto=format&fit=crop', description: 'Éclairage réglable 3 intensités, port USB intégré, bras articulé. Parfaite pour le travail et la lecture.' }
  ];
}

/* =========================================================================
   Data client — talks to the ClickDz Data API.
   Collections: products, orders, settings. No PUT/PATCH exists server-side,
   so "update" = DELETE the old record id then POST a fresh one. Records get
   a server-assigned id; we track it client-side.
   ========================================================================= */
var api = {
  base: function (collection) { return DATA_URL + '/' + collection; },
  headers: function (write) {
    var h = { 'Content-Type': 'application/json' };
    if (write && DATA_TOKEN) h['Authorization'] = 'Bearer ' + DATA_TOKEN;
    return h;
  },
  list: function (collection) {
    return fetch(this.base(collection) + '?limit=500', { headers: { 'Accept': 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('list ' + collection + ' → ' + r.status);
        return r.json();
      })
      .then(function (rows) { return Array.isArray(rows) ? rows : []; });
  },
  create: function (collection, body) {
    return fetch(this.base(collection), { method: 'POST', headers: this.headers(true), body: JSON.stringify(body) })
      .then(function (r) {
        if (!r.ok) throw new Error('create ' + collection + ' → ' + r.status);
        return r.json();
      });
  },
  remove: function (collection, id) {
    if (!id) return Promise.resolve({ deleted: false });
    return fetch(this.base(collection) + '/' + encodeURIComponent(id), { method: 'DELETE', headers: this.headers(true) })
      .then(function (r) {
        if (!r.ok) throw new Error('delete ' + collection + ' → ' + r.status);
        return r.json();
      });
  },
  /* update-by-replace: keeps a stable logical record while the store has no PUT */
  replace: function (collection, id, body) {
    var self = this;
    return self.remove(collection, id).then(function () { return self.create(collection, body); });
  }
};

/* =========================================================================
   Store — in-memory state hydrated from the API.
   ========================================================================= */
var store = {
  settings: null,
  settingsId: null,
  products: [],
  orders: [],
  ordersLoaded: false,
  cart: loadCart(),
  loading: true,
  error: null
};

function loadCart() {
  try { var v = JSON.parse(localStorage.getItem(CART_KEY) || '[]'); return Array.isArray(v) ? v : []; }
  catch (e) { return []; }
}
function saveCart() {
  try { localStorage.setItem(CART_KEY, JSON.stringify(store.cart)); } catch (e) {}
  updateCartCount();
}

/* Load settings + products (orders load lazily in admin). Seeds on first run. */
function bootstrap() {
  store.loading = true; store.error = null;
  return Promise.all([api.list('settings'), api.list('products')])
    .then(function (res) {
      var settingsRows = res[0], productRows = res[1];
      var chain = Promise.resolve();
      /* settings singleton */
      if (settingsRows.length) {
        var s = settingsRows[0];
        store.settingsId = s.id;
        store.settings = Object.assign(defaultSettings(), s);
        store.settings.key = 'settings';
      } else {
        var def = defaultSettings();
        chain = chain.then(function () {
          return api.create('settings', def).then(function (created) {
            store.settingsId = created.id;
            store.settings = Object.assign(defaultSettings(), created);
          }).catch(function () { store.settings = def; });
        });
      }
      /* products seed */
      if (productRows.length) {
        store.products = productRows;
      } else {
        chain = chain.then(function () { return seedProducts(); });
      }
      return chain;
    })
    .then(function () { store.loading = false; applyAppearance(); })
    .catch(function (err) {
      store.loading = false;
      store.error = (err && err.message) || 'Erreur de chargement';
      /* graceful fallback so the storefront still renders something */
      if (!store.settings) store.settings = defaultSettings();
    });
}

function seedProducts() {
  var demos = demoProducts();
  var out = [];
  /* create sequentially to respect rate + keep order */
  return demos.reduce(function (p, prod) {
    return p.then(function () {
      return api.create('products', prod).then(function (created) { out.push(created); })
        .catch(function () { out.push(Object.assign({ id: 'local-' + out.length }, prod)); });
    });
  }, Promise.resolve()).then(function () { store.products = out; });
}

function refreshProducts() {
  return api.list('products').then(function (rows) { store.products = rows; });
}
function refreshOrders() {
  return api.list('orders').then(function (rows) { store.orders = rows; store.ordersLoaded = true; });
}

/* =========================================================================
   Helpers
   ========================================================================= */
function money(n) {
  var v = Math.round(Number(n) || 0);
  return v.toLocaleString('fr-DZ').replace(/ /g, ' ');
}
function priceHtml(n, big) {
  return '<span class="price">' + money(n) + ' <span class="cur">DZD</span></span>';
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function attr(s) { return esc(s); }
function activeProducts() { return store.products.filter(function (p) { return p.active !== false; }); }
function findProduct(id) {
  for (var i = 0; i < store.products.length; i++) if (String(store.products[i].id) === String(id)) return store.products[i];
  return null;
}
function categories() {
  var set = {}, list = [];
  activeProducts().forEach(function (p) { var c = (p.category || '').trim(); if (c && !set[c]) { set[c] = 1; list.push(c); } });
  return list;
}
function stockBadge(p) {
  var s = Number(p.stock) || 0;
  if (s <= 0) return '<span class="badge stock-out">Rupture</span>';
  if (s <= (Number(p.reorderAt) || 5)) return '<span class="badge stock-low">Stock bas</span>';
  return '<span class="badge stock-in">En stock</span>';
}
function thumbHtml(p, cls) {
  if (p.imageUrl) return '<img loading="lazy" src="' + attr(p.imageUrl) + '" alt="' + attr(p.title) + '" onerror="this.style.display=\'none\';this.parentNode.innerHTML=\'<div class=&quot;ph&quot;>🛍️</div>\'" />';
  return '<div class="ph">🛍️</div>';
}
function cartCount() { return store.cart.reduce(function (n, l) { return n + l.qty; }, 0); }
function cartSubtotal() {
  return store.cart.reduce(function (sum, l) {
    var p = findProduct(l.id); return sum + (p ? (Number(p.price) || 0) * l.qty : 0);
  }, 0);
}
function updateCartCount() {
  var els = document.querySelectorAll('[data-cart-count]');
  var n = cartCount();
  els.forEach(function (el) { el.textContent = n; el.hidden = n === 0; });
}
function orderRef() {
  return 'CMD-' + Date.now().toString(36).toUpperCase();
}
function accent() { return (store.settings && store.settings.accent) || '__CLICKDZ_ACCENT__'; }
function shopName() { return (store.settings && store.settings.shopName) || '__CLICKDZ_STORE_NAME__'; }

/* darken a hex color for the accent-dark custom prop */
function shade(hex, pct) {
  var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return hex || '#0b5b54';
  var r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  var f = 1 + pct;
  r = Math.max(0, Math.min(255, Math.round(r * f)));
  g = Math.max(0, Math.min(255, Math.round(g * f)));
  b = Math.max(0, Math.min(255, Math.round(b * f)));
  function h(x) { return ('0' + x.toString(16)).slice(-2); }
  return '#' + h(r) + h(g) + h(b);
}
function tint(hex) {
  var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return '#ccfbf1';
  var r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  r = Math.round(r + (255 - r) * 0.86); g = Math.round(g + (255 - g) * 0.86); b = Math.round(b + (255 - b) * 0.86);
  function h(x) { return ('0' + x.toString(16)).slice(-2); }
  return '#' + h(r) + h(g) + h(b);
}
function applyAccent() {
  var a = accent();
  var root = document.documentElement.style;
  root.setProperty('--accent', a);
  root.setProperty('--accent-d', shade(a, -0.22));
  root.setProperty('--accent-l', tint(a));
  var tc = document.querySelector('meta[name=theme-color]');
  if (tc) tc.setAttribute('content', a);
  document.title = shopName() + ' — Boutique en ligne';
}

/* =========================================================================
   Appearance — THEMES (color/shadow/radius presets), FONTS, LAYOUTS.
   All appearance is a set of CSS custom-property values written onto :root at
   runtime (exactly like applyAccent) — never raw CSS in the settings record, so
   the 8KB singleton cap is never at risk (we store only ids).

   INVARIANTS that keep the default byte-identical:
     • theme 'classic'  writes the SAME values already in the static :root block
       (a pure visual no-op) and leaves accent entirely to applyAccent().
     • font  'system'   resolves to the SAME --font stack as :root and loads no
       <link>.
     • layout 'standard' is the default branch of the view functions and emits
       markup identical to today.
   A non-'classic' theme carries a suggested accent that is applied ONLY while
   the merchant is still on the default accent — a chosen accent from the
   settings singleton always wins (applyAccent runs after applyTheme).
   ========================================================================= */

/* The exact classic (default) neutral palette — mirrors the :root block so
   applyTheme('classic') is a no-op. Non-accent props only; accent stays with
   applyAccent(). */
var THEMES = {
  classic: {
    label: 'Classique',
    vars: {
      '--ink': '#0f172a', '--ink-soft': '#475569', '--ink-mute': '#94a3b8',
      '--line': '#e5e7eb', '--bg': '#f6f7f9', '--card': '#ffffff',
      '--ok': '#16a34a', '--ok-bg': '#dcfce7',
      '--warn': '#b45309', '--warn-bg': '#fef3c7',
      '--danger': '#dc2626', '--danger-bg': '#fee2e2',
      '--info': '#1d4ed8', '--info-bg': '#dbeafe',
      '--shadow': '0 1px 2px rgba(15,23,42,.06),0 8px 24px rgba(15,23,42,.06)',
      '--shadow-lg': '0 12px 40px rgba(15,23,42,.16)',
      '--r': '14px', '--r-sm': '10px'
    }
  },
  dark: {
    label: 'Sombre',
    accent: '#22d3ee',
    themeColor: '#0b1220',
    vars: {
      '--ink': '#e5e7eb', '--ink-soft': '#94a3b8', '--ink-mute': '#64748b',
      '--line': '#1f2937', '--bg': '#0b1220', '--card': '#111827',
      '--ok': '#4ade80', '--ok-bg': '#052e16',
      '--warn': '#fbbf24', '--warn-bg': '#3a2c07',
      '--danger': '#f87171', '--danger-bg': '#3b0d0d',
      '--info': '#60a5fa', '--info-bg': '#0b2447',
      '--shadow': '0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.45)',
      '--shadow-lg': '0 12px 40px rgba(0,0,0,.6)',
      '--r': '14px', '--r-sm': '10px'
    }
  },
  vibrant: {
    label: 'Vibrant',
    accent: '#db2777',
    themeColor: '#fff7fb',
    vars: {
      '--ink': '#1a1030', '--ink-soft': '#5b4a72', '--ink-mute': '#9d8cb3',
      '--line': '#f0d9e8', '--bg': '#fff7fb', '--card': '#ffffff',
      '--ok': '#16a34a', '--ok-bg': '#dcfce7',
      '--warn': '#b45309', '--warn-bg': '#fef3c7',
      '--danger': '#dc2626', '--danger-bg': '#fee2e2',
      '--info': '#7c3aed', '--info-bg': '#ede9fe',
      '--shadow': '0 2px 6px rgba(219,39,119,.10),0 12px 30px rgba(124,58,237,.12)',
      '--shadow-lg': '0 18px 50px rgba(219,39,119,.24)',
      '--r': '20px', '--r-sm': '14px'
    }
  },
  minimal: {
    label: 'Minimal',
    accent: '#111827',
    themeColor: '#ffffff',
    vars: {
      '--ink': '#111827', '--ink-soft': '#4b5563', '--ink-mute': '#9ca3af',
      '--line': '#ececec', '--bg': '#ffffff', '--card': '#ffffff',
      '--ok': '#15803d', '--ok-bg': '#eef7f0',
      '--warn': '#92400e', '--warn-bg': '#fbf3e6',
      '--danger': '#b91c1c', '--danger-bg': '#fbeaea',
      '--info': '#1f2937', '--info-bg': '#eef0f2',
      '--shadow': '0 1px 2px rgba(17,24,39,.04)',
      '--shadow-lg': '0 8px 24px rgba(17,24,39,.10)',
      '--r': '6px', '--r-sm': '4px'
    }
  }
};

/* Curated font stacks. 'system' === the :root default (no webfont fetched). The
   others map to a Google Fonts family + a <link>; the stack still falls back to
   the system fonts so text renders instantly before the webfont loads. */
var SYSTEM_FONT_STACK = "'Segoe UI',system-ui,-apple-system,'Helvetica Neue',Arial,'Noto Sans Arabic',sans-serif";
var FONTS = {
  system: { label: 'Système', stack: SYSTEM_FONT_STACK, google: '' },
  inter: {
    label: 'Inter',
    stack: "'Inter'," + SYSTEM_FONT_STACK,
    google: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap'
  },
  poppins: {
    label: 'Poppins',
    stack: "'Poppins'," + SYSTEM_FONT_STACK,
    google: 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800;900&display=swap'
  },
  playfair: {
    label: 'Élégant (Playfair)',
    stack: "'Playfair Display',Georgia,'Times New Roman',serif",
    google: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700;800;900&display=swap'
  }
};

/* Layout ids (branched in the view functions). 'standard' === today. */
var LAYOUTS = {
  standard: { label: 'Standard' },
  boutique: { label: 'Boutique' }
};

function themeId() {
  var t = store.settings && store.settings.theme;
  return (t && THEMES[t]) ? t : 'classic';
}
function fontId() {
  var f = store.settings && store.settings.font;
  return (f && FONTS[f]) ? f : 'system';
}
function layoutId() {
  var l = store.settings && store.settings.template;
  return (l && LAYOUTS[l]) ? l : 'standard';
}
/* True while the merchant is still on the compile-time default accent, i.e. has
   not chosen a custom accent — lets a theme apply its own suggested accent. */
function accentIsDefault() {
  var a = String((store.settings && store.settings.accent) || '').toLowerCase();
  return !a || a === String('__CLICKDZ_ACCENT__').toLowerCase();
}

/* Write the chosen theme preset's custom props onto :root. Accent is applied
   here ONLY as a theme suggestion when the merchant hasn't picked one; the real
   accent pipeline (applyAccent) runs afterwards and wins for a chosen accent. */
function applyTheme() {
  var preset = THEMES[themeId()] || THEMES.classic;
  var root = document.documentElement.style;
  var vars = preset.vars || {};
  for (var k in vars) { if (Object.prototype.hasOwnProperty.call(vars, k)) root.setProperty(k, vars[k]); }
  if (preset.accent && accentIsDefault()) {
    var a = preset.accent;
    root.setProperty('--accent', a);
    root.setProperty('--accent-d', shade(a, -0.22));
    root.setProperty('--accent-l', tint(a));
    if (store.settings) store.settings.accent = a; /* so applyAccent keeps it */
  }
  applyFont();
}

/* Set --font and inject the Google Fonts <link> for the chosen family. 'system'
   keeps the default stack and loads nothing. */
function applyFont() {
  var f = FONTS[fontId()] || FONTS.system;
  document.documentElement.style.setProperty('--font', f.stack);
  var linkId = 'cdz-font-link';
  var existing = document.getElementById(linkId);
  if (f.google) {
    if (!existing) {
      var pre1 = document.createElement('link'); pre1.rel = 'preconnect'; pre1.href = 'https://fonts.googleapis.com';
      var pre2 = document.createElement('link'); pre2.rel = 'preconnect'; pre2.href = 'https://fonts.gstatic.com'; pre2.crossOrigin = 'anonymous';
      var link = document.createElement('link'); link.id = linkId; link.rel = 'stylesheet'; link.href = f.google;
      document.head.appendChild(pre1); document.head.appendChild(pre2); document.head.appendChild(link);
    } else if (existing.getAttribute('href') !== f.google) {
      existing.setAttribute('href', f.google);
    }
  } else if (existing && existing.parentNode) {
    existing.parentNode.removeChild(existing);
  }
}

/* Apply the whole appearance layer (theme → font → accent). accent LAST so a
   merchant-chosen accent always wins over a theme's suggestion. */
function applyAppearance() {
  applyTheme();
  applyAccent();
}

/* =========================================================================
   Toasts
   ========================================================================= */
function toast(msg, kind) {
  var wrap = document.getElementById('toasts');
  if (!wrap) return;
  var el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  var ic = kind === 'ok' ? '✅' : kind === 'err' ? '⚠️' : 'ℹ️';
  el.innerHTML = '<span class="ic">' + ic + '</span><span>' + esc(msg) + '</span>';
  wrap.appendChild(el);
  setTimeout(function () {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0'; el.style.transform = 'translateY(10px)';
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
  }, 2800);
}

/* =========================================================================
   Cart operations
   ========================================================================= */
function addToCart(id, qty) {
  var p = findProduct(id);
  if (!p) return;
  if ((Number(p.stock) || 0) <= 0) { toast('Produit en rupture de stock', 'err'); return; }
  qty = Math.max(1, Number(qty) || 1);
  var line = null;
  for (var i = 0; i < store.cart.length; i++) if (String(store.cart[i].id) === String(id)) line = store.cart[i];
  var max = Number(p.stock) || 0;
  if (line) { line.qty = Math.min(max, line.qty + qty); }
  else { store.cart.push({ id: String(id), qty: Math.min(max, qty) }); }
  saveCart();
  toast(p.title + ' ajouté au panier', 'ok');
}
function setCartQty(id, qty) {
  qty = Number(qty) || 0;
  for (var i = 0; i < store.cart.length; i++) {
    if (String(store.cart[i].id) === String(id)) {
      var p = findProduct(id); var max = p ? (Number(p.stock) || 0) : qty;
      if (qty <= 0) { store.cart.splice(i, 1); }
      else { store.cart[i].qty = Math.min(max, qty); }
      break;
    }
  }
  saveCart();
}
function removeFromCart(id) {
  store.cart = store.cart.filter(function (l) { return String(l.id) !== String(id); });
  saveCart();
}
function clearCart() { store.cart = []; saveCart(); }

/* =========================================================================
   Router
   ========================================================================= */
function parseHash() {
  var h = (location.hash || '#/').replace(/^#/, '');
  if (!h || h === '/') return { name: 'home' };
  var parts = h.split('/').filter(Boolean);
  if (parts[0] === 'product' && parts[1]) return { name: 'product', id: decodeURIComponent(parts[1]) };
  if (parts[0] === 'cart') return { name: 'cart' };
  if (parts[0] === 'checkout') return { name: 'checkout' };
  if (parts[0] === 'success') return { name: 'success', ref: parts[1] ? decodeURIComponent(parts[1]) : '' };
  if (parts[0] === 'admin') return { name: 'admin', tab: parts[1] || 'orders' };
  return { name: 'home' };
}
function go(path) { location.hash = path; }

var lastSuccess = null;

function render() {
  var app = document.getElementById('app');
  if (!app) return;
  var route = parseHash();
  window.scrollTo(0, 0);

  if (store.loading) {
    app.innerHTML = layoutSkeleton();
    return;
  }

  var body;
  switch (route.name) {
    case 'product': body = viewProduct(route.id); break;
    case 'cart': body = viewCart(); break;
    case 'checkout': body = viewCheckout(); break;
    case 'success': body = viewSuccess(route.ref); break;
    case 'admin': return renderAdmin(route.tab); /* admin owns full shell */
    default: body = viewHome();
  }
  app.innerHTML = topbar() + '<main>' + body + '</main>' + footer();
  bindStorefront(route);
}

/* =========================================================================
   Shared chrome
   ========================================================================= */
function topbar() {
  var n = cartCount();
  return '' +
    '<header class="topbar"><div class="wrap"><div class="topbar-inner">' +
      '<a class="brand" href="#/">' +
        '<span class="logo">🛍️</span>' +
        '<span>' + esc(shopName()) + '<small>Boutique en ligne · COD</small></span>' +
      '</a>' +
      '<div class="top-actions">' +
        '<a class="icon-btn" href="#/cart" aria-label="Panier" title="Panier">🛒' +
          '<span class="cart-count" data-cart-count ' + (n === 0 ? 'hidden' : '') + '>' + n + '</span>' +
        '</a>' +
      '</div>' +
    '</div></div></header>';
}

function footer() {
  var s = store.settings || defaultSettings();
  var wa = digitsOnly(s.whatsapp);
  return '' +
    '<footer><div class="wrap"><div class="f-inner">' +
      '<div class="f-brand">🛍️ ' + esc(s.shopName) + ' <span class="ar">متجر</span></div>' +
      '<div class="f-cod">💵 Paiement à la livraison · الدفع عند الاستلام · Livraison 58 wilayas</div>' +
      '<div class="f-links">' +
        '<a href="#/">Accueil</a>' +
        '<a href="#/cart">Panier</a>' +
        (wa ? '<a href="https://wa.me/' + wa + '" target="_blank" rel="noopener noreferrer">WhatsApp</a>' : '') +
        '<a href="#/admin">Espace gérant</a>' +
      '</div>' +
      '<div class="f-made">Boutique propulsée par <a href="https://clickdz.ai" target="_blank" rel="noopener noreferrer">ClickDz</a></div>' +
    '</div></div></footer>';
}

function layoutSkeleton() {
  var cards = '';
  for (var i = 0; i < 8; i++) {
    cards += '<div class="sk-card"><div class="sk-thumb sk"></div><div class="sk-b">' +
      '<div class="sk-line sk" style="width:90%"></div>' +
      '<div class="sk-line sk" style="width:55%"></div>' +
      '<div class="sk-line sk" style="width:40%;height:20px"></div>' +
    '</div></div>';
  }
  return topbar() + '<main><div class="wrap">' +
    '<div class="section-head"><h2>Nos produits</h2></div>' +
    '<div class="grid">' + cards + '</div></div></main>';
}

function digitsOnly(s) { return String(s || '').replace(/[^0-9]/g, ''); }

/* =========================================================================
   Storefront — Home
   ========================================================================= */
var currentCat = '';

function viewHome() {
  if (layoutId() === 'boutique') return viewHomeBoutique();
  var s = store.settings || defaultSettings();
  var wa = digitsOnly(s.whatsapp);
  var errBanner = store.error ? '<div class="wrap"><div class="callout" style="margin-top:16px"><span class="ic">⚠️</span><div>Certaines données n\'ont pas pu être chargées. Réessayez plus tard.</div></div></div>' : '';

  var hero = '' +
    '<section class="hero"><div class="wrap"><div class="hero-inner">' +
      '<span class="cod-pill">💵 Paiement à la livraison</span>' +
      '<h1>' + esc(s.shopName) + '</h1>' +
      '<p>' + esc(s.tagline) + '</p>' +
      '<div class="cta-row">' +
        '<a class="btn light lg" href="#products">Découvrir les produits</a>' +
        (wa ? '<a class="btn ghost lg" href="https://wa.me/' + wa + '" target="_blank" rel="noopener noreferrer">💬 Nous contacter</a>' : '') +
      '</div>' +
    '</div></div></section>';

  var trust = '' +
    '<div class="trust"><div class="wrap"><div class="trust-inner">' +
      '<span class="trust-item"><span class="ic">💵</span> Paiement à la livraison</span>' +
      '<span class="trust-item"><span class="ic">🚚</span> Livraison 58 wilayas</span>' +
      '<span class="trust-item"><span class="ic">🔄</span> Retour facile</span>' +
      '<span class="trust-item"><span class="ic">📞</span> Support WhatsApp</span>' +
      '<span class="trust-item"><span class="ic">✅</span> Produits garantis</span>' +
    '</div></div></div>';

  var prods = activeProducts();
  var cats = categories();
  var chips = '<button class="chip ' + (currentCat === '' ? 'active' : '') + '" data-cat="">Tous</button>';
  cats.forEach(function (c) {
    chips += '<button class="chip ' + (currentCat === c ? 'active' : '') + '" data-cat="' + attr(c) + '">' + esc(c) + '</button>';
  });

  var shown = currentCat ? prods.filter(function (p) { return (p.category || '') === currentCat; }) : prods;

  var gridHtml;
  if (!prods.length) {
    gridHtml = emptyState('📦', 'Aucun produit pour le moment', 'Revenez bientôt — le catalogue arrive !', wa ? '<a class="btn soft" href="https://wa.me/' + wa + '" target="_blank" rel="noopener noreferrer">💬 Nous contacter</a>' : '');
  } else if (!shown.length) {
    gridHtml = emptyState('🔍', 'Aucun produit dans cette catégorie', 'Essayez une autre catégorie.', '<button class="btn ghost" data-cat="">Voir tout</button>');
  } else {
    gridHtml = '<div class="grid">' + shown.map(productCard).join('') + '</div>';
  }

  return errBanner + hero + trust +
    '<div class="wrap" id="products">' +
      '<div class="section-head"><h2>Nos produits</h2><span class="muted">' + shown.length + ' article' + (shown.length > 1 ? 's' : '') + '</span></div>' +
      (cats.length ? '<div class="chips">' + chips + '</div>' : '') +
      gridHtml +
    '</div>';
}

function productCard(p) {
  var out = (Number(p.stock) || 0) <= 0;
  return '' +
    '<div class="card">' +
      '<a class="thumb" href="#/product/' + encodeURIComponent(p.id) + '" aria-label="' + attr(p.title) + '">' +
        thumbHtml(p) + stockBadge(p) +
        (p.category ? '<span class="badge cat">' + esc(p.category) + '</span>' : '') +
      '</a>' +
      '<div class="body">' +
        '<a href="#/product/' + encodeURIComponent(p.id) + '" class="title">' + esc(p.title) + '</a>' +
        priceHtml(p.price) +
        (out
          ? '<button class="btn ghost sm add" disabled>Rupture de stock</button>'
          : '<button class="btn primary sm add" data-add="' + attr(p.id) + '">🛒 Ajouter</button>') +
      '</div>' +
    '</div>';
}

/* ---- Boutique layout home (settings.template='boutique') ----
   Same data + the same delegated events (data-add / data-cat) as the standard
   home, but an editorial hero, a featured product spotlight and a roomier grid.
   Reuses productCard so cart/stock behavior is identical. */
function viewHomeBoutique() {
  var s = store.settings || defaultSettings();
  var wa = digitsOnly(s.whatsapp);
  var errBanner = store.error ? '<div class="wrap"><div class="callout" style="margin-top:16px"><span class="ic">⚠️</span><div>Certaines données n\'ont pas pu être chargées. Réessayez plus tard.</div></div></div>' : '';

  var hero = '' +
    '<section class="hero-boutique"><div class="wrap"><div class="hb-inner">' +
      '<span class="hb-kicker">✦ ' + esc(s.shopName) + '</span>' +
      '<h1>' + esc(s.shopName) + '</h1>' +
      '<p>' + esc(s.tagline) + '</p>' +
      '<div class="cta-row">' +
        '<a class="btn light lg" href="#products">Explorer la collection</a>' +
        (wa ? '<a class="btn ghost lg" href="https://wa.me/' + wa + '" target="_blank" rel="noopener noreferrer">💬 Nous contacter</a>' : '') +
      '</div>' +
      '<span class="cod-pill" style="background:rgba(255,255,255,.16);border-color:rgba(255,255,255,.3)">💵 Paiement à la livraison · 58 wilayas</span>' +
    '</div></div></section>';

  var prods = activeProducts();
  var cats = categories();
  var chips = '<button class="chip ' + (currentCat === '' ? 'active' : '') + '" data-cat="">Tous</button>';
  cats.forEach(function (c) {
    chips += '<button class="chip ' + (currentCat === c ? 'active' : '') + '" data-cat="' + attr(c) + '">' + esc(c) + '</button>';
  });

  var shown = currentCat ? prods.filter(function (p) { return (p.category || '') === currentCat; }) : prods;

  /* featured spotlight = first shown product (only when browsing "Tous") */
  var featured = '';
  if (!currentCat && shown.length) {
    var fp = shown[0];
    var fout = (Number(fp.stock) || 0) <= 0;
    var media = fp.imageUrl
      ? '<img loading="lazy" src="' + attr(fp.imageUrl) + '" alt="' + attr(fp.title) + '" onerror="this.style.display=\'none\'" />'
      : '<div class="fb-ph">🛍️</div>';
    featured = '<div class="feature-boutique">' +
      '<a class="fb-hero" href="#/product/' + encodeURIComponent(fp.id) + '" aria-label="' + attr(fp.title) + '">' +
        media +
        '<div class="fb-cap"><div class="t">' + esc(fp.title) + '</div><div class="p">' + money(fp.price) + ' DZD</div></div>' +
      '</a>' +
      '<div class="fb-side">' +
        '<div class="section-head" style="margin:0"><h2>À la une</h2></div>' +
        (fp.description ? '<p style="color:var(--ink-soft);font-size:14.5px;margin:0">' + esc(String(fp.description).slice(0, 180)) + '</p>' : '') +
        (fout
          ? '<button class="btn ghost lg block" disabled>Rupture de stock</button>'
          : '<button class="btn primary lg block" data-add="' + attr(fp.id) + '">🛒 Ajouter au panier</button>') +
        '<a class="btn ghost block" href="#/product/' + encodeURIComponent(fp.id) + '">Voir le produit →</a>' +
      '</div>' +
    '</div>';
  }

  var restProducts = (!currentCat && shown.length) ? shown.slice(1) : shown;

  var gridHtml;
  if (!prods.length) {
    gridHtml = emptyState('📦', 'Aucun produit pour le moment', 'Revenez bientôt — le catalogue arrive !', wa ? '<a class="btn soft" href="https://wa.me/' + wa + '" target="_blank" rel="noopener noreferrer">💬 Nous contacter</a>' : '');
  } else if (!shown.length) {
    gridHtml = emptyState('🔍', 'Aucun produit dans cette catégorie', 'Essayez une autre catégorie.', '<button class="btn ghost" data-cat="">Voir tout</button>');
  } else if (!restProducts.length) {
    gridHtml = '';
  } else {
    gridHtml = '<div class="grid-boutique">' + restProducts.map(productCard).join('') + '</div>';
  }

  return errBanner + hero +
    '<div class="wrap" id="products">' +
      '<div class="section-head"><h2>Nos produits</h2><span class="muted">' + shown.length + ' article' + (shown.length > 1 ? 's' : '') + '</span></div>' +
      (cats.length ? '<div class="chips">' + chips + '</div>' : '') +
      featured +
      (featured && gridHtml ? '<div class="section-head" style="margin:22px 0 14px"><h2>Toute la collection</h2></div>' : '') +
      gridHtml +
    '</div>';
}

function emptyState(ic, title, sub, action) {
  return '<div class="empty"><div class="ic">' + ic + '</div><h3>' + esc(title) + '</h3><p>' + esc(sub) + '</p>' + (action || '') + '</div>';
}

/* =========================================================================
   Storefront — Product detail
   ========================================================================= */
function viewProduct(id) {
  var p = findProduct(id);
  if (!p || p.active === false) {
    return '<div class="wrap">' + emptyState('🔍', 'Produit introuvable', 'Ce produit n\'est plus disponible.', '<a class="btn primary" href="#/">← Retour à la boutique</a>') + '</div>';
  }
  var out = (Number(p.stock) || 0) <= 0;
  var s = store.settings || defaultSettings();
  return '<div class="wrap">' +
    '<a class="back-link" href="#/"><span class="arw">←</span> Retour</a>' +
    '<div class="pd">' +
      '<div class="gallery"><div class="main">' + thumbHtml(p) + '</div></div>' +
      '<div class="info">' +
        (p.category ? '<span class="tag confirmee" style="margin-bottom:10px">' + esc(p.category) + '</span>' : '') +
        '<h1>' + esc(p.title) + '</h1>' +
        '<div class="price">' + money(p.price) + ' <span class="cur">DZD</span></div>' +
        stockLine(p) +
        (p.description ? '<div class="desc">' + esc(p.description) + '</div>' : '') +
        (out
          ? '<button class="btn ghost lg block" disabled>Rupture de stock</button>'
          : '<div class="qtyrow"><div class="qty">' +
              '<button data-q="-" aria-label="Diminuer">−</button>' +
              '<input id="pd-qty" type="number" value="1" min="1" max="' + (Number(p.stock) || 1) + '" inputmode="numeric" />' +
              '<button data-q="+" aria-label="Augmenter">+</button>' +
            '</div></div>' +
            '<button class="btn primary lg block" id="pd-add" data-add="' + attr(p.id) + '">🛒 Ajouter au panier</button>') +
        '<div class="meta-list">' +
          '<div class="row"><span class="ic">💵</span> Paiement à la livraison (COD)</div>' +
          '<div class="row"><span class="ic">🚚</span> Livraison dans les 58 wilayas · frais ' + money(s.deliveryFee) + ' DZD</div>' +
          '<div class="row"><span class="ic">🔄</span> Retour possible à la réception</div>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>';
}
function stockLine(p) {
  var st = Number(p.stock) || 0;
  if (st <= 0) return '<p style="color:var(--danger);font-weight:700;margin:4px 0 8px">● Rupture de stock</p>';
  if (st <= (Number(p.reorderAt) || 5)) return '<p style="color:var(--warn);font-weight:700;margin:4px 0 8px">● Plus que ' + st + ' en stock — commandez vite !</p>';
  return '<p style="color:var(--ok);font-weight:700;margin:4px 0 8px">● En stock</p>';
}

/* =========================================================================
   Storefront — Cart
   ========================================================================= */
function viewCart() {
  if (!store.cart.length) {
    return '<div class="wrap">' +
      '<div class="section-head"><h2>Mon panier</h2></div>' +
      emptyState('🛒', 'Votre panier est vide', 'Parcourez nos produits et ajoutez vos articles.', '<a class="btn primary" href="#/">Voir les produits</a>') +
    '</div>';
  }
  var s = store.settings || defaultSettings();
  var rows = store.cart.map(function (l) {
    var p = findProduct(l.id);
    if (!p) return '';
    var sub = (Number(p.price) || 0) * l.qty;
    return '<div class="cart-item">' +
      '<a class="ci-thumb" href="#/product/' + encodeURIComponent(p.id) + '">' + thumbHtml(p) + '</a>' +
      '<div class="ci-main">' +
        '<a class="ci-title" href="#/product/' + encodeURIComponent(p.id) + '">' + esc(p.title) + '</a>' +
        '<div class="ci-price">' + money(p.price) + ' DZD × ' + l.qty + '</div>' +
        '<div class="miniqty" style="margin-top:8px">' +
          '<button data-mq="-" data-id="' + attr(p.id) + '">−</button>' +
          '<span>' + l.qty + '</span>' +
          '<button data-mq="+" data-id="' + attr(p.id) + '">+</button>' +
        '</div>' +
      '</div>' +
      '<div class="ci-right">' +
        '<div class="ci-sub">' + money(sub) + ' DZD</div>' +
        '<button class="link-x" data-rm="' + attr(p.id) + '">✕ Retirer</button>' +
      '</div>' +
    '</div>';
  }).join('');

  var subtotal = cartSubtotal();
  var fee = Number(s.deliveryFee) || 0;
  var total = subtotal + fee;

  return '<div class="wrap">' +
    '<a class="back-link" href="#/"><span class="arw">←</span> Continuer mes achats</a>' +
    '<div class="section-head"><h2>Mon panier</h2><span class="muted">' + cartCount() + ' article' + (cartCount() > 1 ? 's' : '') + '</span></div>' +
    '<div class="panel">' + rows + '</div>' +
    '<div class="panel" style="margin-top:14px"><div class="summary">' +
      '<div class="line"><span>Sous-total</span><span>' + money(subtotal) + ' DZD</span></div>' +
      '<div class="line"><span>Livraison</span><span>' + money(fee) + ' DZD</span></div>' +
      '<div class="line total"><span>Total</span><span>' + money(total) + ' <span class="cur">DZD</span></span></div>' +
    '</div></div>' +
    '<div class="callout"><span class="ic">💵</span><div>Paiement à la livraison : vous payez ' + money(total) + ' DZD en espèces à la réception de votre commande.</div></div>' +
    '<button class="btn primary lg block" style="margin-top:16px" onclick="location.hash=\'#/checkout\'">Passer la commande →</button>' +
  '</div>';
}

/* =========================================================================
   Storefront — Checkout
   ========================================================================= */
function viewCheckout() {
  if (!store.cart.length) {
    return '<div class="wrap">' + emptyState('🛒', 'Votre panier est vide', 'Ajoutez des produits avant de commander.', '<a class="btn primary" href="#/">Voir les produits</a>') + '</div>';
  }
  var s = store.settings || defaultSettings();
  var subtotal = cartSubtotal();
  var fee = Number(s.deliveryFee) || 0;
  var total = subtotal + fee;
  var wilOpts = '<option value="">— Sélectionnez votre wilaya —</option>' +
    WILAYAS.map(function (w) { return '<option value="' + attr(w) + '">' + esc(w) + '</option>'; }).join('');

  var itemsRows = store.cart.map(function (l) {
    var p = findProduct(l.id); if (!p) return '';
    return '<div class="line"><span>' + esc(p.title) + ' × ' + l.qty + '</span><span>' + money((Number(p.price) || 0) * l.qty) + ' DZD</span></div>';
  }).join('');

  return '<div class="wrap">' +
    '<a class="back-link" href="#/cart"><span class="arw">←</span> Retour au panier</a>' +
    '<div class="section-head"><h2>Finaliser la commande</h2></div>' +
    '<div class="pd" style="grid-template-columns:1fr">' +
      '<div class="grid2" style="align-items:start">' +
        '<form class="panel" id="checkout-form" style="padding:18px" novalidate>' +
          '<div class="form">' +
            '<div class="field"><label for="f-nom">Nom complet <span class="req">*</span></label>' +
              '<input class="control" id="f-nom" name="nom" placeholder="Ex : Ahmed Benali" autocomplete="name" required />' +
              '<div class="err-msg" data-err="nom" hidden></div></div>' +
            '<div class="field"><label for="f-tel">Téléphone <span class="req">*</span></label>' +
              '<input class="control" id="f-tel" name="tel" type="tel" inputmode="numeric" placeholder="0555 12 34 56" autocomplete="tel" required />' +
              '<div class="hint">Format algérien : 05, 06 ou 07 suivi de 8 chiffres</div>' +
              '<div class="err-msg" data-err="tel" hidden></div></div>' +
            '<div class="field"><label for="f-wilaya">Wilaya <span class="req">*</span></label>' +
              '<select class="control" id="f-wilaya" name="wilaya" required>' + wilOpts + '</select>' +
              '<div class="err-msg" data-err="wilaya" hidden></div></div>' +
            '<div class="field"><label for="f-commune">Commune <span class="req">*</span></label>' +
              '<input class="control" id="f-commune" name="commune" placeholder="Ex : Bab El Oued" required />' +
              '<div class="err-msg" data-err="commune" hidden></div></div>' +
            '<div class="field"><label for="f-adresse">Adresse de livraison <span class="req">*</span></label>' +
              '<textarea class="control" id="f-adresse" name="adresse" placeholder="Rue, quartier, point de repère…" required></textarea>' +
              '<div class="err-msg" data-err="adresse" hidden></div></div>' +
            '<div class="field"><label for="f-note">Note (optionnel)</label>' +
              '<textarea class="control" id="f-note" name="note" placeholder="Instructions pour le livreur, préférences…"></textarea></div>' +
          '</div>' +
        '</form>' +
        '<div>' +
          '<div class="panel"><div class="sheet-head" style="position:static"><h3>Récapitulatif</h3></div>' +
            '<div class="summary">' + itemsRows +
              '<div class="line" style="border-top:1px dashed var(--line);padding-top:10px"><span>Sous-total</span><span>' + money(subtotal) + ' DZD</span></div>' +
              '<div class="line"><span>Livraison</span><span>' + money(fee) + ' DZD</span></div>' +
              '<div class="line total"><span>Total à payer</span><span>' + money(total) + ' <span class="cur">DZD</span></span></div>' +
            '</div>' +
          '</div>' +
          '<div class="callout" style="margin-top:12px"><span class="ic">💵</span><div><strong>Paiement à la livraison.</strong> Aucun paiement en ligne. Vous réglez en espèces à la réception.</div></div>' +
          '<button class="btn primary lg block" style="margin-top:14px" id="place-order" type="button">✅ Confirmer la commande (' + money(total) + ' DZD)</button>' +
          '<p style="text-align:center;color:var(--ink-mute);font-size:12.5px;margin-top:10px">En confirmant, vous serez redirigé pour envoyer votre commande via WhatsApp.</p>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function validatePhone(v) {
  var d = digitsOnly(v);
  return /^0(5|6|7)[0-9]{8}$/.test(d);
}

function placeOrder() {
  var form = document.getElementById('checkout-form');
  if (!form) return;
  var data = {
    nom: form.nom.value.trim(),
    tel: form.tel.value.trim(),
    wilaya: form.wilaya.value,
    commune: form.commune.value.trim(),
    adresse: form.adresse.value.trim(),
    note: form.note.value.trim()
  };
  /* validation */
  var errs = {};
  if (data.nom.length < 3) errs.nom = 'Veuillez saisir votre nom complet';
  if (!validatePhone(data.tel)) errs.tel = 'Numéro invalide (ex : 0555123456)';
  if (!data.wilaya) errs.wilaya = 'Veuillez choisir votre wilaya';
  if (data.commune.length < 2) errs.commune = 'Veuillez saisir votre commune';
  if (data.adresse.length < 5) errs.adresse = 'Veuillez saisir une adresse complète';

  ['nom', 'tel', 'wilaya', 'commune', 'adresse'].forEach(function (k) {
    var input = form[k];
    var errEl = form.querySelector('[data-err="' + k + '"]');
    if (errs[k]) {
      input.classList.add('err');
      if (errEl) { errEl.textContent = errs[k]; errEl.hidden = false; }
    } else {
      input.classList.remove('err');
      if (errEl) errEl.hidden = true;
    }
  });
  if (Object.keys(errs).length) {
    toast('Veuillez corriger les champs en rouge', 'err');
    var firstBad = form.querySelector('.control.err');
    if (firstBad) firstBad.focus();
    return;
  }

  var s = store.settings || defaultSettings();
  var items = store.cart.map(function (l) {
    var p = findProduct(l.id) || {};
    return { id: String(l.id), title: p.title || 'Produit', price: Number(p.price) || 0, qty: l.qty };
  });
  var subtotal = items.reduce(function (n, it) { return n + it.price * it.qty; }, 0);
  var fee = Number(s.deliveryFee) || 0;
  var total = subtotal + fee;
  var ref = orderRef();

  var order = {
    ref: ref,
    status: 'Nouvelle',
    customer: data.nom,
    phone: digitsOnly(data.tel),
    wilaya: data.wilaya,
    commune: data.commune,
    address: data.adresse,
    note: data.note,
    items: items,
    subtotal: subtotal,
    deliveryFee: fee,
    total: total
  };

  var btn = document.getElementById('place-order');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px"></span> Envoi…'; }

  api.create('orders', order)
    .then(function (created) {
      lastSuccess = Object.assign({}, order, created || {});
      /* decrement stock best-effort (replace product records) */
      decrementStock(items);
      clearCart();
      go('#/success/' + encodeURIComponent(ref));
    })
    .catch(function () {
      /* even if the API write fails, let the merchant get the order via WhatsApp */
      lastSuccess = order;
      clearCart();
      toast('Commande enregistrée — envoyez-la via WhatsApp', 'ok');
      go('#/success/' + encodeURIComponent(ref));
    });
}

/* best-effort stock decrement using replace (no PUT server-side) */
function decrementStock(items) {
  items.forEach(function (it) {
    var p = findProduct(it.id);
    if (!p || !p.id || String(p.id).indexOf('local-') === 0) return;
    var next = Math.max(0, (Number(p.stock) || 0) - it.qty);
    var body = cleanProduct(Object.assign({}, p, { stock: next }));
    api.replace('products', p.id, body).then(function (created) {
      p.stock = next; if (created && created.id) p.id = created.id;
    }).catch(function () {});
  });
}

/* =========================================================================
   Storefront — Success
   ========================================================================= */
function viewSuccess(ref) {
  var s = store.settings || defaultSettings();
  var o = lastSuccess;
  var wa = digitsOnly(s.whatsapp);
  var waText = buildWaText(o, s, ref);
  var waHref = wa ? 'https://wa.me/' + wa + '?text=' + encodeURIComponent(waText) : '';

  return '<div class="wrap"><div class="success">' +
    '<div class="check">✓</div>' +
    '<h1>Commande confirmée !</h1>' +
    '<p>Merci pour votre confiance. Votre commande a bien été enregistrée.</p>' +
    '<div class="ref-chip">' + esc(ref || (o && o.ref) || 'CMD') + '</div>' +
    (o ? '<p style="font-weight:700;color:var(--ink)">Total à payer à la livraison : ' + money(o.total) + ' DZD</p>' : '') +
    '<div class="callout" style="text-align:start;margin:18px 0"><span class="ic">💵</span><div>Un livreur vous contactera bientôt. Vous payez <strong>en espèces à la réception</strong> (paiement à la livraison).</div></div>' +
    (waHref
      ? '<a class="btn wa lg block" href="' + waHref + '" target="_blank" rel="noopener noreferrer">💬 Envoyer ma commande sur WhatsApp</a>' +
        '<p style="color:var(--ink-mute);font-size:12.5px;margin-top:10px">Confirmez votre commande auprès du vendeur en un tap.</p>'
      : '<p style="color:var(--ink-mute)">Le vendeur vous contactera pour confirmer.</p>') +
    '<a class="btn ghost block" style="margin-top:14px" href="#/">← Retour à la boutique</a>' +
  '</div></div>';
}

function buildWaText(o, s, ref) {
  var L = [];
  L.push('🛍️ *Nouvelle commande — ' + s.shopName + '*');
  L.push('Réf : ' + (ref || (o && o.ref) || ''));
  L.push('');
  if (o && o.items) {
    o.items.forEach(function (it) { L.push('• ' + it.title + ' × ' + it.qty + ' = ' + money(it.price * it.qty) + ' DZD'); });
    L.push('');
    L.push('Sous-total : ' + money(o.subtotal) + ' DZD');
    L.push('Livraison : ' + money(o.deliveryFee) + ' DZD');
    L.push('*Total : ' + money(o.total) + ' DZD*');
    L.push('');
    L.push('👤 ' + (o.customer || ''));
    L.push('📞 ' + (o.phone || ''));
    L.push('📍 ' + (o.wilaya || '') + ' — ' + (o.commune || ''));
    L.push('🏠 ' + (o.address || ''));
    if (o.note) L.push('📝 ' + o.note);
    L.push('');
  }
  L.push('💵 Paiement à la livraison');
  return L.join('\n');
}

/* =========================================================================
   Storefront event binding (delegated)
   ========================================================================= */
function bindStorefront(route) {
  var app = document.getElementById('app');
  if (!app) return;

  app.addEventListener('click', function (e) {
    var t = e.target.closest('[data-add]');
    if (t) {
      var id = t.getAttribute('data-add');
      var qty = 1;
      var qi = document.getElementById('pd-qty');
      if (qi && route.name === 'product') qty = Number(qi.value) || 1;
      addToCart(id, qty);
      if (route.name === 'product') { /* stay */ } else { render(); }
      return;
    }
    var cat = e.target.closest('[data-cat]');
    if (cat) { currentCat = cat.getAttribute('data-cat'); render(); return; }
    var mq = e.target.closest('[data-mq]');
    if (mq) {
      var mid = mq.getAttribute('data-id'); var dir = mq.getAttribute('data-mq');
      var line = null; for (var i = 0; i < store.cart.length; i++) if (String(store.cart[i].id) === String(mid)) line = store.cart[i];
      var cur = line ? line.qty : 0;
      setCartQty(mid, dir === '+' ? cur + 1 : cur - 1);
      render();
      return;
    }
    var rm = e.target.closest('[data-rm]');
    if (rm) { removeFromCart(rm.getAttribute('data-rm')); render(); return; }
    var q = e.target.closest('[data-q]');
    if (q) {
      var input = document.getElementById('pd-qty');
      if (input) {
        var val = Number(input.value) || 1;
        var max = Number(input.max) || 999;
        val = q.getAttribute('data-q') === '+' ? Math.min(max, val + 1) : Math.max(1, val - 1);
        input.value = val;
      }
      return;
    }
    var po = e.target.closest('#place-order');
    if (po) { placeOrder(); return; }
  });
}

/* =========================================================================
   ADMIN
   ========================================================================= */
function isAuthed() {
  try { return sessionStorage.getItem(ADMIN_KEY) === '1'; } catch (e) { return false; }
}
function setAuthed(v) {
  try { if (v) sessionStorage.setItem(ADMIN_KEY, '1'); else sessionStorage.removeItem(ADMIN_KEY); } catch (e) {}
}

function renderAdmin(tab) {
  var app = document.getElementById('app');
  var s = store.settings || defaultSettings();

  if (!isAuthed()) {
    app.innerHTML = topbar() + '<main><div class="wrap"><div class="gate">' +
      '<div class="ic">🔒</div>' +
      '<h2>Espace gérant</h2>' +
      '<p>Entrez le code PIN pour gérer votre boutique.</p>' +
      '<div class="field" style="text-align:start"><input class="control" id="pin-input" type="password" inputmode="numeric" placeholder="Code PIN" autocomplete="off" /></div>' +
      '<button class="btn primary block" style="margin-top:12px" id="pin-go">Déverrouiller</button>' +
      '<a class="back-link" href="#/" style="margin-top:16px"><span class="arw">←</span> Retour à la boutique</a>' +
    '</div></div></main>';
    var input = document.getElementById('pin-input');
    var tryPin = function () {
      if (input.value === String(s.adminPin || '__CLICKDZ_PIN__')) {
        setAuthed(true);
        toast('Bienvenue dans votre espace gérant', 'ok');
        if (!store.ordersLoaded) { refreshOrders().then(function () { renderAdmin('orders'); }); } else { renderAdmin('orders'); }
      } else { input.classList.add('err'); toast('Code PIN incorrect', 'err'); input.select(); }
    };
    document.getElementById('pin-go').addEventListener('click', tryPin);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') tryPin(); });
    input.focus();
    return;
  }

  /* ensure orders loaded */
  if (!store.ordersLoaded && tab === 'orders') {
    app.innerHTML = adminShell(tab, '<div class="center-load"><div class="spinner"></div><span>Chargement des commandes…</span></div>');
    refreshOrders().then(function () { renderAdmin('orders'); }).catch(function () { store.ordersLoaded = true; renderAdmin('orders'); });
    return;
  }

  var body;
  if (tab === 'products') body = adminProducts();
  else if (tab === 'settings') body = adminSettings();
  else body = adminOrders();

  app.innerHTML = adminShell(tab, body);
  bindAdmin(tab);
}

function adminShell(tab, body) {
  var s = store.settings || defaultSettings();
  return '' +
    '<header class="topbar"><div class="wrap"><div class="topbar-inner">' +
      '<a class="brand" href="#/"><span class="logo">🛍️</span><span>' + esc(s.shopName) + '<small>Espace gérant</small></span></a>' +
      '<div class="top-actions">' +
        '<a class="btn ghost sm" href="#/">👁️ Voir la boutique</a>' +
        '<button class="btn ghost sm" id="admin-logout">Quitter</button>' +
      '</div>' +
    '</div></div></header>' +
    '<main><div class="wrap">' +
      '<div class="admin-nav">' +
        '<button class="' + (tab === 'orders' ? 'active' : '') + '" data-tab="orders">📦 Commandes</button>' +
        '<button class="' + (tab === 'products' ? 'active' : '') + '" data-tab="products">🏷️ Produits</button>' +
        '<button class="' + (tab === 'settings' ? 'active' : '') + '" data-tab="settings">⚙️ Réglages</button>' +
      '</div>' +
      body +
    '</div></main>';
}

/* ---- Admin: Orders board ---- */
function adminOrders() {
  var orders = store.orders.slice();
  var counts = {}; STATUSES.forEach(function (st) { counts[st] = 0; });
  var revenue = 0;
  orders.forEach(function (o) {
    counts[o.status] = (counts[o.status] || 0) + 1;
    if (o.status === 'Livrée') revenue += Number(o.total) || 0;
  });

  var stats = '<div class="stat-row">' +
    '<div class="stat"><div class="k">Commandes</div><div class="v">' + orders.length + '</div></div>' +
    '<div class="stat"><div class="k">Nouvelles</div><div class="v">' + (counts['Nouvelle'] || 0) + '</div></div>' +
    '<div class="stat"><div class="k">Livrées</div><div class="v">' + (counts['Livrée'] || 0) + '</div></div>' +
    '<div class="stat"><div class="k">CA livré</div><div class="v">' + money(revenue) + ' <span class="cur">DZD</span></div></div>' +
  '</div>';

  if (!orders.length) {
    return stats + emptyState('📭', 'Aucune commande pour l\'instant', 'Les commandes de vos clients apparaîtront ici en temps réel.', '<a class="btn soft" href="#/">Voir la boutique</a>');
  }

  var cards = orders.map(function (o) {
    var items = (o.items || []).map(function (it) {
      return '<div class="li"><span>' + esc(it.title) + ' × ' + it.qty + '</span><span>' + money((Number(it.price) || 0) * it.qty) + '</span></div>';
    }).join('');
    var next = NEXT_STATUS[o.status];
    var adv = '';
    if (next) adv += '<button class="btn primary sm" data-adv="' + attr(o.id) + '" data-to="' + attr(next) + '">→ ' + esc(next) + '</button>';
    if (o.status !== 'Livrée' && o.status !== 'Retournée') adv += '<button class="btn danger sm" data-adv="' + attr(o.id) + '" data-to="Retournée">↩ Retour</button>';
    var wa = digitsOnly(o.phone);
    var when = o.createdAt ? new Date(o.createdAt).toLocaleString('fr-DZ', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    return '<div class="order-card">' +
      '<div class="oc-head">' +
        '<div><div class="oc-ref">' + esc(o.ref || o.id) + '</div>' +
          '<div class="oc-meta">' + esc(o.customer || '') + ' · ' + esc(o.wilaya || '') + (when ? ' · ' + esc(when) : '') + '</div></div>' +
        '<span class="tag ' + (STATUS_CLASS[o.status] || 'nouvelle') + '">' + esc(o.status || 'Nouvelle') + '</span>' +
      '</div>' +
      '<div class="oc-items">' + items + '</div>' +
      '<div class="oc-meta">📞 ' + esc(o.phone || '') + ' · 📍 ' + esc(o.commune || '') + ' — ' + esc(o.address || '') + (o.note ? ' · 📝 ' + esc(o.note) : '') + '</div>' +
      '<div class="oc-foot">' +
        '<span class="oc-total">' + money(o.total) + ' DZD <span style="font-weight:600;color:var(--ink-mute);font-size:12px">· COD</span></span>' +
        '<div class="adv-row">' +
          (wa ? '<a class="btn ghost sm" href="https://wa.me/' + wa + '" target="_blank" rel="noopener noreferrer">💬</a>' : '') +
          adv +
          '<button class="pillbtn" data-del-order="' + attr(o.id) + '" title="Supprimer">🗑️</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  return stats +
    '<div class="section-head" style="margin-bottom:10px"><h2>Commandes</h2><span class="muted">Faites avancer chaque commande</span></div>' +
    '<div class="adm-list">' + cards + '</div>';
}

/* ---- Admin: Products CRUD ---- */
function adminProducts() {
  var prods = store.products.slice();
  var low = prods.filter(function (p) { return (Number(p.stock) || 0) <= (Number(p.reorderAt) || 5); }).length;
  var stats = '<div class="stat-row">' +
    '<div class="stat"><div class="k">Produits</div><div class="v">' + prods.length + '</div></div>' +
    '<div class="stat"><div class="k">Actifs</div><div class="v">' + prods.filter(function (p) { return p.active !== false; }).length + '</div></div>' +
    '<div class="stat"><div class="k">Stock bas</div><div class="v" style="color:' + (low ? 'var(--warn)' : 'var(--ink)') + '">' + low + '</div></div>' +
  '</div>';

  var list;
  if (!prods.length) {
    list = emptyState('🏷️', 'Aucun produit', 'Ajoutez votre premier produit pour lancer la boutique.', '<button class="btn primary" id="add-product">+ Nouveau produit</button>');
  } else {
    list = '<div class="adm-list">' + prods.map(function (p) {
      var on = p.active !== false;
      return '<div class="adm-item">' +
        '<div class="ai-thumb">' + thumbHtml(p) + '</div>' +
        '<div class="ai-main">' +
          '<div class="ai-title">' + esc(p.title) + '</div>' +
          '<div class="ai-sub">' +
            '<span>' + money(p.price) + ' DZD</span>' +
            '<span>Stock : ' + (Number(p.stock) || 0) + '</span>' +
            (p.category ? '<span>' + esc(p.category) + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="ai-actions">' +
          '<button class="pillbtn ' + (on ? 'on' : 'off') + '" data-toggle="' + attr(p.id) + '" title="' + (on ? 'Actif' : 'Masqué') + '">' + (on ? '👁️' : '🚫') + '</button>' +
          '<button class="pillbtn" data-edit="' + attr(p.id) + '" title="Modifier">✏️</button>' +
          '<button class="pillbtn" data-del-product="' + attr(p.id) + '" title="Supprimer">🗑️</button>' +
        '</div>' +
      '</div>';
    }).join('') + '</div>';
  }

  return stats +
    '<div class="section-head" style="margin-bottom:10px"><h2>Produits</h2><button class="btn primary sm" id="add-product">+ Nouveau</button></div>' +
    list;
}

function cleanProduct(p) {
  /* keep only storable fields; imageUrl only (no base64) to respect 8KB cap */
  var img = String(p.imageUrl || '');
  if (img.length > 1500) img = ''; /* guard against giant/data URLs */
  return {
    type: 'product',
    title: String(p.title || '').slice(0, 120),
    price: Math.max(0, Math.round(Number(p.price) || 0)),
    imageUrl: img,
    stock: Math.max(0, Math.round(Number(p.stock) || 0)),
    reorderAt: Math.max(0, Math.round(Number(p.reorderAt) || 0)),
    category: String(p.category || '').slice(0, 40),
    description: String(p.description || '').slice(0, 900),
    active: p.active !== false
  };
}

function openProductModal(id) {
  var editing = id ? findProduct(id) : null;
  var p = editing || { title: '', price: '', imageUrl: '', stock: '', reorderAt: 5, category: '', description: '', active: true };
  var html = '<div class="backdrop" id="modal-bd">' +
    '<div class="sheet" role="dialog" aria-modal="true">' +
      '<div class="sheet-head"><h3>' + (editing ? 'Modifier le produit' : 'Nouveau produit') + '</h3><button class="x-btn" data-close>✕</button></div>' +
      '<div class="sheet-body"><form class="form" id="product-form">' +
        '<div class="field"><label>Nom du produit <span class="req">*</span></label><input class="control" name="title" value="' + attr(p.title) + '" required maxlength="120" /></div>' +
        '<div class="grid2">' +
          '<div class="field"><label>Prix (DZD) <span class="req">*</span></label><input class="control" name="price" type="number" min="0" value="' + attr(p.price) + '" required inputmode="numeric" /></div>' +
          '<div class="field"><label>Catégorie</label><input class="control" name="category" value="' + attr(p.category) + '" placeholder="Ex : Mode" maxlength="40" /></div>' +
        '</div>' +
        '<div class="grid2">' +
          '<div class="field"><label>Stock</label><input class="control" name="stock" type="number" min="0" value="' + attr(p.stock) + '" inputmode="numeric" /></div>' +
          '<div class="field"><label>Seuil réappro</label><input class="control" name="reorderAt" type="number" min="0" value="' + attr(p.reorderAt) + '" inputmode="numeric" /></div>' +
        '</div>' +
        '<div class="field"><label>Image (URL)</label><input class="control" name="imageUrl" value="' + attr(p.imageUrl) + '" placeholder="https://…/photo.jpg" /><div class="hint">Collez le lien d\'une image (max ~1500 caractères).</div></div>' +
        '<div class="field"><label>Description</label><textarea class="control" name="description" maxlength="900" placeholder="Décrivez le produit…">' + esc(p.description) + '</textarea></div>' +
        '<label style="display:flex;align-items:center;gap:9px;font-weight:600;font-size:14px;cursor:pointer"><input type="checkbox" name="active" ' + (p.active !== false ? 'checked' : '') + ' style="width:18px;height:18px;accent-color:var(--accent)" /> Produit visible dans la boutique</label>' +
      '</form></div>' +
      '<div class="sheet-foot">' +
        '<button class="btn ghost" data-close style="flex:1">Annuler</button>' +
        '<button class="btn primary" id="save-product" style="flex:2">' + (editing ? 'Enregistrer' : 'Ajouter le produit') + '</button>' +
      '</div>' +
    '</div>' +
  '</div>';
  mountModal(html, function (root) {
    root.querySelector('#save-product').addEventListener('click', function () {
      var f = root.querySelector('#product-form');
      if (!f.title.value.trim()) { toast('Le nom est requis', 'err'); f.title.focus(); return; }
      var body = cleanProduct({
        title: f.title.value, price: f.price.value, imageUrl: f.imageUrl.value,
        stock: f.stock.value, reorderAt: f.reorderAt.value, category: f.category.value,
        description: f.description.value, active: f.active.checked
      });
      var btn = root.querySelector('#save-product');
      btn.disabled = true; btn.textContent = 'Enregistrement…';
      var op = editing ? api.replace('products', editing.id, body) : api.create('products', body);
      op.then(function () { return refreshProducts(); })
        .then(function () { closeModal(); toast(editing ? 'Produit mis à jour' : 'Produit ajouté', 'ok'); renderAdmin('products'); })
        .catch(function () { btn.disabled = false; btn.textContent = 'Réessayer'; toast('Échec de l\'enregistrement', 'err'); });
    });
  });
}

/* ---- Admin: Settings ---- */
function selectOptions(table, current) {
  var out = '';
  for (var id in table) {
    if (!Object.prototype.hasOwnProperty.call(table, id)) continue;
    var sel = String(current) === id ? ' selected' : '';
    out += '<option value="' + attr(id) + '"' + sel + '>' + esc(table[id].label || id) + '</option>';
  }
  return out;
}

function adminSettings() {
  var s = store.settings || defaultSettings();
  var palette = ['#0f766e', '#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#16a34a', '#0891b2', '#4f46e5', '#111827'];
  var sw = palette.map(function (c) {
    return '<div class="swatch ' + (c.toLowerCase() === String(s.accent || '').toLowerCase() ? 'sel' : '') + '" data-color="' + c + '" style="background:' + c + '"></div>';
  }).join('');
  var curTheme = THEMES[s.theme] ? s.theme : 'classic';
  var curTemplate = LAYOUTS[s.template] ? s.template : 'standard';
  var curFont = FONTS[s.font] ? s.font : 'system';

  return '<div class="section-head" style="margin-bottom:10px"><h2>Réglages de la boutique</h2></div>' +
    '<form class="panel" id="settings-form" style="padding:20px"><div class="form">' +
      '<div class="field"><label>Nom de la boutique</label><input class="control" name="shopName" value="' + attr(s.shopName) + '" maxlength="60" /></div>' +
      '<div class="field"><label>Slogan</label><textarea class="control" name="tagline" maxlength="200">' + esc(s.tagline) + '</textarea></div>' +
      '<div class="grid2">' +
        '<div class="field"><label>Numéro WhatsApp</label><input class="control" name="whatsapp" value="' + attr(s.whatsapp) + '" placeholder="213600000000" inputmode="numeric" /><div class="hint">Format international sans +, ex : 213xxxxxxxxx</div></div>' +
        '<div class="field"><label>Frais de livraison (DZD)</label><input class="control" name="deliveryFee" type="number" min="0" value="' + attr(s.deliveryFee) + '" inputmode="numeric" /></div>' +
      '</div>' +
      '<div class="field"><label>Code PIN gérant</label><input class="control" name="adminPin" value="' + attr(s.adminPin) + '" maxlength="12" /><div class="hint">Sert à protéger cet espace. Notez-le bien.</div></div>' +
      '<div class="field"><label>Couleur d\'accentuation</label><div class="colorrow" id="swatches">' + sw + '</div>' +
        '<input type="hidden" name="accent" value="' + attr(s.accent) + '" /></div>' +
      '<div class="section-head" style="margin:8px 0 0"><h2 style="font-size:16px">Apparence</h2></div>' +
      '<div class="grid2">' +
        '<div class="field"><label>Thème</label><select class="control" name="theme">' + selectOptions(THEMES, curTheme) + '</select><div class="hint">Palette, ombres et coins.</div></div>' +
        '<div class="field"><label>Mise en page</label><select class="control" name="template">' + selectOptions(LAYOUTS, curTemplate) + '</select><div class="hint">Agencement de l\'accueil.</div></div>' +
      '</div>' +
      '<div class="field"><label>Police</label><select class="control" name="font">' + selectOptions(FONTS, curFont) + '</select><div class="hint">La police système ne charge aucune ressource externe.</div></div>' +
    '</div></form>' +
    '<button class="btn primary lg block" style="margin-top:14px" id="save-settings">💾 Enregistrer les réglages</button>' +
    '<div class="callout" style="margin-top:14px"><span class="ic">💡</span><div>Ces réglages pilotent votre vitrine : nom, couleurs, thème, mise en page, police, frais de livraison et bouton WhatsApp de commande.</div></div>';
}

/* ---- Admin binding ---- */
function bindAdmin(tab) {
  var app = document.getElementById('app');

  var logout = document.getElementById('admin-logout');
  if (logout) logout.addEventListener('click', function () { setAuthed(false); toast('Déconnecté', 'ok'); go('#/'); });

  app.querySelectorAll('[data-tab]').forEach(function (b) {
    b.addEventListener('click', function () { renderAdmin(b.getAttribute('data-tab')); });
  });

  if (tab === 'orders') {
    app.querySelectorAll('[data-adv]').forEach(function (b) {
      b.addEventListener('click', function () { advanceOrder(b.getAttribute('data-adv'), b.getAttribute('data-to')); });
    });
    app.querySelectorAll('[data-del-order]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!confirm('Supprimer cette commande ?')) return;
        var id = b.getAttribute('data-del-order');
        api.remove('orders', id).then(function () {
          store.orders = store.orders.filter(function (o) { return String(o.id) !== String(id); });
          toast('Commande supprimée', 'ok'); renderAdmin('orders');
        }).catch(function () { toast('Échec de la suppression', 'err'); });
      });
    });
  }

  if (tab === 'products') {
    var add = document.getElementById('add-product');
    if (add) add.addEventListener('click', function () { openProductModal(null); });
    app.querySelectorAll('[data-edit]').forEach(function (b) {
      b.addEventListener('click', function () { openProductModal(b.getAttribute('data-edit')); });
    });
    app.querySelectorAll('[data-toggle]').forEach(function (b) {
      b.addEventListener('click', function () { toggleProduct(b.getAttribute('data-toggle')); });
    });
    app.querySelectorAll('[data-del-product]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!confirm('Supprimer ce produit ?')) return;
        var id = b.getAttribute('data-del-product');
        api.remove('products', id).then(function () { return refreshProducts(); })
          .then(function () { toast('Produit supprimé', 'ok'); renderAdmin('products'); })
          .catch(function () { toast('Échec de la suppression', 'err'); });
      });
    });
  }

  if (tab === 'settings') {
    app.querySelectorAll('#swatches .swatch').forEach(function (sw) {
      sw.addEventListener('click', function () {
        var c = sw.getAttribute('data-color');
        app.querySelectorAll('#swatches .swatch').forEach(function (x) { x.classList.remove('sel'); });
        sw.classList.add('sel');
        var hid = app.querySelector('#settings-form [name=accent]');
        if (hid) hid.value = c;
        if (store.settings) store.settings.accent = c;
        document.documentElement.style.setProperty('--accent', c);
        document.documentElement.style.setProperty('--accent-d', shade(c, -0.22));
        document.documentElement.style.setProperty('--accent-l', tint(c));
      });
    });
    /* live theme preview (accent re-applied after so a chosen accent still wins) */
    var themeSel = app.querySelector('#settings-form [name=theme]');
    if (themeSel) themeSel.addEventListener('change', function () {
      if (!THEMES[themeSel.value]) return;
      if (store.settings) store.settings.theme = themeSel.value;
      applyTheme(); applyAccent();
      var hid = app.querySelector('#settings-form [name=accent]');
      if (hid && store.settings) hid.value = store.settings.accent;
    });
    /* live font preview */
    var fontSel = app.querySelector('#settings-form [name=font]');
    if (fontSel) fontSel.addEventListener('change', function () {
      if (!FONTS[fontSel.value]) return;
      if (store.settings) store.settings.font = fontSel.value;
      applyFont();
    });
    var save = document.getElementById('save-settings');
    if (save) save.addEventListener('click', saveSettings);
  }
}

function advanceOrder(id, to) {
  var o = null;
  for (var i = 0; i < store.orders.length; i++) if (String(store.orders[i].id) === String(id)) o = store.orders[i];
  if (!o) return;
  var body = {
    type: 'order', ref: o.ref, status: to, customer: o.customer, phone: o.phone,
    wilaya: o.wilaya, commune: o.commune, address: o.address, note: o.note,
    items: o.items, subtotal: o.subtotal, deliveryFee: o.deliveryFee, total: o.total
  };
  var prev = o.status;
  o.status = to; renderAdmin('orders'); /* optimistic */
  api.replace('orders', id, body).then(function (created) {
    if (created && created.id) o.id = created.id;
    toast('Commande → ' + to, 'ok');
  }).catch(function () { o.status = prev; toast('Échec — statut restauré', 'err'); renderAdmin('orders'); });
}

function toggleProduct(id) {
  var p = findProduct(id);
  if (!p) return;
  var body = cleanProduct(Object.assign({}, p, { active: !(p.active !== false) }));
  api.replace('products', id, body).then(function () { return refreshProducts(); })
    .then(function () { toast('Visibilité mise à jour', 'ok'); renderAdmin('products'); })
    .catch(function () { toast('Échec', 'err'); });
}

function saveSettings() {
  var f = document.getElementById('settings-form');
  if (!f) return;
  var cur = store.settings || defaultSettings();
  /* appearance ids: read the picker when present, else preserve the current id.
     Guarded against unknown ids so a stray value can never poison :root. */
  var theme = (f.theme && THEMES[f.theme.value]) ? f.theme.value : (THEMES[cur.theme] ? cur.theme : 'classic');
  var template = (f.template && LAYOUTS[f.template.value]) ? f.template.value : (LAYOUTS[cur.template] ? cur.template : 'standard');
  var font = (f.font && FONTS[f.font.value]) ? f.font.value : (FONTS[cur.font] ? cur.font : 'system');
  var body = {
    key: 'settings',
    shopName: String(f.shopName.value || '').slice(0, 60) || '__CLICKDZ_STORE_NAME__',
    tagline: String(f.tagline.value || '').slice(0, 200),
    whatsapp: digitsOnly(f.whatsapp.value),
    deliveryFee: Math.max(0, Math.round(Number(f.deliveryFee.value) || 0)),
    adminPin: String(f.adminPin.value || '__CLICKDZ_PIN__').slice(0, 12) || '__CLICKDZ_PIN__',
    accent: f.accent.value || '__CLICKDZ_ACCENT__',
    currency: 'DZD',
    theme: theme,
    template: template,
    font: font
  };
  var btn = document.getElementById('save-settings');
  btn.disabled = true; btn.textContent = 'Enregistrement…';
  api.replace('settings', store.settingsId, body)
    .then(function (created) {
      store.settingsId = created && created.id ? created.id : store.settingsId;
      store.settings = Object.assign(defaultSettings(), body);
      applyAppearance();
      toast('Réglages enregistrés', 'ok');
      renderAdmin('settings');
    })
    .catch(function () { btn.disabled = false; btn.textContent = 'Réessayer'; toast('Échec de l\'enregistrement', 'err'); });
}

/* =========================================================================
   Modal helpers
   ========================================================================= */
function mountModal(html, onReady) {
  var host = document.createElement('div');
  host.id = 'modal-host';
  host.innerHTML = html;
  document.body.appendChild(host);
  var bd = host.querySelector('#modal-bd');
  bd.addEventListener('click', function (e) { if (e.target === bd || e.target.closest('[data-close]')) closeModal(); });
  document.addEventListener('keydown', escClose);
  if (onReady) onReady(host);
}
function escClose(e) { if (e.key === 'Escape') closeModal(); }
function closeModal() {
  var host = document.getElementById('modal-host');
  if (host && host.parentNode) host.parentNode.removeChild(host);
  document.removeEventListener('keydown', escClose);
}

/* =========================================================================
   Boot
   ========================================================================= */
window.addEventListener('hashchange', render);
bootstrap().then(function () {
  render();
  updateCartCount();
});
render(); /* initial skeleton */

</script>
</body>
</html>
`;
