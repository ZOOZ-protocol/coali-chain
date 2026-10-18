FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.mjs price.mjs ./
# State kept across restarts (named volume, created with this ownership).
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "index.mjs"]
