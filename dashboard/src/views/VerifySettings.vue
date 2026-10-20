<template>
  <AdminLayout :baseUrl="apiUrl" @logout="logout" @refresh="loadSettings">
    <div class="max-w-4xl mx-auto space-y-8">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <router-link to="/settings"
            class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-200 text-gray-500 transition-colors">
            <i class="fa-solid fa-arrow-left"></i>
          </router-link>
          <h1 class="text-2xl font-bold text-gray-800">人机验证</h1>
        </div>
        <div class="flex items-center gap-3">
          <span v-if="saved" class="text-sm text-green-600 font-medium">保存成功</span>
          <button @click="saveSettings" :disabled="loading"
            class="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors text-sm font-medium">
            {{ loading ? '保存中...' : '保存设置' }}
          </button>
        </div>
      </div>

      <!-- 1. 无感验证：总开关 + 验证强度 -->
      <section data-test="verify-section-core"
        class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 flex items-center gap-2">
          <i class="fa-solid fa-shield-halved text-indigo-500"></i> 无感验证
        </h2>
        <p class="text-xs text-gray-500 mt-2">
          开启后，评论区会在「预览」按钮左侧显示一个验证框。浏览器在后台静默完成一次工作量证明，真人无需任何点击；
          机械化的批量提交会因为计算成本而明显受限。默认关闭。
        </p>

        <div class="mt-5 flex items-center justify-between gap-4">
          <div>
            <p class="text-sm font-medium text-gray-700">启用无感验证</p>
            <p class="text-xs text-gray-400 mt-1">开启后提交评论必须携带验证凭证，博主使用管理员密钥时自动放行</p>
          </div>
          <label class="relative shrink-0 ms-4 inline-flex items-center cursor-pointer">
            <input type="checkbox" v-model="commentVerifyEnabled" class="sr-only peer">
            <div class="relative w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-indigo-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
            <span class="ms-3 text-sm font-medium whitespace-nowrap text-gray-700">
              {{ commentVerifyEnabled ? '已启用' : '已禁用' }}
            </span>
          </label>
        </div>

        <!-- 验证强度：只有开启后才有意义 -->
        <div v-if="commentVerifyEnabled" class="mt-5 pt-4 border-t border-gray-100 max-w-md">
          <label class="block text-sm font-medium text-gray-700 mb-1">验证强度</label>
          <SelectMenu v-model="commentVerifyDifficulty" class="w-full" accent="indigo" title="算力证明强度"
            :options="[
              { label: '低（约 25 万次计算：桌面不到 0.3 秒，低端手机约 1–2 秒）', value: '250000' },
              { label: '中（约 100 万次计算，推荐：桌面约 1 秒，低端手机 3–6 秒）', value: '1000000' },
              { label: '高（约 400 万次计算：桌面约 4 秒，低端手机可能 15 秒以上）', value: '4000000' }
            ]" />
          <p class="text-xs text-gray-400 mt-1">
            数值为访客需要完成的哈希计算总次数（会分摊到 4 个子挑战并行求解）。强度越高越能拦住机器人，
            但等待时间也越长；手机性能通常只有桌面的 1/5 到 1/10，请按主要访客的设备选择。
          </p>
        </div>
      </section>

      <!-- 2. 环境质询（第二层） -->
      <section v-if="commentVerifyEnabled" data-test="verify-section-instr"
        class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 flex items-center gap-2">
          <i class="fa-solid fa-microchip text-indigo-500"></i> 环境质询（第二层）
        </h2>
        <p class="text-xs text-gray-500 mt-2">
          在算力证明之外，再要求访客的浏览器真实执行一段随机生成的程序并回传环境特征。
          与算力证明互补：一个证明「付出了算力」，一个证明「计算真的发生在浏览器里」。默认关闭。
        </p>

        <div class="mt-5 flex items-center justify-between gap-4">
          <div>
            <p class="text-sm font-medium text-gray-700">启用环境质询（第二层）</p>
            <p class="text-xs text-gray-400 mt-1">关闭时只做第一层的算力证明</p>
          </div>
          <label class="relative shrink-0 ms-4 inline-flex items-center cursor-pointer">
            <input type="checkbox" v-model="commentVerifyInstrEnabled" class="sr-only peer">
            <div class="relative w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-indigo-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
            <span class="ms-3 text-sm font-medium whitespace-nowrap text-gray-700">
              {{ commentVerifyInstrEnabled ? '已启用' : '已禁用' }}
            </span>
          </label>
        </div>

        <div v-if="commentVerifyInstrEnabled"
          class="mt-5 pt-4 border-t border-gray-100 flex items-center justify-between gap-4">
          <div>
            <p class="text-sm font-medium text-gray-700">命中自动化特征时拒绝</p>
            <p class="text-xs text-gray-400 mt-1">
              默认只把命中的特征写进日志、不拦截任何人。开启前请先观察日志确认没有误伤
              （Tor Browser 的字体整数量化、混合 DPI 多显示器环境都可能被误判）。
              注意：有头原生 Chrome 配 undetected-chromedriver 这类工具可以绕过全部检测，
              真正让批量滥用变贵的是第一层的算力证明。
            </p>
          </div>
          <label class="relative shrink-0 ms-4 inline-flex items-center cursor-pointer">
            <input type="checkbox" v-model="commentVerifyBlockAutomated" class="sr-only peer">
            <div class="relative w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-indigo-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
            <span class="ms-3 text-sm font-medium whitespace-nowrap text-gray-700">
              {{ commentVerifyBlockAutomated ? '已开启' : '仅记录' }}
            </span>
          </label>
        </div>
      </section>

      <!-- 3. 来源域名绑定：复用「访问控制 → 跨域设置」的白名单，把挑战/票据绑定到签发它的域名 -->
      <section v-if="commentVerifyEnabled" data-test="verify-section-domain"
        class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 class="text-lg font-semibold text-gray-800 flex items-center gap-2">
          <i class="fa-solid fa-globe text-indigo-500"></i> 来源域名绑定
        </h2>
        <p class="text-xs text-gray-500 mt-2">
          要求挑战签发、答案兑换与评论提交三处都来自白名单内的域名，并把来源域名签进挑战与票据。
          这样「把组件搬到别的站点、或用自己的服务器转发请求」就拿不到凭证：为 A 域名签发的挑战无法在 B 域名兑换。
          默认关闭。白名单在「访问控制 → 跨域设置」里维护，本页不保存它。
        </p>

        <div class="mt-5 flex items-center justify-between gap-4">
          <div>
            <p class="text-sm font-medium text-gray-700">启用来源域名绑定</p>
            <p class="text-xs text-gray-400 mt-1">
              注意来源头（Origin / Referer）本身是可伪造的，这道闸门抬高的是滥用成本、不是密码学边界
            </p>
          </div>
          <label class="relative shrink-0 ms-4 inline-flex items-center cursor-pointer">
            <input type="checkbox" v-model="commentVerifyDomainEnabled" class="sr-only peer">
            <div class="relative w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-indigo-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
            <span class="ms-3 text-sm font-medium whitespace-nowrap text-gray-700">
              {{ commentVerifyDomainEnabled ? '已启用' : '已禁用' }}
            </span>
          </label>
        </div>

        <p v-if="commentVerifyDomainEnabled && !domainWhitelistUsable"
          class="mt-4 text-xs text-red-500 bg-red-50 border border-red-200 rounded p-2">
          当前「访问控制 → 跨域设置」白名单为空或包含 <code>*</code>，域名绑定需要一份具体域名白名单，
          此时会<strong>拒绝所有</strong>验证请求（fail-closed：挑战返回 403，评论也无法提交）。
          请先到「访问控制」页添加至少一个域名。
        </p>
        <p v-else-if="commentVerifyDomainEnabled" class="mt-4 text-xs text-gray-400">
          生效中的白名单：{{ originList.join('、') }}
        </p>
      </section>

      <!-- 4. 认证记录（保留策略）：数据在「认证记录」页展示，见 router 的 /verify-records -->
      <section v-if="commentVerifyEnabled" data-test="verify-section-records"
        class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div class="flex items-center justify-between gap-3">
          <h2 class="text-lg font-semibold text-gray-800 flex items-center gap-2">
            <i class="fa-solid fa-clipboard-list text-indigo-500"></i> 认证记录
          </h2>
          <router-link to="/verify-records" class="text-xs text-indigo-600 hover:underline shrink-0">
            查看认证记录 <i class="fa-solid fa-arrow-right ms-0.5"></i>
          </router-link>
        </div>
        <p class="text-xs text-gray-500 mt-2">
          每一次挑战签发与通过/失败都会落库，可在「认证记录」页查看趋势、失败原因与来源 IP / 域名。
          这里只控制记录多少与保留多久。
        </p>

        <div class="mt-5 flex items-center justify-between gap-4">
          <div>
            <p class="text-sm font-medium text-gray-700">记录签发事件</p>
            <p class="text-xs text-gray-400 mt-1">
              默认记录每一次挑战签发。关闭后只记录通过/失败，能明显降低写入量
              （签发事件在评论框加载时就会产生，是记录条数的主要来源），
              代价是看不到「签发了但没人提交答案」的情况。
            </p>
          </div>
          <label class="relative shrink-0 ms-4 inline-flex items-center cursor-pointer">
            <input type="checkbox" v-model="commentVerifyLogChallenge" class="sr-only peer">
            <div class="relative w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-indigo-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
            <span class="ms-3 text-sm font-medium whitespace-nowrap text-gray-700">
              {{ commentVerifyLogChallenge ? '已记录' : '仅结果' }}
            </span>
          </label>
        </div>

        <div class="mt-5 pt-4 border-t border-gray-100 max-w-md">
          <label class="block text-sm font-medium text-gray-700 mb-1">认证记录保留天数</label>
          <input v-model.number="commentVerifyRetentionDays" type="number" min="0" max="3650" step="1"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm" />
          <p class="text-xs text-gray-400 mt-1">
            超期记录会被自动清理（默认 30 天，上限 3650 天）。设为 <code class="bg-gray-100 px-1 rounded text-gray-600">0</code> 表示永久保留 —— 访客 IP 会随记录长期留在数据库里，请谨慎选择。
          </p>
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
import SelectMenu from '../components/SelectMenu.vue'

const router = useRouter()
const apiUrl = ref(localStorage.getItem('apiUrl') || window.location.origin)

const loading = ref(false)
const saved = ref(false)

const commentVerifyEnabled = ref(false)
// 总哈希计算次数（协议 v2 语义）。默认值与后端 HASHWX_DEFAULT_DIFFICULTY 保持一致，
// 这样「未设置过」的部署打开本页时选中「中」，保存后不会意外改变验证强度。
const commentVerifyDifficulty = ref('1000000')
// 第二层环境质询：默认关闭，与后端 comment_verify_instr_enabled 默认值一致
const commentVerifyInstrEnabled = ref(false)
// 命中自动化特征时是否拒绝：默认关闭，只记录日志
const commentVerifyBlockAutomated = ref(false)
// 来源域名绑定（复用 allow_origin 白名单）：默认关闭；白名单不可用时 fail-closed
const commentVerifyDomainEnabled = ref(false)
// 认证记录：是否记录「签发挑战」事件（默认记录）与保留天数（0 = 永久保留）
const commentVerifyLogChallenge = ref(true)
const commentVerifyRetentionDays = ref(30)

/** 保留天数归一化：非法输入按默认 30 天处理，负数按 0（永久保留），上限 3650 */
const normalizedRetentionDays = computed(() => {
  const parsed = parseInt(commentVerifyRetentionDays.value, 10)
  if (!Number.isFinite(parsed)) return 30
  if (parsed <= 0) return 0
  return Math.min(parsed, 3650)
})

/**
 * 白名单只读副本：仅用于「来源域名绑定」的 fail-closed 告警展示。
 * 白名单的编辑在「访问控制」（/settings/security）页，本页不保存 allow_origin。
 */
const originList = ref([])

/**
 * 白名单是否可用于域名绑定：必须非空且不含 `*`。
 * 不满足时后端会 fail-closed（挑战与评论全部 403），所以面板要显式告警。
 */
const domainWhitelistUsable = computed(
  () => originList.value.length > 0 && !originList.value.includes('*')
)

const isDirty = ref(false)
let initialSnapshot = ''

const takeSnapshot = () => JSON.stringify({
  verifyEnabled: commentVerifyEnabled.value,
  verifyDifficulty: commentVerifyDifficulty.value,
  verifyInstrEnabled: commentVerifyInstrEnabled.value,
  verifyBlockAutomated: commentVerifyBlockAutomated.value,
  verifyDomainEnabled: commentVerifyDomainEnabled.value,
  verifyLogChallenge: commentVerifyLogChallenge.value,
  verifyRetentionDays: commentVerifyRetentionDays.value,
})

watch([commentVerifyEnabled, commentVerifyDifficulty, commentVerifyInstrEnabled, commentVerifyBlockAutomated, commentVerifyDomainEnabled, commentVerifyLogChallenge, commentVerifyRetentionDays], () => {
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
    // 后端设置分组不变：comment_verify_* 仍属于 security 组，只是面板拆成两页
    const res = await request.get('/admin/settings', { params: { type: 'security' } })
    if (res.code === 200 && res.data) {
      commentVerifyEnabled.value = res.data.comment_verify_enabled === 'true'
      // 难度归一化：未设置/空值时回落到后端默认「中」档
      commentVerifyDifficulty.value = res.data.comment_verify_difficulty || '1000000'
      commentVerifyInstrEnabled.value = res.data.comment_verify_instr_enabled === 'true'
      commentVerifyBlockAutomated.value = res.data.comment_verify_block_automated === 'true'
      commentVerifyDomainEnabled.value = res.data.comment_verify_domain_enabled === 'true'
      // 默认记录签发事件（后端默认值也是「非 false 即记录」）
      commentVerifyLogChallenge.value = res.data.comment_verify_log_challenge !== 'false'
      const retention = parseInt(res.data.comment_verify_retention_days ?? '30', 10)
      commentVerifyRetentionDays.value = Number.isFinite(retention) ? retention : 30
      // allow_origin 只读，用于域名绑定的白名单可用性告警
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
    // 只提交本页负责的七个 comment_verify_* 键；
    // admin_comment_key* / allow_origin / 黑名单 / trust_proxy 由其他页面负责
    const payload = {
      comment_verify_enabled: commentVerifyEnabled.value ? 'true' : 'false',
      comment_verify_difficulty: commentVerifyDifficulty.value,
      comment_verify_instr_enabled: commentVerifyInstrEnabled.value ? 'true' : 'false',
      comment_verify_block_automated: commentVerifyBlockAutomated.value ? 'true' : 'false',
      comment_verify_domain_enabled: commentVerifyDomainEnabled.value ? 'true' : 'false',
      comment_verify_log_challenge: commentVerifyLogChallenge.value ? 'true' : 'false',
      comment_verify_retention_days: String(normalizedRetentionDays.value),
    }
    const res = await request.put('/admin/settings', payload)
    if (res.code === 200) {
      saved.value = true
      toast.success('人机验证设置已保存')
      initialSnapshot = takeSnapshot()
      isDirty.value = false
      setTimeout(() => { saved.value = false }, 3000)
    }
  } catch (e) {
    console.error('Failed to save settings:', e)
    toast.error(e?.message || '人机验证设置保存失败')
  } finally {
    loading.value = false
  }
}

const logout = () => {
  localStorage.removeItem('token')
  router.push('/login')
}
</script>
