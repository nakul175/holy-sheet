FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN groupadd --gid 1001 holy && useradd --uid 1001 --gid holy --system holy
COPY --from=build --chown=holy:holy /app/.next/standalone ./
COPY --from=build --chown=holy:holy /app/.next/static ./.next/static
COPY --from=build --chown=holy:holy /app/public ./public
COPY --from=build --chown=holy:holy /app/db ./db
COPY --from=build --chown=holy:holy /app/scripts ./scripts
USER holy
EXPOSE 3000
CMD ["node", "server.js"]
