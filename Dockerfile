# ── Etapa 1: compilar TypeScript ─────────────────────────────────────────────
FROM node:20-slim AS build
WORKDIR /app

# .npmrc es necesario: evita el bug de npm con los peers de vitest (legacy-peer-deps)
COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ── Etapa 2: imagen de ejecución (solo dependencias de producción + dist) ────
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Cloud Run define PORT (8080) en tiempo de ejecución; index.ts lo lee de process.env.PORT.
# EXPOSE es solo documentación.
EXPOSE 8080
USER node

CMD ["node", "dist/index.js"]
