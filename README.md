<div align="center">
<h1>Momo Backend</h1>
<span>
<img src="https://img.shields.io/badge/Node->=22-green" alt="Node">
<img src="https://img.shields.io/badge/Cloudflare-Worker-orange?logo=cloudflare" alt="Cloudflare Worker">
</span>
</div>

<div align="center">
<span>
<img src="https://img.shields.io/badge/Prisma-2E7C7E?logo=prisma&logoColor=white" alt="Prisma">
<img src="https://img.shields.io/badge/SQLite-3E8E41?logo=sqlite&logoColor=white" alt="SQLite">
<img src="https://img.shields.io/badge/Hono-FF6B35?logo=hono&logoColor=white" alt="Hono">
<img src="https://img.shields.io/badge/Koa-33333D?logo=koa&logoColor=white" alt="Koa">
<img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TS">
</span>

</div>

<!-- ![License](https://img.shields.io/badge/license-MIT-blue) -->

<div align="center">
轻量，便捷，易部署的博客评论系统 
</div>

## 快速开始

Momo Backend 包含前端部署和服务器部署两个模块：

### 前端部署

部署方式可以参考[frontend](./frontend/README.md)。如果需要自己实现前端样式，可以参考[api文档](./doc/api.md)。

### 后端部署

目前提供了两种部署方式：

* 基于 Node.js 开发环境，本地部署
* 基于 Cloudflare Worker，无需服务器部署

请访问对应的文档获取具体的部署信息：[Node.js 版本](./nodejs/README.md)，[Cloudflare Worker 版本](./worker/README.md)

后续会提供Vercel版本；如果需要提供其他平台的部署方式，可以告诉我。

## 其他

* [API 文档](./doc/api.md)
* [数据库表结构](./doc/data_table.md)
* [Momo 静态博客](https://github.com/Motues/Momo)

## TODO

- [ ] 规范 API 接口
- [ ] 使用 Go 重构新的版本（提高速度，降低资源占用）
- [ ] 提供统一，便捷的前端接口
- [ ] 提供 Docker 一键部署
- [ ] 完善文档

> 欢迎对本仓库提出建议，进行优化
> Made with ❤️ by [Motues](https://github.com/Motues)
