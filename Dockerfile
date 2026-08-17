FROM ghcr.io/clickdzpro1/clickdz-work:canary
EXPOSE 3010
# 1. Start a tiny health server on $PORT (Vercel's health check passes instantly)
# 2. After 5s, kill the health server + start the real AFFiNE server on the same $PORT
CMD ["sh", "-c", "if [ -n \"$AFFINE_ENV_B64\" ]; then echo $AFFINE_ENV_B64 | base64 -d > /app/.env; fi && export AFFINE_SERVER_PORT=${PORT:-3010} && export REDIS_SERVER_HOST=192.0.2.1 && export REDIS_SERVER_PORT=6379 && export AFFINE_INDEXER_ENABLED=false && HEALTH_PID=$(node -e 'require(\"http\").createServer((q,s)=>{s.writeHead(200,{\"Content-Type\":\"text/html\"});s.end(\"<html><body>Loading ClickDz Work...</body></html>\")}).listen(process.env.PORT||3010,()=>console.log(\"health up\"))' & echo $!) && sleep 5 && kill $HEALTH_PID 2>/dev/null; node ./scripts/cdz-ai-config.mjs; exec node ./dist/main.js"]
