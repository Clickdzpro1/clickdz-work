FROM ghcr.io/clickdzpro1/clickdz-work:canary
EXPOSE 3010
# Don't decode AFFINE_ENV_B64 — all env vars are set on the Vercel project directly.
# The server reads from process.env (Vercel injects them). No .env file needed.
# Reverse proxy on $PORT forwards to AFFiNE on 3010.
CMD ["sh", "-c", "export AFFINE_SERVER_PORT=3010 && node -e 'const http=require(\"http\");const p=http.createServer((q,s)=>{const r=http.request({hostname:\"127.0.0.1\",port:3010,path:q.url,method:q.method,headers:q.headers},(up)=>{s.writeHead(up.statusCode,up.headers);up.pipe(s)});r.on(\"error\",()=>{s.writeHead(200,{\"Content-Type\":\"text/html\"});s.end(\"<html><body>Starting ClickDz Work...</body></html>\")});q.pipe(r)});p.listen(process.env.PORT||3010,()=>console.log(\"proxy on \"+(process.env.PORT||3010)))' & sleep 2 && node ./scripts/cdz-ai-config.mjs; exec node ./dist/main.js"]
