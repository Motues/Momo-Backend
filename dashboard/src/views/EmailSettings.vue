<template>
  <AdminLayout :baseUrl="apiUrl" @logout="logout" @refresh="loadSettings">
    <div class="max-w-4xl mx-auto space-y-8">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <router-link to="/settings"
            class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-200 text-gray-500 transition-colors">
            <i class="fa-solid fa-arrow-left"></i>
          </router-link>
          <h1 class="text-2xl font-bold text-gray-800">邮件通知设置</h1>
        </div>
        <div class="flex items-center gap-3">
          <span v-if="saved" class="text-sm text-green-600 font-medium">保存成功</span>
          <button @click="saveSettings" :disabled="loading"
            class="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors text-sm font-medium">
            {{ loading ? '保存中...' : '保存设置' }}
          </button>
        </div>
      </div>

      <!-- SMTP 邮件设置 -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-lg font-semibold text-gray-800 flex items-center gap-2">
            <i class="fa-solid fa-envelope text-blue-500"></i> SMTP 服务器
          </h2>
          <label class="relative shrink-0 ms-4 inline-flex items-center cursor-pointer">
            <input type="checkbox" v-model="form.email_enabled" class="sr-only peer" true-value="true" false-value="false">
            <div class="relative w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
            <span class="ms-3 text-sm font-medium whitespace-nowrap text-gray-700">
              {{ form.email_enabled === 'true' ? '已开启' : '已关闭' }}
            </span>
          </label>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">SMTP 服务器</label>
            <input v-model="form.smtp_host" type="text" placeholder="smtp.example.com"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">SMTP 端口</label>
            <input v-model="form.smtp_port" type="text" placeholder="465"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">邮箱用户名</label>
            <input v-model="form.email_user" type="text"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">邮箱密码</label>
            <input v-model="form.email_password" type="password" placeholder="留空则不修改"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">安全连接 (SSL/TLS)</label>
            <SelectMenu v-model="form.email_secure" class="w-full" title="SMTP 安全连接方式"
              :options="[
                { label: '是 (端口 465)', value: 'true' },
                { label: '否 (端口 587)', value: 'false' },
              ]" />
          </div>
        </div>

        <div class="mt-4 flex items-center gap-3 pt-4 border-t border-gray-100">
          <button @click="handleTestEmail" :disabled="testingEmail"
            class="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors text-sm font-medium flex items-center gap-2">
            <i v-if="testingEmail" class="fa-solid fa-circle-notch animate-spin"></i>
            <i v-else class="fa-solid fa-paper-plane"></i>
            {{ testingEmail ? '发送中...' : '发送测试邮件' }}
          </button>
          <p class="text-xs text-gray-400">保存设置后，点击测试 SMTP 配置是否正确</p>
        </div>
      </section>

      <!-- 邮箱验证 -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fa-solid fa-shield-halved text-blue-500"></i> 邮箱验证
        </h2>
        <div class="flex items-center justify-between mb-4">
          <div>
            <p class="text-sm font-medium text-gray-700">启用邮箱验证</p>
            <p class="text-xs text-gray-400 mt-1">开启后，未验证邮箱的评论将先保存为待审核状态，验证后自动发布</p>
          </div>
          <label class="relative shrink-0 ms-4 inline-flex items-center cursor-pointer">
            <input type="checkbox" v-model="form.email_verify_enabled" class="sr-only peer" true-value="true" false-value="false">
            <div class="relative w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
            <span class="ms-3 text-sm font-medium whitespace-nowrap text-gray-700">
              {{ form.email_verify_enabled === 'true' ? '已启用' : '已禁用' }}
            </span>
          </label>
        </div>
        <div class="pt-4 border-t border-gray-100">
          <label class="block text-sm font-medium text-gray-700 mb-1">API 地址</label>
          <input v-model="form.verify_base_url" type="text" placeholder="https://api.example.com"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm" />
          <p class="text-xs text-gray-400 mt-1">验证邮件链接的基础地址，不能以 / 结尾</p>
        </div>
      </section>

      <!-- 邮件模板 -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fa-solid fa-pen-to-square text-blue-500"></i> 邮件模板
        </h2>
        <p class="text-sm text-gray-500 mb-4">留空则使用默认模板。</p>

        <div class="space-y-6">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">回复通知模板</label>
            <p class="text-xs text-gray-400 mb-2">
              发送给评论作者，通知其评论被回复。可用占位符：
            </p>
            <div class="space-y-1 mb-2 text-xs">
              <div><code class="bg-gray-100 px-1.5 rounded text-gray-600">&#123;&#123;toName&#125;&#125;</code> <span class="text-gray-400 ml-1">被回复者昵称</span></div>
              <div><code class="bg-gray-100 px-1.5 rounded text-gray-600">&#123;&#123;replyAuthor&#125;&#125;</code> <span class="text-gray-400 ml-1">回复者昵称</span></div>
              <div><code class="bg-gray-100 px-1.5 rounded text-gray-600">&#123;&#123;postTitle&#125;&#125;</code> <span class="text-gray-400 ml-1">文章标题</span></div>
              <div><code class="bg-gray-100 px-1.5 rounded text-gray-600">&#123;&#123;postUrl&#125;&#125;</code> <span class="text-gray-400 ml-1">文章链接</span></div>
              <div><code class="bg-gray-100 px-1.5 rounded text-gray-600">&#123;&#123;parentComment&#125;&#125;</code> <span class="text-gray-400 ml-1">原评论内容</span></div>
              <div><code class="bg-gray-100 px-1.5 rounded text-gray-600">&#123;&#123;replyContent&#125;&#125;</code> <span class="text-gray-400 ml-1">回复内容</span></div>
            </div>
            <textarea v-model="form.reply_template" rows="6"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm font-mono"
              placeholder="留空使用默认模板"></textarea>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">新评论通知模板</label>
            <p class="text-xs text-gray-400 mb-2">
              发送给站长，通知有新评论。可用占位符：
            </p>
            <div class="space-y-1 mb-2 text-xs">
              <div><code class="bg-gray-100 px-1.5 rounded text-gray-600">&#123;&#123;postTitle&#125;&#125;</code> <span class="text-gray-400 ml-1">文章标题</span></div>
              <div><code class="bg-gray-100 px-1.5 rounded text-gray-600">&#123;&#123;postUrl&#125;&#125;</code> <span class="text-gray-400 ml-1">文章链接</span></div>
              <div><code class="bg-gray-100 px-1.5 rounded text-gray-600">&#123;&#123;commentAuthor&#125;&#125;</code> <span class="text-gray-400 ml-1">评论者昵称</span></div>
              <div><code class="bg-gray-100 px-1.5 rounded text-gray-600">&#123;&#123;commentContent&#125;&#125;</code> <span class="text-gray-400 ml-1">评论内容</span></div>
            </div>
            <textarea v-model="form.notification_template" rows="6"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm font-mono"
              placeholder="留空使用默认模板"></textarea>
          </div>
        </div>
      </section>
    </div>
  </AdminLayout>
</template>

<script setup>
import { ref, reactive, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRouter, onBeforeRouteLeave } from 'vue-router'
import request from '../utils/request'
import toast from '../utils/toast'
import AdminLayout from '../components/AdminLayout.vue'
import SelectMenu from '../components/SelectMenu.vue'

const router = useRouter()
const apiUrl = ref(localStorage.getItem('apiUrl') || window.location.origin)

const loading = ref(false)
const saved = ref(false)

const isDirty = ref(false)
let initialSnapshot = ''

const form = reactive({
  smtp_host: '',
  smtp_port: '',
  email_user: '',
  email_password: '',
  email_secure: 'true',
  email_enabled: 'true',
  email_verify_enabled: 'false',
  verify_base_url: '',
  reply_template: '',
  notification_template: '',
})

const takeSnapshot = () => JSON.stringify({ ...form })

watch(form, () => {
  isDirty.value = takeSnapshot() !== initialSnapshot
}, { deep: true })

onBeforeRouteLeave((to, from, next) => {
  if (isDirty.value) {
    const answer = window.confirm('有未保存的修改，确定要离开吗？')
    if (!answer) { next(false); return }
  }
  next()
})

const handleBeforeUnload = (e) => {
  if (isDirty.value) {
    e.preventDefault()
    e.returnValue = ''
  }
}
onMounted(() => window.addEventListener('beforeunload', handleBeforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', handleBeforeUnload))

const loadSettings = async () => {
  try {
    const res = await request.get('/admin/settings', { params: { type: 'email' } })
    if (res.code === 200 && res.data) {
      Object.assign(form, res.data)
    }
  } catch (e) {
    console.error('Failed to load settings:', e)
  }
  initialSnapshot = takeSnapshot()
  isDirty.value = false
}

onMounted(() => {
  loadSettings()
})

const saveSettings = async () => {
  loading.value = true
  saved.value = false

  // 验证：启用邮箱验证时必须填写 API 地址
  if (form.email_verify_enabled === 'true' && !form.verify_base_url) {
    toast.error('启用邮箱验证时必须填写 API 地址')
    loading.value = false
    return
  }

  try {
    const payload = { ...form }
    if (!payload.email_password) {
      delete payload.email_password
    }
    // 去除末尾斜杠
    if (payload.verify_base_url) {
      payload.verify_base_url = payload.verify_base_url.replace(/\/+$/, '')
    }
    const res = await request.put('/admin/settings', payload)
    if (res.code === 200) {
      saved.value = true
      toast.success('设置已保存')
      initialSnapshot = takeSnapshot()
      isDirty.value = false
      setTimeout(() => { saved.value = false }, 3000)
    }
  } catch (e) {
    console.error('Failed to save settings:', e)
  } finally {
    loading.value = false
  }
}

const testingEmail = ref(false)

const handleTestEmail = async () => {
  testingEmail.value = true
  try {
    const res = await request.post('/admin/settings/test-email')
    if (res.code === 200) {
      toast.success('测试邮件已发送，请查收')
    }
  } catch (e) {
    toast.error(e.message || '测试邮件发送失败')
  } finally {
    testingEmail.value = false
  }
}

const logout = () => {
  localStorage.removeItem('token')
  router.push('/login')
}
</script>
