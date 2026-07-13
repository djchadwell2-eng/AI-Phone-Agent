# Webhook service container for Railway. Trigger.dev tasks do NOT run here —
# they deploy separately to Trigger.dev cloud via `npm run deploy:trigger`.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm i -g tsx@4
COPY tsconfig.json ./
COPY src ./src
# tsx runs TS directly — no build step to drift from source. This service is
# small enough that startup transpile cost is irrelevant.
CMD ["tsx", "src/webhooks/server.ts"]
