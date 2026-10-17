FROM public.ecr.aws/docker/library/node@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
COPY ui/ ./ui/
COPY vite.config.ts ./vite.config.ts
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM public.ecr.aws/docker/library/node@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/ui-dist ./ui-dist
COPY --from=build /app/package.json ./package.json
COPY vendor/ /opt/runtime/
COPY scripts/cx /usr/local/bin/cx
RUN chmod 755 /usr/local/bin/cx /app/dist/cli.js && ln -s /app/dist/cli.js /usr/local/bin/telegramvisor && mkdir /data && chown 501:20 /data
ENV NODE_ENV=production DATA_DIRECTORY=/data T3_URL=http://host.docker.internal:3773 HEALTH_PORT=9037 UI_PORT=9038 PATH=/opt/runtime/aarch64-unknown-linux-musl/bin:${PATH}
USER 501:20
CMD ["node", "dist/main.js"]
