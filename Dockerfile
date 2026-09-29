# Pond Battle (Frog Pond Brawl): zero-dependency Node server + Telegram bot in one small image
FROM node:22-alpine
WORKDIR /app
COPY engine.js server.js ranks.js telegram.js index.html frogs.json items.json sets.json ./
COPY static ./static
COPY tools ./tools
ENV NODE_ENV=production PORT=8420 DATA_DIR=/data
# Rooms, profiles and game history live in /data (mount a volume there)
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8420
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8420/api/health >/dev/null || exit 1
CMD ["node", "server.js"]
