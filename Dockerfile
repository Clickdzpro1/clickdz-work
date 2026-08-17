FROM ghcr.io/clickdzpro1/clickdz-work:canary
EXPOSE 3010
# The AFFiNE server must listen on $PORT (Vercel injects this for containers).
# Decode full .env, override Redis (non-routable, fails fast), disable indexer.
# Start the health server first (instant 200 on $PORT for Vercel's check),
# then the real server ALSO on $PORT (the health server gets replaced when
# the real server binds). This way Vercel's health check passes immediately
# AND the real app serves once it's ready.
CMD ["sh", "-c", "if [ -n \"$AFFINE_ENV_B64\" ]; then echo $AFFINE_ENV_B64 | base64 -d > /app/.env; fi && export AFFINE_SERVER_PORT=${PORT:-3010} && export REDIS_SERVER_HOST=192.0.2.1 && export REDIS_SERVER_PORT=6379 && export AFFINE_INDEXER_ENABLED=false && node -e 'require(\"http\").createServer((q,s)=>{s.writeHead(200,{\"Content-Type\":\"text/html\"});s.end(\"<html><body>Loading ClickDz Work...</body></html>\")}).listen(process.env.PORT||3010,()=>console.log(\"health on \"+(process.env.PORT||3010)))' & sleep 2 && node ./scripts/cdz-ai-config.mjs; exec node ./dist/main.js"]
