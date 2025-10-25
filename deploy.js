#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('开始部署准备...');

try {
  // 1. 检查是否已安装依赖
  console.log('1. 检查依赖...');
  if (!fs.existsSync(path.join(__dirname, 'node_modules'))) {
    console.log('安装依赖...');
    execSync('pnpm install', { stdio: 'inherit' });
  }

  // 2. 编译 TypeScript 代码
  console.log('2. 编译项目...');
  execSync('pnpm build', { stdio: 'inherit' });
  console.log('项目编译完成');

  // 3. 准备数据库
  console.log('3. 准备数据库...');
  
  // 检查是否存在数据库文件
  const dbPath = path.join(__dirname, 'prisma', 'dev.db');
  const dbExists = fs.existsSync(dbPath);
  
  if (!dbExists) {
    console.log('初始化数据库...');
    execSync('npx prisma migrate dev --name init', { stdio: 'inherit' });
  } else {
    console.log('数据库已存在，运行迁移...');
    execSync('npx prisma migrate deploy', { stdio: 'inherit' });
  }
  
  // 4. 生成 Prisma Client
  console.log('4. 生成 Prisma Client...');
  execSync('npx prisma generate', { stdio: 'inherit' });
  
  // 5. 复制必要的文件到 dist 目录
  console.log('5. 复制必要文件...');
  
  // 确保 dist 目录存在
  const distPath = path.join(__dirname, 'dist');
  if (!fs.existsSync(distPath)) {
    fs.mkdirSync(distPath);
  }
  
  // 复制 prisma schema 和数据库文件
  const prismaDir = path.join(__dirname, 'prisma');
  const distPrismaDir = path.join(distPath, 'prisma');
  
  if (!fs.existsSync(distPrismaDir)) {
    fs.mkdirSync(distPrismaDir);
  }
  
  // 复制 schema 文件
  fs.copyFileSync(
    path.join(prismaDir, 'schema.prisma'),
    path.join(distPrismaDir, 'schema.prisma')
  );
  
  // 如果数据库文件存在，也复制它
  if (fs.existsSync(dbPath)) {
    fs.copyFileSync(
      dbPath,
      path.join(distPrismaDir, 'dev.db')
    );
    console.log('数据库文件已复制到 dist/prisma/');
  }
  
  // 复制环境变量文件（如果存在）
  const envFiles = ['.env', '.env.production'];
  envFiles.forEach(envFile => {
    const envPath = path.join(__dirname, envFile);
    if (fs.existsSync(envPath)) {
      fs.copyFileSync(envPath, path.join(distPath, envFile));
      console.log(`${envFile} 已复制到 dist/`);
    }
  });
  
  // 6. 创建部署说明文件
  const deployInstructions = `
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
  `;
  
  fs.writeFileSync(path.join(distPath, 'DEPLOYMENT.md'), deployInstructions);
  
  console.log('部署包已生成在 dist/ 目录');
  console.log('请查看 dist/DEPLOYMENT.md 获取部署说明');
  
} catch (error) {
  console.error('部署过程中出现错误:', error.message);
  process.exit(1);
}