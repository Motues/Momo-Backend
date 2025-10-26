# API 接口定义

## 提交评论（POST `/api/comments`）

**请求体**：
```json
{
  "post_slug": "/posts/my-article",
  "author": "张三",
  "email": "zhangsan@example.com",
  "url": "https://example.com",
  "content": "写得真好！",
  "parent_id": null,
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

### 管理接口（需 Authorization: Bearer <ADMIN_TOKEN>）

- `DELETE /admin/comments/delete?id=...`  
  删除评论
  响应：
  `{ message: "Comment deleted, id: 1." }`

- `GET /admin/comments/list`  
  获取所有评论，格式如下
```json
{
  "data": [
    {
      "post_slug": "/posts/my-article",
      "comments": [
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
    },
    {
      "post_slug": "/posts/my-article-2",
      "comments": []
    }
  ]
}
```
