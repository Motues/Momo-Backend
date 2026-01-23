# Momo Comment Frontend

提供简单、易用的前端评论组件，使用 Svelte 构建。

## 快速使用

只需要导入一个js文件，就可以在前端使用。

```html
<div id="momo-comment"></div>

<script src="https://cdn.jsdelivr.net/npm/@motues/momo-comment/dist/momo-comment.min.js"></script>
<script>
    momo.init({
        el: '#momo-comment', // 评论容器的 id
        title: 'Test', // 文章标题
        slugId: 'blog/test', // 文章的唯一 slugId
        lang: 'zh-cn', // 语言，目前支持 zh-cn, en
        apiUrl: 'https://api-momo.motues.top' // 后端地址
        });
</script>
```

## 自定义样式

目前可以修改评论组件的颜色，后续会推出自定义样式的功能。颜色通过设置全局变量来修改，并且支持黑暗模式。

```css
:root {
    --momo-text-color: #d51111;            /* 文字颜色 */
    --momo-button-border-color: #e5e5e5;   /* 按钮边框颜色 */
    --momo-button-hover-bg-color: #f5f5f5; /* 按钮背景颜色（hover 状态）*/
    --momo-link-color: #003b6e;            /* 链接颜色 */
}
[data-theme="dark"] { 
    --momo-text-color: #3ad8d8;
    --momo-button-border-color: #2e2e2e;
    --momo-button-hover-bg-color: #3c3c3c;
    --momo-link-color: #fff;
}
```

## 样式效果

![comment](./doc/images/comment.png)