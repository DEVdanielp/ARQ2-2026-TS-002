# One image definition for every service of the Nest monorepo.
#   docker build --build-arg APP=orders-service -t fasttrack/orders-service .
ARG NODE_VERSION=24-bookworm-slim

FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG APP
RUN test -n "$APP" || (echo "Build arg APP is required" && exit 1)
RUN npx nest build "$APP"
RUN npm prune --omit=dev

FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ARG APP
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/apps/${APP} ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
