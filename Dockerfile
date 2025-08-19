# ---- 基础镜像 ----
FROM node:20-alpine

# ---- 创建应用目录 ----
WORKDIR /app

# ---- 复制依赖清单并安装 ----
COPY package*.json ./
RUN npm ci --omit=dev

# ---- 复制源码 ----
COPY *.js ./

# ---- 暴露端口 ----
EXPOSE 3000

# ---- 启动命令 ----
CMD ["node", "leaflow.js"]
