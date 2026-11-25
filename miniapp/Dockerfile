FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc tsconfig.json ./
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund
COPY client/src/ ./client/src/
COPY shared/ ./shared/
COPY miniapp/office-art.ts ./miniapp/
RUN npm run miniapp:build

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

ENV NODE_ENV=production HOST=0.0.0.0 PORT=4849
WORKDIR /app
COPY --chown=node:node miniapp/bridge-queue.mjs miniapp/gateway.mjs miniapp/preview.mjs miniapp/telegram-auth.mjs ./miniapp/
COPY --chown=node:node miniapp/web/ ./miniapp/web/
COPY --chown=node:node shared/locales/telegram.mjs ./shared/locales/telegram.mjs
COPY --chown=node:node client/public/assets/brand/logo-mark@4x.png ./client/public/assets/brand/
COPY --chown=node:node client/public/assets/illustrations/empty-office.png ./client/public/assets/illustrations/
COPY --from=build --chown=node:node /app/dist/miniapp/ ./dist/miniapp/
USER node
EXPOSE 4849
CMD ["node", "miniapp/gateway.mjs"]
