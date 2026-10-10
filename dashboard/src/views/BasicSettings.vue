<template>
  <AdminLayout :baseUrl="apiUrl" @logout="logout" @refresh="loadSettings">
    <div class="max-w-4xl mx-auto space-y-8">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <router-link to="/settings"
            class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-200 text-gray-500 transition-colors">
            <i class="fa-solid fa-arrow-left"></i>
          </router-link>
          <h1 class="text-2xl font-bold text-gray-800">基本设置</h1>
        </div>
        <div class="flex items-center gap-3">
          <span v-if="saved" class="text-sm text-green-600 font-medium">保存成功</span>
          <button @click="saveSettings" :disabled="loading"
            class="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors text-sm font-medium">
            {{ loading ? '保存中...' : '保存设置' }}
          </button>
        </div>
      </div>

      <!-- 站点设置 -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fa-solid fa-globe text-blue-500"></i> 站点信息
        </h2>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">站点名称</label>
            <input v-model="form.site_name" type="text"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">管理员邮箱</label>
            <input v-model="form.admin_email" type="email"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm" />
          </div>
        </div>
      </section>

      <!-- 评论审核 -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fa-solid fa-check-double text-blue-500"></i> 评论审核
        </h2>
        <div class="flex items-center justify-between">
          <div>
            <p class="text-sm font-medium text-gray-700">评论自动通过</p>
            <p class="text-xs text-gray-400 mt-1">开启后新评论无需审核即可显示，命中下方垃圾规则的除外</p>
          </div>
          <label class="relative shrink-0 ms-4 inline-flex items-center cursor-pointer">
            <input type="checkbox" v-model="form.comment_auto_approve" class="sr-only peer" true-value="true" false-value="false">
            <div class="relative w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
            <span class="ms-3 text-sm font-medium whitespace-nowrap text-gray-700">
              {{ form.comment_auto_approve === 'true' ? '已开启' : '已关闭' }}
            </span>
          </label>
        </div>
        <p class="text-xs text-amber-600 mt-3 flex items-center gap-1">
          <i class="fa-solid fa-triangle-exclamation"></i>
          关闭后，新评论状态为"待审核"，需在评论管理中手动通过
        </p>

        <!-- 审核自动化（垃圾规则） -->
        <div v-if="form.comment_auto_approve === 'true'" class="mt-5 pt-5 border-t border-gray-100 space-y-5">
          <div>
            <p class="text-sm font-medium text-gray-700 flex items-center gap-2">
              <i class="fa-solid fa-filter text-blue-500"></i> 审核自动化规则
            </p>
            <p class="text-xs text-gray-400 mt-1">
              命中任一规则的评论会被标记为垃圾评论并转入"待审核"，未命中的直接通过。
              <strong>四项阈值默认均为 0（不启用），不会拦下任何评论</strong>；请按需填写，0 表示不启用该条规则。
              博主（管理员密钥已验证）的评论不受规则影响。
            </p>
          </div>

          <!-- 敏感关键词 -->
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">敏感关键词</label>
            <div class="flex flex-wrap gap-2 mb-2 min-h-[28px]">
              <span v-for="(word, index) in spamKeywords" :key="index"
                class="inline-flex items-center gap-1 px-3 py-1 bg-blue-50 border border-blue-200 text-blue-700 rounded-full text-sm">
                {{ word }}
                <button @click="removeKeyword(index)" class="hover:text-red-500 transition-colors leading-none">
                  <i class="fa-solid fa-xmark"></i>
                </button>
              </span>
              <span v-if="spamKeywords.length === 0" class="text-xs text-gray-400 leading-[28px]">未设置关键词（该规则不启用）</span>
            </div>
            <div class="flex gap-2">
              <input v-model="newKeyword" type="text" placeholder="例如：加微信" @keydown.enter.prevent="addKeyword"
                class="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm" />
              <button @click="addKeyword" :disabled="!newKeyword.trim()"
                class="px-4 py-2 bg-blue-50 text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-100 disabled:opacity-50 transition-colors text-sm font-medium whitespace-nowrap">
                添加
              </button>
            </div>
            <p class="text-xs text-gray-400 mt-1">
              不区分大小写，命中评论正文、昵称或个人网址任一即判为垃圾；最多 200 条，单条不超过 100 字
            </p>
          </div>

          <!-- 链接数 / 长度 / 重复 -->
          <div class="grid grid-cols-1 md:grid-cols-3 gap-5">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">链接数上限</label>
              <input v-model.number="form.comment_spam_max_links" type="number" min="0" max="50" step="1"
                placeholder="建议 3"
                class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm" />
              <p class="text-xs text-gray-400 mt-1">
                正文链接 + 个人网址字段（计 1）超过该值即判为垃圾；0 = 不限制（默认）
              </p>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">正文最少字符数</label>
              <input v-model.number="form.comment_spam_min_length" type="number" min="0" max="2000" step="1"
                placeholder="建议 5"
                class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm" />
              <p class="text-xs text-gray-400 mt-1">
                正文短于该长度即判为垃圾（按字符数）；0 = 不限制（默认）。中文短评较多时请慎用或设小
              </p>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">重复检测时间窗（分钟）</label>
              <input v-model.number="form.comment_spam_duplicate_window" type="number" min="0" max="10080" step="1"
                placeholder="建议 10"
                class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm" />
              <p class="text-xs text-gray-400 mt-1">
                同一 IP 在该时间窗内提交过完全相同的正文即判为垃圾；0 = 关闭（默认）
              </p>
            </div>
          </div>
        </div>
      </section>

      <!-- 博主标识 -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fa-solid fa-crown text-blue-500"></i> 博主标识
        </h2>
        <div class="space-y-5">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm font-medium text-gray-700">启用博主标签</p>
              <p class="text-xs text-gray-400 mt-1">开启后博主的评论会显示特殊标识</p>
            </div>
            <label class="relative shrink-0 ms-4 inline-flex items-center cursor-pointer">
              <input type="checkbox" v-model="form.blogger_badge_enabled" class="sr-only peer" true-value="true" false-value="false">
              <div class="relative w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              <span class="ms-3 text-sm font-medium whitespace-nowrap text-gray-700">
                {{ form.blogger_badge_enabled === 'true' ? '已启用' : '已禁用' }}
              </span>
            </label>
          </div>
          <div v-if="form.blogger_badge_enabled === 'true'">
            <label class="block text-sm font-medium text-gray-700 mb-1">自定义标签文字</label>
            <input v-model="form.blogger_badge_text" type="text" placeholder="例如：博主"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm" />
            <p class="text-xs text-gray-400 mt-1">将显示在博主评论名称的旁边</p>
          </div>
        </div>
      </section>

      <!-- 自定义占位符 -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fa-solid fa-pen-to-square text-blue-500"></i> 自定义占位符
        </h2>
        <p class="text-xs text-gray-400 mb-4">留空则使用默认占位文字</p>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-5">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">昵称输入框</label>
            <input v-model="form.placeholder_name" type="text" placeholder="例如：输入昵称"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">邮箱输入框</label>
            <input v-model="form.placeholder_email" type="text" placeholder="例如：输入邮箱"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">评论内容输入框</label>
            <input v-model="form.placeholder_content" type="text" placeholder="例如：写下你的评论..."
              class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm" />
          </div>
        </div>
        <div class="mt-3">
          <label class="block text-sm font-medium text-gray-700 mb-1">网址输入框</label>
          <input v-model="form.placeholder_url" type="text" placeholder="例如：https://"
            class="w-full max-w-md px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm" />
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

const router = useRouter()
const apiUrl = ref(localStorage.getItem('apiUrl') || window.location.origin)

const loading = ref(false)
const saved = ref(false)

const isDirty = ref(false)
let initialSnapshot = ''

const form = reactive({
  site_name: '',
  admin_email: '',
  comment_auto_approve: 'true',
  // 审核自动化规则：默认全部为 0（不启用），与后端默认值一致 ——
  // 开启「评论自动通过」后不会凭空拦下评论，由管理员按需填写阈值
  comment_spam_max_links: '0',
  comment_spam_min_length: '0',
  comment_spam_duplicate_window: '0',
  comment_spam_keywords: '[]',
  blogger_badge_enabled: 'false',
  blogger_badge_text: '',
  placeholder_name: '',
  placeholder_email: '',
  placeholder_content: '',
  placeholder_url: '',
})

// 敏感关键词单独用数组维护，保存时序列化为 JSON 字符串（与 ip_blacklist 的处理一致）
const spamKeywords = ref([])
const newKeyword = ref('')

const addKeyword = () => {
  const val = newKeyword.value.trim()
  if (val && !spamKeywords.value.includes(val)) {
    spamKeywords.value.push(val)
  }
  newKeyword.value = ''
}

const removeKeyword = (index) => {
  spamKeywords.value.splice(index, 1)
}

/** 数值归一化：非法输入退回默认值，超出后端上限按上限夹取（后端也会校验） */
const normalizeNumber = (value, fallback, max) => {
  const parsed = parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return String(fallback)
  return String(Math.min(parsed, max))
}

const takeSnapshot = () => JSON.stringify({ ...form, comment_spam_keywords: [...spamKeywords.value] })

watch([form, spamKeywords], () => {
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
    const res = await request.get('/admin/settings', { params: { type: 'basic' } })
    if (res.code === 200 && res.data) {
      Object.assign(form, res.data)
      // 规则阈值：未配置时显示后端默认值（全部为 0 = 不启用），避免「页面显示空」而实际仍在按默认值拦截
      if (res.data.comment_spam_max_links === undefined) form.comment_spam_max_links = '0'
      if (res.data.comment_spam_min_length === undefined) form.comment_spam_min_length = '0'
      if (res.data.comment_spam_duplicate_window === undefined) form.comment_spam_duplicate_window = '0'
      try {
        spamKeywords.value = res.data.comment_spam_keywords ? JSON.parse(res.data.comment_spam_keywords) : []
        if (!Array.isArray(spamKeywords.value)) spamKeywords.value = []
      } catch {
        spamKeywords.value = []
      }
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
      ...form,
      // 阈值归一化：后端也会校验，这里先夹取并转成字符串
      comment_spam_max_links: normalizeNumber(form.comment_spam_max_links, 0, 50),
      comment_spam_min_length: normalizeNumber(form.comment_spam_min_length, 0, 2000),
      comment_spam_duplicate_window: normalizeNumber(form.comment_spam_duplicate_window, 0, 10080),
      comment_spam_keywords: JSON.stringify(spamKeywords.value),
    }
    // 把归一化后的阈值写回表单：页面显示与实际落库保持一致
    // （后端也会夹取超限值、把非法值退回默认值）
    form.comment_spam_max_links = payload.comment_spam_max_links
    form.comment_spam_min_length = payload.comment_spam_min_length
    form.comment_spam_duplicate_window = payload.comment_spam_duplicate_window
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

const logout = () => {
  localStorage.removeItem('token')
  router.push('/login')
}
</script>
