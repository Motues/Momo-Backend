# API 接口定义

## 用户接口

### 提交评论（POST `/api/comments`）

**请求体**：
```json
{
  "post_slug": "/posts/my-article",
  "author": "张三",
  "email": "zhangsan@example.com",
  "url": "https://example.com",
  "content": "写得真好！",
  "parent_id": null,
  "post_url": "https://blog.example.com/posts/my-article",
}
```

**响应（成功）**：
```json
{ "message": "Comment submitted. Awaiting moderation." }
```
---

### 获取评论（GET `/api/comments`）

**查询参数**：
- `post_slug`（必需）
- `page`（默认 1）
- `limit`（默认 20，最大 50）
- `nested`（默认 true）

**响应**：
`GET /api/comments?post_slug=...&nested=false`

```json
{
  "data": [
    {
      "id": 123,
      "author": "张三",
      "url": "https://example.com",
      "avatar": "https://example.com/avatar.png",
      "contentText": "写得真好！",
      "contentHtml": "<p>写得真好！</p>",
      "pubDate": "2025-10-23T10:00:00Z",
      "parentId": null
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1
  }
}
```

`GET /api/comments?post_slug=...&nested=true`

```json
{
  "data": [
    {
      "id": 123,
      "author": "张三",
      "contentText": "写得真好！",
      "contentHtml": "<p>写得真好！</p>",
      "pubDate": "2025-10-23T10:00:00Z",
      "replies": [
        {
          "id": 124,
          "author": "李四",
          "contentText": "同意",
          "contentHtml": "<p>同意</p>",
          "pubDate": "2025-10-23T11:00:00Z",
          "replies": []
        }
      ]
    }
  ]
}
```

> 🔒 仅返回 `status = 'approved'` 的评论

---

## 管理员接口（需 Authorization: Bearer <ADMIN_TOKEN>）

### 删除评论 (DELETE `/admin/comments/delete`)

**请求参数**：

- `id`（必需）
- `key`（必需）

**响应**：
`DELETE /admin/comments/delete?id=...`  

```json
{
  "message": "Comment deleted, id: 1." ,
}
```

### 获取所有评论 (GET `/admin/comments/list`)

**查询参数**：
- `page`（默认 1）
- `key`（必需）

**响应**：
`GET /admin/comments/list&page=1&key=...`

```json
{
  "data": [
    {
      "id": 123,
      "pubDate": "2025-10-23T10:00:00Z",
      "author": "张三",
      "email": "zhangsan@example.com",
      "url": "https://example.com",
      "ipAddress": "192.168.1.1",
      "contentText": "写得真好！",
      "contentHtml": "<p>写得真好！</p>",
      "status": "approved",
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1
  }
}
```

如果key不正确，返回401
```json
{
  "message": "Invalid key"
}
```

### 修改评论状态 (PUT `/admin/comments/status`)

**请求参数**：
- `id`（必需）
- `status`（必需）
- `key`（必需）

**响应**：
`PUT/admin/comments/status?id=...&status=...`

```json
{
  "message": "Comment status updated, id: 1, status: approved."
}
```

### 登录 (POST `/admin/login`)

**请求体**：
```json
{
  "name": "admin",
  "password": "password"
}
```

**响应**：

如果登录成功，返回一个key
```json
{
  "key": "<KEY>"
}
```

否则返回
```json
{
  "message": "Invalid username or password"
}
```
