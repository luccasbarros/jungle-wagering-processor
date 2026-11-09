FROM oven/bun:1.3.12-alpine

WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
# --production: TypeScript runs as-is in Bun, so devDependencies (tsc, types) never ship.
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY tsconfig.json ./
COPY src ./src

USER bun
EXPOSE 3000

CMD ["bun", "run", "src/main.ts"]
