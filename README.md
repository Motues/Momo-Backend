# Momo-Backend

[Momo](https://github.com/Motues/Momo)的后端评论系统

## 部署

1. 克隆仓库
    ```bash
    git clone https://github.com/Motues/Momo-Backend.git
    cd Momo-Backend
    ```
2. 安装依赖并允许
    ```bash
    cp .env.example .env
    vim .env
    # 根据情况修改环境变量
    pnpm install
    pnpm dev
    ```
3. 编译部署
    ```bash
    pnpm build # 编译后的文件在 dist 目录下
    pnpm start
    ```
    启动成功后，访问 http://localhost:17171

## 配置 .env

| 变量名 | 说明 | 
| ------ | ---- | 
| `NODE_ENV` | 在 development 环境下，没有跨域保护，建议部署到服务器的时候选择 production 环境 | 
| `PORT` | 端口号，默认为17171 |
| `DATABASE_URL` | 数据库连接地址 |
| `ALLOW_ORIGIN` | 允许跨域访问的域名 |
| `RESEND_API_KEY` | Resend API Key，用于启用邮箱通知功能；如不开启，请设置为空 |
| `RESEND_FROM_EMAIL` | 邮件发送通知的邮箱 |
| `ADMIN_NAME` | 登录账号 |
| `ADMIN_PASSWORD` | 登录密码 |

## 其他

* 日志存放在 `./logs/` 目录下 
* 登录超过5次错误登录，则锁定账号，需要重新登录
* 如果需要更新程序，可以直接运行 `deploy.sh` 脚本，会自动备份数据库
* 由于文章采用静态部署，后端只提供评论系统

## Ngnix 配置

如果使用 Ngnix 和 Cloudflare做反向代理，需要按照下面的配置 ngnix，确保可以获取到正确的 IP 地址

```ngnix
server {
    server_name api.example.com; # 后端域名

    location / {
        proxy_pass http://localhost:17171;
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

## 待完成

- [ ] 完善文档
- [ ] 编写 `docker-commpose.yml`
- [ ] 使用 Go 重构代码，降低资源占用（重要）
- [ ] 修复未知问题
