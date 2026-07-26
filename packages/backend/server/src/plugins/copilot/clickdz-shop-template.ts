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
// WS4 (TEMPLATE CATALOG) — eight MORE optional tokens let a picked vertical
// preset ship its appearance ids, copy, seed pack and reading direction. As
// with C5, every default is the EXACT string that was hardcoded here before, so
// a mint with NO templateId substitutes the same bytes → byte-identical output:
//   __CLICKDZ_THEME__        → THEMES id   (default "classic")
//   __CLICKDZ_FONT__         → FONTS id    (default "system")
//   __CLICKDZ_LAYOUT__       → LAYOUTS id  (default "standard")
//   __CLICKDZ_TAGLINE__      → hero/settings tagline (default the FR line below)
//   __CLICKDZ_HERO__         → hero headline override (default "" → uses shopName)
//   __CLICKDZ_RTL__          → <html dir> value: "ltr" [default] | "rtl"
//   __CLICKDZ_CATEGORIES__   → reserved category hint CSV (default "" → derived)
//   __CLICKDZ_SEED__         → first-run seed products JSON array (default the
//                              six demoProducts() below, verbatim). MUST be a
//                              double-quoted JSON string with no backtick, no
//                              apostrophe and no dollar-brace template sequence,
//                              so it survives String.raw + JSON.parse.
// The theme/font/layout tokens seed defaultSettings() (still runtime-validated
// against THEMES/FONTS/LAYOUTS); rtl seeds settings.rtl and the initial <html>
// dir; seed feeds demoProducts(); tagline/hero feed the hero copy.
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
//   settings.template → LAYOUTS id     ('standard' [default] | 'boutique' | 'grid-dense' | 'editorial-split')
//   settings.font     → FONTS id       ('system'  [default] | 'inter' | 'poppins' | 'playfair')
// At runtime applyTheme(settings) writes the chosen preset's CSS custom props
// onto :root (mirroring applyAccent, which still runs AFTER so settings.accent
// overrides the preset accent). 'classic' writes the SAME values already present
// in the static :root block (a visual no-op); 'standard' branches emit markup
// identical to today; 'system' keeps the current --font stack and loads no font
// <link>. The Shop Appearance editor (SHOP-UX) and the ERP settings allowlist
// (BRIDGE-BE normalizeErpSettings / POST /erp/settings) validate these ids.
//
// WSF-3 — Section gating + feature flags (data-driven runtime, like onlinePay).
// settings.sections is a canonical CSV over the four home bands
// ('hero','trust','categories','featured'); sectionOn(id) hides a band whose id
// is absent from the CSV. The default is ABSENT → every band shown (byte-
// identical to today). settings.features is the generic capability CSV read by
// featureOn(id) (default OFF/absent, mirroring onlinePayEnabled) — the seam
// Wave-B feature builders hang self-contained render fns on.
// WS4-6 — settings.rtl (bool) flips the document direction at runtime via
// applyDir(); absent/false keeps the compile-time __CLICKDZ_RTL__ dir (default
// "ltr"). The CSS already uses logical props (inset-inline / margin-inline) so
// the layout mirrors correctly with no per-rule work.
//
// String.raw is used so any backslashes in the HTML/CSS/JS survive verbatim;
// the inner content is authored to contain no backtick or ${ sequences, so no
// escaping is required inside the literal.

export const CLICKDZ_SHOP_TEMPLATE_HTML: string = String.raw`<!doctype html>
<html lang="fr" dir="__CLICKDZ_RTL__">
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

  /* ---------- layout: grid-dense (settings.template='grid-dense') ----------
     A compact product-forward home: a slim editorial header band (no full-bleed
     hero gradient) + a tighter, denser product grid. Reuses .card / productCard;
     only used when opted in, so standard/boutique are untouched. */
  .header-dense{background:var(--card);border-bottom:1px solid var(--line)}
  .header-dense .hd-inner{display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;padding:22px 0 20px}
  .header-dense .hd-text{min-width:0}
  .header-dense h1{font-size:clamp(22px,4.4vw,30px);font-weight:900;letter-spacing:-.03em}
  .header-dense p{margin:4px 0 0;color:var(--ink-soft);font-size:14.5px;max-width:560px}
  .header-dense .cod-pill{margin:0;background:var(--accent-l);border-color:transparent;color:var(--accent-d)}
  .header-dense .hd-actions{margin-inline-start:auto;display:flex;gap:8px;flex-wrap:wrap}
  .grid-dense{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
  @media(min-width:560px){.grid-dense{grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:14px}}
  @media(min-width:980px){.grid-dense{grid-template-columns:repeat(auto-fill,minmax(190px,1fr))}}
  .grid-dense .card .body{padding:10px 11px 12px;gap:5px}
  .grid-dense .card .title{font-size:14px;min-height:2.2em}
  .grid-dense .card .price{font-size:17px}

  /* ---------- layout: editorial-split (settings.template='editorial-split') --
     An asymmetric split hero (copy on one side, a large product/lifestyle image
     on the other) over a standard product grid. Reuses productCard; opt-in only. */
  .hero-split{background:linear-gradient(180deg,var(--card),var(--bg))}
  .hero-split .hs-inner{display:grid;gap:20px;padding:40px 0 30px;align-items:center}
  @media(min-width:820px){.hero-split .hs-inner{grid-template-columns:1.05fr .95fr;gap:40px;padding:56px 0 44px}}
  .hero-split .hs-copy{display:flex;flex-direction:column;gap:14px;align-items:flex-start;text-align:start;min-width:0}
  .hero-split .hs-copy .cod-pill{margin:0;background:var(--accent-l);border-color:transparent;color:var(--accent-d)}
  .hero-split .hs-copy h1{font-size:clamp(28px,5.4vw,48px);font-weight:900;letter-spacing:-.035em;line-height:1.04;color:var(--ink)}
  .hero-split .hs-copy p{margin:0;color:var(--ink-soft);font-size:clamp(15px,2.2vw,18px);max-width:500px}
  .hero-split .hs-copy .cta-row{display:flex;gap:10px;flex-wrap:wrap;margin-top:4px}
  .hero-split .hs-media{position:relative;border-radius:calc(var(--r) + 6px);overflow:hidden;min-height:240px;background:var(--card);border:1px solid var(--line);box-shadow:var(--shadow)}
  .hero-split .hs-media img{width:100%;height:100%;object-fit:cover;position:absolute;inset:0}
  .hero-split .hs-media .hs-ph{position:absolute;inset:0;display:grid;place-items:center;font-size:72px;color:var(--ink-mute);background:linear-gradient(135deg,#eef1f4,#e2e7ec)}
  .hero-split .hs-media .hs-cap{position:absolute;inset-inline:0;bottom:0;padding:16px 18px;background:linear-gradient(0deg,rgba(0,0,0,.6),transparent);color:#fff}
  .hero-split .hs-media .hs-cap .t{font-weight:800;font-size:17px}
  .hero-split .hs-media .hs-cap .p{font-weight:900;font-size:15px;margin-top:2px}

  /* ---------- WSF-4 features: wishlist / reviews / promo / variants ---------- */
  .wish-btn{border:1px solid var(--line);background:#fff;border-radius:999px;width:38px;height:38px;display:inline-grid;place-items:center;font-size:17px;line-height:1;cursor:pointer;transition:.15s;padding:0}
  .wish-btn:hover{border-color:var(--danger);background:var(--danger-bg)}
  .wish-btn.on{border-color:var(--danger);background:var(--danger-bg)}
  .card .wish-btn.card-heart{position:absolute;inset-block-start:10px;inset-inline-end:10px;width:34px;height:34px;font-size:15px;box-shadow:var(--shadow);z-index:2}
  .card{position:relative}
  .pd-wish{display:flex;align-items:center;gap:10px;margin-top:12px;color:var(--ink-soft);font-size:14px;font-weight:600}
  .pd-wish .wish-btn.lg{width:44px;height:44px;font-size:19px}
  .rev-mini{display:flex;align-items:center;gap:6px;margin-top:2px}
  .rev-mini .rev-n{font-size:12.5px;color:var(--ink-soft);font-weight:600}
  .stars{display:inline-flex;gap:1px;font-size:14px;line-height:1;color:#f59e0b}
  .stars .es{color:var(--ink-mute)}
  .reviews{margin:34px 0 6px;border-top:1px solid var(--line);padding-top:24px}
  .reviews .rev-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:16px}
  .reviews .rev-head h2{font-size:21px;font-weight:800;letter-spacing:-.02em}
  .rev-head-score{display:flex;align-items:center;gap:8px;font-size:15px}
  .rev-head-score .stars{font-size:17px}
  .rev-head-score strong{font-size:18px;font-weight:900;color:var(--ink)}
  .rev-list{display:flex;flex-direction:column;gap:12px;margin-bottom:20px}
  .rev-item{background:var(--card);border:1px solid var(--line);border-radius:var(--r-sm);padding:13px 15px;box-shadow:var(--shadow)}
  .rev-item-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px}
  .rev-name{font-weight:700;font-size:14px;color:var(--ink)}
  .rev-body{font-size:14px;color:var(--ink-soft);white-space:pre-wrap}
  .rev-form{padding:16px;display:flex;flex-direction:column;gap:14px}
  .rev-form-head{font-weight:800;font-size:16px;color:var(--ink)}
  .rev-picker{display:inline-flex;gap:4px}
  .rev-star{border:0;background:none;font-size:26px;line-height:1;color:var(--ink-mute);cursor:pointer;padding:0}
  .rev-star.on{color:#f59e0b}
  .promo-box{margin-top:14px;border-top:1px dashed var(--line);padding-top:14px}
  .promo-box label{display:block;font-weight:600;font-size:14px;color:var(--ink);margin-bottom:6px}
  .promo-row{display:flex;gap:8px}
  .promo-row .control{flex:1}
  .promo-row .btn{flex:0 0 auto}
  .promo-ok{color:var(--ok);font-size:13px;font-weight:700;margin-top:8px}
  .summary .line.promo-line{color:var(--ok);font-weight:700}
  .variants{display:flex;flex-direction:column;gap:14px;margin:18px 0}
  .vgroup{display:flex;flex-direction:column;gap:8px}
  .vlabel{font-weight:700;font-size:14px;color:var(--ink)}
  .vopts{display:flex;flex-wrap:wrap;gap:8px}
  .vopt{border:1px solid var(--line);background:#fff;color:var(--ink);border-radius:var(--r-sm);padding:9px 15px;font-size:14px;font-weight:600;cursor:pointer;transition:.15s}
  .vopt:hover{border-color:var(--accent)}
  .vopt.sel{background:var(--accent);border-color:var(--accent);color:#fff}
  .ci-variant{color:var(--ink-mute);font-size:12.5px;margin-top:2px}


  /* ---------- WSF-5 (batch B): announcement bar ---------- */
  .cdz-ann{background:var(--accent-d);color:#fff}
  .cdz-ann-in{display:flex;align-items:center;gap:12px;padding:9px 16px;font-size:13.5px;font-weight:600}
  .cdz-ann-txt{flex:1;text-align:center}
  .cdz-ann-x{margin-inline-start:auto;background:rgba(255,255,255,.16);border:0;color:#fff;width:26px;height:26px;border-radius:8px;font-size:13px;line-height:1;flex:0 0 auto}
  .cdz-ann-x:hover{background:rgba(255,255,255,.28)}

  /* ---------- lang toggle ---------- */
  .icon-btn.cdz-lang{font-size:14px;font-weight:800;letter-spacing:.02em}

  /* ---------- instagram feed ---------- */
  .cdz-ig{margin-top:28px}
  .ig-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
  @media(min-width:560px){.ig-grid{grid-template-columns:repeat(6,1fr);gap:10px}}
  .ig-cell{position:relative;aspect-ratio:1/1;border-radius:var(--r-sm);overflow:hidden;background:var(--bg);display:block}
  .ig-cell img{width:100%;height:100%;object-fit:cover;transition:.2s}
  .ig-cell:hover img{transform:scale(1.06)}
  .ig-cell.ig-ph::after,.ig-follow{display:grid;place-items:center;color:var(--ink-mute);font-size:26px;width:100%;height:100%}
  .ig-follow{flex-direction:column;gap:4px;font-size:24px}
  .ig-follow span{font-size:12px;font-weight:700;color:var(--ink-soft)}

  /* ---------- bundles ---------- */
  .cdz-bundles{margin-top:28px}
  .bn-grid{display:grid;grid-template-columns:1fr;gap:14px}
  @media(min-width:560px){.bn-grid{grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}}
  .bn-card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);overflow:hidden;display:flex;flex-direction:column}
  .bn-thumbs{display:flex;gap:2px;background:var(--bg)}
  .bn-thumbs img,.bn-thumbs .bn-ph{flex:1;aspect-ratio:1/1;object-fit:cover;min-width:0}
  .bn-thumbs .bn-ph{display:grid;place-items:center;font-size:30px;color:var(--ink-mute)}
  .bn-body{padding:13px 14px 15px;display:flex;flex-direction:column;gap:7px;flex:1}
  .bn-title{font-weight:700;font-size:14.5px;color:var(--ink)}
  .bn-price{font-weight:900;font-size:18px;color:var(--accent-d)}
  .bn-price s{font-size:13px;font-weight:600;color:var(--ink-mute)}
  .bn-save{font-size:12px;font-weight:800;color:var(--ok);background:var(--ok-bg);padding:2px 7px;border-radius:999px}
  .bn-add{margin-top:auto}

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
/* WS4 catalog wiring — each default equals the value hardcoded before this seam,
   so a mint WITHOUT a templateId substitutes the same bytes (byte-identical). */
var TPL_RTL_DIR = '__CLICKDZ_RTL__';        // 'ltr' (default) | 'rtl'
var TPL_HERO_LINE = '__CLICKDZ_HERO__';     // '' (default) → hero uses the shop name
var TPL_SEED_JSON = '__CLICKDZ_SEED__';     // '' (default) → the six demoProducts below
var TPL_CATEGORIES = '__CLICKDZ_CATEGORIES__'; // '' (default) — reserved category hint CSV; categories() still derives from products

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
    tagline: '__CLICKDZ_TAGLINE__',
    whatsapp: '__CLICKDZ_WHATSAPP__',
    deliveryFee: 500,
    adminPin: '__CLICKDZ_PIN__',
    accent: '__CLICKDZ_ACCENT__',
    currency: 'DZD',
    theme: '__CLICKDZ_THEME__',
    template: '__CLICKDZ_LAYOUT__',
    font: '__CLICKDZ_FONT__',
    rtl: TPL_RTL_DIR === 'rtl'
  };
}

/* Six tasteful demo products seeded on first run — the byte-identical default.
   WS4-3 seed seam: when a picked vertical injects a seed via the TPL_SEED_JSON
   wiring var above (a double-quoted, apostrophe-free JSON array), those products
   seed instead. The default token value is '' → demoProducts() returns the exact
   six below, so a mint with no templateId is byte-identical and first-run seeds
   them unchanged. */
function demoProducts() {
  var hardcoded = [
    { title: 'Montre Élégance Classic', price: 4900, category: 'Accessoires', stock: 24, reorderAt: 5, active: true, imageUrl: 'https://images.unsplash.com/photo-1524592094714-0f0654e20314?w=600&q=70&auto=format&fit=crop', description: 'Montre à quartz, bracelet acier inoxydable, résistante à l\'eau. Un accessoire intemporel pour le quotidien.' },
    { title: 'Sac à Main Cuir Premium', price: 6500, category: 'Mode', stock: 12, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1584917865442-de89df76afd3?w=600&q=70&auto=format&fit=crop', description: 'Sac en cuir véritable, finitions soignées, plusieurs compartiments. Élégance et robustesse au rendez-vous.' },
    { title: 'Écouteurs Sans Fil Pro', price: 3200, category: 'Électronique', stock: 3, reorderAt: 6, active: true, imageUrl: 'https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=600&q=70&auto=format&fit=crop', description: 'Son immersif, réduction de bruit, autonomie 24h avec le boîtier. Compatibles tous smartphones.' },
    { title: 'Parfum Oud Intense 50ml', price: 5800, category: 'Beauté', stock: 18, reorderAt: 5, active: true, imageUrl: 'https://images.unsplash.com/photo-1541643600914-78b084683601?w=600&q=70&auto=format&fit=crop', description: 'Fragrance orientale boisée, tenue longue durée. Un sillage raffiné qui vous accompagne toute la journée.' },
    { title: 'Baskets Urban Confort', price: 4200, category: 'Mode', stock: 0, reorderAt: 4, active: true, imageUrl: 'https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?w=600&q=70&auto=format&fit=crop', description: 'Semelle amortissante, mesh respirant, style moderne. Idéales pour la ville comme pour le sport léger.' },
    { title: 'Lampe LED Design Bureau', price: 2400, category: 'Maison', stock: 30, reorderAt: 8, active: true, imageUrl: 'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?w=600&q=70&auto=format&fit=crop', description: 'Éclairage réglable 3 intensités, port USB intégré, bras articulé. Parfaite pour le travail et la lecture.' }
  ];
  var raw = TPL_SEED_JSON;
  /* Default '' (or any non-array): the six above, verbatim. */
  if (!raw || raw.charAt(0) !== '[') return hardcoded;
  try {
    var arr = JSON.parse(raw);
    if (arr && arr.length) {
      /* normalize each seed row to the fields the store/admin expect */
      return arr.map(function (p) {
        return {
          title: String((p && p.title) || ''),
          price: Number((p && p.price) || 0) || 0,
          category: String((p && p.category) || ''),
          stock: (p && p.stock != null) ? (Number(p.stock) || 0) : 20,
          reorderAt: (p && p.reorderAt != null) ? (Number(p.reorderAt) || 0) : 5,
          active: !(p && p.active === false),
          imageUrl: String((p && p.imageUrl) || ''),
          description: String((p && p.description) || '')
        };
      });
    }
  } catch (e) { /* malformed seed → fall through to the hardcoded six */ }
  return hardcoded;
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
    /* PR-6 prep (staged rollout): reads now send the SAME bearer the writes
       already send (headers(true)). Today the backend ignores it on reads;
       once CDZ_DATA_READ_GATE flips on server-side, sensitive collections
       (orders, customers, ...) will REQUIRE it — storefronts re-served with
       this template keep working through the flip with zero downtime. */
    var h = this.headers(true);
    h['Accept'] = 'application/json';
    return fetch(this.base(collection) + '?limit=500', { headers: h })
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
  reviews: [],
  promo: '',
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
    .then(function () { store.loading = false; applyAppearance(); loadReviews(); })
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

/* WSF-4 reviews — load the per-slug 'reviews' collection once, best-effort.
   Only fetched when the feature is enabled; failure is swallowed (the block
   degrades to 'no reviews yet'). Re-renders so aggregates/list appear. */
function loadReviews() {
  if (!featureOn('reviews')) return;
  if (store.reviewsLoaded) return;
  store.reviewsLoaded = true;
  api.list('reviews').then(function (rows) {
    store.reviews = Array.isArray(rows) ? rows : [];
    render();
  }).catch(function () { /* offline: keep whatever is in-memory */ });
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
/* Online-payment (Chargily) feature flag — merchant opt-in via the settings
   singleton. Strictly === true so any legacy/absent settings keep COD-only. */
function onlinePayEnabled(s) {
  s = s || store.settings || {};
  return s.onlinePay === true;
}
/* WSF-3 — csvHas(raw, id): membership test over a CSV string OR a string[]. */
function csvHas(raw, id) {
  var list = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(',');
  for (var i = 0; i < list.length; i++) { if (String(list[i]).trim() === id) return true; }
  return false;
}
/* WSF-3 — sectionOn(id): is a home band ('hero'|'trust'|'categories'|'featured')
   shown? settings.sections is a canonical CSV; ABSENT/undefined means "all bands
   on" (the byte-identical default — a shop that never touched appearance shows
   every band exactly like today). An explicit '' means all bands hidden. */
function sectionOn(id) {
  var s = store.settings || {};
  var raw = s.sections;
  if (raw === undefined || raw === null) return true;
  return csvHas(raw, id);
}
/* WSF-3 — featureOn(id): generic capability flag (mirrors onlinePayEnabled).
   settings.features is a CSV of enabled feature ids; ABSENT/empty = OFF, so
   every add-on is dormant by default and Wave-B builders gate their render fns
   on featureOn('<id>'). */
function featureOn(id) {
  var s = store.settings || {};
  return csvHas(s.features, id);
}


/* =========================================================================
   WSF-5 (Wave-B, batch B) — logistics / content / i18n features.
   Each is dormant unless featureOn('<id>') (settings.features CSV). All render
   fns are self-contained; zero effect when the flag is off. IDs/params are the
   canonical registry keys (clickdz-features.ts). No backtick / dollar-brace so
   the String.raw literal is unchanged.
   ========================================================================= */

/* ---- shared tiny helpers ---- */
/* clamp a stored scalar to a trimmed string (settings values are always
   strings/undefined in the singleton). */
function sVal(key) {
  var s = store.settings || {};
  return (s[key] == null) ? '' : String(s[key]);
}
/* localStorage get/set that never throws (private-mode safe), namespaced per slug. */
function lsGet(k) { try { return localStorage.getItem('clickdz.shop.' + k + '.' + SLUG); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem('clickdz.shop.' + k + '.' + SLUG, v); } catch (e) {} }

/* =========================================================================
   delivery-matrix — per-wilaya delivery fee.
   settings.deliveryMatrix = compact CSV 'w16:400,w31:600' (key = 'w' + the
   leading wilaya number). Fallback = settings.deliveryDefaultFee, then the
   existing flat settings.deliveryFee. Only active when featureOn('delivery-matrix').
   ========================================================================= */
/* the leading numeric code of a wilaya option value like '16 - Alger' → '16'. */
function wilCode(w) {
  var m = /^\s*0*([0-9]{1,2})/.exec(String(w || ''));
  return m ? m[1] : '';
}
/* parse the matrix CSV once into { '16': 400, '31': 600 }. Tolerates spaces and
   an optional leading 'w' on each code. */
function deliveryMatrix() {
  var out = {};
  var raw = sVal('deliveryMatrix');
  if (!raw) return out;
  raw.split(',').forEach(function (pair) {
    var kv = pair.split(':');
    if (kv.length < 2) return;
    var code = String(kv[0]).trim().replace(/^w/i, '').replace(/^0+/, '');
    var fee = Math.round(Number(kv[1]) || 0);
    if (code) out[code] = Math.max(0, fee);
  });
  return out;
}
/* the flat/default fee used when a wilaya has no matrix entry (or matrix off). */
function deliveryDefaultFee() {
  var s = store.settings || defaultSettings();
  var d = sVal('deliveryDefaultFee');
  if (d !== '' && !isNaN(Number(d))) return Math.max(0, Math.round(Number(d)));
  return Math.max(0, Math.round(Number(s.deliveryFee) || 0));
}
/* fee for a given wilaya option value. Matrix off → the flat fee (byte-identical
   behaviour). Matrix on → per-wilaya fee, else the default fallback. */
function deliveryFeeFor(wilaya) {
  if (!featureOn('delivery-matrix')) return Math.max(0, Math.round(Number((store.settings || defaultSettings()).deliveryFee) || 0));
  var code = wilCode(wilaya).replace(/^0+/, '');
  var mtx = deliveryMatrix();
  if (code && mtx[code] != null) return mtx[code];
  return deliveryDefaultFee();
}
/* the wilaya currently chosen in the live checkout form (empty until picked). */
function checkoutWilaya() {
  var el = document.getElementById('f-wilaya');
  return el ? el.value : '';
}
/* live-update the checkout recap + button labels when the wilaya changes. Locates
   the recap by DOM structure (no ids needed) so it never fights the base markup:
   at the checkout route only the checkout .summary is mounted. Total also nets
   any bundle discount so the two features compose. Safe no-op off the route. */
function recomputeCheckout() {
  if (!featureOn('delivery-matrix') && !featureOn('bundles')) return;
  var form = document.getElementById('checkout-form');
  if (!form) return;
  var subtotal = cartSubtotal();
  var disc = bundleDiscount();
  var fee = deliveryFeeFor(checkoutWilaya());
  var total = Math.max(0, subtotal - disc) + fee;
  var totalLine = document.querySelector('.summary .line.total span:last-child');
  if (totalLine) totalLine.innerHTML = money(total) + ' <span class="cur">DZD</span>';
  /* the fee line is the .line directly before .line.total in the recap */
  var totalRow = document.querySelector('.summary .line.total');
  if (totalRow && totalRow.previousElementSibling) {
    var feeSpan = totalRow.previousElementSibling.querySelector('span:last-child');
    if (feeSpan) feeSpan.textContent = money(fee) + ' DZD';
  }
  var placeBtn = document.getElementById('place-order');
  if (placeBtn) placeBtn.innerHTML = '✅ Confirmer la commande (' + money(total) + ' DZD)';
  var payBtn = document.getElementById('pay-online');
  if (payBtn) payBtn.innerHTML = '💳 Payer en ligne (' + money(total) + ' DZD)';
  var note = document.getElementById('cdz-ship-note');
  if (note) {
    var w = checkoutWilaya();
    note.innerHTML = w
      ? ('🚚 Frais de livraison pour ' + esc(w) + ' : <strong>' + money(fee) + ' DZD</strong>')
      : '🚚 Sélectionnez votre wilaya pour voir les frais de livraison.';
  }
}

/* =========================================================================
   announcement-bar — dismissible top strip. settings.announcementText (<=140).
   Dismissal persists in localStorage keyed by a short hash of the text, so a new
   message re-appears. RTL-safe (logical props + inherits document dir).
   ========================================================================= */
/* tiny stable hash of the announcement text (djb2) → dismissal key suffix. */
function annHash(t) {
  var h = 5381, str = String(t || '');
  for (var i = 0; i < str.length; i++) { h = ((h << 5) + h + str.charCodeAt(i)) | 0; }
  return String(h >>> 0);
}
function announcementBar() {
  if (!featureOn('announcement-bar')) return '';
  var txt = sVal('announcementText').slice(0, 140);
  if (!txt) return '';
  if (lsGet('ann') === annHash(txt)) return '';
  return '<div class="cdz-ann" id="cdz-ann"><div class="wrap cdz-ann-in">' +
      '<span class="cdz-ann-txt">' + esc(txt) + '</span>' +
      '<button class="cdz-ann-x" data-ann-dismiss type="button" aria-label="Fermer">✕</button>' +
    '</div></div>';
}

/* =========================================================================
   instagram-feed — a home grid. settings.instagramHandle (<=30, no @) +
   settings.instagramImages (CSV of up to 6 image URLs). No external API call —
   the grid just links to the public profile. Off → renders nothing.
   ========================================================================= */
function igHandle() { return sVal('instagramHandle').replace(/^@+/, '').trim().slice(0, 30); }
function igImages() {
  var raw = sVal('instagramImages');
  if (!raw) return [];
  return raw.split(',').map(function (u) { return String(u).trim(); }).filter(function (u) { return u; }).slice(0, 6);
}
function instagramSection() {
  if (!featureOn('instagram-feed')) return '';
  var handle = igHandle();
  if (!handle) return '';
  var url = 'https://instagram.com/' + encodeURIComponent(handle);
  var imgs = igImages();
  var cells = imgs.map(function (src) {
    return '<a class="ig-cell" href="' + attr(url) + '" target="_blank" rel="noopener noreferrer">' +
      '<img loading="lazy" src="' + attr(src) + '" alt="Instagram" onerror="this.style.display=\'none\';this.parentNode.classList.add(\'ig-ph\')" />' +
    '</a>';
  }).join('');
  if (!cells) {
    cells = '<a class="ig-cell ig-follow" href="' + attr(url) + '" target="_blank" rel="noopener noreferrer">📷<span>@' + esc(handle) + '</span></a>';
  }
  return '<section class="wrap cdz-ig" id="cdz-ig">' +
      '<div class="section-head"><h2>' + t('ig.title') + '</h2>' +
        '<a class="muted" href="' + attr(url) + '" target="_blank" rel="noopener noreferrer">@' + esc(handle) + ' →</a></div>' +
      '<div class="ig-grid">' + cells + '</div>' +
    '</section>';
}

/* =========================================================================
   bundles — 'pack' pseudo-products. settings.bundles = compact CSV
   'id1+id2=packPrice;id3+id4=packPrice'. A pack's discount applies at checkout
   whenever every member is in the cart (qty>=1), so "Ajouter le pack" simply adds
   the members. Off → no section, no discount, byte-identical checkout.
   ========================================================================= */
function parseBundles() {
  var raw = sVal('bundles');
  if (!raw) return [];
  return raw.split(';').map(function (chunk) {
    chunk = String(chunk).trim();
    if (!chunk) return null;
    var eq = chunk.split('=');
    if (eq.length < 2) return null;
    var ids = String(eq[0]).split('+').map(function (x) { return String(x).trim(); }).filter(function (x) { return x; });
    var price = Math.max(0, Math.round(Number(eq[1]) || 0));
    if (ids.length < 2 || !price) return null;
    return { ids: ids, price: price };
  }).filter(function (b) { return b; });
}
/* resolve a bundle's member products + list price (sum of member prices). */
function bundleInfo(b) {
  var items = [], listPrice = 0, ok = true;
  b.ids.forEach(function (id) {
    var p = findProduct(id);
    if (!p) { ok = false; return; }
    items.push(p);
    listPrice += Number(p.price) || 0;
  });
  return { items: items, listPrice: listPrice, price: b.price, ok: ok, saving: Math.max(0, listPrice - b.price) };
}
/* is every member of bundle b currently in the cart (qty>=1)? */
function bundleInCart(b) {
  for (var i = 0; i < b.ids.length; i++) {
    var found = false;
    for (var j = 0; j < store.cart.length; j++) { if (String(store.cart[j].id) === String(b.ids[i])) { found = true; break; } }
    if (!found) return false;
  }
  return true;
}
/* total discount from all packs whose members are all in the cart. Derived from
   cart membership — no separate persistence needed (v1). */
function bundleDiscount() {
  if (!featureOn('bundles')) return 0;
  var disc = 0;
  parseBundles().forEach(function (b) {
    var info = bundleInfo(b);
    if (info.ok && info.saving > 0 && bundleInCart(b)) disc += info.saving;
  });
  return disc;
}
/* the packs currently applied — for the order payload marker. */
function activeBundles() {
  if (!featureOn('bundles')) return [];
  var out = [];
  parseBundles().forEach(function (b) {
    var info = bundleInfo(b);
    if (info.ok && bundleInCart(b)) out.push({ ids: b.ids.join('+'), price: b.price, saving: info.saving });
  });
  return out;
}
/* add every member of a pack to the cart (the discount is then auto-detected). */
function addBundle(idx) {
  var list = parseBundles();
  var b = list[idx];
  if (!b) return;
  var info = bundleInfo(b);
  if (!info.ok) { toast('Pack indisponible', 'err'); return; }
  b.ids.forEach(function (id) { addToCart(id, 1); });
  toast('Pack ajouté au panier', 'ok');
}
function bundlesSection() {
  if (!featureOn('bundles')) return '';
  var list = parseBundles();
  if (!list.length) return '';
  var cards = '';
  list.forEach(function (b, i) {
    var info = bundleInfo(b);
    if (!info.ok || !info.items.length) return;
    var thumbs = info.items.map(function (p) {
      return p.imageUrl
        ? '<img loading="lazy" src="' + attr(p.imageUrl) + '" alt="' + attr(p.title) + '" onerror="this.style.display=\'none\'" />'
        : '<span class="bn-ph">🛍️</span>';
    }).join('');
    var names = info.items.map(function (p) { return esc(p.title); }).join(' + ');
    cards += '<div class="bn-card">' +
        '<div class="bn-thumbs">' + thumbs + '</div>' +
        '<div class="bn-body">' +
          '<div class="bn-title">' + names + '</div>' +
          '<div class="bn-price">' + money(b.price) + ' DZD' +
            (info.saving > 0 ? ' <s>' + money(info.listPrice) + '</s> <span class="bn-save">-' + money(info.saving) + '</span>' : '') +
          '</div>' +
          '<button class="btn primary sm bn-add" data-bundle="' + i + '" type="button">' + t('bundle.add') + '</button>' +
        '</div>' +
      '</div>';
  });
  if (!cards) return '';
  return '<section class="wrap cdz-bundles" id="cdz-bundles">' +
      '<div class="section-head"><h2>' + t('bundle.title') + '</h2><span class="muted">' + t('bundle.sub') + '</span></div>' +
      '<div class="bn-grid">' + cards + '</div>' +
    '</section>';
}

/* =========================================================================
   loyalty — client-side points (v1). settings.loyaltyRate = points per 100 DZD
   (canonical registry unit; default 1). Tally kept in localStorage keyed by phone.
   Shows an earned-points hint + info blurb at checkout; awards on a confirmed
   order. Off → nothing renders and no tally is kept.
   ========================================================================= */
function loyaltyRate() {
  var r = Number(sVal('loyaltyRate'));
  if (!r || isNaN(r)) r = 1;
  return Math.max(1, Math.min(100, Math.round(r)));
}
function loyaltyPointsFor(amount) {
  return Math.floor((Math.max(0, Number(amount) || 0) / 100) * loyaltyRate());
}
function loyaltyBalance(phone) {
  var d = digitsOnly(phone);
  if (!d) return 0;
  var v = Number(lsGet('loy.' + d));
  return (!v || isNaN(v)) ? 0 : v;
}
/* award points for a confirmed order, once per ref (idempotent via a stored set). */
function loyaltyAward(order) {
  if (!featureOn('loyalty') || !order) return;
  var ref = String(order.ref || '');
  var phone = digitsOnly(order.phone);
  if (!ref || !phone) return;
  var doneRaw = lsGet('loy.refs') || '';
  if (csvHas(doneRaw, ref)) return;
  var pts = loyaltyPointsFor(order.total);
  if (pts > 0) lsSet('loy.' + phone, String(loyaltyBalance(phone) + pts));
  lsSet('loy.refs', (doneRaw ? doneRaw + ',' : '') + ref);
}
/* the checkout hint block (earned points + how-to blurb). */
function loyaltyCheckoutHint(total) {
  if (!featureOn('loyalty')) return '';
  var pts = loyaltyPointsFor(total);
  return '<div class="callout cdz-loy" id="cdz-loy" style="margin-top:12px"><span class="ic">⭐</span>' +
      '<div><strong>' + t('loy.earn') + ' ' + pts + ' ' + t('loy.points') + '</strong>' +
      '<div style="font-size:12.5px;margin-top:2px;opacity:.85">' + t('loy.note') + '</div></div>' +
    '</div>';
}

/* =========================================================================
   order-tracking — a public "Suivi de commande" view (#/tracking). The customer
   enters their phone; we list matching orders with the 5 canonical status labels.
   Mirrors the admin order list read (api.list('orders')) — the per-slug Data API
   GET is public by the data model — then filters client-side by phone.
   ========================================================================= */
var trackState = { phone: '', results: null, loading: false, done: false };
function viewTracking() {
  var rows = '';
  if (trackState.loading) {
    rows = '<div class="center-load"><div class="spinner"></div><span>' + t('track.searching') + '</span></div>';
  } else if (trackState.done) {
    var list = trackState.results || [];
    if (!list.length) {
      rows = emptyState('🔍', t('track.none'), t('track.none.sub'), '');
    } else {
      rows = '<div class="adm-list">' + list.map(function (o) {
        var items = (o.items || []).map(function (it) {
          return '<div class="li"><span>' + esc(it.title) + ' × ' + it.qty + '</span><span>' + money((Number(it.price) || 0) * it.qty) + '</span></div>';
        }).join('');
        var when = o.createdAt ? new Date(o.createdAt).toLocaleString('fr-DZ', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
        return '<div class="order-card">' +
            '<div class="oc-head"><div><div class="oc-ref">' + esc(o.ref || o.id) + '</div>' +
              '<div class="oc-meta">' + (when ? esc(when) : '') + ' · ' + esc(o.wilaya || '') + '</div></div>' +
              '<span class="tag ' + (STATUS_CLASS[o.status] || 'nouvelle') + '">' + esc(o.status || 'Nouvelle') + '</span></div>' +
            '<div class="oc-items">' + items + '</div>' +
            '<div class="oc-foot"><span class="oc-total">' + money(o.total) + ' DZD</span></div>' +
          '</div>';
      }).join('') + '</div>';
    }
  }
  return '<div class="wrap">' +
      '<a class="back-link" href="#/"><span class="arw">←</span> ' + t('track.back') + '</a>' +
      '<div class="section-head"><h2>' + t('track.title') + '</h2></div>' +
      '<form class="panel" id="track-form" style="padding:18px" novalidate><div class="form">' +
        '<div class="field"><label for="track-phone">' + t('track.phone') + '</label>' +
          '<input class="control" id="track-phone" name="phone" type="tel" inputmode="numeric" placeholder="0555 12 34 56" value="' + attr(trackState.phone) + '" /></div>' +
        '<button class="btn primary block" id="track-go" type="submit">' + t('track.cta') + '</button>' +
      '</div></form>' +
      '<div style="margin-top:14px">' + rows + '</div>' +
    '</div>';
}
function trackLookup(phone) {
  var d = digitsOnly(phone);
  trackState.phone = phone; trackState.loading = true; trackState.done = false; trackState.results = null;
  render();
  if (!d || d.length < 6) { trackState.loading = false; trackState.done = true; trackState.results = []; render(); return; }
  api.list('orders').then(function (rows) {
    trackState.results = (rows || []).filter(function (o) { return digitsOnly(o.phone) === d; })
      .sort(function (a, b) { return (b.createdAt || 0) < (a.createdAt || 0) ? -1 : 1; });
    trackState.loading = false; trackState.done = true; render();
  }).catch(function () { trackState.loading = false; trackState.done = true; trackState.results = []; render(); });
}

/* =========================================================================
   lang-toggle — français <-> Algerian darja for the visible chrome. A compact
   dict (t) covers the top chrome strings this feature renders; a late-binding
   translateChrome() pass rewrites the remaining hardcoded French chrome in the
   DOM after each render when darja is active. Darja also flips the document dir
   (via the shared applyDir(), which treats lang 'ar' as RTL). Choice persists in
   localStorage. Off → t() returns French and translateChrome is a no-op.
   ========================================================================= */
/* the active storefront language: explicit localStorage choice wins, else the
   merchant default (settings.defaultLang), else 'fr'. */
function shopLang() {
  var ls = lsGet('lang');
  if (ls === 'fr' || ls === 'ar') return ls;
  var d = sVal('defaultLang').toLowerCase();
  return (d === 'ar' || d === 'ar-dz' || d === 'dz') ? 'ar' : 'fr';
}
function isDarja() { return featureOn('lang-toggle') && shopLang() === 'ar'; }
/* keyed strings used by THIS batch's own rendered chrome. */
var I18N = {
  fr: {
    'ig.title': 'Suivez-nous sur Instagram',
    'bundle.title': 'Packs & offres', 'bundle.sub': 'Économisez en achetant ensemble', 'bundle.add': '🛒 Ajouter le pack',
    'loy.earn': 'Gagnez', 'loy.points': 'points', 'loy.note': 'Cumulez des points à chaque commande et profitez de réductions.',
    'track.title': 'Suivi de commande', 'track.back': 'Retour à la boutique', 'track.phone': 'Votre numéro de téléphone',
    'track.cta': 'Rechercher mes commandes', 'track.searching': 'Recherche…', 'track.none': 'Aucune commande trouvée',
    'track.none.sub': 'Vérifiez le numéro saisi lors de la commande.', 'track.link': 'Suivi de commande'
  },
  ar: {
    'ig.title': 'تابعنا على انستغرام',
    'bundle.title': 'باكات و عروض', 'bundle.sub': 'اربح كي تشري مع بعض', 'bundle.add': '🛒 زيد الباك',
    'loy.earn': 'تربح', 'loy.points': 'نقاط', 'loy.note': 'اجمع نقاط في كل طلبية و استفد من تخفيضات.',
    'track.title': 'تتبع الطلبية', 'track.back': 'ارجع للمتجر', 'track.phone': 'رقم الهاتف تاعك',
    'track.cta': 'قلّب على طلبياتي', 'track.searching': 'قاعد نقلب…', 'track.none': 'ما لقينا حتى طلبية',
    'track.none.sub': 'تأكد من الرقم لي دخلتيه في الطلبية.', 'track.link': 'تتبع الطلبية'
  }
};
function t(key) {
  var lang = isDarja() ? 'ar' : 'fr';
  var d = I18N[lang] || I18N.fr;
  return (d[key] != null) ? d[key] : (I18N.fr[key] != null ? I18N.fr[key] : key);
}
/* the nav toggle button. Shows the language you'd switch TO. */
function langToggleBtn() {
  if (!featureOn('lang-toggle')) return '';
  var toAr = !isDarja();
  return '<button class="icon-btn cdz-lang" data-lang-toggle type="button" aria-label="Langue" title="FR / الدارجة">' +
      (toAr ? 'ع' : 'FR') +
    '</button>';
}
/* flip <html dir> for darja. Because Chisel's rtlOn() short-circuits on an
   explicit settings.rtl (defaultSettings always sets rtl:false), we set BOTH
   settings.lang and settings.rtl from the chosen language so applyDir() mirrors
   it (darja → rtl, français → ltr). Only runs when the toggle is enabled, so a
   shop without lang-toggle keeps Chisel's exact rtl behaviour untouched. */
function applyLang() {
  if (!featureOn('lang-toggle')) return;
  var ar = shopLang() === 'ar';
  if (store.settings) { store.settings.lang = shopLang(); store.settings.rtl = ar; }
  applyDir();
}
/* the chrome phrases we late-bind to darja. Ordered LONGEST FIRST so a substring
   (e.g. 'Total') never clobbers a longer phrase ('Total à payer'). Covers the
   top ~24 visible chrome strings the storefront renders in French. */
var CHROME_FR2AR = [
  ['Boutique en ligne · COD', 'متجر أونلاين · الدفع عند الاستلام'],
  ['Continuer mes achats', 'كمّل التسوق'],
  ['Découvrir les produits', 'شوف المنتجات'],
  ['Finaliser la commande', 'أكمل الطلبية'],
  ['Adresse de livraison', 'عنوان التوصيل'],
  ['Passer la commande →', 'أكمل الطلبية ←'],
  ['Paiement à la livraison', 'الدفع عند الاستلام'],
  ['Ajouter au panier', 'زيد للسلة'],
  ['Nous contacter', 'تواصل معانا'],
  ['Total à payer', 'المبلغ الإجمالي'],
  ['Espace gérant', 'فضاء المسير'],
  ['Nos produits', 'المنتجات تاعنا'],
  ['Nom complet', 'الاسم الكامل'],
  ['Sous-total', 'المجموع الفرعي'],
  ['Mon panier', 'السلة تاعي'],
  ['Téléphone', 'الهاتف'],
  ['Livraison', 'التوصيل'],
  ['Ajouter', 'زيد'],
  ['Commune', 'البلدية'],
  ['Wilaya', 'الولاية'],
  ['Accueil', 'الرئيسية'],
  ['Panier', 'السلة'],
  ['Retour', 'رجوع'],
  ['Total', 'الإجمالي']
];
/* walk text nodes + a few attributes under root, swapping enumerated phrases when
   darja is active. Skips SCRIPT/STYLE and our own already-darja chrome. Cheap:
   runs once per render only when the toggle is on and darja selected. */
function translateChrome(root) {
  if (!isDarja() || !root) return;
  function swap(str) {
    var out = str;
    for (var i = 0; i < CHROME_FR2AR.length; i++) {
      var pair = CHROME_FR2AR[i];
      if (out.indexOf(pair[0]) !== -1) out = out.split(pair[0]).join(pair[1]);
    }
    return out;
  }
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
  var textNodes = [], nd;
  while ((nd = walker.nextNode())) {
    var pn = nd.parentNode;
    if (pn && (pn.nodeName === 'SCRIPT' || pn.nodeName === 'STYLE')) continue;
    textNodes.push(nd);
  }
  textNodes.forEach(function (n) {
    var v = n.nodeValue;
    if (!v || !v.trim()) return;
    var sw = swap(v);
    if (sw !== v) n.nodeValue = sw;
  });
  /* a few user-facing attributes */
  var attrEls = root.querySelectorAll('[placeholder],[title],[aria-label]');
  attrEls.forEach(function (el) {
    ['placeholder', 'title', 'aria-label'].forEach(function (a) {
      if (!el.hasAttribute(a)) return;
      var val = el.getAttribute(a);
      var sw = swap(val);
      if (sw !== val) el.setAttribute(a, sw);
    });
  });
}
/* =========================================================================
   home-page extra sections (bundles + instagram feed). Appended inside <main>
   after the layout body for the home route only, so all four layout variants get
   them uniformly. Each inner section self-gates on its own feature flag, so this
   returns '' when neither is on (byte-identical home).
   ========================================================================= */
function homeExtras(route) {
  if (!route || route.name !== 'home') return '';
  return bundlesSection() + instagramSection();
}

/* =========================================================================
   Wave-B global post-render hook — called from render() after storefront chrome
   is mounted (see render-compose snippet). Order matters: translate chrome first
   (so recomputed money strings we set below stay in digits), then recompute the
   checkout totals, award loyalty on the success view, and bind nothing here
   (interactions are delegated once at boot).
   ========================================================================= */
function wsfAfterRender(route) {
  translateChrome(document.getElementById('app'));
  if (route && route.name === 'checkout') recomputeCheckout();
  if (route && route.name === 'success') loyaltyAward(lastSuccess);
}

/* =========================================================================
   WSF-4 — Shop features batch A (wishlist · reviews · promo-codes · variants).
   Every block below is gated by featureOn('<id>') (canonical ids, Anvil
   registry) and is a dead branch when its flag is absent — so a shop with no
   settings.features renders byte-identically to today. Storage stays IDs/
   scalars only in the settings singleton (8KB cap); reviews use the existing
   per-slug Data API exactly like orders; wishlist is client-side localStorage.
   Authored with plain string concatenation, ES5-ish, matching the file style
   (no backtick and no dollar-brace template sequences inside the literal).
   ========================================================================= */

/* ---- wishlist: localStorage-backed favorites, keyed per slug ---- */
var WISH_KEY = 'clickdz.shop.wish.' + SLUG;
function wishList() {
  try { var v = JSON.parse(localStorage.getItem(WISH_KEY) || '[]'); return Array.isArray(v) ? v : []; }
  catch (e) { return []; }
}
/* Stable per-product key for wishlist membership. Uses the product slug when a
   record carries one, else its id — so favorites survive re-seeds that keep the
   slug. String()'d so mixed id/slug types compare safely. */
function wishKey(p) {
  if (!p) return '';
  return String((p && p.slug) || (p && p.id) || '');
}
function inWish(p) {
  var k = wishKey(p); if (!k) return false;
  var l = wishList();
  for (var i = 0; i < l.length; i++) { if (String(l[i]) === k) return true; }
  return false;
}
function wishCount() { return wishList().length; }
function toggleWish(p) {
  var k = wishKey(p); if (!k) return false;
  var l = wishList(); var out = []; var had = false;
  for (var i = 0; i < l.length; i++) { if (String(l[i]) === k) { had = true; } else { out.push(l[i]); } }
  if (!had) out.push(k);
  try { localStorage.setItem(WISH_KEY, JSON.stringify(out)); } catch (e) {}
  updateWishCount();
  return !had;
}
function updateWishCount() {
  var els = document.querySelectorAll('[data-wish-count]');
  var n = wishCount();
  for (var i = 0; i < els.length; i++) { els[i].textContent = n; els[i].hidden = n === 0; }
}
function findByWishKey(k) {
  for (var i = 0; i < store.products.length; i++) { if (wishKey(store.products[i]) === String(k)) return store.products[i]; }
  return null;
}
/* A single heart button for a product (card + detail reuse it). data-wish carries
   the wishKey; the pressed state drives the fill. */
function wishBtn(p, cls) {
  var on = inWish(p);
  return '<button class="wish-btn ' + (cls || '') + (on ? ' on' : '') + '" type="button" data-wish="' + attr(wishKey(p)) +
    '" aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="' + (on ? 'Retirer des favoris' : 'Ajouter aux favoris') +
    '" title="' + (on ? 'Retirer des favoris' : 'Ajouter aux favoris') + '">' + (on ? '❤️' : '🤍') + '</button>';
}
/* The wishlist page (#/wishlist) — reuses productCard so cart/stock/review/
   variant behavior is identical to the grid. */
function viewWishlist() {
  var keys = wishList();
  var prods = [];
  for (var i = 0; i < keys.length; i++) { var p = findByWishKey(keys[i]); if (p && p.active !== false) prods.push(p); }
  var head = '<div class="wrap">' +
    '<a class="back-link" href="#/"><span class="arw">←</span> Continuer mes achats</a>' +
    '<div class="section-head"><h2>Mes favoris ❤️</h2><span class="muted">' + prods.length + ' article' + (prods.length > 1 ? 's' : '') + '</span></div>';
  if (!prods.length) {
    return head + emptyState('🤍', 'Aucun favori pour le moment', 'Touchez le cœur sur un produit pour l\'ajouter ici.', '<a class="btn primary" href="#/">Voir les produits</a>') + '</div>';
  }
  return head + '<div class="grid">' + prods.map(productCard).join('') + '</div></div>';
}

/* ---- reviews: per-product ratings/comments via the Data API collection
   'reviews' (business key productId + createdAt, mirroring how orders POST).
   Loaded once, best-effort; graceful (empty) when the API is unreachable. ---- */
function reviewsFor(p) {
  var key = wishKey(p);
  var pid = String((p && p.id) || '');
  var out = [];
  for (var i = 0; i < store.reviews.length; i++) {
    var r = store.reviews[i];
    var rk = String(r.productKey || '');
    var rid = String(r.productId || '');
    if ((key && rk === key) || (pid && rid === pid)) out.push(r);
  }
  return out;
}
function reviewStats(p) {
  var rs = reviewsFor(p); var n = rs.length; var sum = 0;
  for (var i = 0; i < n; i++) { sum += Math.max(1, Math.min(5, Number(rs[i].rating) || 0)); }
  return { count: n, avg: n ? (sum / n) : 0 };
}
/* Static 5-star row for a given rating value (0..5). Filled/empty glyphs; the
   half case rounds to nearest for the compact card display. */
function starsHtml(val, cls) {
  var v = Math.max(0, Math.min(5, Math.round(Number(val) || 0)));
  var out = '<span class="stars ' + (cls || '') + '" aria-hidden="true">';
  for (var i = 1; i <= 5; i++) { out += '<span class="' + (i <= v ? 'fs' : 'es') + '">' + (i <= v ? '★' : '☆') + '</span>'; }
  return out + '</span>';
}
/* Compact aggregate shown on the product card (★ 4.5 · 12). Empty string when
   the product has no reviews yet, so cards without reviews are unchanged. */
function reviewMini(p) {
  var st = reviewStats(p);
  if (!st.count) return '';
  return '<div class="rev-mini">' + starsHtml(st.avg) + '<span class="rev-n">' + st.avg.toFixed(1) + ' · ' + st.count + '</span></div>';
}
/* The reviews block on the product detail (aggregate + list + submit form). */
function reviewsBlock(p) {
  var st = reviewStats(p);
  var rs = reviewsFor(p);
  var headNum = st.count
    ? ('<div class="rev-head-score">' + starsHtml(st.avg) + '<strong>' + st.avg.toFixed(1) + '</strong><span class="muted">sur 5 · ' + st.count + ' avis</span></div>')
    : '<div class="rev-head-score muted">Aucun avis pour le moment — soyez le premier !</div>';
  var listHtml = '';
  for (var i = 0; i < rs.length; i++) {
    var r = rs[i];
    var nm = esc(String(r.name || 'Client'));
    var body = esc(String(r.comment || ''));
    listHtml += '<div class="rev-item"><div class="rev-item-top"><span class="rev-name">' + nm + '</span>' + starsHtml(r.rating) + '</div>' +
      (body ? '<div class="rev-body">' + body + '</div>' : '') + '</div>';
  }
  var picker = '<div class="rev-picker" id="rev-stars" data-rating="5">';
  for (var j = 1; j <= 5; j++) { picker += '<button type="button" class="rev-star on" data-star="' + j + '" aria-label="' + j + ' étoile' + (j > 1 ? 's' : '') + '">★</button>'; }
  picker += '</div>';
  var form = '<form class="rev-form panel" id="review-form" data-pid="' + attr(String(p.id)) + '" data-pkey="' + attr(wishKey(p)) + '">' +
    '<div class="rev-form-head">Laisser un avis</div>' +
    '<div class="field"><label for="rev-name">Votre nom</label><input class="control" id="rev-name" name="name" maxlength="40" placeholder="Ex : Ahmed" /></div>' +
    '<div class="field"><label>Note</label>' + picker + '</div>' +
    '<div class="field"><label for="rev-comment">Commentaire</label><textarea class="control" id="rev-comment" name="comment" maxlength="400" placeholder="Partagez votre expérience…"></textarea></div>' +
    '<button class="btn primary" id="rev-submit" type="button">Publier mon avis</button>' +
    '</form>';
  return '<section class="reviews"><div class="rev-head"><h2>Avis clients</h2>' + headNum + '</div>' +
    (listHtml ? '<div class="rev-list">' + listHtml + '</div>' : '') + form + '</section>';
}
function submitReview(form) {
  if (!form) return;
  var pid = form.getAttribute('data-pid') || '';
  var pkey = form.getAttribute('data-pkey') || '';
  var nameEl = form.querySelector('#rev-name');
  var commentEl = form.querySelector('#rev-comment');
  var starsEl = form.querySelector('#rev-stars');
  var rating = starsEl ? (Number(starsEl.getAttribute('data-rating')) || 5) : 5;
  var comment = commentEl ? commentEl.value.trim() : '';
  var name = nameEl ? nameEl.value.trim() : '';
  if (!comment) { toast('Veuillez écrire un commentaire', 'err'); if (commentEl) commentEl.focus(); return; }
  var btn = form.querySelector('#rev-submit');
  if (btn) { btn.disabled = true; btn.textContent = 'Envoi…'; }
  var review = {
    type: 'review',
    productId: String(pid),
    productKey: String(pkey),
    name: (name || 'Client').slice(0, 40),
    rating: Math.max(1, Math.min(5, Math.round(rating))),
    comment: comment.slice(0, 400),
    createdAt: Date.now()
  };
  api.create('reviews', review)
    .then(function (created) {
      store.reviews.push(Object.assign({}, review, created || {}));
      toast('Merci pour votre avis !', 'ok');
      render();
    })
    .catch(function () {
      /* offline / API down: keep the UX intact — show it locally this session */
      store.reviews.push(review);
      toast('Avis enregistré', 'ok');
      render();
    });
}

/* ---- promo-codes: cart-level percentage discount. Codes are read from a
   settings scalar CSV of code:percent pairs (see NOTES — kebab id 'promo-codes'
   maps to settings.promoCodes by the SAME camelCase rule Anvil uses for
   online-pay/deliveryMatrix). Absent/empty → no promo UI, byte-identical.
   Applied code is held in-memory (store.promo) for the session. ---- */
function promoMap() {
  var s = store.settings || {};
  var raw = s.promoCodes;
  var map = {};
  if (raw == null) return map;
  var list = Array.isArray(raw) ? raw : String(raw).split(',');
  for (var i = 0; i < list.length; i++) {
    var pair = String(list[i]).split(':');
    var code = (pair[0] || '').trim().toUpperCase();
    var pct = Math.max(0, Math.min(100, Math.round(Number(pair[1]) || 0)));
    if (code && pct > 0) map[code] = pct;
  }
  return map;
}
function promoPercent() {
  if (!store.promo) return 0;
  var map = promoMap();
  return map[store.promo] || 0;
}
/* Discount (DZD) applied to a given subtotal by the active promo. Rounded. */
function promoDiscount(subtotal) {
  var pct = promoPercent();
  if (!pct) return 0;
  return Math.round((Number(subtotal) || 0) * pct / 100);
}
function applyPromo(codeRaw) {
  var code = String(codeRaw || '').trim().toUpperCase();
  var map = promoMap();
  if (!code) { store.promo = ''; render(); return; }
  if (map[code]) { store.promo = code; toast('Code promo appliqué : -' + map[code] + '%', 'ok'); }
  else { store.promo = ''; toast('Code promo invalide', 'err'); }
  render();
}

/* ---- variants: per-product option groups read from an OPTIONAL product field
   (p.variants). Backward-compatible: absent → no selector, unchanged. Shape is
   either an array [{label:'Taille', options:['S','M','L']}, …] OR a compact CSV
   'Taille:S,M,L;Couleur:Noir,Blanc' (parsed to the same structure). Selection is
   a single '/'-joined label carried on the cart line + order item. ---- */
function productVariants(p) {
  var raw = p && p.variants;
  if (!raw) return [];
  var groups = [];
  if (Array.isArray(raw)) {
    for (var i = 0; i < raw.length; i++) {
      var g = raw[i]; if (!g) continue;
      var label = String(g.label || g.name || '').trim();
      var opts = [];
      var src = g.options || g.values || [];
      if (Array.isArray(src)) { for (var j = 0; j < src.length; j++) { var o = String(src[j]).trim(); if (o) opts.push(o); } }
      else { var parts = String(src).split(','); for (var k = 0; k < parts.length; k++) { var op = parts[k].trim(); if (op) opts.push(op); } }
      if (label && opts.length) groups.push({ label: label, options: opts });
    }
    return groups;
  }
  /* CSV form: groups separated by ';', 'label:opt,opt' each */
  var gs = String(raw).split(';');
  for (var a = 0; a < gs.length; a++) {
    var seg = gs[a].split(':');
    var lb = (seg[0] || '').trim();
    var ov = (seg[1] || '').split(',');
    var list2 = [];
    for (var b = 0; b < ov.length; b++) { var v2 = ov[b].trim(); if (v2) list2.push(v2); }
    if (lb && list2.length) groups.push({ label: lb, options: list2 });
  }
  return groups;
}
function hasVariants(p) { return productVariants(p).length > 0; }
/* Selector UI for the product detail. Each group is a labeled chip row; the
   first option is pre-selected so the payload always carries a valid choice. */
function variantSelector(p) {
  var groups = productVariants(p);
  if (!groups.length) return '';
  var out = '<div class="variants" id="pd-variants">';
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    out += '<div class="vgroup" data-vg="' + attr(g.label) + '"><span class="vlabel">' + esc(g.label) + '</span><div class="vopts">';
    for (var j = 0; j < g.options.length; j++) {
      out += '<button type="button" class="vopt' + (j === 0 ? ' sel' : '') + '" data-vopt="' + attr(g.options[j]) + '">' + esc(g.options[j]) + '</button>';
    }
    out += '</div></div>';
  }
  return out + '</div>';
}
/* Read the current selection from the rendered selector as a '/'-joined label,
   e.g. 'Taille: M / Couleur: Noir'. '' when the product has no variants. */
function readVariantChoice() {
  var host = document.getElementById('pd-variants');
  if (!host) return '';
  var parts = [];
  var groups = host.querySelectorAll('.vgroup');
  for (var i = 0; i < groups.length; i++) {
    var label = groups[i].getAttribute('data-vg') || '';
    var sel = groups[i].querySelector('.vopt.sel');
    if (sel) parts.push(label + ': ' + (sel.getAttribute('data-vopt') || ''));
  }
  return parts.join(' / ');
}
/* WS4-3 — the hero display copy (the paragraph under the shop name). A picked
   vertical may override it via settings.heroLine or the TPL_HERO_LINE wiring var
   above; when neither is set it falls back to the tagline — exactly what the hero
   showed before this seam (byte-identical default). Kept distinct from the
   stored/editable tagline (used by the settings form + footer/meta). */
function heroLine() {
  var s = store.settings || {};
  var h = (s.heroLine != null ? String(s.heroLine) : String(TPL_HERO_LINE || '')).trim();
  if (h) return h;
  return (s.tagline != null) ? String(s.tagline) : defaultSettings().tagline;
}
/* The published-app base URL, derived from the SAME wiring the Data API uses.
   DATA_URL is '<appBase>/api/v2/apps-data/<slug>'; strip that suffix to recover
   '<appBase>', then the pay endpoint lives at '<appBase>/api/v1/apps/<slug>/...'.
   Reusing DATA_URL guarantees the checkout call hits the exact same origin. */
function payCheckoutUrl() {
  var suffix = '/api/v2/apps-data/' + SLUG;
  var base = DATA_URL;
  var i = base.indexOf(suffix);
  if (i >= 0) base = base.slice(0, i);
  else base = base.replace(/\/api\/v2\/apps-data\/[^/]*\/?$/, '');
  base = base.replace(/\/+$/, '');
  return base + '/api/v1/apps/' + encodeURIComponent(SLUG) + '/pay/checkout';
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
  },
  sahara: {
    label: 'Sahara',
    accent: '#c2410c',
    themeColor: '#faf5ec',
    vars: {
      '--ink': '#3b2f23', '--ink-soft': '#6f5f4b', '--ink-mute': '#a89880',
      '--line': '#eadfcc', '--bg': '#faf5ec', '--card': '#fffdf8',
      '--ok': '#3f6212', '--ok-bg': '#ecfccb',
      '--warn': '#92400e', '--warn-bg': '#fef3c7',
      '--danger': '#b91c1c', '--danger-bg': '#fee2e2',
      '--info': '#0369a1', '--info-bg': '#e0f2fe',
      '--shadow': '0 1px 2px rgba(120,72,20,.08),0 10px 26px rgba(120,72,20,.10)',
      '--shadow-lg': '0 16px 44px rgba(120,72,20,.20)',
      '--r': '16px', '--r-sm': '12px'
    }
  },
  'nuit-doree': {
    label: 'Nuit doree',
    accent: '#d4af37',
    themeColor: '#101014',
    vars: {
      '--ink': '#ece7db', '--ink-soft': '#b7ae99', '--ink-mute': '#7d7666',
      '--line': '#2a2a31', '--bg': '#101014', '--card': '#1a1a20',
      '--ok': '#4ade80', '--ok-bg': '#052e16',
      '--warn': '#fbbf24', '--warn-bg': '#3a2c07',
      '--danger': '#f87171', '--danger-bg': '#3b0d0d',
      '--info': '#93c5fd', '--info-bg': '#12233f',
      '--shadow': '0 1px 2px rgba(0,0,0,.5),0 10px 30px rgba(0,0,0,.55)',
      '--shadow-lg': '0 18px 52px rgba(0,0,0,.7)',
      '--r': '18px', '--r-sm': '12px'
    }
  },
  olive: {
    label: 'Olive',
    accent: '#4d7c0f',
    themeColor: '#f8f7f2',
    vars: {
      '--ink': '#26301c', '--ink-soft': '#5c6650', '--ink-mute': '#99a18c',
      '--line': '#e4e4d8', '--bg': '#f8f7f2', '--card': '#ffffff',
      '--ok': '#3f6212', '--ok-bg': '#ecfccb',
      '--warn': '#92400e', '--warn-bg': '#fef3c7',
      '--danger': '#b91c1c', '--danger-bg': '#fee2e2',
      '--info': '#155e75', '--info-bg': '#e0f7fa',
      '--shadow': '0 1px 2px rgba(38,48,28,.06),0 8px 22px rgba(38,48,28,.08)',
      '--shadow-lg': '0 12px 38px rgba(38,48,28,.16)',
      '--r': '12px', '--r-sm': '8px'
    }
  },
  azur: {
    label: 'Azur',
    accent: '#0369a1',
    themeColor: '#f1f5f9',
    vars: {
      '--ink': '#0c1a2b', '--ink-soft': '#42566e', '--ink-mute': '#8ba0b8',
      '--line': '#dbe4ee', '--bg': '#f1f5f9', '--card': '#ffffff',
      '--ok': '#15803d', '--ok-bg': '#dcfce7',
      '--warn': '#b45309', '--warn-bg': '#fef3c7',
      '--danger': '#dc2626', '--danger-bg': '#fee2e2',
      '--info': '#1d4ed8', '--info-bg': '#dbeafe',
      '--shadow': '0 1px 2px rgba(12,26,43,.06),0 8px 24px rgba(12,26,43,.08)',
      '--shadow-lg': '0 14px 42px rgba(12,26,43,.18)',
      '--r': '10px', '--r-sm': '7px'
    }
  },
  flash: {
    label: 'Flash',
    accent: '#e11d48',
    themeColor: '#0d0d0f',
    vars: {
      '--ink': '#f4f4f5', '--ink-soft': '#b9b9c0', '--ink-mute': '#77777f',
      '--line': '#26262c', '--bg': '#0d0d0f', '--card': '#17171b',
      '--ok': '#4ade80', '--ok-bg': '#052e16',
      '--warn': '#facc15', '--warn-bg': '#3a2c07',
      '--danger': '#f87171', '--danger-bg': '#3b0d0d',
      '--info': '#60a5fa', '--info-bg': '#0b2447',
      '--shadow': '0 2px 6px rgba(225,29,72,.14),0 12px 32px rgba(0,0,0,.6)',
      '--shadow-lg': '0 20px 56px rgba(0,0,0,.75)',
      '--r': '20px', '--r-sm': '14px'
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

/* Layout ids (branched in the view functions). 'standard' === today.
   WS4-2 adds 'grid-dense' (compact header + tight grid) and 'editorial-split'
   (asymmetric split hero + standard grid); both opt-in, both reuse productCard,
   both honor the same section ids — standard/boutique output is untouched. */
var LAYOUTS = {
  standard: { label: 'Standard' },
  boutique: { label: 'Boutique' },
  'grid-dense': { label: 'Grille dense' },
  'editorial-split': { label: 'Éditorial' }
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

/* WS4-6 — reading direction. RTL when the merchant opts in via settings.rtl
   (bool) or a settings.lang of 'ar'/'ar-dz'/'dz' (darja). Absent/false keeps the
   compile-time <html dir> (default 'ltr'), so nothing changes by default. */
function rtlOn() {
  var s = store.settings || {};
  if (s.rtl === true) return true;
  if (s.rtl === false) return false;
  var lang = String(s.lang || '').trim().toLowerCase();
  return lang === 'ar' || lang === 'ar-dz' || lang === 'dz';
}
/* Flip <html dir>. The stylesheet already uses logical props (inset-inline /
   margin-inline) + a couple of html[dir=rtl] rules, so the whole layout mirrors
   with no per-view work. Runtime-only (mirrors applyTheme reading the singleton
   while the token sets the initial value). */
function applyDir() {
  var dir = rtlOn() ? 'rtl' : (String(TPL_RTL_DIR) === 'rtl' ? 'rtl' : 'ltr');
  var el = document.documentElement;
  if (el.getAttribute('dir') !== dir) el.setAttribute('dir', dir);
}

/* Apply the whole appearance layer (theme → font → accent → dir). accent before
   dir; dir is orthogonal (no accent interplay). */
function applyAppearance() {
  applyTheme();

  applyLang();
  applyAccent();
  applyDir();
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
function addToCart(id, qty, variant) {
  var p = findProduct(id);
  if (!p) return;
  if ((Number(p.stock) || 0) <= 0) { toast('Produit en rupture de stock', 'err'); return; }
  qty = Math.max(1, Number(qty) || 1);
  var line = null;
  for (var i = 0; i < store.cart.length; i++) if (String(store.cart[i].id) === String(id)) line = store.cart[i];
  var max = Number(p.stock) || 0;
  if (line) { line.qty = Math.min(max, line.qty + qty); if (variant) line.variant = variant; }
  else { var nl = { id: String(id), qty: Math.min(max, qty) }; if (variant) nl.variant = variant; store.cart.push(nl); }
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
  if (parts[0] === 'wishlist') return { name: 'wishlist' };
  if (parts[0] === 'tracking') return { name: 'tracking' };

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
    case 'wishlist': body = featureOn('wishlist') ? viewWishlist() : viewHome(); break;
    case 'tracking': body = viewTracking(); break;

    case 'admin': return renderAdmin(route.tab); /* admin owns full shell */
    default: body = viewHome();
  }
  app.innerHTML = announcementBar() + topbar() + '<main>' + body + homeExtras(route) + '</main>' + footer();
  wsfAfterRender(route);
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
      (featureOn('wishlist')
        ? '<a class="icon-btn" href="#/wishlist" aria-label="Favoris" title="Favoris">❤️' +
            '<span class="cart-count" data-wish-count ' + (wishCount() === 0 ? 'hidden' : '') + '>' + wishCount() + '</span>' +
          '</a>'
        : '') +
        langToggleBtn() +

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
        (featureOn('order-tracking') ? '<a href="#/tracking">' + t('track.link') + '</a>' : '') +

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
  var lid = layoutId();
  if (lid === 'boutique') return viewHomeBoutique();
  if (lid === 'grid-dense') return viewHomeGridDense();
  if (lid === 'editorial-split') return viewHomeEditorial();
  var s = store.settings || defaultSettings();
  var wa = digitsOnly(s.whatsapp);
  var errBanner = store.error ? '<div class="wrap"><div class="callout" style="margin-top:16px"><span class="ic">⚠️</span><div>Certaines données n\'ont pas pu être chargées. Réessayez plus tard.</div></div></div>' : '';

  /* WSF-3 — the four home bands are gated by settings.sections. Absent settings
     → every band on → byte-identical to today. */
  var hero = sectionOn('hero') ? ('' +
    '<section class="hero"><div class="wrap"><div class="hero-inner">' +
      '<span class="cod-pill">💵 Paiement à la livraison</span>' +
      '<h1>' + esc(s.shopName) + '</h1>' +
      '<p>' + esc(heroLine()) + '</p>' +
      '<div class="cta-row">' +
        '<a class="btn light lg" href="#products">Découvrir les produits</a>' +
        (wa ? '<a class="btn ghost lg" href="https://wa.me/' + wa + '" target="_blank" rel="noopener noreferrer">💬 Nous contacter</a>' : '') +
      '</div>' +
    '</div></div></section>') : '';

  var trust = sectionOn('trust') ? ('' +
    '<div class="trust"><div class="wrap"><div class="trust-inner">' +
      '<span class="trust-item"><span class="ic">💵</span> Paiement à la livraison</span>' +
      '<span class="trust-item"><span class="ic">🚚</span> Livraison 58 wilayas</span>' +
      '<span class="trust-item"><span class="ic">🔄</span> Retour facile</span>' +
      '<span class="trust-item"><span class="ic">📞</span> Support WhatsApp</span>' +
      '<span class="trust-item"><span class="ic">✅</span> Produits garantis</span>' +
    '</div></div></div>') : '';

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

  /* categories band = the filter chip row (gated); 'featured' has no dedicated
     band in the standard layout, so its toggle is a no-op here by design. */
  var chipsHtml = (sectionOn('categories') && cats.length) ? ('<div class="chips">' + chips + '</div>') : '';

  return errBanner + hero + trust +
    '<div class="wrap" id="products">' +
      '<div class="section-head"><h2>Nos produits</h2><span class="muted">' + shown.length + ' article' + (shown.length > 1 ? 's' : '') + '</span></div>' +
      chipsHtml +
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
        (featureOn('reviews') ? reviewMini(p) : '') +
        (featureOn('wishlist') ? wishBtn(p, 'card-heart') : '') +
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

  /* WSF-3 — boutique gates the same section ids: hero + featured spotlight +
     the category chips. Boutique has no trust strip today, so sectionOn('trust')
     is a no-op here (there is nothing to hide) — keeping existing boutique shops
     byte-identical. Absent settings → all bands on → identical to today. */
  var hero = sectionOn('hero') ? ('' +
    '<section class="hero-boutique"><div class="wrap"><div class="hb-inner">' +
      '<span class="hb-kicker">✦ ' + esc(s.shopName) + '</span>' +
      '<h1>' + esc(s.shopName) + '</h1>' +
      '<p>' + esc(heroLine()) + '</p>' +
      '<div class="cta-row">' +
        '<a class="btn light lg" href="#products">Explorer la collection</a>' +
        (wa ? '<a class="btn ghost lg" href="https://wa.me/' + wa + '" target="_blank" rel="noopener noreferrer">💬 Nous contacter</a>' : '') +
      '</div>' +
      '<span class="cod-pill" style="background:rgba(255,255,255,.16);border-color:rgba(255,255,255,.3)">💵 Paiement à la livraison · 58 wilayas</span>' +
    '</div></div></section>') : '';

  var prods = activeProducts();
  var cats = categories();
  var chips = '<button class="chip ' + (currentCat === '' ? 'active' : '') + '" data-cat="">Tous</button>';
  cats.forEach(function (c) {
    chips += '<button class="chip ' + (currentCat === c ? 'active' : '') + '" data-cat="' + attr(c) + '">' + esc(c) + '</button>';
  });

  var shown = currentCat ? prods.filter(function (p) { return (p.category || '') === currentCat; }) : prods;

  /* featured spotlight = first shown product (only when browsing "Tous"), gated */
  var featured = '';
  if (sectionOn('featured') && !currentCat && shown.length) {
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

  /* the spotlight consumes the first product ONLY when it actually rendered, so
     a gated-off featured keeps every product in the grid (no silent drop). */
  var restProducts = featured ? shown.slice(1) : shown;

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

  var chipsHtml = (sectionOn('categories') && cats.length) ? ('<div class="chips">' + chips + '</div>') : '';

  return errBanner + hero +
    '<div class="wrap" id="products">' +
      '<div class="section-head"><h2>Nos produits</h2><span class="muted">' + shown.length + ' article' + (shown.length > 1 ? 's' : '') + '</span></div>' +
      chipsHtml +
      featured +
      (featured && gridHtml ? '<div class="section-head" style="margin:22px 0 14px"><h2>Toute la collection</h2></div>' : '') +
      gridHtml +
    '</div>';
}

/* ---- Grid-dense layout home (settings.template='grid-dense') ----
   A compact, product-forward home: a slim header band replaces the full-bleed
   hero, over a tighter grid. Same data + delegated events (data-add / data-cat)
   and productCard as the other layouts. Section ids gate the same way: 'hero'
   shows/hides the slim header band, 'trust' the reassurance row, 'categories'
   the chips; 'featured' is a no-op here (no dedicated spotlight). */
function viewHomeGridDense() {
  var s = store.settings || defaultSettings();
  var wa = digitsOnly(s.whatsapp);
  var errBanner = store.error ? '<div class="wrap"><div class="callout" style="margin-top:16px"><span class="ic">⚠️</span><div>Certaines données n\'ont pas pu être chargées. Réessayez plus tard.</div></div></div>' : '';

  var header = sectionOn('hero') ? ('' +
    '<section class="header-dense"><div class="wrap"><div class="hd-inner">' +
      '<div class="hd-text">' +
        '<span class="cod-pill">💵 Paiement à la livraison</span>' +
        '<h1>' + esc(s.shopName) + '</h1>' +
        '<p>' + esc(heroLine()) + '</p>' +
      '</div>' +
      '<div class="hd-actions">' +
        '<a class="btn primary" href="#products">Voir les produits</a>' +
        (wa ? '<a class="btn ghost" href="https://wa.me/' + wa + '" target="_blank" rel="noopener noreferrer">💬 Contacter</a>' : '') +
      '</div>' +
    '</div></div></section>') : '';

  var trust = sectionOn('trust') ? ('' +
    '<div class="trust"><div class="wrap"><div class="trust-inner">' +
      '<span class="trust-item"><span class="ic">💵</span> Paiement à la livraison</span>' +
      '<span class="trust-item"><span class="ic">🚚</span> Livraison 58 wilayas</span>' +
      '<span class="trust-item"><span class="ic">🔄</span> Retour facile</span>' +
      '<span class="trust-item"><span class="ic">📞</span> Support WhatsApp</span>' +
      '<span class="trust-item"><span class="ic">✅</span> Produits garantis</span>' +
    '</div></div></div>') : '';

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
    gridHtml = '<div class="grid-dense">' + shown.map(productCard).join('') + '</div>';
  }

  var chipsHtml = (sectionOn('categories') && cats.length) ? ('<div class="chips">' + chips + '</div>') : '';

  return errBanner + header + trust +
    '<div class="wrap" id="products">' +
      '<div class="section-head"><h2>Nos produits</h2><span class="muted">' + shown.length + ' article' + (shown.length > 1 ? 's' : '') + '</span></div>' +
      chipsHtml +
      gridHtml +
    '</div>';
}

/* ---- Editorial-split layout home (settings.template='editorial-split') ----
   An asymmetric split hero (copy + a large lead-product image) over a standard
   grid. Reuses productCard + delegated events. Gating: 'hero' toggles the split
   band, 'trust' the reassurance row, 'categories' the chips; 'featured' toggles
   whether the split hero shows a product image (falls back to a copy-only hero). */
function viewHomeEditorial() {
  var s = store.settings || defaultSettings();
  var wa = digitsOnly(s.whatsapp);
  var errBanner = store.error ? '<div class="wrap"><div class="callout" style="margin-top:16px"><span class="ic">⚠️</span><div>Certaines données n\'ont pas pu être chargées. Réessayez plus tard.</div></div></div>' : '';

  var prods = activeProducts();
  var cats = categories();
  var chips = '<button class="chip ' + (currentCat === '' ? 'active' : '') + '" data-cat="">Tous</button>';
  cats.forEach(function (c) {
    chips += '<button class="chip ' + (currentCat === c ? 'active' : '') + '" data-cat="' + attr(c) + '">' + esc(c) + '</button>';
  });
  var shown = currentCat ? prods.filter(function (p) { return (p.category || '') === currentCat; }) : prods;

  /* lead media = first shown product image (only browsing "Tous" + featured on) */
  var lead = (sectionOn('featured') && !currentCat && shown.length) ? shown[0] : null;
  var media = '';
  if (lead) {
    var inner = lead.imageUrl
      ? '<img loading="lazy" src="' + attr(lead.imageUrl) + '" alt="' + attr(lead.title) + '" onerror="this.style.display=\'none\'" />'
      : '<div class="hs-ph">🛍️</div>';
    media = '<a class="hs-media" href="#/product/' + encodeURIComponent(lead.id) + '" aria-label="' + attr(lead.title) + '">' +
      inner +
      '<div class="hs-cap"><div class="t">' + esc(lead.title) + '</div><div class="p">' + money(lead.price) + ' DZD</div></div>' +
    '</a>';
  }

  var hero = sectionOn('hero') ? ('' +
    '<section class="hero-split"><div class="wrap"><div class="hs-inner">' +
      '<div class="hs-copy">' +
        '<span class="cod-pill">💵 Paiement à la livraison</span>' +
        '<h1>' + esc(s.shopName) + '</h1>' +
        '<p>' + esc(heroLine()) + '</p>' +
        '<div class="cta-row">' +
          '<a class="btn primary lg" href="#products">Découvrir les produits</a>' +
          (wa ? '<a class="btn ghost lg" href="https://wa.me/' + wa + '" target="_blank" rel="noopener noreferrer">💬 Nous contacter</a>' : '') +
        '</div>' +
      '</div>' +
      media +
    '</div></div></section>') : '';

  var trust = sectionOn('trust') ? ('' +
    '<div class="trust"><div class="wrap"><div class="trust-inner">' +
      '<span class="trust-item"><span class="ic">💵</span> Paiement à la livraison</span>' +
      '<span class="trust-item"><span class="ic">🚚</span> Livraison 58 wilayas</span>' +
      '<span class="trust-item"><span class="ic">🔄</span> Retour facile</span>' +
      '<span class="trust-item"><span class="ic">📞</span> Support WhatsApp</span>' +
      '<span class="trust-item"><span class="ic">✅</span> Produits garantis</span>' +
    '</div></div></div>') : '';

  var gridHtml;
  if (!prods.length) {
    gridHtml = emptyState('📦', 'Aucun produit pour le moment', 'Revenez bientôt — le catalogue arrive !', wa ? '<a class="btn soft" href="https://wa.me/' + wa + '" target="_blank" rel="noopener noreferrer">💬 Nous contacter</a>' : '');
  } else if (!shown.length) {
    gridHtml = emptyState('🔍', 'Aucun produit dans cette catégorie', 'Essayez une autre catégorie.', '<button class="btn ghost" data-cat="">Voir tout</button>');
  } else {
    gridHtml = '<div class="grid">' + shown.map(productCard).join('') + '</div>';
  }

  var chipsHtml = (sectionOn('categories') && cats.length) ? ('<div class="chips">' + chips + '</div>') : '';

  return errBanner + hero + trust +
    '<div class="wrap" id="products">' +
      '<div class="section-head"><h2>Nos produits</h2><span class="muted">' + shown.length + ' article' + (shown.length > 1 ? 's' : '') + '</span></div>' +
      chipsHtml +
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
        (featureOn('variants') ? variantSelector(p) : '') +
        (featureOn('wishlist') ? '<div class="pd-wish">' + wishBtn(p, 'lg') + '<span>Ajouter aux favoris</span></div>' : '') +
        (out
          ? '<button class="btn ghost lg block" disabled>Rupture de stock</button>'
          : '<div class="qtyrow"><div class="qty">' +
              '<button data-q="-" aria-label="Diminuer">−</button>' +
              '<input id="pd-qty" type="number" value="1" min="1" max="' + (Number(p.stock) || 1) + '" inputmode="numeric" />' +
              '<button data-q="+" aria-label="Augmenter">+</button>' +
            '</div></div>' +
            '<button class="btn primary lg block" id="pd-add" data-add="' + attr(p.id) + '">🛒 Ajouter au panier</button>') +
        (featureOn('reviews') ? reviewsBlock(p) : '') +
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
        (l.variant ? '<div class="ci-variant">' + esc(l.variant) + '</div>' : '') +
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
  var promoOff = featureOn('promo-codes') ? promoDiscount(subtotal) : 0;
  var total = subtotal + fee - promoOff;
  var wilOpts = '<option value="">— Sélectionnez votre wilaya —</option>' +
    WILAYAS.map(function (w) { return '<option value="' + attr(w) + '">' + esc(w) + '</option>'; }).join('');

  var itemsRows = store.cart.map(function (l) {
    var p = findProduct(l.id); if (!p) return '';
    var vl = l.variant ? ' (' + esc(l.variant) + ')' : '';
    return '<div class="line"><span>' + esc(p.title) + vl + ' × ' + l.qty + '</span><span>' + money((Number(p.price) || 0) * l.qty) + ' DZD</span></div>';
  }).join('');

  /* Online payment (Chargily) — additive, shown ONLY when the merchant enabled
     settings.onlinePay. When off, onlineBtn is '' so the checkout markup below is
     byte-identical to the cash-on-delivery-only storefront. */
  var onlineBtn = onlinePayEnabled(s)
    ? '<div style="display:flex;align-items:center;gap:10px;margin:14px 0 2px;color:var(--ink-mute);font-size:12.5px"><span style="flex:1;height:1px;background:var(--line)"></span>ou<span style="flex:1;height:1px;background:var(--line)"></span></div>' +
      '<button class="btn primary lg block" id="pay-online" type="button">💳 Payer en ligne (' + money(total) + ' DZD)</button>' +
      '<p style="text-align:center;color:var(--ink-mute);font-size:12.5px;margin-top:10px">Paiement sécurisé par carte CIB / Edahabia. Vous serez redirigé vers une page de paiement.</p>'
    : '';

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
              (promoOff > 0 ? '<div class="line promo-line"><span>Remise (' + esc(store.promo) + ')</span><span>-' + money(promoOff) + ' DZD</span></div>' : '') +
              '<div class="line total"><span>Total à payer</span><span>' + money(total) + ' <span class="cur">DZD</span></span></div>' +
            '</div>' +
          '</div>' +
          '<div class="callout" style="margin-top:12px"><span class="ic">💵</span><div><strong>Paiement à la livraison.</strong> Aucun paiement en ligne. Vous réglez en espèces à la réception.</div></div>' +
          (featureOn('promo-codes')
            ? '<div class="promo-box">' +
                '<label for="promo-input">Code promo</label>' +
                '<div class="promo-row">' +
                  '<input class="control" id="promo-input" placeholder="Ex : PROMO10" value="' + attr(store.promo || '') + '" autocomplete="off" />' +
                  '<button class="btn ghost" id="promo-apply" type="button">' + (store.promo ? 'Retirer' : 'Appliquer') + '</button>' +
                '</div>' +
                (promoOff > 0 ? '<div class="promo-ok">✓ -' + promoPercent() + '% appliqué</div>' : '') +
              '</div>'
            : '') +
          (featureOn('delivery-matrix') ? '<div class="callout" id="cdz-ship-note" style="margin-top:12px"><span class="ic">🚚</span><div>Sélectionnez votre wilaya pour voir les frais de livraison.</div></div>' : '') +
          loyaltyCheckoutHint(total) +

          '<button class="btn primary lg block" style="margin-top:14px" id="place-order" type="button">✅ Confirmer la commande (' + money(total) + ' DZD)</button>' +
          '<p style="text-align:center;color:var(--ink-mute);font-size:12.5px;margin-top:10px">En confirmant, vous serez redirigé pour envoyer votre commande via WhatsApp.</p>' +
          onlineBtn +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function validatePhone(v) {
  var d = digitsOnly(v);
  return /^0(5|6|7)[0-9]{8}$/.test(d);
}

/* Validate the checkout form + build the order object. Returns { order, items }
   on success, or null (after painting inline errors) on validation failure.
   Shared by the cash-on-delivery flow (placeOrder) and the online-pay flow
   (payOnline) so both produce the byte-identical order shape & French errors. */
function readCheckoutOrder() {
  var form = document.getElementById('checkout-form');
  if (!form) return null;
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
    return null;
  }

  var s = store.settings || defaultSettings();
  var items = store.cart.map(function (l) {
    var p = findProduct(l.id) || {};
    var it = { id: String(l.id), title: p.title || 'Produit', price: Number(p.price) || 0, qty: l.qty };
    if (l.variant) it.variant = String(l.variant);
    return it;
  });
  var subtotal = items.reduce(function (n, it) { return n + it.price * it.qty; }, 0);
  var fee = Number(s.deliveryFee) || 0;
  var promoOff = featureOn('promo-codes') ? promoDiscount(subtotal) : 0;
  var total = subtotal + fee - promoOff;
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
    deliveryFee: featureOn('delivery-matrix') ? deliveryFeeFor(data.wilaya) : fee,
    total: (subtotal - bundleDiscount() - (promoOff > 0 ? promoOff : 0)) + (featureOn('delivery-matrix') ? deliveryFeeFor(data.wilaya) : fee)
  };
  if (featureOn('delivery-matrix')) { order.deliveryZone = wilCode(data.wilaya); }
  var __bx = activeBundles();
  if (__bx.length) { order.bundles = __bx; order.bundleDiscount = bundleDiscount(); }
  if (promoOff > 0) { order.promoCode = store.promo; order.discount = promoOff; }

  return { order: order, items: items };
}

function placeOrder() {
  var built = readCheckoutOrder();
  if (!built) return;
  var order = built.order;
  var items = built.items;
  var ref = order.ref;

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

/* Online payment (Chargily) — same validation + order creation as the COD flow,
   then hand the buyer off to a hosted checkout. On ANY failure (endpoint not
   configured, network, non-2xx, missing checkout_url) we degrade gracefully to
   the exact wa.me cash-on-delivery success/receipt flow so checkout never breaks. */
function payOnline() {
  var built = readCheckoutOrder();
  if (!built) return;
  var order = built.order;
  var items = built.items;
  var ref = order.ref;

  var payBtn = document.getElementById('pay-online');
  var codBtn = document.getElementById('place-order');
  var payLabel = payBtn ? payBtn.innerHTML : '';
  if (payBtn) { payBtn.disabled = true; payBtn.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px"></span> Redirection…'; }
  if (codBtn) codBtn.disabled = true;

  /* Fall back to the intact COD + WhatsApp flow. The order is already persisted
     (or attempted) exactly as COD does, so the merchant still receives it. */
  function fallbackToCod(reason) {
    lastSuccess = order;
    clearCart();
    toast(reason || 'Paiement en ligne indisponible — envoyez votre commande via WhatsApp', 'ok');
    go('#/success/' + encodeURIComponent(ref));
  }

  /* Step 1. create/get the order ref (same write as the wa.me flow) */
  api.create('orders', order)
    .then(function (created) {
      lastSuccess = Object.assign({}, order, created || {});
      decrementStock(items);
      /* Step 2. ask the app to open a Chargily checkout for this order */
      return fetch(payCheckoutUrl(), {
        method: 'POST',
        headers: api.headers(true),
        body: JSON.stringify({ orderRef: ref, amount: order.total, dataToken: DATA_TOKEN })
      });
    })
    .then(function (r) {
      return r.json().then(function (body) { return { ok: r.ok, body: body || {} }; }, function () { return { ok: false, body: {} }; });
    })
    .then(function (res) {
      /* Step 3a. success → redirect the buyer to the hosted checkout page */
      if (res.ok && res.body && res.body.checkout_url) {
        clearCart();
        window.location.href = res.body.checkout_url;
        return;
      }
      /* Step 3b. pay_not_configured or any other error → graceful COD fallback */
      fallbackToCod();
    })
    .catch(function () {
      /* network / unexpected failure → never break checkout, fall back to COD */
      if (payBtn) { payBtn.disabled = false; payBtn.innerHTML = payLabel; }
      if (codBtn) codBtn.disabled = false;
      fallbackToCod();
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
    o.items.forEach(function (it) { L.push('• ' + it.title + (it.variant ? ' [' + it.variant + ']' : '') + ' × ' + it.qty + ' = ' + money(it.price * it.qty) + ' DZD'); });
    L.push('');
    L.push('Sous-total : ' + money(o.subtotal) + ' DZD');
    L.push('Livraison : ' + money(o.deliveryFee) + ' DZD');
    if (o.discount) L.push('Remise (' + (o.promoCode || '') + ') : -' + money(o.discount) + ' DZD');
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
      var variant = (route.name === 'product' && featureOn('variants')) ? readVariantChoice() : '';
      addToCart(id, qty, variant);
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
    var pay = e.target.closest('#pay-online');
    if (pay) { payOnline(); return; }
    var wb = e.target.closest('[data-wish]');
    if (wb) {
      var wp = findByWishKey(wb.getAttribute('data-wish'));
      if (wp) {
        var added = toggleWish(wp);
        toast(added ? 'Ajouté aux favoris ❤️' : 'Retiré des favoris', 'ok');
        if (route.name === 'wishlist') { render(); }
        else {
          wb.classList.toggle('on', added);
          wb.setAttribute('aria-pressed', added ? 'true' : 'false');
          wb.innerHTML = added ? '❤️' : '🤍';
        }
      }
      return;
    }
    var vo = e.target.closest('[data-vopt]');
    if (vo) {
      var grp = vo.closest('.vgroup');
      if (grp) {
        var sibs = grp.querySelectorAll('.vopt');
        for (var vi = 0; vi < sibs.length; vi++) sibs[vi].classList.remove('sel');
        vo.classList.add('sel');
      }
      return;
    }
    var rstar = e.target.closest('[data-star]');
    if (rstar) {
      var pick = rstar.closest('#rev-stars');
      if (pick) {
        var val = Number(rstar.getAttribute('data-star')) || 5;
        pick.setAttribute('data-rating', val);
        var stbtns = pick.querySelectorAll('.rev-star');
        for (var si = 0; si < stbtns.length; si++) { stbtns[si].classList.toggle('on', (si + 1) <= val); }
      }
      return;
    }
    var rsub = e.target.closest('#rev-submit');
    if (rsub) { submitReview(document.getElementById('review-form')); return; }
    var pap = e.target.closest('#promo-apply');
    if (pap) {
      if (store.promo) { applyPromo(''); }
      else { var pin = document.getElementById('promo-input'); applyPromo(pin ? pin.value : ''); }
      return;
    }
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
  /* Preserve fields the deployed-admin form does not edit (managed by the studio
     /erp/settings allowlist) so a basic save never wipes them. Added only when
     already present, so a shop that never set them keeps the same body as before. */
  if (cur.onlinePay !== undefined) body.onlinePay = cur.onlinePay;
  if (cur.sections !== undefined) body.sections = cur.sections;
  if (cur.features !== undefined) body.features = cur.features;
  if (cur.rtl === true) body.rtl = true;   /* only when opted in (default false is a no-op) */
  if (cur.lang) body.lang = cur.lang;
  if (cur.heroLine) body.heroLine = cur.heroLine;
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
/* WSF-5 (batch B) — one delegated listener set for all Wave-B interactive chrome.
   Registered once at boot (document-level), independent of per-render binding. */
document.addEventListener('click', function (e) {
  var lang = e.target.closest ? e.target.closest('[data-lang-toggle]') : null;
  if (lang) { lsSet('lang', isDarja() ? 'fr' : 'ar'); applyLang(); render(); return; }
  var ann = e.target.closest ? e.target.closest('[data-ann-dismiss]') : null;
  if (ann) {
    var txt = sVal('announcementText').slice(0, 140);
    lsSet('ann', annHash(txt));
    var bar = document.getElementById('cdz-ann');
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    return;
  }
  var bn = e.target.closest ? e.target.closest('[data-bundle]') : null;
  if (bn) { addBundle(Number(bn.getAttribute('data-bundle'))); render(); return; }
});
document.addEventListener('change', function (e) {
  var w = e.target.closest ? e.target.closest('#f-wilaya') : null;
  if (w) recomputeCheckout();
});
document.addEventListener('submit', function (e) {
  var tf = e.target.closest ? e.target.closest('#track-form') : null;
  if (tf) {
    e.preventDefault();
    var inp = document.getElementById('track-phone');
    trackLookup(inp ? inp.value : '');
  }
});

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
