## Momo Backend Go

Momo Backend Go 是一个基于 Go 语言开发的博客评论系统，使用 Gin + SQLite 实现。

## 部署条件

* 拥有一个支持 Linux/Windows 的服务器
* 不需要任何运行时环境，直接使用编译好的二进制文件
* 如果使用 Docker 部署，需要安装 Docker 环境

## 快速部署

### 1. 下载二进制文件

从 [Release](https://github.com/Motues/Momo-Backend/releases/latest) 下载最新的 Go 版本压缩包，根据你的系统选择对应的文件：

* **Linux**: `go-linux-amd64.tar.gz` 
* **Windows**: `go-windows-amd64.zip`

以 Linux 为例，可以使用自带的脚本进行部署：

```bash
wget https://github.com/Motues/Momo-Backend/releases/latest/download/go-linux-amd64.tar.gz
tar -xzf mgo-linux-amd64.tar.gz
chmod +x momo.bash
./momo.bash
# 然后根据提示进行操作
```

### 2. 设置环境变量

运行之后会生成一个 `./config/config.yaml` 文件，可以参考下面的环境变量，请根据需要修改，修改后需要重启服务。

```bash
vim ./config/config.yaml
# 根据实际情况修改环境变量
./momo.bash
```

**环境变量**

```yaml
# ./config/config.yaml
PORT: 3000  # server port
# TRUST_PROXY: true  # 可选：是否信任反向代理下发的客户端 IP 头
```

> **TRUST_PROXY 说明**：该开关默认由后台页面控制，**无需修改配置文件**：
> 进入「系统设置 → 安全设置 → 客户端 IP 识别」即可开启/关闭，设置保存在数据库中。
> 只有在需要强制指定（例如不可变部署）时才在此填写或使用环境变量 `TRUST_PROXY`，
> 优先级为：环境变量 > 配置文件 > 页面设置。
>
> - 关闭时（默认）后端只使用 TCP 连接对端地址，
>   伪造 `CF-Connecting-IP` / `X-Real-IP` / `X-Forwarded-For` 无法绕过
>   IP 黑名单、登录失败锁定与评论频率限制。
> - **部署在 Nginx / Cloudflare 之后时必须开启**，否则所有请求会被识别为代理 IP。
>   开启后 `X-Forwarded-For` 取**最右一跳**，客户端伪造的前置条目不会生效。

启动成功后，访问 `http://localhost:3000`

### 3. 修改系统参数

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

## Docker 部署

使用 Docker Compose 一键启动：

```yaml
# docker-compose.yml
services:
  momo-backend:
    image: ghcr.io/motues/momo-backend:latest
    container_name: momo-backend
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    restart: always
```

```bash
docker compose up -d
```

或直接运行容器：

```bash
docker run -d \
  --name momo-backend \
  -p 3000:3000 \
  -v momo-data:/app/data \
  ghcr.io/motues/momo-backend:latest
```

数据目录说明：
- `/app/data` — 数据库文件，需挂载持久化存储

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

* 日志存放在 `momo.log` 中，可以使用 `momo.bash` 脚本查看
* 超过 5 次错误登录，则锁定 IP 30 分钟
* Token 有效期为 20 分钟
* 数据库文件默认存放在 `./data/momo.db`
* 静态文件存放在 `./public` 中，如果只需要更新后台管理页面，则可以直接替换 `./public` 中的文件

## Ngnix 配置

如果使用 Ngnix 和 Cloudflare 做反向代理，需要按照下面的配置 ngnix，确保可以获取到正确的 IP 地址

> 配置了下面的代理头之后，请同时在后台开启「安全设置 → 客户端 IP 识别 → 信任反向代理下发的 IP 头」
> （或在 `./config/config.yaml` 中写 `TRUST_PROXY: true` 强制指定），否则后端只会使用代理自身的 IP。

```nginx
server {
    server_name api.example.com; # 这里修改为你的域名

    location / {
        proxy_pass http://localhost:17172; # 这里修改为实际端口号
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

## 自行编译

如果你想要自行编译源代码，需要安装 Go 1.25 环境：

```bash
cd go
go mod download
go build -o ./build/momo-backend main.go
```

编译完成后，将生成的二进制文件移动到合适的位置，并按照上述步骤进行配置。

## 从 Node.js 版本迁移

如果你正在使用 Node.js 版本，可以直接替换为 Go 版本：

1. 备份数据库文件（通常位于 `nodejs/prisma/dev.db` 或你自定义的路径）
2. 下载 Go 版本的二进制文件
3. 配置相同的环境变量
4. 将备份的数据库文件放到 `./data/data.db` 
5. 启动 Go 版本服务
