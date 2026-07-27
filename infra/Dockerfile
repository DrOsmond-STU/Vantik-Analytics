# Vantik Analytics — image gabungan API + frontend.
# Mendukung deployment on-premise, cloud, maupun hybrid (PRD Bagian 7, DEPLOYMENT.md Bagian 1).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY shared/design-tokens/package.json shared/design-tokens/
COPY services/package.json services/
COPY frontend/web-app/package.json frontend/web-app/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
# Berjalan sebagai pengguna non-root (SECURITY.md Bagian 10).
USER node
EXPOSE 4000
# Probe kesehatan sesuai DEPLOYMENT.md Bagian 7.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "run", "start"]
