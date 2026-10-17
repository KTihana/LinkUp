FROM node:24-alpine
WORKDIR /srv/tiho
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --chown=node:node server.mjs store.mjs protocol.mjs call-config.mjs push.mjs ./
RUN mkdir -p /srv/data && chown node:node /srv/data
USER node
ENV HOST=0.0.0.0 ALLOW_PUBLIC_BIND=true PORT=8787 DATA_DIR=/srv/data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
