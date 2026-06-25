FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY codex-relay ./codex-relay
RUN npm run relay:build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/codex-relay/dist ./codex-relay/dist
EXPOSE 8788
CMD ["node", "codex-relay/dist/server.js"]
