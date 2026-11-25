# Site Next.js. Construit depuis la racine du dépôt : docker build -f apps/web/Dockerfile .
FROM node:22-bookworm-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w @erp/web --include-workspace-root=false
COPY apps/web apps/web
ARG API_URL=http://api:4000
ARG NEXT_PUBLIC_TENANT=saint-kisito
ARG NEXT_PUBLIC_DEMO=true
ENV API_URL=$API_URL NEXT_PUBLIC_TENANT=$NEXT_PUBLIC_TENANT NEXT_PUBLIC_DEMO=$NEXT_PUBLIC_DEMO NEXT_TELEMETRY_DISABLED=1
RUN cd apps/web && npx next build

FROM node:22-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/apps/web apps/web
WORKDIR /repo/apps/web
USER node
EXPOSE 3000
# Commit d'où vient cette image (installer-serveur.sh le donne) : controle-production.sh vérifie, après une mise à jour,
# que la version en marche est bien le commit attendu (demande de Dankou du 24 novembre 2026). « inconnu » sinon.
ARG CAHIORA_COMMIT=inconnu
ENV CAHIORA_COMMIT=$CAHIORA_COMMIT
CMD ["npx", "next", "start", "-p", "3000"]
