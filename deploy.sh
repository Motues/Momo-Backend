#!/bin/bash

# 部署脚本 - 编译项目并准备部署文件

echo "开始部署准备..."

# 1. 检查是否已安装依赖
echo "1. 检查依赖..."
if [ ! -d "node_modules" ]; then
  echo "安装依赖..."
  pnpm install
fi

# 32. 准备数据库
echo "2. 准备数据库..."

# 检查是否存在数据库文件
if [ ! -f "prisma/dev.db" ]; then
  echo "初始化数据库..."
  npx prisma migrate dev --name init
else
  echo "数据库已存在，运行迁移..."
  # 备份数据库
  cp prisma/dev.db prisma/dev.db.bak
  npx prisma migrate deploy
fi

# 3. 生成 Prisma Client
echo "3. 生成 Prisma Client..."
npx prisma generate

# 4. 编译 TypeScript 代码
echo "2. 编译项目..."
pnpm build
echo "项目编译完成"

echo "部署包已生成在 dist/ 目录"