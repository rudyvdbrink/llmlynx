# Production image, built on the server it runs on (see .github/workflows/deploy.yml).
# Debian rather than Alpine: Prisma's engines and bcrypt ship glibc builds.
FROM node:24-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS build
# Dependencies first, so a code change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build && npm prune --omit=dev

FROM base AS runner
ENV NODE_ENV=production
# The prisma CLI stays (it is a runtime dependency), so this image also runs the migrations.
COPY --from=build --chown=node:node /app/package.json /app/next.config.ts ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/prisma ./prisma
USER node
CMD ["node_modules/.bin/next", "start"]
