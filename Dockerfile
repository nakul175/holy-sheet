FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-bookworm-slim AS runtime
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
