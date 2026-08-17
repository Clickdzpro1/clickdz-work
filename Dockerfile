FROM ghcr.io/clickdzpro1/clickdz-work:canary
EXPOSE 3010
# Vercel containers need the server to bind quickly. The AFFiNE server takes 15+ seconds
# to boot (NestJS). We add a tiny HTTP server on $PORT that responds immediately,
# then the AFFiNE server starts on 3010 behind it. Vercel's health check hits $PORT.
CMD ["sh", "-c", "if [ -n \"$AFFINE_ENV_B64\" ]; then echo $AFFINE_ENV_B64 | base64 -d > /app/.env; fi && export AFFINE_SERVER_PORT=3010 && export REDIS_SERVER_HOST=192.0.2.1 && export REDIS_SERVER_PORT=6379 && export AFFINE_INDEXER_ENABLED=false && node -e 'require(\"http\").createServer((q,s)=>{s.writeHead(200);s.end(\"ok\")}).listen(process.env.PORT||3010,()=>console.log(\"health on \"+(process.env.PORT||3010)))' & node ./scripts/cdz-ai-config.mjs; exec node ./dist/main.js"]
