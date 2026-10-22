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
          <div class="md:col-span-2">
            <label class="block text-sm font-medium text-gray-700 mb-1">API 地址</label>
            <input v-model="form.verify_base_url" type="url" placeholder="https://api.example.com"
              data-test="verify-base-url"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm" />
            <p class="text-xs text-gray-400 mt-1">
              站点对外根地址，用于邮箱验证、历史链接同步确认与休眠提醒邮件里的链接；
              <strong>不填写时这些功能无法开启</strong>。不要带 <code class="bg-gray-100 px-1 rounded">/api</code> 后缀。
            </p>
          </div>
        </div>

        <!-- 管理员邮箱列表 -->
        <div class="mt-5 pt-5 border-t border-gray-100">
          <label class="block text-sm font-medium text-gray-700 mb-1">管理员邮箱</label>
          <p class="text-xs text-gray-400 mb-2">
            命中列表的邮箱即视为博主（免评论冷却、可显示博主标识、可用管理员密钥），最多 {{ ADMIN_EMAIL_MAX }} 个，不区分大小写。
          </p>
          <div class="flex flex-wrap gap-2 mb-2 min-h-[28px]" data-test="admin-email-list">
            <span v-for="(email, index) in adminEmails" :key="email"
              class="inline-flex items-center gap-1 px-3 py-1 bg-blue-50 border border-blue-200 text-blue-700 rounded-full text-sm">
              {{ email }}
              <button @click="removeAdminEmail(index)" class="hover:text-red-500 transition-colors leading-none"
                data-test="admin-email-remove">
                <i class="fa-solid fa-xmark"></i>
              </button>
            </span>
            <span v-if="adminEmails.length === 0" class="text-xs text-gray-400 leading-[28px]">未设置管理员邮箱</span>
          </div>
          <div class="flex gap-2">
            <input v-model="newEmail" type="email" placeholder="例如：admin@example.com" @keydown.enter.prevent="addEmail"
              class="flex-1 md:max-w-md px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
              data-test="admin-email-input" />
            <button @click="addEmail" :disabled="!newEmail.trim()"
              class="px-4 py-2 bg-blue-50 text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-100 disabled:opacity-50 transition-colors text-sm font-medium whitespace-nowrap"
              data-test="admin-email-add">
              添加邮箱
            </button>
          </div>
          <p v-if="emailInputError" class="mt-1 text-xs text-red-500" data-test="admin-email-error">{{ emailInputError }}</p>
          <p class="text-xs text-gray-400 mt-1">按回车或点「添加」加入列表；重复邮箱（不区分大小写）与非法邮箱会被拒绝。</p>

          <!-- 通知邮箱 -->
          <div class="mt-4">
            <label class="block text-sm font-medium text-gray-700 mb-1">邮件通知邮箱</label>
            <SelectMenu v-model="notifyEmail" class="w-full md:max-w-md" :options="notifyOptions"
              :disabled="adminEmails.length === 0" placeholder="暂无管理员邮箱" title="通知邮箱"
              data-test="notify-email" />
            <p class="text-xs text-gray-400 mt-1" data-test="notify-hint">
              <template v-if="adminEmails.length === 0">管理员邮箱列表为空，无法选择通知邮箱。</template>
              <template v-else>新评论通知与「发送测试邮件」都发到这个邮箱，未选择时默认用列表第一个。</template>
            </p>
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

        <!-- 邮箱验证（原「邮件通知 → 邮箱验证」） -->
        <div class="mt-5 pt-5 border-t border-gray-100">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm font-medium text-gray-700">邮箱验证</p>
              <p class="text-xs text-gray-400 mt-1">
                开启后，未验证邮箱的评论先保存为待审核状态，验证后自动发布
              </p>
            </div>
            <label class="relative shrink-0 ms-4 inline-flex items-center cursor-pointer">
              <input type="checkbox" v-model="form.email_verify_enabled" :disabled="emailVerifyLocked"
                class="sr-only peer" true-value="true" false-value="false"
                data-test="email-verify-enabled">
              <div class="relative w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"
                :class="emailVerifyLocked ? 'opacity-50 cursor-not-allowed' : ''"></div>
              <span class="ms-3 text-sm font-medium whitespace-nowrap text-gray-700">
                {{ form.email_verify_enabled === 'true' ? '已启用' : '已禁用' }}
              </span>
            </label>
          </div>
          <p v-if="!normalizedBaseUrl" class="mt-3 text-xs text-amber-600 flex items-center gap-1" data-test="email-verify-no-base-url">
            <i class="fa-solid fa-triangle-exclamation"></i>
            请先在「站点信息」填写 API 地址，否则邮箱验证无法开启
          </p>
          <p v-else class="mt-3 text-xs text-gray-400">
            验证邮件里的链接使用上方 API 地址；还需要在「邮件通知」中配置 SMTP 并开启邮件通知。
          </p>
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

      <!-- 管理员评论密钥（配置属于后端 security 组，展示在这里） -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <i class="fa-solid fa-lock text-blue-500"></i> 管理员评论密钥
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
            <label class="relative shrink-0 ms-4 inline-flex items-center cursor-pointer">
              <input type="checkbox" v-model="adminCommentKeyEnabled" class="sr-only peer"
                data-test="admin-comment-key-enabled">
              <div class="relative w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              <span class="ms-3 text-sm font-medium whitespace-nowrap text-gray-700">
                {{ adminCommentKeyEnabled ? '已启用' : '已禁用' }}
              </span>
            </label>
          </div>
          <div v-if="adminCommentKeyEnabled">
            <label class="block text-sm font-medium text-gray-700 mb-1">评论密钥</label>
            <input v-model="adminCommentKey" type="password" placeholder="输入管理员评论密钥"
              data-test="admin-comment-key"
              class="w-full max-w-md px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm" />
            <p class="text-xs text-gray-400 mt-1">留空表示不修改（读取接口不会回显已保存的密钥）；关闭开关会清除已保存的密钥，重新开启需重新填写</p>
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
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRouter, onBeforeRouteLeave } from 'vue-router'
import request from '../utils/request'
import toast from '../utils/toast'
import AdminLayout from '../components/AdminLayout.vue'
import SelectMenu from '../components/SelectMenu.vue'
import {
  ADMIN_EMAIL_MAX,
  ADMIN_EMAIL_TOO_MANY,
  addAdminEmail,
  isValidEmail,
  normalizeEmail,
  parseAdminEmails,
  resolveNotifyEmail,
} from '../utils/emails'
import { normalizeBaseUrl, validateBaseUrl } from '../utils/baseUrl'

const router = useRouter()
const apiUrl = ref(localStorage.getItem('apiUrl') || window.location.origin)

const loading = ref(false)
const saved = ref(false)

const isDirty = ref(false)
let initialSnapshot = ''

const form = reactive({
  site_name: '',
  // 站点对外根地址：邮箱验证 / 历史链接同步确认 / 休眠提醒邮件共用
  verify_base_url: '',
  // 邮箱验证开关（原「邮件通知」页，已合并到评论审核）
  email_verify_enabled: 'false',
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

// 管理员邮箱列表与通知邮箱：同样单独维护，保存时 admin_emails 序列化为 JSON 字符串
const adminEmails = ref([])
const notifyEmail = ref('')
const newEmail = ref('')
const emailInputError = ref('')

// 管理员评论密钥：配置仍存在后端 security 组（GET type=security 读取），
// 属于敏感键 —— 读取接口始终返回空串，因此输入框保持为空并提示「留空表示不修改」
const adminCommentKey = ref('')
const adminCommentKeyEnabled = ref(false)

const notifyOptions = computed(() => adminEmails.value.map((email) => ({ label: email, value: email })))

/** API 地址归一化值（保存时提交、开关联动都用它） */
const normalizedBaseUrl = computed(() => normalizeBaseUrl(form.verify_base_url))

/**
 * API 地址为空时不允许「开启」邮箱验证；已经开启的旧配置仍然可以关闭。
 * 与后端「邮箱验证开启时必须填写 API 地址」同一口径。
 */
const emailVerifyLocked = computed(
  () => form.email_verify_enabled !== 'true' && !normalizedBaseUrl.value,
)

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

const addEmail = () => {
  if (normalizeEmail(newEmail.value) === '') {
    emailInputError.value = ''
    return
  }
  const { list, error } = addAdminEmail(adminEmails.value, newEmail.value)
  emailInputError.value = error
  if (error) return
  adminEmails.value = list
  newEmail.value = ''
}

const removeAdminEmail = (index) => {
  adminEmails.value.splice(index, 1)
  emailInputError.value = ''
}

// 列表一变就把通知邮箱对齐到列表内：不在列表里（含被删掉）时回落到第一个
watch(adminEmails, (list) => {
  if (!list.includes(notifyEmail.value)) notifyEmail.value = list[0] || ''
}, { deep: true })

watch(newEmail, () => {
  emailInputError.value = ''
})

/** 数值归一化：非法输入退回默认值，超出后端上限按上限夹取（后端也会校验） */
const normalizeNumber = (value, fallback, max) => {
  const parsed = parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return String(fallback)
  return String(Math.min(parsed, max))
}

const takeSnapshot = () => JSON.stringify({
  ...form,
  comment_spam_keywords: [...spamKeywords.value],
  admin_emails: [...adminEmails.value],
  notify_email: notifyEmail.value,
  admin_comment_key: adminCommentKey.value,
  admin_comment_key_enabled: adminCommentKeyEnabled.value,
})

watch([form, spamKeywords, adminEmails, notifyEmail, adminCommentKey, adminCommentKeyEnabled], () => {
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
      // 管理员邮箱列表与通知邮箱单独接管：不把原始 JSON 字符串留在 form 里
      const { admin_emails, notify_email, admin_email, ...rest } = res.data
      Object.assign(form, rest)
      // 开关只接受 true/false；空串/脏值一律按关闭展示（与后端 fail-closed 一致）
      if (form.email_verify_enabled !== 'true') form.email_verify_enabled = 'false'
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
      // admin_emails 为空时回落旧键 admin_email（doc/admin_emails.md 第 4 节）
      adminEmails.value = parseAdminEmails(admin_emails, admin_email)
      notifyEmail.value = resolveNotifyEmail(notify_email, adminEmails.value)
      newEmail.value = ''
      emailInputError.value = ''
    }
  } catch (e) {
    console.error('Failed to load settings:', e)
  }
  try {
    // 管理员评论密钥属于后端 security 组：额外拉一次，只读这两个键
    const secRes = await request.get('/admin/settings', { params: { type: 'security' } })
    if (secRes.code === 200 && secRes.data) {
      // 敏感键：GET 始终返回 ""，所以这里等于把输入框清空（留空表示不修改）
      adminCommentKey.value = secRes.data.admin_comment_key || ''
      adminCommentKeyEnabled.value = secRes.data.admin_comment_key_enabled === 'true'
    }
  } catch (e) {
    console.error('Failed to load security settings:', e)
  }
  initialSnapshot = takeSnapshot()
  isDirty.value = false
}

onMounted(() => {
  loadSettings()
})

const saveSettings = async () => {
  // 管理员邮箱：列表非空时至少要有一个合法邮箱；通知邮箱必须命中列表（doc/admin_emails.md 第 7 节）
  if (adminEmails.value.length > 0 && !adminEmails.value.some(isValidEmail)) {
    toast.error('请至少填写一个合法的管理员邮箱')
    return
  }
  if (adminEmails.value.length > ADMIN_EMAIL_MAX) {
    toast.error(ADMIN_EMAIL_TOO_MANY)
    return
  }
  let selected = normalizeEmail(notifyEmail.value)
  if (adminEmails.value.length === 0) {
    selected = ''
  } else if (!adminEmails.value.includes(selected)) {
    toast.error('通知邮箱必须在管理员邮箱列表中')
    return
  }
  notifyEmail.value = selected

  // API 地址：格式校验 + 邮箱验证的开启前置（后端还会校验链接同步/休眠提醒）
  const baseUrlError = validateBaseUrl(form.verify_base_url)
  if (baseUrlError) {
    toast.error(baseUrlError)
    return
  }
  const baseUrl = normalizedBaseUrl.value
  if (form.email_verify_enabled === 'true' && !baseUrl) {
    toast.error('邮箱验证开启时必须填写 API 地址')
    return
  }

  loading.value = true
  saved.value = false
  try {
    const payload = {
      ...form,
      // API 地址：去首尾空格与末尾斜杠后提交（后端同口径归一化）
      verify_base_url: baseUrl,
      // 邮箱验证开关只提交归一化后的 "true" / "false"
      email_verify_enabled: form.email_verify_enabled === 'true' ? 'true' : 'false',
      // 阈值归一化：后端也会校验，这里先夹取并转成字符串
      comment_spam_max_links: normalizeNumber(form.comment_spam_max_links, 0, 50),
      comment_spam_min_length: normalizeNumber(form.comment_spam_min_length, 0, 2000),
      comment_spam_duplicate_window: normalizeNumber(form.comment_spam_duplicate_window, 0, 10080),
      comment_spam_keywords: JSON.stringify(spamKeywords.value),
      // v3：数组为准；同时写旧键 admin_email（= 通知邮箱）以便旧版本后端/旧快照读到的行为不变
      admin_emails: JSON.stringify(adminEmails.value),
      notify_email: selected,
      admin_email: selected || adminEmails.value[0] || '',
      // 管理员评论密钥（后端 security 组）：
      //  - 开关始终提交；
      //  - 密钥是敏感键（读取接口不回显），因此「开启 + 输入了内容」才提交新值；
      //  - **关闭开关时提交空串**，与历史行为一致（关闭即清除已保存的密钥，重新开启需重新填写）
      admin_comment_key_enabled: adminCommentKeyEnabled.value ? 'true' : 'false',
    }
    if (adminCommentKeyEnabled.value && adminCommentKey.value) {
      payload.admin_comment_key = adminCommentKey.value
    } else if (!adminCommentKeyEnabled.value) {
      payload.admin_comment_key = ''
    }
    // 把归一化后的阈值写回表单：页面显示与实际落库保持一致
    // （后端也会夹取超限值、把非法值退回默认值）
    form.comment_spam_max_links = payload.comment_spam_max_links
    form.comment_spam_min_length = payload.comment_spam_min_length
    form.comment_spam_duplicate_window = payload.comment_spam_duplicate_window
    form.verify_base_url = baseUrl
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
