// SlidePro — export to PDF via the browser's own print pipeline (no heavy deps,
// no server round-trip). We open a new window containing one landscape @page per
// slide, styled with a dedicated print stylesheet, then call print(). The user
// picks "Save as PDF" in the native dialog. Each sheet mirrors the SlideView
// layout rules closely enough to be a faithful, high-resolution export.

import { getTheme, type SlideTheme } from './themes';
import type { Deck, Slide } from './types';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bulletsHtml(bullets: string[], theme: SlideTheme, size: number): string {
  if (!bullets.length) return '';
  const items = bullets
    .map(
      b =>
        `<li style="position:relative;padding-left:2.4em;font-size:${size}pt;line-height:1.35;margin:0 0 0.6em;color:${theme.fg};">` +
        `<span style="position:absolute;left:0;top:0.55em;width:0.55em;height:0.55em;border-radius:2px;transform:rotate(45deg);background:${theme.accent};"></span>` +
        `${esc(b)}</li>`
    )
    .join('');
  return `<ul style="list-style:none;margin:0;padding:0;">${items}</ul>`;
}

function kickerHtml(theme: SlideTheme): string {
  return `<span style="display:block;width:2.6em;height:0.28em;border-radius:2px;background:${theme.accent};margin-bottom:0.9em;"></span>`;
}

function titleHtml(text: string, theme: SlideTheme): string {
  return (
    `<div style="margin-bottom:1.2em;">${kickerHtml(theme)}` +
    `<h2 style="margin:0;font-size:34pt;line-height:1.1;font-weight:800;letter-spacing:-0.015em;color:${theme.fg};font-family:${theme.headingFont};">${esc(
      text
    )}</h2></div>`
  );
}

function slideBodyHtml(slide: Slide, theme: SlideTheme): string {
  switch (slide.layout) {
    case 'title':
      return (
        `<div style="height:100%;display:flex;flex-direction:column;justify-content:center;">` +
        kickerHtml(theme) +
        `<h1 style="margin:0;font-size:52pt;line-height:1.05;font-weight:800;letter-spacing:-0.02em;color:${theme.fg};font-family:${theme.headingFont};">${esc(
          slide.title || 'Titre'
        )}</h1>` +
        (slide.bullets[0]
          ? `<p style="margin:0.7em 0 0;font-size:24pt;line-height:1.4;color:${theme.muted};font-family:${theme.bodyFont};max-width:80%;">${esc(
              slide.bullets[0]
            )}</p>`
          : '') +
        `</div>`
      );
    case 'quote':
      return (
        `<div style="height:100%;display:flex;flex-direction:column;justify-content:center;">` +
        `<div style="border-left:0.28em solid ${theme.accent};padding-left:1em;">` +
        `<p style="margin:0;font-size:38pt;line-height:1.25;font-weight:600;font-style:italic;color:${theme.fg};font-family:${theme.headingFont};">${esc(
          slide.bullets[0] || slide.title || '« Citation »'
        )}</p>` +
        (slide.notes
          ? `<p style="margin:0.8em 0 0;font-size:20pt;color:${theme.muted};font-family:${theme.bodyFont};">— ${esc(
              slide.notes.split('\n')[0]
            )}</p>`
          : '') +
        `</div></div>`
      );
    case 'two-column':
      return (
        `<div style="height:100%;display:flex;flex-direction:column;">` +
        (slide.title ? titleHtml(slide.title, theme) : '') +
        `<div style="flex:1;display:grid;grid-template-columns:1fr 1fr;gap:1.6em;align-items:start;">` +
        `<div style="background:${theme.surface};border-radius:0.6em;padding:1.1em 1.2em;height:100%;box-sizing:border-box;">${bulletsHtml(
          slide.bullets,
          theme,
          20
        )}</div>` +
        `<div style="background:${theme.surface};border-radius:0.6em;padding:1.1em 1.2em;height:100%;box-sizing:border-box;">${bulletsHtml(
          slide.bulletsRight,
          theme,
          20
        )}</div>` +
        `</div></div>`
      );
    case 'image-text':
      return (
        `<div style="height:100%;display:flex;flex-direction:column;">` +
        (slide.title ? titleHtml(slide.title, theme) : '') +
        `<div style="flex:1;display:grid;grid-template-columns:1fr 1fr;gap:1.6em;align-items:center;min-height:0;">` +
        `<div>${bulletsHtml(slide.bullets, theme, 21)}</div>` +
        `<div style="height:100%;border-radius:0.6em;overflow:hidden;background:${theme.surface};border:1px solid ${theme.line};display:flex;align-items:center;justify-content:center;">` +
        (slide.imageUrl
          ? `<img src="${esc(
              slide.imageUrl
            )}" style="width:100%;height:100%;object-fit:cover;" crossorigin="anonymous" />`
          : `<span style="color:${theme.muted};font-size:16pt;font-family:${theme.bodyFont};padding:1em;text-align:center;">Aucune image</span>`) +
        `</div></div></div>`
      );
    case 'title-bullets':
    default:
      return (
        `<div style="height:100%;display:flex;flex-direction:column;">` +
        titleHtml(slide.title || 'Titre de la diapositive', theme) +
        `<div style="flex:1;">${bulletsHtml(slide.bullets, theme, 22)}</div>` +
        `</div>`
      );
  }
}

function slideSheetHtml(
  slide: Slide,
  theme: SlideTheme,
  index: number,
  total: number,
  deckTitle: string
): string {
  return (
    `<section class="slide" style="background:${theme.bg};color:${theme.fg};font-family:${theme.bodyFont};">` +
    `<div class="slide-inner">${slideBodyHtml(slide, theme)}</div>` +
    `<div class="slide-footer" style="color:${theme.muted};border-top:1px solid ${theme.line};">` +
    `<span>${esc(deckTitle)}</span><span>${index + 1} / ${total}</span>` +
    `</div>` +
    `</section>`
  );
}

/**
 * Open a print window for `deck` and trigger the native print dialog. Returns
 * false if the window was blocked by a popup blocker (the caller can surface a
 * hint). The window closes itself after printing (or if the user cancels).
 */
export function printDeck(deck: Deck): boolean {
  const theme = getTheme(deck.themeId);
  const total = deck.slides.length;
  const sheets = deck.slides
    .map((s, i) => slideSheetHtml(s, theme, i, total, deck.title))
    .join('\n');

  // A dedicated print stylesheet: landscape, one slide per physical page, the
  // slide filling the printable area with a small safety margin. print-color-
  // adjust keeps the theme backgrounds (browsers strip backgrounds otherwise).
  const doc = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<title>${esc(deck.title)}</title>
<style>
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; background: #333; }
  @page { size: 1280px 720px; margin: 0; }
  .slide {
    position: relative;
    width: 1280px;
    height: 720px;
    padding: 76px 88px 64px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    page-break-after: always;
    break-after: page;
  }
  .slide:last-child { page-break-after: auto; break-after: auto; }
  .slide-inner { flex: 1; min-height: 0; }
  .slide-footer {
    display: flex; align-items: center; justify-content: space-between;
    padding-top: 16px; font-size: 14pt; margin-top: 12px;
  }
  /* Screen preview between opening + the dialog: stack sheets with a gap. */
  @media screen {
    body { display: flex; flex-direction: column; align-items: center; gap: 20px; padding: 20px; }
    .slide { box-shadow: 0 4px 24px rgba(0,0,0,0.4); }
  }
</style>
</head>
<body>
${sheets}
<script>
  // Wait for images (slide illustrations) to load before printing so they are
  // not blank in the PDF, then print. A hard timeout guards a stuck/broken img.
  (function () {
    var imgs = Array.prototype.slice.call(document.images || []);
    var pending = imgs.filter(function (i) { return !i.complete; });
    var done = false;
    function go() {
      if (done) return; done = true;
      setTimeout(function () { window.focus(); window.print(); }, 60);
    }
    if (pending.length === 0) { go(); }
    else {
      var left = pending.length;
      pending.forEach(function (i) {
        i.addEventListener('load', function () { if (--left === 0) go(); });
        i.addEventListener('error', function () { if (--left === 0) go(); });
      });
      setTimeout(go, 4000);
    }
    window.addEventListener('afterprint', function () { window.close(); });
  })();
</script>
</body>
</html>`;

  const win = window.open('', '_blank', 'noopener,noreferrer');
  if (!win) return false;
  win.document.open();
  win.document.write(doc);
  win.document.close();
  return true;
}
