import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { Bindings } from './bindings'
import { HomeView } from './views/html'
import { customCors } from './utils/cors'
import { adminAuth } from './utils/auth'

import { getComments } from './api/public/getComments'
import { postComment } from './api/public/postComment'
import { adminLogin } from './api/admin/login'
import { deleteComment } from './api/admin/deleteComment'
import { listComments } from './api/admin/listComments'
import { updateStatus } from './api/admin/updateStatus'

const app = new Hono<{ Bindings: Bindings }>()

// 跨域
app.use('/api/*', async (c, next) => {
  const corsMiddleware = customCors(c.env.ALLOW_ORIGIN)
  return corsMiddleware(c, next)
})

// 首页
app.get('/', (c) => c.html(HomeView))


// API
app.get('/api/comments', getComments)
app.post('/api/comments', postComment)

app.post('/admin/login', adminLogin)
app.use('/admin/*', adminAuth)
app.delete('/admin/comments/delete', deleteComment);
app.get('/admin/comments/list', listComments);
app.put('/admin/comments/status', updateStatus);

export default app