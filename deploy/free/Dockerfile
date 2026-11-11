# SleePhy relay, packaged so any container host can run it.
#
# The relay only needs `ws`, `node:sqlite` and src/lib, so this image stays
# small. node:sqlite is built into Node 24 and needs no extra dependency.
#
# Build and run locally:
#   docker build -f deploy/free/Dockerfile -t sleephy-relay .
#   docker run -p 8787:8787 -v sleephy-data:/data sleephy-relay

FROM node:24-alpine

WORKDIR /app

# Only the runtime deps: the build toolchain (electron) is not needed here.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY src ./src
COPY server-default.json ./

# The relay hands out the download page from SLEEPHY_DOWNLOADS, so it has to be
# in the image. Only the page is copied: the installer is served from the GitHub
# release the page links to, which keeps the image small.
COPY deploy/free/index.html ./dist/index.html

# The database lives on a volume so it survives a redeploy.
ENV SLEEPHY_DB=/data/sleephy.db
ENV SLEEPHY_DOWNLOADS=/app/dist
ENV PORT=8787
RUN mkdir -p /data /app/dist

EXPOSE 8787

# A host that checks a URL uses this; the relay answers {"ok":true}.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "server/index.js"]
