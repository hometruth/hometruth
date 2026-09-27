FROM oven/bun:1.3.12 AS build
USER root
RUN apt-get update && apt-get install -y --no-install-recommends build-essential libssl-dev pkg-config && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY src ./src
RUN bun src/integrations/hue-proxy/build-dtls.ts /app/dtls

FROM oven/bun:1.3.12
USER root
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dtls /usr/local/bin/hometruth-hue-dtls
ENTRYPOINT ["bun", "src/integrations/hue-proxy/main.ts"]
CMD ["--config", "/config/hue-proxy.yml"]
