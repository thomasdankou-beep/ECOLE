# API NestJS. Construit depuis la racine du dépôt : docker build -f apps/api/Dockerfile .
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w @erp/api --include-workspace-root=false
COPY apps/api apps/api
RUN cd apps/api && npx prisma generate && npx nest build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/apps/api apps/api
WORKDIR /repo/apps/api
RUN mkdir -p storage && chown -R node:node storage
USER node
EXPOSE 4000
# Applique les migrations (rôle propriétaire) puis démarre l'API (rôle applicatif).
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
