# Build: everything (client bundle, server bundle, card db extract).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# Run: the bundled server plus its one external runtime dependency (ws).
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data/rooms
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules/ws ./node_modules/ws
COPY --from=build /app/dist ./dist
VOLUME /data
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/server/main.mjs"]
