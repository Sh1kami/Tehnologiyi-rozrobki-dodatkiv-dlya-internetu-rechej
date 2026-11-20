FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3080 BIND=0.0.0.0 DB_PATH=/data/fleet.sqlite
RUN mkdir /data && chown node:node /data
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/package.json ./package.json
COPY --chown=node:node --from=build /app/src ./src
COPY --chown=node:node --from=build /app/dist ./dist
USER node
EXPOSE 3080
CMD ["node","src/start.js"]
