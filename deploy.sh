#!/bin/bash

# 部署脚本 - 编译项目并准备部署文件

echo "开始部署准备..."

# 1. 检查是否已安装依赖
echo "1. 检查依赖..."
if [ ! -d "node_modules" ]; then
  echo "安装依赖..."
  pnpm install
fi

# 2. 编译 TypeScript 代码
echo "2. 编译项目..."
pnpm build
echo "项目编译完成"

# 3. 准备数据库
echo "3. 准备数据库..."

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

# 4. 生成 Prisma Client
echo "4. 生成 Prisma Client..."
npx prisma generate

# 5. 复制必要的文件到 dist 目录
echo "5. 复制必要文件..."

# 确保 dist 目录存在
mkdir -p dist

# 复制 prisma schema 和数据库文件
mkdir -p dist/prisma

# 复制 schema 文件
cp prisma/schema.prisma dist/prisma/

# 如果数据库文件存在，也复制它
if [ -f "prisma/dev.db" ]; then
  cp prisma/dev.db dist/prisma/
  echo "数据库文件已复制到 dist/prisma/"
fi

# 复制环境变量文件（如果存在）
if [ -f ".env" ]; then
  cp .env dist/
  echo ".env 已复制到 dist/"
fi

if [ -f ".env.production" ]; then
  cp .env.production dist/
  echo ".env.production 已复制到 dist/"
fi

# 6. 创建部署说明文件
cat > dist/DEPLOYMENT.md << 'EOF'
Momo-Backend 部署包
=====================

项目已编译并准备好部署。

目录结构:
- dist/                 编译后的代码
- dist/prisma/          包含数据库文件和 schema
- dist/.env             环境变量文件（如存在）

部署步骤:
1. 将整个 dist 目录上传到服务器
2. 在服务器上安装 Node.js 和 pnpm
3. 进入 dist 目录并运行: pnpm install --production
4. 启动服务: node app.js 或使用 pm2 管理进程

生产环境推荐使用 pm2:
1. 安装 pm2: npm install -g pm2
2. 启动应用: pm2 start app.js --name momo-backend
3. 设置开机自启: pm2 startup && pm2 save

注意:
- 确保服务器上的 PORT 环境变量设置正确
- 如使用 SQLite 数据库，请确保 prisma/dev.db 文件有读写权限
- 建议使用 Nginx 等反向代理服务器
EOF

echo "部署包已生成在 dist/ 目录"
echo "请查看 dist/DEPLOYMENT.md 获取部署说明"