/**
 * ClickDz Work — desktop download page (served at GET /download).
 *
 * Self-contained HTML: inline styles + a small vanilla script that reads the
 * same-origin release feed (`/api/releases?channel=stable&minimal=true`) and
 * wires the platform buttons to the CURRENT release assets. The feed rewrites
 * asset urls to GitHub browser_download_url, so buttons stream installers
 * directly. Every button starts with (and falls back to) the GitHub
 * releases/latest page, so the page degrades gracefully without JS or if the
 * feed is unavailable.
 *
 * Asset matching relies on the versionless permalink copies the publish
 * workflow adds to every release (ClickDzWork-windows-x64.exe etc. — see the
 * artifact naming contract in publish-desktop-release.yml); matching is by
 * name suffix with shortest-name preference, so it also works against
 * versioned names if the permalinks are ever absent.
 *
 * NOTE: the client script intentionally avoids template literals so this file
 * can hold the whole page in a single backtick string.
 */
export const DOWNLOAD_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Download ClickDz Work — desktop app</title>
<meta name="description" content="Get the ClickDz Work desktop app for Windows, macOS, and Linux. AI workspace with chat, app builder, image generation, and docs — with automatic updates." />
<link rel="icon" href="/favicon.ico" />
<style>
  :root {
    --bg: #0b0d12;
    --panel: #12151d;
    --panel-hover: #161a24;
    --border: #232838;
    --text: #eef1f7;
    --muted: #9aa3b5;
    --accent1: #5b8cff;
    --accent2: #a06bff;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    background:
      radial-gradient(1100px 500px at 70% -10%, rgba(91,140,255,0.14), transparent 60%),
      radial-gradient(900px 460px at 10% 110%, rgba(160,107,255,0.10), transparent 60%),
      var(--bg);
    color: var(--text);
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    padding: 0 20px 64px;
  }
  .wrap { max-width: 980px; margin: 0 auto; }
  header { padding: 44px 0 8px; display: flex; align-items: center; gap: 12px; }
  .mark {
    width: 34px; height: 34px; border-radius: 9px; flex: none;
    background: linear-gradient(135deg, var(--accent1), var(--accent2));
    box-shadow: 0 4px 18px rgba(91,140,255,0.35);
  }
  .brand { font-weight: 700; font-size: 18px; letter-spacing: 0.2px; }
  .brand a { color: var(--text); text-decoration: none; }
  h1 { font-size: clamp(30px, 5vw, 44px); line-height: 1.12; letter-spacing: -0.6px; margin: 26px 0 10px; }
  h1 .grad {
    background: linear-gradient(90deg, var(--accent1), var(--accent2));
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .sub { color: var(--muted); max-width: 640px; font-size: 17px; }
  .meta { display: flex; align-items: center; gap: 10px; margin: 18px 0 30px; flex-wrap: wrap; }
  .pill {
    display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 13px;
    border: 1px solid var(--border); background: var(--panel); color: var(--text);
  }
  .meta .muted { color: var(--muted); font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
  @media (max-width: 840px) { .grid { grid-template-columns: 1fr; } }
  .card {
    position: relative; background: var(--panel); border: 1px solid var(--border);
    border-radius: 14px; padding: 22px 20px 20px; transition: border-color .15s, background .15s;
  }
  .card:hover { background: var(--panel-hover); }
  .card.detected { border-color: rgba(91,140,255,0.65); box-shadow: 0 0 0 1px rgba(91,140,255,0.35), 0 10px 30px rgba(91,140,255,0.08); }
  .badge {
    position: absolute; top: -10px; right: 14px; font-size: 11px; font-weight: 600;
    letter-spacing: 0.4px; text-transform: uppercase; padding: 3px 9px; border-radius: 999px;
    color: #fff; background: linear-gradient(90deg, var(--accent1), var(--accent2));
  }
  .os-name { font-weight: 650; font-size: 17px; margin-bottom: 2px; }
  .os-hint { color: var(--muted); font-size: 13px; margin-bottom: 16px; }
  a.btn {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    text-decoration: none; border-radius: 10px; padding: 11px 14px; font-weight: 600;
    font-size: 14.5px; margin-bottom: 9px; border: 1px solid var(--border);
    color: var(--text); background: rgba(255,255,255,0.02); transition: transform .08s, border-color .15s, background .15s;
  }
  a.btn:hover { border-color: rgba(91,140,255,0.6); background: rgba(91,140,255,0.08); }
  a.btn:active { transform: translateY(1px); }
  a.btn.primary {
    background: linear-gradient(90deg, var(--accent1), var(--accent2));
    border: none; color: #fff; box-shadow: 0 6px 20px rgba(101,113,255,0.28);
  }
  a.btn.primary:hover { filter: brightness(1.07); }
  a.btn .size { font-weight: 500; font-size: 12.5px; opacity: 0.75; flex: none; }
  .alt { display: flex; gap: 8px; flex-wrap: wrap; }
  .alt a.btn { flex: 1 1 auto; justify-content: center; padding: 8px 10px; font-size: 13px; margin-bottom: 0; }
  .notes { margin-top: 34px; display: grid; gap: 8px; max-width: 760px; }
  .notes p { color: var(--muted); font-size: 13.5px; }
  .notes strong { color: var(--text); font-weight: 600; }
  .notes a { color: var(--accent1); text-decoration: none; }
  .notes a:hover { text-decoration: underline; }
  footer { margin-top: 46px; padding-top: 18px; border-top: 1px solid var(--border); color: var(--muted); font-size: 13px; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  footer a { color: var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="mark" aria-hidden="true"></div>
    <div class="brand"><a href="/">ClickDz Work</a></div>
  </header>

  <h1>Get the <span class="grad">desktop app</span></h1>
  <p class="sub">Your AI workspace — chat, app builder, image generation, and docs — as a native app for Windows, macOS, and Linux. It keeps itself up to date automatically.</p>

  <div class="meta">
    <span class="pill" id="version">latest</span>
    <span class="muted" id="published"></span>
    <span class="muted">·</span>
    <a class="muted" id="release-link" href="https://github.com/Clickdzpro1/clickdz-work/releases/latest" target="_blank" rel="noopener noreferrer" style="color:inherit;">release notes</a>
  </div>

  <div class="grid">
    <section class="card" id="sec-windows">
      <span class="badge" id="badge-windows" hidden>Your platform</span>
      <div class="os-name">Windows</div>
      <div class="os-hint">Windows 10/11 · 64-bit</div>
      <a class="btn primary" id="dl-win" href="https://github.com/Clickdzpro1/clickdz-work/releases/latest">Download installer <span class="size"></span></a>
      <div class="alt">
        <a class="btn" id="dl-win-portable" href="https://github.com/Clickdzpro1/clickdz-work/releases/latest">Portable .zip <span class="size"></span></a>
      </div>
    </section>

    <section class="card" id="sec-macos">
      <span class="badge" id="badge-macos" hidden>Your platform</span>
      <div class="os-name">macOS</div>
      <div class="os-hint">macOS 12+ · pick your chip</div>
      <a class="btn primary" id="dl-mac-arm" href="https://github.com/Clickdzpro1/clickdz-work/releases/latest">Apple Silicon .dmg <span class="size"></span></a>
      <a class="btn" id="dl-mac-intel" href="https://github.com/Clickdzpro1/clickdz-work/releases/latest">Intel .dmg <span class="size"></span></a>
    </section>

    <section class="card" id="sec-linux">
      <span class="badge" id="badge-linux" hidden>Your platform</span>
      <div class="os-name">Linux</div>
      <div class="os-hint">x64 · AppImage, deb, Flatpak</div>
      <a class="btn primary" id="dl-linux-appimage" href="https://github.com/Clickdzpro1/clickdz-work/releases/latest">AppImage <span class="size"></span></a>
      <div class="alt">
        <a class="btn" id="dl-linux-deb" href="https://github.com/Clickdzpro1/clickdz-work/releases/latest">.deb</a>
        <a class="btn" id="dl-linux-flatpak" href="https://github.com/Clickdzpro1/clickdz-work/releases/latest">Flatpak</a>
        <a class="btn" id="dl-linux-zip" href="https://github.com/Clickdzpro1/clickdz-work/releases/latest">.zip</a>
      </div>
    </section>
  </div>

  <div class="notes">
    <p><strong>Automatic updates:</strong> the app checks for new versions and updates itself — install once, stay current.</p>
    <p><strong>Windows SmartScreen:</strong> the installer is not yet code-signed, so Windows may show a warning. Choose “More info → Run anyway”. Code signing is on the roadmap.</p>
    <p>All downloads, older versions, and checksums are on <a id="all-downloads" href="https://github.com/Clickdzpro1/clickdz-work/releases" target="_blank" rel="noopener noreferrer">GitHub Releases</a>. Prefer the browser? <a href="/">Open ClickDz Work on the web →</a></p>
  </div>

  <footer>
    <span>© ClickDz — work.clickdz.ai</span>
    <a href="https://github.com/Clickdzpro1/clickdz-work" target="_blank" rel="noopener noreferrer">Source on GitHub</a>
  </footer>
</div>

<script>
(function () {
  var FALLBACK = 'https://github.com/Clickdzpro1/clickdz-work/releases/latest';
  function fmtSize(bytes) {
    if (!bytes || bytes < 1048576) return '';
    return Math.round(bytes / 1048576) + ' MB';
  }
  function pick(assets, suffix) {
    var m = assets.filter(function (a) {
      return String(a.name || '').toLowerCase().endsWith(suffix);
    });
    m.sort(function (a, b) { return a.name.length - b.name.length; });
    return m[0] || null;
  }
  function el(id) { return document.getElementById(id); }
  function setBtn(id, asset) {
    var node = el(id);
    if (!node) return;
    if (asset && asset.url) {
      node.href = asset.url;
      var s = node.querySelector('.size');
      if (s) s.textContent = fmtSize(asset.size);
    } else {
      node.href = FALLBACK;
    }
  }
  function detectOS() {
    var ua = navigator.userAgent || '';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Macintosh|Mac OS X/i.test(ua)) return 'macos';
    if (/Linux|X11/i.test(ua)) return 'linux';
    return '';
  }

  var os = detectOS();
  if (os) {
    var section = el('sec-' + os);
    if (section) section.classList.add('detected');
    var badge = el('badge-' + os);
    if (badge) badge.hidden = false;
  }

  fetch('/api/releases?channel=stable&minimal=true')
    .then(function (r) {
      if (!r.ok) throw new Error('feed ' + r.status);
      return r.json();
    })
    .then(function (releases) {
      var rel = releases && releases[0];
      if (!rel || !rel.assets || !rel.assets.length) throw new Error('empty feed');
      var assets = rel.assets;
      var version = String(rel.tag_name || '').replace(/^desktop-v/, '');
      if (version) el('version').textContent = 'v' + version;
      if (rel.published_at) {
        var d = new Date(rel.published_at);
        if (!isNaN(d.getTime())) {
          el('published').textContent = 'released ' + d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
        }
      }
      if (rel.url) el('release-link').href = rel.url;
      setBtn('dl-win', pick(assets, 'windows-x64.exe'));
      setBtn('dl-win-portable', pick(assets, 'windows-x64-portable.zip'));
      setBtn('dl-mac-arm', pick(assets, 'macos-arm64.dmg'));
      setBtn('dl-mac-intel', pick(assets, 'macos-x64.dmg'));
      setBtn('dl-linux-appimage', pick(assets, 'linux-x64.appimage'));
      setBtn('dl-linux-deb', pick(assets, 'linux-x64.deb'));
      setBtn('dl-linux-flatpak', pick(assets, 'linux-x64.flatpak'));
      setBtn('dl-linux-zip', pick(assets, 'linux-x64.zip'));
    })
    .catch(function () {
      // Feed unavailable: every button already points at releases/latest.
    });
})();
</script>
</body>
</html>
`;
