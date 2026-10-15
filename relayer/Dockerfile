FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.mjs migrate-trust-keys.mjs ./
USER node
CMD ["node", "index.mjs"]
