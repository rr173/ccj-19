# ---------- 构建/测试阶段 ----------
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY public ./public
COPY test ./test
RUN npm test

# ---------- 运行阶段（零依赖静态服务器，无需 node_modules） ----------
FROM node:20-alpine
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY server.js ./
COPY --from=build /app/public ./public
EXPOSE 8080
USER node
CMD ["node", "server.js"]
