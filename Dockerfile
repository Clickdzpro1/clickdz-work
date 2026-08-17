FROM ghcr.io/clickdzpro1/clickdz-work:canary
EXPOSE 3010
# Decode .env from AFFINE_ENV_B64, then OVERRIDE Redis with the Vercel project's
# env vars (Upstash KV) which are injected by the platform. The dotenv loader
# in prelude.ts reads .env, but process.env (set by Vercel) takes priority
# for keys that are already set — so we force-export the Redis vars AFTER
# writing .env to ensure the Upstash connection wins.
CMD ["sh", "-c", "if [ -n \"$AFFINE_ENV_B64\" ]; then echo $AFFINE_ENV_B64 | base64 -d > /app/.env; fi && export AFFINE_SERVER_PORT=3010 && export REDIS_SERVER_HOST=${KV_REST_API_URL:+live-sheep-143646.upstash.io} && export REDIS_SERVER_PORT=6379 && export REDIS_SERVER_PASSWORD=${KV_REST_API_TOKEN} && export REDIS_SERVER_USERNAME=default && export REDIS_SERVER_TLS=true && node -e 'const http=require(\"http\");const p=http.createServer((q,s)=>{const r=http.request({hostname:\"127.0.0.1\",port:3010,path:q.url,method:q.method,headers:q.headers},(up)=>{s.writeHead(up.statusCode,up.headers);up.pipe(s)});r.on(\"error\",()=>{s.writeHead(200,{\"Content-Type\":\"text/html\"});s.end(\"<html><body>Starting ClickDz Work...</body></html>\")});q.pipe(r)});p.listen(process.env.PORT||3010,()=>console.log(\"proxy on \"+(process.env.PORT||3010)))' & sleep 2 && node ./scripts/cdz-ai-config.mjs; exec node ./dist/main.js"]
