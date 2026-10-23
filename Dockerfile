# Self-hosted Passive Perception: docker run -p 8080:8080 -v perception-data:/data <image>
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm at the version package.json pins ("packageManager"); not corepack, which Node 25+ no longer ships.
RUN npm install -g "$(node -p "require('./package.json').packageManager")" && pnpm install --prod --frozen-lockfile
COPY public ./public
COPY src ./src
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "src/node/server.js"]
