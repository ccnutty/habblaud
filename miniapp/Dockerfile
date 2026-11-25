FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

ENV NODE_ENV=production HOST=0.0.0.0 PORT=4849
WORKDIR /app
COPY --chown=node:node miniapp/bridge-queue.mjs miniapp/gateway.mjs miniapp/preview.mjs miniapp/telegram-auth.mjs ./miniapp/
COPY --chown=node:node miniapp/web/ ./miniapp/web/
COPY --chown=node:node shared/locales/telegram.mjs ./shared/locales/telegram.mjs
USER node
EXPOSE 4849
CMD ["node", "miniapp/gateway.mjs"]
