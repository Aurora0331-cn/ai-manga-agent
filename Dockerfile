# ===== build stage：装依赖 + 打包前端 =====
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# ===== runtime stage：仅生产依赖 + 已打包前端 =====
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
COPY package*.json ./
RUN npm install --omit=dev
COPY server ./server
COPY skills ./skills
COPY --from=build /app/dist ./dist
# 运行时数据目录（项目持久化 / 导出）
RUN mkdir -p data/projects exports
EXPOSE 5174
CMD ["node", "server/index.js"]
