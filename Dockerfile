FROM ghcr.io/clickdzpro1/clickdz-work:canary
EXPOSE 3010
# Start a reverse proxy on $PORT that forwards to localhost:3010 (the AFFiNE server).
# The proxy responds with 200 "starting..." immediately (Vercel health check passes),
# and once the AFFiNE server boots on 3010, it proxies all requests to it.
CMD ["sh", "-c", "if [ -n \"$AFFINE_ENV_B64\" ]; then echo $AFFINE_ENV_B64 | base64 -d > /app/.env; fi && export AFFINE_SERVER_PORT=3010 && export REDIS_SERVER_HOST=192.0.2.1 && export REDIS_SERVER_PORT=6379 && export AFFINE_INDEXER_ENABLED=false && node -e 'const http=require(\"http\");const p=http.createServer((q,s)=>{const r=http.request({hostname:\"127.0.0.1\",port:3010,path:q.url,method:q.method,headers:q.headers},(up)=>{s.writeHead(up.statusCode,up.headers);up.pipe(s)});r.on(\"error\",()=>{s.writeHead(200,{\"Content-Type\":\"text/html\"});s.end(\"<html><body>Starting ClickDz Work...</body></html>\")});q.pipe(r)});p.listen(process.env.PORT||3010,()=>console.log(\"proxy on \"+(process.env.PORT||3010)))' & sleep 2 && node ./scripts/cdz-ai-config.mjs; exec node ./dist/main.js"]
