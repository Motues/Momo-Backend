<template>
  <AdminLayout :baseUrl="apiUrl" @logout="logout" @refresh="loadSettings">
    <div class="max-w-4xl mx-auto space-y-8">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <router-link to="/settings"
            class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-200 text-gray-500 transition-colors">
            <i class="fa-solid fa-arrow-left"></i>
          </router-link>
          <h1 class="text-2xl font-bold text-gray-800">安全设置</h1>
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
          <i class="fa-solid fa-earth-americas text-orange-500"></i> 跨域设置 (CORS)
        </h2>
        <p class="text-sm text-gray-500 mb-4">设置允许访问 API 的跨域来源，多个域名用逗号分隔。</p>
        <div class="flex flex-wrap gap-2 mb-2 min-h-[28px]">
          <span v-for="(origin, index) in originList" :key="index"
            class="inline-flex items-center gap-1 px-3 py-1 bg-orange-50 border border-orange-200 text-orange-700 rounded-full text-sm">
            {{ origin }}
            <button @click="removeOrigin(index)" class="hover:text-red-500 transition-colors leading-none">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </span>
        </div>
        <div class="flex gap-2">
          <input v-model="newOrigin" type="text" placeholder="https://example.com" @keydown.enter.prevent="addOrigin"
            class="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-transparent text-sm" />
          <button @click="addOrigin" :disabled="!newOrigin.trim()"
            class="px-4 py-2 bg-orange-50 text-orange-700 border border-orange-200 rounded-lg hover:bg-orange-100 disabled:opacity-50 transition-colors text-sm font-medium">
            添加
          </button>
        </div>
        <p class="text-xs text-gray-400 mt-1">输入域名后按回车或点击"添加"，点击标签上的 × 可删除</p>
      </section>

      <!-- 客户端 IP 识别 -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fa-solid fa-network-wired text-sky-500"></i> 客户端 IP 识别
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
          <label class="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" v-model="trustProxy" class="sr-only peer">
            <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-sky-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-sky-600"></div>
            <span class="ms-3 text-sm font-medium text-gray-700">
              {{ trustProxy ? '已开启' : '已关闭' }}
            </span>
          </label>
        </div>
        <p v-if="trustProxyOverrideHint"
          class="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
          <i class="fa-solid fa-triangle-exclamation mr-1"></i>{{ trustProxyOverrideHint }}
        </p>
      </section>

      <!-- 管理员评论密钥 -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fa-solid fa-lock text-purple-500"></i> 管理员评论密钥
        </h2>
        <p class="text-sm text-gray-500 mb-4">
          设置密钥后，博主使用管理员邮箱在前台发表评论时需输入此密钥验证身份，验证通过的评论将直接通过审核。
        </p>
        <div class="space-y-4">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm font-medium text-gray-700">启用评论密钥</p>
              <p class="text-xs text-gray-400 mt-1">开启后前台发表管理员评论时需要输入密钥验证</p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" v-model="adminCommentKeyEnabled" class="sr-only peer">
              <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-purple-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600"></div>
              <span class="ms-3 text-sm font-medium text-gray-700">
                {{ adminCommentKeyEnabled ? '已启用' : '已禁用' }}
              </span>
            </label>
          </div>
          <div v-if="adminCommentKeyEnabled">
            <label class="block text-sm font-medium text-gray-700 mb-1">评论密钥</label>
            <input v-model="adminCommentKey" type="password" placeholder="输入管理员评论密钥"
              class="w-full max-w-md px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm" />
            <p class="text-xs text-gray-400 mt-1">关闭开关后密钥将被清除</p>
          </div>
        </div>
      </section>

      <!-- 人机验证（无感验证） -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fa-solid fa-shield-halved text-emerald-500"></i> 人机验证
        </h2>
        <p class="text-sm text-gray-500 mb-4">
          开启后，评论区会在「预览」按钮左侧显示一个验证框。浏览器在后台静默完成一次工作量证明，真人无需任何点击；
          机械化的批量提交会因为计算成本而明显受限。默认关闭。
        </p>
        <div class="space-y-4">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm font-medium text-gray-700">启用无感验证</p>
              <p class="text-xs text-gray-400 mt-1">开启后提交评论必须携带验证凭证，博主使用管理员密钥时自动放行</p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" v-model="commentVerifyEnabled" class="sr-only peer">
              <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-emerald-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-600"></div>
              <span class="ms-3 text-sm font-medium text-gray-700">
                {{ commentVerifyEnabled ? '已启用' : '已禁用' }}
              </span>
            </label>
          </div>
          <div v-if="commentVerifyEnabled" class="max-w-md">
            <label class="block text-sm font-medium text-gray-700 mb-1">验证强度</label>
            <select v-model="commentVerifyDifficulty"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent text-sm">
              <option value="250000">低（约 25 万次计算：桌面不到 0.3 秒，低端手机约 1–2 秒）</option>
              <option value="1000000">中（约 100 万次计算，推荐：桌面约 1 秒，低端手机 3–6 秒）</option>
              <option value="4000000">高（约 400 万次计算：桌面约 4 秒，低端手机可能 15 秒以上）</option>
            </select>
            <p class="text-xs text-gray-400 mt-1">
              数值为访客需要完成的哈希计算总次数（会分摊到 4 个子挑战并行求解）。强度越高越能拦住机器人，
              但等待时间也越长；手机性能通常只有桌面的 1/5 到 1/10，请按主要访客的设备选择。
            </p>
          </div>

          <!-- 第二层：Instrumentation 环境质询 -->
          <div v-if="commentVerifyEnabled" class="border-t border-gray-100 pt-4 space-y-4">
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm font-medium text-gray-700">启用环境质询（第二层）</p>
                <p class="text-xs text-gray-400 mt-1">
                  在算力证明之外，再要求访客的浏览器真实执行一段随机生成的程序并回传环境特征。
                  与算力证明互补：一个证明「付出了算力」，一个证明「计算真的发生在浏览器里」。默认关闭。
                </p>
              </div>
              <label class="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" v-model="commentVerifyInstrEnabled" class="sr-only peer">
                <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-emerald-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-600"></div>
                <span class="ms-3 text-sm font-medium text-gray-700">
                  {{ commentVerifyInstrEnabled ? '已启用' : '已禁用' }}
                </span>
              </label>
            </div>

            <div v-if="commentVerifyInstrEnabled" class="flex items-center justify-between pl-4 border-l-2 border-gray-100">
              <div>
                <p class="text-sm font-medium text-gray-700">命中自动化特征时拒绝</p>
                <p class="text-xs text-gray-400 mt-1">
                  默认只把命中的特征写进日志、不拦截任何人。开启前请先观察日志确认没有误伤
                  （Tor Browser 的字体整数量化、混合 DPI 多显示器环境都可能被误判）。
                  注意：有头原生 Chrome 配 undetected-chromedriver 这类工具可以绕过全部检测，
                  真正让批量滥用变贵的是第一层的算力证明。
                </p>
              </div>
              <label class="relative inline-flex items-center cursor-pointer">
                <input type="checkbox" v-model="commentVerifyBlockAutomated" class="sr-only peer">
                <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-emerald-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-600"></div>
                <span class="ms-3 text-sm font-medium text-gray-700">
                  {{ commentVerifyBlockAutomated ? '已开启' : '仅记录' }}
                </span>
              </label>
            </div>
          </div>
        </div>
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
const adminCommentKey = ref('')
const adminCommentKeyEnabled = ref(false)
const commentVerifyEnabled = ref(false)
// 总哈希计算次数（协议 v2 语义）。默认值与后端 HASHWX_DEFAULT_DIFFICULTY 保持一致，
// 这样「未设置过」的部署打开本页时选中「中」，保存后不会意外改变验证强度。
const commentVerifyDifficulty = ref('1000000')
// 第二层环境质询：默认关闭，与后端 comment_verify_instr_enabled 默认值一致
const commentVerifyInstrEnabled = ref(false)
// 命中自动化特征时是否拒绝：默认关闭，只记录日志
const commentVerifyBlockAutomated = ref(false)
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
  adminKey: adminCommentKey.value,
  keyEnabled: adminCommentKeyEnabled.value,
  verifyEnabled: commentVerifyEnabled.value,
  verifyDifficulty: commentVerifyDifficulty.value,
  verifyInstrEnabled: commentVerifyInstrEnabled.value,
  verifyBlockAutomated: commentVerifyBlockAutomated.value,
  trustProxy: trustProxy.value,
})

watch([ipBlacklist, emailBlacklist, originList, adminCommentKey, adminCommentKeyEnabled, commentVerifyEnabled, commentVerifyDifficulty, commentVerifyInstrEnabled, commentVerifyBlockAutomated, trustProxy], () => {
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
      adminCommentKey.value = res.data.admin_comment_key || ''
      adminCommentKeyEnabled.value = res.data.admin_comment_key_enabled === 'true'
      commentVerifyEnabled.value = res.data.comment_verify_enabled === 'true'
      commentVerifyDifficulty.value = res.data.comment_verify_difficulty || '1000000'
      commentVerifyInstrEnabled.value = res.data.comment_verify_instr_enabled === 'true'
      commentVerifyBlockAutomated.value = res.data.comment_verify_block_automated === 'true'
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
    const payload = {
      allow_origin: originList.value.join(','),
      ip_blacklist: JSON.stringify(ipBlacklist.value),
      email_blacklist: JSON.stringify(emailBlacklist.value),
      admin_comment_key_enabled: adminCommentKeyEnabled.value ? 'true' : 'false',
      comment_verify_enabled: commentVerifyEnabled.value ? 'true' : 'false',
      comment_verify_difficulty: commentVerifyDifficulty.value,
      comment_verify_instr_enabled: commentVerifyInstrEnabled.value ? 'true' : 'false',
      comment_verify_block_automated: commentVerifyBlockAutomated.value ? 'true' : 'false',
      trust_proxy: trustProxy.value ? 'true' : 'false',
    }
    if (adminCommentKeyEnabled.value && adminCommentKey.value) {
      payload.admin_comment_key = adminCommentKey.value
    } else if (!adminCommentKeyEnabled.value) {
      payload.admin_comment_key = ''
    }
    const res = await request.put('/admin/settings', payload)
    if (res.code === 200) {
      saved.value = true
      toast.success('安全设置已保存')
      initialSnapshot = takeSnapshot()
      isDirty.value = false
      setTimeout(() => { saved.value = false }, 3000)
    }
  } catch (e) {
    console.error('Failed to save settings:', e)
    // 后端会校验 IP 黑名单格式，失败原因（如非法 IP/CIDR）需要展示给用户
    toast.error(e?.message || '安全设置保存失败')
  } finally {
    loading.value = false
  }
}

const logout = () => {
  localStorage.removeItem('token')
  router.push('/login')
}
</script>
