# Browser tools for llmlynx agents (see docker-compose.yml). The Playwright
# image brings Chromium and its system libraries; its version must match the
# playwright version in package.json. Update both regularly (for example
# monthly): a pinned browser stops getting security fixes.
FROM mcr.microsoft.com/playwright:v1.64.1-noble AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Chromium runs as an unprivileged user
USER pwuser
EXPOSE 8080
CMD ["node", "dist/server.js"]
