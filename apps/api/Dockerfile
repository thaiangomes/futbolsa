# Imagem da API. Contexto de build: a raiz do repositório (o motor e os contratos entram junto).
#   docker build -f apps/api/Dockerfile -t futbolsa-api .

# 1) compila o motor, os contratos e a API
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts
COPY packages packages
COPY apps/api apps/api
RUN npm run build:libs && npm run build -w @futbolsa/api

# 2) só o que roda: dependências de produção e os dist/
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --ignore-scripts -w @futbolsa/api --include-workspace-root=false
COPY --from=build /app/packages/engine/dist packages/engine/dist
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/drizzle apps/api/drizzle
USER node
EXPOSE 3000
WORKDIR /app/apps/api
# aplica as migrações que faltam antes de subir (rodar de novo não faz nada)
CMD ["sh", "-c", "node dist/infra/db/migrate.js && node dist/main.js"]
