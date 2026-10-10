import { Hono } from 'hono'
import { Bindings } from './bindings'
import { customCors } from './utils/cors'
import { getSetting } from './utils/settings'
import { adminAuth } from './utils/auth'
import { ensureMigrated } from './utils/migrations'

import { getComments } from './api/public/getComments'
import { postComment } from './api/public/postComment'
import { verifyEmail } from './api/public/verifyEmail'
import { verifyChallenge } from './api/public/verifyChallenge'
import { verifySolutionHandler } from './api/public/verifySolution'
import { adminLogin } from './api/admin/login'
import { getSettings, updateSettings, testEmail } from './api/admin/settings'
import { changePassword, adminLogout } from './api/admin/password'
import { listComments } from './api/admin/listComments'
import { updateStatus } from './api/admin/updateStatus'
import { updateComment } from './api/admin/updateComment'
import { statsOverview } from './api/admin/statsOverview'
import { verifyOverview } from './api/admin/verifyOverview'
import { verifyRecords } from './api/admin/verifyRecords'
import { userList } from './api/admin/userList'
import { userComments } from './api/admin/userComments'
import { addUserToBlacklist, removeUserFromBlacklist } from './api/admin/userBlacklist'
import { exportSettings, exportComments } from './api/admin/dataExport'
import { importComments, importSettings } from './api/admin/dataImport'

const app = new Hono<{ Bindings: Bindings }>()

// 幂等启动自迁移：每个 isolate 只执行一次，失败仅记录日志不阻断请求
app.use('*', async (c, next) => {
  await ensureMigrated(c.env)
  await next()
})

// 跨域（从数据库读取允许的来源；未配置即拒绝跨域，与 Node/Go 默认姿态一致）
app.use('/api/*', async (c, next) => {
  const allowOriginStr = await getSetting(c.env, "allow_origin") || ''
  const corsMiddleware = customCors(allowOriginStr)
  return corsMiddleware(c, next)
})

// API
app.get('/api/comments', getComments)
app.post('/api/comments', postComment)
app.get('/api/verify-email/verify', verifyEmail)

// 无感验证（Turnstile 风格）
app.post('/api/verify/challenge', verifyChallenge)
app.post('/api/verify/solution', verifySolutionHandler)

app.post('/admin/login', adminLogin)
app.use('/admin/*', adminAuth)
app.get('/admin/settings', getSettings);
app.put('/admin/settings', updateSettings);
app.post('/admin/settings/test-email', testEmail);
app.put('/admin/password', changePassword);
app.post('/admin/logout', adminLogout);
app.get('/admin/comments/list', listComments);
app.put('/admin/comments/status', updateStatus);
app.put('/admin/comments/edit', updateComment);
app.get('/admin/stats/overview', statsOverview);
// 认证记录（无感验证的签发/通过/失败统计与明细）
app.get('/admin/verify/overview', verifyOverview);
app.get('/admin/verify/records', verifyRecords);
app.get('/admin/stats/users', userList);
app.get('/admin/stats/users/comments', userComments);
app.post('/admin/users/blacklist', addUserToBlacklist);
app.delete('/admin/users/blacklist', removeUserFromBlacklist);
app.get('/admin/data/export/settings', exportSettings);
app.get('/admin/data/export/comments', exportComments);
app.post('/admin/data/import/comments', importComments);
app.post('/admin/data/import/settings', importSettings);

export default app