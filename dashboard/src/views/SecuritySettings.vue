<template>
  <AdminLayout :baseUrl="apiUrl" @logout="logout" @refresh="loadSettings">
    <div class="max-w-4xl mx-auto space-y-8">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <router-link to="/settings"
            class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-200 text-gray-500 transition-colors">
            <i class="fa-solid fa-arrow-left"></i>
          </router-link>
          <h1 class="text-2xl font-bold text-gray-800">访问控制</h1>
        </div>
        <div class="flex items-center gap-3">
          <span v-if="saved" class="text-sm text-green-600 font-medium">保存成功</span>
          <button @click="saveSettings" :disabled="loading"
            class="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors text-sm font-medium">
            {{ loading ? '保存中...' : '保存设置' }}
          </button>
        </div>
      </div>

      <!-- CORS 跨域设置 -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fa-solid fa-earth-americas text-red-500"></i> 跨域设置 (CORS)
        </h2>
        <p class="text-sm text-gray-500 mb-4">设置允许调用 API 的来源白名单，多个域名用逗号分隔。白名单同时用于 CORS 响应头、<b>提交评论的服务端来源校验</b>与<b>无感验证的来源域名绑定</b>（后者在「人机验证」页开启）：白名单外的站点提交评论会被 403 拒绝（不落库、不发信）。留空表示不放开跨域、也不启用提交评论的来源校验；填 <code>*</code> 表示允许任意来源（注意：开启「来源域名绑定」后 <code>*</code> 会被视为没有可用白名单）。</p>
        <div class="flex flex-wrap gap-2 mb-2 min-h-[28px]">
          <span v-for="(origin, index) in originList" :key="index"
            class="inline-flex items-center gap-1 px-3 py-1 bg-red-50 border border-red-200 text-red-700 rounded-full text-sm">
            {{ origin }}
            <button @click="removeOrigin(index)" class="hover:text-red-500 transition-colors leading-none">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </span>
        </div>
        <div class="flex gap-2">
          <input v-model="newOrigin" type="text" placeholder="https://example.com" @keydown.enter.prevent="addOrigin"
            class="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent text-sm" />
          <button @click="addOrigin" :disabled="!newOrigin.trim()"
            class="px-4 py-2 bg-red-50 text-red-700 border border-red-200 rounded-lg hover:bg-red-100 disabled:opacity-50 transition-colors text-sm font-medium">
            添加
          </button>
        </div>
        <p class="text-xs text-gray-400 mt-1">输入域名后按回车或点击"添加"，点击标签上的 × 可删除</p>
      </section>

      <!-- 客户端 IP 识别 -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fa-solid fa-network-wired text-red-500"></i> 客户端 IP 识别
        </h2>
        <p class="text-sm text-gray-500 mb-4">
          默认只使用 TCP 连接的对端地址识别访客 IP，因此伪造
          <code class="bg-gray-100 px-1.5 rounded text-gray-600 text-xs">CF-Connecting-IP</code> /
          <code class="bg-gray-100 px-1.5 rounded text-gray-600 text-xs">X-Real-IP</code> /
          <code class="bg-gray-100 px-1.5 rounded text-gray-600 text-xs">X-Forwarded-For</code>
          无法绕过 IP 黑名单、登录失败锁定与评论频率限制。
          <strong>本站部署在 Nginx / Cloudflare 等反向代理之后时请开启本开关</strong>，
          否则所有访客都会被识别成代理 IP，导致频率限制误伤全站。
        </p>
        <div class="flex items-center justify-between">
          <div>
            <p class="text-sm font-medium text-gray-700">信任反向代理下发的 IP 头</p>
            <p class="text-xs text-gray-400 mt-1">开启后 X-Forwarded-For 取最右一跳，客户端伪造的前置条目不会生效</p>
          </div>
          <label class="relative shrink-0 ms-4 inline-flex items-center cursor-pointer">
            <input type="checkbox" v-model="trustProxy" class="sr-only peer">
            <div class="relative w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-red-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-600"></div>
            <span class="ms-3 text-sm font-medium whitespace-nowrap text-gray-700">
              {{ trustProxy ? '已开启' : '已关闭' }}
            </span>
          </label>
        </div>
        <p v-if="trustProxyOverrideHint"
          class="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
          <i class="fa-solid fa-triangle-exclamation mr-1"></i>{{ trustProxyOverrideHint }}
        </p>
      </section>

      <!-- IP 黑名单 -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fa-solid fa-ban text-red-500"></i> IP 黑名单
        </h2>
        <p class="text-sm text-gray-500 mb-4">
          被加入黑名单的 IP 地址将无法提交评论。支持单个 IP（如 <code class="bg-gray-100 px-1.5 rounded text-gray-600 text-xs">192.168.1.1</code>）和 IP 段（如 <code class="bg-gray-100 px-1.5 rounded text-gray-600 text-xs">10.0.0.0/8</code>）。
        </p>

        <div class="space-y-2 mb-4">
          <div v-for="(entry, index) in ipBlacklist" :key="index"
            class="flex items-center justify-between px-4 py-2.5 bg-gray-50 rounded-lg border border-gray-200">
            <div class="flex items-center gap-2">
              <i class="fa-solid fa-network-wired text-gray-400 text-sm"></i>
              <span class="text-sm font-mono text-gray-700">{{ entry }}</span>
            </div>
            <button @click="removeIpEntry(index)"
              class="text-red-500 hover:text-red-700 transition-colors text-sm">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </div>
          <div v-if="ipBlacklist.length === 0" class="text-sm text-gray-400 py-3 text-center">
            暂无 IP 黑名单条目
          </div>
        </div>

        <div class="flex gap-2">
          <input v-model="newIpEntry" type="text" placeholder="192.168.1.1 或 10.0.0.0/8" @keydown.enter.prevent="addIpEntry"
            class="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent text-sm font-mono" />
          <button @click="addIpEntry" :disabled="!newIpEntry.trim()"
            class="px-4 py-2 bg-red-50 text-red-700 border border-red-200 rounded-lg hover:bg-red-100 disabled:opacity-50 transition-colors text-sm font-medium whitespace-nowrap">
            添加
          </button>
        </div>
      </section>

      <!-- 邮箱黑名单 -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fa-solid fa-envelope-circle-check text-red-500"></i> 邮箱黑名单
        </h2>
        <p class="text-sm text-gray-500 mb-4">
          被加入黑名单的邮箱将无法提交评论。输入完整邮箱地址进行精确匹配。
        </p>

        <div class="space-y-2 mb-4">
          <div v-for="(entry, index) in emailBlacklist" :key="index"
            class="flex items-center justify-between px-4 py-2.5 bg-gray-50 rounded-lg border border-gray-200">
            <div class="flex items-center gap-2">
              <i class="fa-solid fa-at text-gray-400 text-sm"></i>
              <span class="text-sm font-mono text-gray-700">{{ entry }}</span>
            </div>
            <button @click="removeEmailEntry(index)"
              class="text-red-500 hover:text-red-700 transition-colors text-sm">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </div>
          <div v-if="emailBlacklist.length === 0" class="text-sm text-gray-400 py-3 text-center">
            暂无邮箱黑名单条目
          </div>
        </div>

        <div class="flex gap-2">
          <input v-model="newEmailEntry" type="email" placeholder="spam@example.com" @keydown.enter.prevent="addEmailEntry"
            class="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent text-sm" />
          <button @click="addEmailEntry" :disabled="!newEmailEntry.trim()"
            class="px-4 py-2 bg-red-50 text-red-700 border border-red-200 rounded-lg hover:bg-red-100 disabled:opacity-50 transition-colors text-sm font-medium whitespace-nowrap">
            添加
          </button>
        </div>
      </section>
    </div>
  </AdminLayout>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount, computed } from 'vue'
import { useRouter, onBeforeRouteLeave } from 'vue-router'
import request from '../utils/request'
import toast from '../utils/toast'
import AdminLayout from '../components/AdminLayout.vue'

const router = useRouter()
const apiUrl = ref(localStorage.getItem('apiUrl') || window.location.origin)

const loading = ref(false)
const saved = ref(false)

const ipBlacklist = ref([])
const emailBlacklist = ref([])
const newIpEntry = ref('')
const newEmailEntry = ref('')
// 客户端 IP 识别：是否信任反向代理下发的 IP 头
const trustProxy = ref(false)
const trustProxyOverride = ref('')

const trustProxyOverrideHint = computed(() => {
  switch (trustProxyOverride.value) {
    case 'env':
      return '该开关已被环境变量 TRUST_PROXY 强制指定，页面上的修改不会生效。'
    case 'config':
      return '该开关已被 config.yaml 中的 TRUST_PROXY 强制指定，页面上的修改不会生效。'
    case 'worker':
      return 'Cloudflare Worker 部署始终使用 Cloudflare 提供的 cf-connecting-ip，此开关在该形态下无需设置。'
    default:
      return ''
  }
})

const originList = ref([])
const newOrigin = ref('')

const addOrigin = () => {
  const val = newOrigin.value.trim()
  if (val && !originList.value.includes(val)) {
    originList.value.push(val)
  }
  newOrigin.value = ''
}

const removeOrigin = (index) => {
  originList.value.splice(index, 1)
}

const addIpEntry = () => {
  const val = newIpEntry.value.trim()
  if (val && !ipBlacklist.value.includes(val)) {
    ipBlacklist.value.push(val)
  }
  newIpEntry.value = ''
}

const removeIpEntry = (index) => {
  ipBlacklist.value.splice(index, 1)
}

const addEmailEntry = () => {
  const val = newEmailEntry.value.trim()
  if (val && !emailBlacklist.value.includes(val)) {
    emailBlacklist.value.push(val)
  }
  newEmailEntry.value = ''
}

const removeEmailEntry = (index) => {
  emailBlacklist.value.splice(index, 1)
}

const isDirty = ref(false)
let initialSnapshot = ''

const takeSnapshot = () => JSON.stringify({
  ipList: [...ipBlacklist.value],
  emailList: [...emailBlacklist.value],
  origins: [...originList.value],
  trustProxy: trustProxy.value,
})

watch([ipBlacklist, emailBlacklist, originList, trustProxy], () => {
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
    const res = await request.get('/admin/settings', { params: { type: 'security' } })
    if (res.code === 200 && res.data) {
      trustProxy.value = res.data.trust_proxy === 'true'
      trustProxyOverride.value = res.data.trust_proxy_override || ''
      try {
        ipBlacklist.value = res.data.ip_blacklist ? JSON.parse(res.data.ip_blacklist) : []
        if (!Array.isArray(ipBlacklist.value)) ipBlacklist.value = []
      } catch {
        ipBlacklist.value = []
      }
      try {
        emailBlacklist.value = res.data.email_blacklist ? JSON.parse(res.data.email_blacklist) : []
        if (!Array.isArray(emailBlacklist.value)) emailBlacklist.value = []
      } catch {
        emailBlacklist.value = []
      }
      originList.value = res.data.allow_origin
        ? res.data.allow_origin.split(',').map(s => s.trim()).filter(Boolean)
        : []
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
  try {
    // 只提交本页负责的四个键；管理员评论密钥在人机验证 / 基本设置页管理，
    // comment_verify_* 已迁到「人机验证」页（/settings/verify）
    const payload = {
      allow_origin: originList.value.join(','),
      ip_blacklist: JSON.stringify(ipBlacklist.value),
      email_blacklist: JSON.stringify(emailBlacklist.value),
      trust_proxy: trustProxy.value ? 'true' : 'false',
    }
    const res = await request.put('/admin/settings', payload)
    if (res.code === 200) {
      saved.value = true
      toast.success('访问控制已保存')
      initialSnapshot = takeSnapshot()
      isDirty.value = false
      setTimeout(() => { saved.value = false }, 3000)
    }
  } catch (e) {
    console.error('Failed to save settings:', e)
    // 后端会校验 IP 黑名单格式，失败原因（如非法 IP/CIDR）需要展示给用户
    toast.error(e?.message || '访问控制保存失败')
  } finally {
    loading.value = false
  }
}

const logout = () => {
  localStorage.removeItem('token')
  router.push('/login')
}
</script>
