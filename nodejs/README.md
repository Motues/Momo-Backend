# Momo Backend Node.js

Cloudflare Node.js 版本基于 Koa + Prisma + SQLite 实现，需要服务器进行部署。

## 部署条件

* 拥有一个 Node.js 运行环境，版本 >= 22
* 拥有一个服务器

## 快速部署

#### 1. 克隆项目，安装依赖

可以直接克隆仓库代码，或者从 Release 下载最新的稳定代码，这里推荐选择后面一种。

* **克隆仓库**
	```bash
	git clone https://github.com/Motues/Momo-Backend.git
	cd Momo-Backend/nodejs
	pnpm install
	```
* **从 Release 下载代码**，可以使用命令行，也可以浏览器直接下载然后解压
	```bash
	wget https://github.com/Motues/Momo-Backend/releases/latest/download/nodejs.zip
    unzip nodejs.zip
    cd nodejs
    pnpm install
	```

#### 2. 设置环境变量

复制 `.env.example` 文件，并修改为实际需要的环境变量，环境变量[参考](#环境变量)

```bash
cp .env.example .env
vim .env
# 根据情况修改环境变量
```

#### 3. 编译部署

```bash
pnpm build # 编译后的文件在 dist 目录下
pnpm start
```
启动成功后，访问 http://localhost:17171

建议使用 `pm2` 管理进程

```bash
npm install -g pm2
pm2 start dist/app.js --name momo-backend
```

## 环境变量

| 变量名 | 说明 | 
| ------ | ---- | 
| `NODE_ENV` | 在 development 环境下，没有跨域保护，建议部署到服务器的时候选择 production 环境 | 
| `PORT` | 端口号，默认为17171 |
| `DATABASE_URL` | 数据库连接地址 |
| `ALLOW_ORIGIN` | 允许跨域访问的域名 |
| `RESEND_API_KEY` | Resend API Key，用于启用邮箱通知功能；**如不开启，请设置为空** |
| `RESEND_FROM_EMAIL` | Resend 邮件发送通知的邮箱，需要在 Resend 中认证；**如不开启，请设置为空** |
| `EMAIL_ADDRESS` | 管理员邮件接收通知的邮箱；**如不开启，请设置为空** |
| `ADMIN_NAME` | 管理员登录账号 |
| `ADMIN_PASSWORD` | 管理员登录密码 |

**注:** [Resend 官网](https://resend.com/)

## 其他

* 日志存放在 `./logs/` 目录下 
* 超过5次错误登录，则锁定账号 10 分钟，需要重新登录
* 配置好环境变量后，可以使用 `pnpm deploy` 命令一键编译部署，并且会自动备份数据库

## Ngnix 配置

如果使用 Ngnix 和 Cloudflare 做反向代理，需要按照下面的配置 ngnix，确保可以获取到正确的 IP 地址

```ngnix
server {
    server_name api.example.com; # 这里修改为你的域名

    location / {
        proxy_pass http://localhost:17171; # 这里修改为实际端口号
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header CF-Connecting-IP $http_cf_connecting_ip;
        proxy_set_header True-Client-IP $http_true_client_ip;
        proxy_cache_bypass $http_upgrade;
    }
}
```
