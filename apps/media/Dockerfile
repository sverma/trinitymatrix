FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data/media && chown node:node /data/media
RUN chmod 700 /data/media
WORKDIR /app/apps/media
COPY --chown=node:node apps/media/package.json ./
COPY --chown=node:node apps/media/src ./src
COPY LICENSE NOTICE.md /app/
ENV NODE_ENV=production MEDIA_HOST=0.0.0.0 MEDIA_PORT=8082 MEDIA_STORAGE_PATH=/data/media
USER node
EXPOSE 8082
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.MEDIA_PORT+'/healthz',{headers:{'X-Trinity-Media-Key':process.env.BROADCAST_MEDIA_SECRET}}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/index.mjs"]
