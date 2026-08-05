FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production TSUB_PLATFORM=server TSUB_STORAGE_TYPE=sqlite TSUB_DATA_DIR=/var/lib/tsub-controller TSUB_STATIC_DIR=/app/dist
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/functions ./functions
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/src/shared ./src/shared
RUN groupadd --system --gid 10001 tsub-controller && useradd --system --uid 10001 --gid tsub-controller --home /var/lib/tsub-controller tsub-controller \
    && mkdir -p /var/lib/tsub-controller /run/tsub \
    && chown -R tsub-controller:tsub-controller /var/lib/tsub-controller /run/tsub /app
USER tsub-controller
EXPOSE 8787
VOLUME ["/var/lib/tsub-controller", "/run/tsub"]
CMD ["node", "server/index.mjs"]
