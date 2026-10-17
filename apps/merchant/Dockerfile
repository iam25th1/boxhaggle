# BOXHAGGLE merchant. ALTERNATE deploy (Railway); the live demo is self-hosted, see docs/SELF-HOSTING.md.
# Build context: repository root.
FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/merchant/package.json apps/merchant/
COPY apps/agent/package.json apps/agent/
COPY apps/web/package.json apps/web/
COPY apps/plugin/package.json apps/plugin/
RUN npm ci --ignore-scripts
COPY packages/core packages/core
COPY apps/merchant apps/merchant
RUN npm run build -w @boxhaggle/core && npm run build -w @boxhaggle/merchant

FROM node:24.21.0-bookworm-slim
ENV NODE_ENV=production
# Inside a container loopback is unreachable from the platform proxy, so bind all interfaces here only.
ENV HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/merchant/package.json apps/merchant/
COPY apps/agent/package.json apps/agent/
COPY apps/web/package.json apps/web/
COPY apps/plugin/package.json apps/plugin/
RUN npm ci --ignore-scripts --omit=dev -w @boxhaggle/core -w @boxhaggle/merchant && npm cache clean --force
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/apps/merchant/dist apps/merchant/dist
USER node
EXPOSE 8787
CMD ["node", "apps/merchant/dist/index.js"]
