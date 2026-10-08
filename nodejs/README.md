# Momo Backend Node.js

Cloudflare Node.js 版本基于 Hono + Drizzle + SQLite 实现，需要服务器进行部署。

## 部署条件

* 拥有一个 Node.js 运行环境，版本 >= 22
* 拥有一个服务器

## 快速部署

#### 1. 克隆项目，安装依赖

可以直接克隆仓库代码，或者从 Release 下载最新的稳定代码，**这里推荐选择后面一种**。

两者的区别在于，Release 中包含了已经编译好的后端管理页面，如果直接克隆仓库，需要自行编译管理页面的代码然后复制到 `public` 目录下。

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

复制 `.env.example` 文件，并修改为实际需要的环境变量，环境变量参考如下。

```bash
cp .env.example .env
vim .env
# 根据情况修改环境变量
```

| 变量名 | 说明 | 
| ------ | ---- | 
| `NODE_ENV` | 在 development 环境下，没有跨域保护，建议部署到服务器的时候选择 production 环境 | 
| `PORT` | 端口号，默认为3000 |
| `DATABASE_URL` | 数据库连接地址 |
| `TRUST_PROXY` | **可选，一般无需设置**。是否信任反向代理下发的客户端 IP 头。请优先在后台「系统设置 → 安全设置 → 客户端 IP 识别」中开关；只有当需要强制指定（例如不可变部署）时才使用本变量，一旦设置将覆盖页面设置 |

#### 3. 编译部署

* **克隆仓库**

如果你选择克隆仓库的方式，则需要先编译后端管理页面的代码，位于 `/dashboard` 目录下。编译完成后，复制到 `./public` 目录下

```bash
cd ../dashboard
pnpm install
pnpm build
cp -r ./dist ../nodejs/public
cd ../nodejs
```

然后按照下面的步骤继续进行

* **从 Release 下载代码**

如果选择从 Release 下载代码的方式，则不需要进行编译，直接运行即可

```bash
pnpm build # 编译后的文件在 dist 目录下
pnpm start
```
启动成功后，访问 http://localhost:3000（端口号根据环境变量中的配置为准）

建议使用 `pm2` 管理进程

```bash
npm install -g pm2
pm2 start dist/app.js --name momo-backend
```

#### 4.修改系统参数

如果显示后端管理页面并可以正常登录则部署成功。**默认用户和密码均为`momo`，首次进入需要修改用户名和密码**，系统参数可以在右侧的系统参数中修改，可以参考[系统参数](##系统参数)。

## 系统参数

部分系统参数如下所示，如果不使用邮箱服务可以关闭。

| 变量名 | 描述 |
| --- | --- |
| `站点名称` | 站点名称，用于邮件提醒中的站点名称 |
| `管理员邮箱` | 管理员邮箱，用于接收新评论通知邮件 |
| `允许的跨域来源 (CORS)` | 允许跨域请求的域名，用逗号分隔 |
| `SMTP 服务器` | SMTP 服务器地址，**如果不需要邮件服务可以不填** |
| `SMTP 端口` | SMTP 端口，默认为 465，**如果不需要邮件服务可以不填** |
| `邮箱用户名` | SMTP 用户名，**如果不需要邮件服务可以不填** |
| `邮箱密码` | SMTP 密码，**如果不需要邮件服务可以不填** |
| `安全连接 (SSL/TLS)` | SMTP 是否使用 SSL，默认为 true |

## 邮件模板

可以自定义自己的邮件模板，支持的参数如下

### 回复通知模板

| 参数名 | 描述 |
| --- | --- |
| `{{toName}}` | 收件人名称 |
| `{{replyAuthor}}` | 评论人的名称 |
| `{{postTitle}}` | 文章的标题 |
| `{{postUrl}}` | 文章的链接 |
| `{{parentComment}}` | 收件人评论的内容 |
| `{{replyContent}}` | 评论人评论的内容 |

默认模板如下：

```html
<div style="background-color: #f4f7f9; padding: 20px 10px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
    <div style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 10px rgba(0,0,0,0.05); border: 1px solid #e1e4e8;">
        <div style="padding: 30px;">
            <h2 style="margin-top: 0; color: #333; font-size: 18px;">Hi {{toName}}，</h2>
            <p style="color: #555; line-height: 1.6;">
              <strong>{{replyAuthor}}</strong> 回复了你在 <span style="color: #007acc;">《{{postTitle}}》</span> 中的评论：
            </p>
            <div style="margin: 20px 0; padding: 12px 16px; border-left: 4px solid #dfe3e8; background-color: #fcfcfc; color: #555; font-size: 14px;">
              {{parentComment}}
            </div>
            <p style="color: #333; font-weight: bold; margin-bottom: 8px;">最新回复：</p>
            <div style="margin-bottom: 30px; padding: 16px; border-radius: 6px; background-color: #f0f7ff; border-left: 4px solid #007acc; color: #2c3e50; line-height: 1.6;">
              {{replyContent}}
            </div>
            <div style="text-align: center;">
              <a href="{{postUrl}}" style="display: inline-block; background-color: #007acc; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 15px; box-shadow: 0 2px 5px rgba(0,122,204,0.2);">
                点击查看回复
              </a>
            </div>
        </div>
        <div style="background-color: #fafbfc; padding: 15px 30px; border-top: 1px solid #eeeeee; text-align: center;">
            <p style="margin: 0; font-size: 12px; color: #999;">此邮件由系统自动发送，请勿直接回复。</p>
        </div>
    </div>
</div>
```

### 新评论通知模板

| 参数名 | 描述 |
| --- | --- |
| `{{postTitle}}` | 文章标题 |
| `{{postUrl}}` |  文章链接 |
| `{{commentAuthor}}` |  评论者昵称 |
| `{{commentContent}}` |  评论内容 |

默认模板如下：

```html
<div style="background-color: #f6f8fa; padding: 40px 20px; min-height: 100%; font-family: 'PingFang SC', 'Microsoft YaHei', Helvetica, Arial, sans-serif;">
    <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.05); overflow: hidden;">
        <div style="height: 4px; background: linear-gradient(90deg, #007acc, #00c6ff);"></div>
        	<div style="padding: 32px;">
            <h2 style="margin: 0 0 16px 0; color: #1a1a1a; font-size: 20px; line-height: 1.4;">有人在你的文章下发表了评论</h2>
            <p style="color: #555; font-size: 15px; margin-bottom: 24px; line-height: 1.6;">
              	<strong style="color: #007acc;">{{commentAuthor}}</strong> 评论了你的文章 <b style="color: #1a1a1a;">《{{postTitle}}》</b>：
            </p>
            <div style="background-color: #f9fafb; border-radius: 8px; padding: 20px; border: 1px dashed #e1e4e8; margin-bottom: 32px;">
              	<div style="color: #444; font-size: 15px; line-height: 1.8; word-break: break-all;">
                	{{commentContent}}
              	</div>
            </div>
            <div style="text-align: center;">
              	<a href="{{postUrl}}" style="display: inline-block; background-color: #007acc; color: #ffffff; padding: 12px 32px; text-decoration: none; border-radius: 50px; font-weight: 500; font-size: 15px; transition: all 0.3s ease;">
                	立即前往查看
              	</a>
            </div>
        </div>
        <div style="background-color: #fafbfc; padding: 20px; text-align: center; border-top: 1px solid #f0f0f0;">
            <p style="margin: 0; font-size: 13px; color: #99aab5; line-height: 1.5;">此邮件由系统自动发送，请勿直接回复。</p>
        </div>
    </div>
</div>
```

## 其他

* 日志存放在 `./logs/` 目录下 
* 超过5次错误登录，则锁定账号 30 分钟，需要重新登录
* 配置好环境变量后，可以使用 `pnpm deploy` 命令一键编译部署，并且会自动备份数据库

## Ngnix 配置

如果使用 Ngnix 和 Cloudflare 做反向代理，需要按照下面的配置 ngnix，确保可以获取到正确的 IP 地址

> **重要**：配置了下面的代理头之后，必须同时开启后端的「信任反向代理下发的 IP 头」开关
> （**系统设置 → 安全设置 → 客户端 IP 识别**，也可用环境变量 `TRUST_PROXY=true` 强制指定），
> 否则后端只会使用代理自身的 IP，导致 IP 黑名单、登录失败锁定与评论频率限制失效或误伤所有访客。
> 未使用反向代理时保持该开关关闭，此时伪造 `CF-Connecting-IP` / `X-Real-IP` / `X-Forwarded-For`
> 无法影响后端的 IP 判定。

```ngnix
server {
    server_name api.example.com; # 这里修改为你的域名

    location / {
        proxy_pass http://localhost:3000; # 这里修改为实际端口号
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

> 说明：开启 `TRUST_PROXY` 后，`X-Forwarded-For` 取**最右一跳**（离本机最近的可信代理看到的地址），
> 因此客户端自行伪造的前置条目不会生效。
