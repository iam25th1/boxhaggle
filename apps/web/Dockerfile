# BOXHAGGLE spectator web. ALTERNATE deploy (Railway); the live demo is self-hosted, see docs/SELF-HOSTING.md.
# Build context: repository root.
FROM node:24.21.0-bookworm-slim AS build
# Public, non-secret: the merchant origin baked into the bundle for Live mode.
ARG VITE_MERCHANT_URL=""
ENV VITE_MERCHANT_URL=$VITE_MERCHANT_URL
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/merchant/package.json apps/merchant/
COPY apps/agent/package.json apps/agent/
COPY apps/web/package.json apps/web/
COPY apps/plugin/package.json apps/plugin/
RUN npm ci --ignore-scripts
COPY packages/core packages/core
COPY apps/web apps/web
RUN npm run build -w @boxhaggle/core && npm run build -w @boxhaggle/web

FROM node:24.21.0-bookworm-slim
ENV NODE_ENV=production
# Inside a container loopback is unreachable from the platform proxy, so bind all interfaces here only.
ENV HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app/apps/web/dist dist
COPY apps/web/serve.mjs serve.mjs
USER node
EXPOSE 8080
CMD ["node", "serve.mjs"]
