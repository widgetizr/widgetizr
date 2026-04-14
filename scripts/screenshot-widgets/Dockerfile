FROM oven/bun:slim
WORKDIR /app
COPY package.json .
RUN bun install
RUN bunx playwright install --with-deps chromium
COPY screenshot.mjs .
CMD ["bun", "screenshot.mjs"]
