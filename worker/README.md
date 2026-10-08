# Momo Backend Worker

Cloudflare Worker 版本基于 Cloudflare Workers + D1 + KV 实现，无需服务器即可部署运行。

## 部署条件

* 拥有一个 Cloudflare 账号（使用邮箱即可注册，[官网地址](https://www.cloudflare.com/)）
* 拥有一个 Node.js 运行环境，版本 >= 22（本地部署需要）
* 拥有一个域名并托管在 Cloudflare 上（这个不是必须项，但可以提高国内访问速度，也更方便）

## 部署

<!-- 目前提供两种部署方式：1. [一键部署](#一键部署) 2. [本地部署](#本地部署)。

一键部署不需要 Node.js 环境，所有操作在操作面板上完成，操作过程可能会稍微复杂一点；本地部署需要用于 Node.js 环境，但是大部分配置都可以使用命令行完成，操作相对更加简单，也方便后期二次开发。可以根据自己的需求进行选择。 -->

<!-- ### 一键部署

#### 1. 点击下方按钮进行部署

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Motues/Momo-Backend/tree/main/worker)

注意：如果没有绑定Github账号的，可能需要进行一下绑定。

#### 2. 填写信息

根据自己的需求填写需要的信息，这里的环境变量可以先不修改，等之后在设置中修改。

填写完成后下滑，点击 `创建和部署` 按钮。

![deploy-2](../doc/images/worker/deploy-2.png)

#### 3. 绑定 D1 和 KV

等构建完成后进入如下页面，点击中间的 `添加绑定` 按钮，进行数据库的绑定。

![deploy-3](../doc/images/worker/deploy-3.png)

首先绑定数据库，左侧选择 `D1数据库`，然后点击右下角的添加绑定。然后需要设置数据库的相关信息，这里变量名称一定要填写为 `MOMO_DB`，数据库可以选择已有的，或者创建一个新的。完成之后点击右下角的 `添加绑定` 按钮。

![deploy-3-D1-1](../doc/images/worker/deploy-3-D1-1.png)

创建之后我们点击该数据库，进入管理页面；点击左上方选项卡中的 `控制台` 选项，并分别执行下面三条的 SQL 语句，创建表结构。

```sql
CREATE TABLE IF NOT EXISTS Comment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pub_date INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    post_slug TEXT NOT NULL,
    author TEXT NOT NULL,
    email TEXT NOT NULL,
    url TEXT,
    ip_address TEXT,
    device TEXT,
    os TEXT,
    browser TEXT,
    user_agent TEXT,
    content_text TEXT NOT NULL,
    content_html TEXT NOT NULL,
    parent_id INTEGER,
    status TEXT DEFAULT 'pending',
    FOREIGN KEY (parent_id) REFERENCES Comment (id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_post_slug ON Comment(post_slug);
CREATE INDEX IF NOT EXISTS idx_status ON Comment(status);
```

> `pub_date` 统一为 **Unix 毫秒整数**（与 Node/Go 一致）。`SchemaMigration` 表由 Worker 首次请求时自动创建，
> 不需要手工执行；历史数据里的 ISO 字符串也会在那时自动转为毫秒整数（见 `doc/migrations/README.md`）。
![deploy-3-D1-2](../doc/images/worker/deploy-3-D1-2.png)

KV 命名空间的绑定与数据类似。左侧选择 `KV命名空间`，然后点击右下角的添加绑定。这里的变量名称一定要填写为 `MOMO_AUTH_KV`，KV 选择已有的，或者创建一个新的。完成之后点击右下角的 `添加绑定` 按钮。

![deploy-3-KV-1](../doc/images/worker/deploy-3-KV-1.png)

#### 4. 设置环境变量

回到面板首页，点击左上方选项卡中的 `设置` 选项，进入设置页面。我们可以看见变量和机密一栏，已经存在一些环境变量，可以点击编辑进行批量修改。这里可以[参考](#环境变量)下面的表格修改环境变量。对于不使用的环境变量，请删除，以免出现不确定的错误。

注意：尽量不要使用默认的管理员名称和密码。

![deploy-4](../doc/images/worker/deploy-4.png)

#### 5. 检测部署情况

最后访问 `域和路由` 中提供的域名，一般格式为`https://<your-progect-name>.xxx.workers.dev`，返回如下的管理页面。我们需要将接口地址改为当前的后端地址，用户名和密码填写为管理员名称和密码。

如果成功进入后台则表示部署成功。

![deploy-5](../doc/images/worker/deploy-5.png) -->

### 本地部署

#### 1. 下载代码，安装依赖

可以直接克隆仓库代码，或者从 Release 下载最新的稳定版本代码，这里推荐选择后面一种。

两者的区别在于，Release 中包含了已经编译好的后端管理页面，如果直接克隆仓库，需要自行编译管理页面的代码然后复制到 `public` 目录下。

* **克隆仓库**
	```bash
	git clone https://github.com/Motues/Momo-Backend.git
	cd Momo-Backend/worker
	pnpm install
	```
* **从 Release 下载代码**，可以使用命令行，也可以浏览器直接[下载](https://github.com/Motues/Momo-Backend/releases/latest/download/worker.zip)然后解压
	```bash
	wget https://github.com/Motues/Momo-Backend/releases/latest/download/worker.zip
	unzip worker.zip
	cd worker
	pnpm install
	```

如果你选择克隆仓库的方式，则需要先编译后端管理页面的代码，位于 `/dashboard` 目录下。编译完成后，复制到 `./public` 目录下

```bash
pnpm build:dashboard

# 或者使用以下命令逐步执行
cd ../dashboard
pnpm install
pnpm build
cp -r ./dist ../worker/public
cd ../worker
```

#### 2. 配置Cloudflare Workers

对于 D1 和 KV 配置，有两种方法，第一种是直接使用命令行配置，第二种是使用网页面板创建后填写配置文件，这里推荐使用第一种方法。如果想要使用之前 Cloudflare 上面已经创建的数据库，可以选择自行配置 `wrangler.jsonc` 文件。

下面介绍第一种方法。

* **登录到 Cloudflare**
	```bash
	pnpm wrangler login
	```
* **创建数据库和数据库表**，如果遇到提示，请按回车继续
	```bash
	pnpm wrangler d1 create MOMO_DB
	pnpm wrangler d1 execute MOMO_DB --remote --file=./schemas/comment.sql
	```
	运行完成后可以确认一下 `wrangler.jsonc` 中是否有如下配置
	```jsonc
	"d1_databases": [
	    {
	        "binding": "MOMO_DB",
	        "database_name": "MOMO_DB",
	        "database_id": "xxxxxx" // D1 数据库 ID
	    }
	]
	```
	如果`binding`字段不是`MOMO_DB`，请修改为`MOMO_DB`
* **创建 KV 存储**，如果遇到提示，按回车继续
	```bash
	pnpm wrangler kv namespace create MOMO_AUTH_KV
	```
	运行完成后可以确认一下 `wrangler.jsonc` 中是否有如下配置
	```jsonc
	"kv_namespaces": [
	    {
	        "binding": "MOMO_AUTH_KV",
	        "id": "xxxxxxx" // KV 存储 ID
	    }
	]
	```
* **部署上线**
	```bash
	pnpm run deploy
	```

没有异常报错后，可以进入Cloudflare Workers 面板查看是否部署成功，若显示存在一个名称为 `momo-backend-worker` 的项目即推送成功。

![worker-1](../doc/images/worker/dev-1.png)

#### 3. 检测部署情况

部署成功后回得到一个域名，即为后端的域名（格式一般为`https://momo-backend-worker.xxx.workers.dev`。

访问该域名，如果显示后端管理页面并可以正常登录则部署成功。**默认用户和密码均为`momo`，首次进入需要修改用户名和密码**，系统参数可以在右侧的系统参数中修改，可以参考[系统参数](##系统参数)。

将后端域名填写到博客的配置文件中即可使用评论功能。当然也可以使用自定义域名，注意不要使用三级域名，即`*.*.example.com`。

## 系统参数

部分系统参数如下所示，如果不使用邮箱服务可以关闭。

| 变量名 | 描述 |
| --- | --- |
| `站点名称` | 站点名称，用于邮件提醒中的站点名称 |
| `管理员邮箱` | 管理员邮箱，用于接收新评论通知邮件 |
| `允许的跨域来源 (CORS)` | 允许跨域请求的域名，用逗号分隔。**留空即拒绝所有跨域请求**；填 `*` 表示允许任意来源 |
| `SMTP 服务器` | SMTP 服务器地址，**如果不需要邮件服务可以不填** |
| `SMTP 端口` | SMTP 端口，默认为 465，**如果不需要邮件服务可以不填** |
| `邮箱用户名` | SMTP 用户名，**如果不需要邮件服务可以不填** |
| `邮箱密码` | SMTP 密码，**如果不需要邮件服务可以不填** |
| `安全连接 (SSL/TLS)` | SMTP 是否使用 SSL，默认为 true |

> Worker 版部署在 Cloudflare 边缘，客户端 IP 一律取自 Cloudflare 覆写的 `cf-connecting-ip` 头，
> 客户端无法伪造，因此**不需要** Node/Go 版本中的 `TRUST_PROXY` 开关。
> 面板上的同名开关（安全设置 → 客户端 IP 识别）在 Worker 形态下不生效，切到 Worker 时页面会给出提示。

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

## 本地测试

```bash
pnpm run dev
```