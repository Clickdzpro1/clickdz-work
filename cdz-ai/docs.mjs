/** The CDZ AI documentation page — served at / and /docs. */
export function docsPage(host = 'api.clickdz.ai') {
  const base = `https://${host}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>CDZ AI — API & MCP Documentation</title>
<meta name="description" content="CDZ AI — one API for real Claude, Gemini and GPT. OpenAI-compatible + MCP." />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
<style>
  :root{
    --bg:#0a0a0f; --panel:#12121a; --panel2:#171722; --line:#24243360;
    --text:#e9e9f0; --muted:#9a9ab0; --dim:#6b6b82;
    --violet:#7d5cff; --violet2:#9d8cff; --blue:#4285f4; --green:#10a37f; --clay:#d97757;
    --radius:14px;
  }
  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,sans-serif;line-height:1.6;-webkit-font-smoothing:antialiased}
  a{color:var(--violet2);text-decoration:none}
  a:hover{text-decoration:underline}
  code,pre{font-family:'JetBrains Mono',monospace}
  .wrap{max-width:920px;margin:0 auto;padding:0 24px}

  /* hero */
  header{position:relative;overflow:hidden;border-bottom:1px solid var(--line)}
  header::before{content:"";position:absolute;inset:-40% -20% auto;height:520px;
    background:radial-gradient(60% 60% at 30% 0%,rgba(125,92,255,.28),transparent 70%),
               radial-gradient(50% 50% at 80% 10%,rgba(66,133,244,.20),transparent 70%);
    filter:blur(20px);z-index:0}
  .hero{position:relative;z-index:1;padding:72px 0 56px}
  .badge{display:inline-flex;align-items:center;gap:8px;font-size:12px;font-weight:600;color:var(--violet2);
    background:rgba(125,92,255,.12);border:1px solid rgba(125,92,255,.35);padding:5px 12px;border-radius:999px;margin-bottom:22px}
  .badge .dot{width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 0 rgba(34,197,94,.6);animation:pulse 2s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.5)}70%{box-shadow:0 0 0 8px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
  h1{font-size:clamp(38px,6vw,64px);font-weight:800;letter-spacing:-.03em;margin:0 0 16px;
    background:linear-gradient(180deg,#fff,#c9c9e0);-webkit-background-clip:text;background-clip:text;color:transparent}
  .lede{font-size:clamp(17px,2.4vw,21px);color:var(--muted);max-width:640px;margin:0 0 28px}
  .cta{display:flex;gap:12px;flex-wrap:wrap}
  .btn{display:inline-flex;align-items:center;gap:8px;padding:11px 18px;border-radius:10px;font-weight:600;font-size:14px;border:1px solid var(--line)}
  .btn.primary{background:linear-gradient(180deg,var(--violet2),var(--violet));color:#fff;border-color:transparent}
  .btn.ghost{background:var(--panel);color:var(--text)}

  section{padding:52px 0;border-bottom:1px solid var(--line)}
  h2{font-size:13px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin:0 0 24px}
  h3{font-size:20px;font-weight:700;margin:0 0 6px;letter-spacing:-.01em}

  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px 20px;transition:transform .16s,border-color .16s}
  .card:hover{transform:translateY(-2px);border-color:rgba(125,92,255,.4)}
  .chip{display:inline-flex;width:26px;height:26px;border-radius:7px;align-items:center;justify-content:center;font-weight:700;font-size:12px;margin-bottom:12px}
  .c-violet{background:rgba(125,92,255,.16);color:var(--violet2)}
  .c-blue{background:rgba(66,133,244,.16);color:#7aa7ff}
  .c-green{background:rgba(16,163,127,.16);color:#3dd7ad}
  .c-clay{background:rgba(217,119,87,.16);color:#e59b7f}
  .card p{margin:0;color:var(--muted);font-size:13.5px}
  .card .mid{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--dim);margin-top:8px}

  pre{background:#0d0d14;border:1px solid var(--line);border-radius:12px;padding:18px 20px;overflow-x:auto;font-size:13px;position:relative}
  pre .k{color:var(--violet2)} pre .s{color:#7ee0b8} pre .c{color:var(--dim)} pre .p{color:#e59b7f}
  .ep{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--line)}
  .ep:last-child{border-bottom:none}
  .m{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:600;padding:3px 9px;border-radius:6px;min-width:52px;text-align:center}
  .m.get{background:rgba(16,163,127,.16);color:#3dd7ad} .m.post{background:rgba(66,133,244,.16);color:#7aa7ff}
  .ep code{font-size:13px;color:var(--text)} .ep span{color:var(--muted);font-size:13px;margin-left:auto;text-align:right}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  td{padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}
  td:first-child{font-family:'JetBrains Mono',monospace;color:var(--violet2);white-space:nowrap;font-size:12.5px}
  td:last-child{color:var(--muted)}
  footer{padding:40px 0 60px;color:var(--dim);font-size:13px;text-align:center}
  .note{background:rgba(125,92,255,.07);border:1px solid rgba(125,92,255,.25);border-radius:12px;padding:14px 18px;font-size:13.5px;color:var(--muted)}
</style>
</head>
<body>
<header><div class="wrap hero">
  <div class="badge"><span class="dot"></span> All systems operational</div>
  <h1>CDZ AI</h1>
  <p class="lede">One API for real Claude, Gemini and GPT. OpenAI-compatible, MCP-native, and powered end-to-end by the ClickDz engine.</p>
  <div class="cta">
    <a class="btn primary" href="#quickstart">Quickstart →</a>
    <a class="btn ghost" href="#models">Browse models</a>
    <a class="btn ghost" href="#mcp">MCP server</a>
  </div>
</div></header>

<section id="models"><div class="wrap">
  <h2>Supermodels</h2>
  <div class="grid">
    <div class="card"><span class="chip c-violet">U</span><h3>cdz-ultra</h3><p>Smart router — sends each request to the best real model automatically.</p><div class="mid">auto-route</div></div>
    <div class="card"><span class="chip c-violet">C</span><h3>cdz-council</h3><p>Claude Opus 4.8 + Gemini 3.1 Pro + GPT-5.5 answer in parallel, then a synthesis.</p><div class="mid">3 vendors + synthesis</div></div>
    <div class="card"><span class="chip c-clay">S</span><h3>cdz-sage</h3><p>Deep reasoning, nuance and caveats.</p><div class="mid">Claude Opus 4.8</div></div>
    <div class="card"><span class="chip c-green">A</span><h3>cdz-architect</h3><p>Code, systems and step-by-step builds.</p><div class="mid">GPT-5.5</div></div>
    <div class="card"><span class="chip c-blue">R</span><h3>cdz-scholar</h3><p>Research, structure and long documents.</p><div class="mid">Gemini 3.1 Pro</div></div>
    <div class="card"><span class="chip c-blue">F</span><h3>cdz-flash</h3><p>Instant answers for everyday questions.</p><div class="mid">Gemini 3.5 Flash</div></div>
    <div class="card"><span class="chip c-green">P</span><h3>cdz-polyglot</h3><p>Arabic, French &amp; English mastery, Algeria-aware.</p><div class="mid">GPT-5.4</div></div>
    <div class="card"><span class="chip c-violet">↳</span><h3>Raw models</h3><p>Call any vendor model directly.</p><div class="mid">claude-opus-4-8 · gemini-3.1-pro-preview · gpt-5.5</div></div>
  </div>
</div></section>

<section id="quickstart"><div class="wrap">
  <h2>Quickstart</h2>
  <p style="color:var(--muted);margin:-8px 0 18px">Any OpenAI SDK works — just set the base URL and your key.</p>
  <pre><span class="c"># cURL</span>
curl ${base}/v1/chat/completions \\
  -H <span class="s">"Authorization: Bearer $CDZ_API_KEY"</span> \\
  -H <span class="s">"Content-Type: application/json"</span> \\
  -d <span class="s">'{"model":"cdz-council","messages":[{"role":"user","content":"Hello"}]}'</span></pre>
  <pre><span class="c"># Python — openai SDK</span>
<span class="k">from</span> openai <span class="k">import</span> OpenAI
client = OpenAI(base_url=<span class="s">"${base}/v1"</span>, api_key=<span class="s">"$CDZ_API_KEY"</span>)
r = client.chat.completions.create(
    model=<span class="s">"cdz-ultra"</span>,
    messages=[{<span class="s">"role"</span>:<span class="s">"user"</span>,<span class="s">"content"</span>:<span class="s">"Explain quantum tunneling simply"</span>}],
)
<span class="k">print</span>(r.choices[<span class="p">0</span>].message.content)</pre>
</div></section>

<section id="endpoints"><div class="wrap">
  <h2>Endpoints</h2>
  <div class="ep"><span class="m get">GET</span><code>/v1/models</code><span>List all models</span></div>
  <div class="ep"><span class="m post">POST</span><code>/v1/chat/completions</code><span>Chat — streaming, multimodal</span></div>
  <div class="ep"><span class="m post">POST</span><code>/v1/images/describe</code><span>Vision — describe an image URL</span></div>
  <div class="ep"><span class="m post">POST</span><code>/v1/audio/transcriptions</code><span>Transcribe an audio URL</span></div>
  <div class="ep"><span class="m post">POST</span><code>/mcp</code><span>MCP server (JSON-RPC 2.0)</span></div>
  <div class="ep"><span class="m get">GET</span><code>/v1/usage</code><span>Usage counters</span></div>
</div></section>

<section id="mcp"><div class="wrap">
  <h2>MCP Server</h2>
  <p style="color:var(--muted);margin:-8px 0 18px">Connect Claude Desktop, Cursor, or any MCP client to <code>${base}/mcp</code>. Tools:</p>
  <table>
    <tr><td>cdz_ask</td><td>Ask any supermodel or raw frontier model.</td></tr>
    <tr><td>cdz_council</td><td>Convene the 3-vendor council with synthesis.</td></tr>
    <tr><td>cdz_describe_image</td><td>Describe an image from a public URL.</td></tr>
    <tr><td>cdz_transcribe_audio</td><td>Transcribe an audio file from a URL.</td></tr>
    <tr><td>cdz_ocr</td><td>Extract verbatim text from an image/document.</td></tr>
    <tr><td>cdz_web_search</td><td>Grounded web search with a cited answer.</td></tr>
  </table>
  <div class="note" style="margin-top:20px">Auth: send <code>Authorization: Bearer &lt;your key&gt;</code> on every request. Need a key? Contact your ClickDz admin.</div>
</div></section>

<footer><div class="wrap">CDZ AI · powered by the ClickDz engine · <a href="https://work.clickdz.ai">work.clickdz.ai</a></div></footer>
</body>
</html>`;
}
