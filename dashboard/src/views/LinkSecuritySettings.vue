<template>
  <AdminLayout :baseUrl="apiUrl" @logout="logout" @refresh="loadSettings">
    <div class="max-w-4xl mx-auto space-y-8">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <router-link to="/settings"
            class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-200 text-gray-500 transition-colors">
            <i class="fa-solid fa-arrow-left"></i>
          </router-link>
          <h1 class="text-2xl font-bold text-gray-800">链接安全</h1>
        </div>
        <div class="flex items-center gap-3">
          <span v-if="saved" class="text-sm text-green-600 font-medium">保存成功</span>
          <button @click="saveSettings" :disabled="saving || loading"
            class="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors text-sm font-medium"
            data-test="save-link">
            {{ saving ? '保存中...' : '保存设置' }}
          </button>
        </div>
      </div>

      <!-- API 地址缺失：链接同步 / 休眠提醒都无法开启 -->
      <div v-if="apiBaseUrlMissing"
        class="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
        data-test="link-api-base-url-missing">
        <i class="fa-solid fa-triangle-exclamation mr-1"></i>
        历史链接同步与休眠提醒依赖<strong>API 地址</strong>：当前未填写，这两个开关无法开启。
        <router-link to="/settings/basic" class="text-amber-800 underline font-medium">
          前往基本设置 → 站点信息填写
        </router-link>
      </div>

      <!-- 休眠链接 -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-lg font-semibold text-gray-800 flex items-center gap-2">
            <i class="fa-solid fa-link-slash text-sky-500"></i> 休眠链接
          </h2>
          <label class="relative shrink-0 ms-4 inline-flex items-center cursor-pointer">
            <input type="checkbox" v-model="securityEnabled" class="sr-only peer" true-value="true" false-value="false"
              data-test="link-security-enabled">
            <div class="relative w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-sky-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-sky-600"></div>
            <span class="ms-3 text-sm font-medium whitespace-nowrap text-gray-700">
              {{ securityEnabled === 'true' ? '已开启' : '已关闭' }}
            </span>
          </label>
        </div>
        <p class="text-xs text-gray-500">
          评论者很久没再来评论时，他留下的个人网站链接可能已经失效甚至被他人接管。
          开启后，这类链接会被标记为<strong>休眠</strong>：其他访客点击时<strong>不再自动跳转</strong>，
          只会看到「无法访问」的提示（没有任何继续访问的入口）；评论者本人下次评论后休眠<strong>自动解除</strong>。
          如果某条链接其实正常，可在<strong>用户列表</strong>里点「确认安全」人工放行 ——
          有效期与下面的休眠天数相同，到期后自动恢复休眠。
        </p>

        <div class="mt-5 max-w-xs">
          <label class="block text-sm font-medium text-gray-700 mb-1">多少天没来评论就标记为休眠</label>
          <input v-model="dormantDays" type="number" :min="MIN_LINK_DORMANT_DAYS" :max="MAX_LINK_DORMANT_DAYS" step="1"
            class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-sky-500 focus:border-transparent text-sm"
            data-test="link-dormant-days" />
          <p class="text-xs text-gray-400 mt-1">
            整数，{{ MIN_LINK_DORMANT_DAYS }}–{{ MAX_LINK_DORMANT_DAYS }} 天，默认 {{ DEFAULT_LINK_DORMANT_DAYS }} 天；
            判断口径是「严格大于」该天数。
          </p>
        </div>
      </section>

      <!-- 休眠提醒邮件 -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-lg font-semibold text-gray-800 flex items-center gap-2">
            <i class="fa-solid fa-envelope-open-text text-sky-500"></i> 休眠提醒邮件
          </h2>
          <label class="relative shrink-0 ms-4 inline-flex items-center cursor-pointer">
            <input type="checkbox" v-model="noticeEnabled" class="sr-only peer" true-value="true" false-value="false"
              :disabled="noticeBlocked"
              data-test="link-dormant-notice-enabled">
            <div class="relative w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-sky-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-sky-600"
              :class="noticeBlocked ? 'opacity-50 cursor-not-allowed' : ''"></div>
            <span class="ms-3 text-sm font-medium whitespace-nowrap text-gray-700">
              {{ noticeEnabled === 'true' ? '已开启' : '已关闭' }}
            </span>
          </label>
        </div>
        <p class="text-xs text-gray-500">
          某条个人网站链接<strong>刚进入休眠</strong>时，给评论者本人发一封提醒邮件：他可以在邮件里确认
          「我仍在使用」（恢复正常 {{ resolveLinkDormantDays(dormantDays) }} 天），或直接提交新链接
          （会同步更新他的历史评论）。同一个休眠周期只提醒一次，单次请求最多发 3 封，避免群发被判成垃圾邮件。
          关闭后就不发任何提醒邮件（休眠标记本身照常生效）。
        </p>

        <div v-if="noticeOnWithoutBaseUrl"
          class="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700"
          data-test="link-dormant-notice-warning">
          <i class="fa-solid fa-triangle-exclamation mr-1"></i>
          休眠提醒邮件依赖<strong>API 地址</strong>：当前 <code class="px-1 bg-amber-100 rounded">verify_base_url</code>
          为空，即使这里打开，通知邮件也不会发出（功能实际不生效）。
          <router-link to="/settings/basic" class="text-amber-800 underline font-medium">前往基本设置 → 站点信息填写</router-link>
        </div>
      </section>

      <!-- 历史链接同步 -->
      <section class="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-lg font-semibold text-gray-800 flex items-center gap-2">
            <i class="fa-solid fa-arrows-rotate text-sky-500"></i> 历史链接同步
          </h2>
          <label class="relative shrink-0 ms-4 inline-flex items-center cursor-pointer">
            <input type="checkbox" v-model="syncEnabled" class="sr-only peer" true-value="true" false-value="false"
              :disabled="syncBlocked"
              data-test="link-sync-enabled">
            <div class="relative w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-sky-300 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-sky-600"
              :class="syncBlocked ? 'opacity-50 cursor-not-allowed' : ''"></div>
            <span class="ms-3 text-sm font-medium whitespace-nowrap text-gray-700">
              {{ syncEnabled === 'true' ? '已开启' : '已关闭' }}
            </span>
          </label>
        </div>
        <p class="text-xs text-gray-500">
          评论者提交了新的个人网址时，系统会给他发一封确认邮件；
          <strong>只有他本人点邮件里的链接确认后</strong>，他所有历史评论里的旧链接才会被改写成新网址
          （邮件 24 小时内有效，不确认则历史评论不动）。
        </p>
        <p class="text-xs text-gray-400 mt-2">
          另外，评论者的邮箱需要<strong>曾经通过邮箱验证</strong>（存在已验证记录）；
          如果站点从未开启过邮箱验证，则不会有验证记录，本功能不会触发。
        </p>

        <div v-if="syncOnWithoutBaseUrl"
          class="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700"
          data-test="link-sync-warning">
          <i class="fa-solid fa-triangle-exclamation mr-1"></i>
          历史链接同步依赖<strong>API 地址</strong>：当前 <code class="px-1 bg-amber-100 rounded">verify_base_url</code>
          为空，即使这里打开，确认邮件也不会发出（功能实际不生效）。
          <router-link to="/settings/basic" class="text-amber-800 underline font-medium">前往基本设置 → 站点信息填写</router-link>
        </div>
      </section>

      <p v-if="loading" class="text-sm text-gray-400">正在加载...</p>
    </div>
  </AdminLayout>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import AdminLayout from '../components/AdminLayout.vue';
import request from '../utils/request';
import toast from '../utils/toast';
import {
  DEFAULT_LINK_DORMANT_DAYS,
  MAX_LINK_DORMANT_DAYS,
  MIN_LINK_DORMANT_DAYS,
  normalizeLinkSwitch,
  resolveLinkDormantDays,
  validateLinkDormantDays,
} from '../utils/linkSecurity';

const router = useRouter();
const apiUrl = ref(localStorage.getItem('apiUrl') || window.location.origin);

const securityEnabled = ref('false');
const syncEnabled = ref('false');
/** 链接进入休眠时是否给评论者发提醒邮件（依赖 API 地址，不再依赖邮箱验证） */
const noticeEnabled = ref('false');
const dormantDays = ref(String(DEFAULT_LINK_DORMANT_DAYS));
/** API 地址（基本设置 → 站点信息）：历史链接同步与休眠提醒邮件的硬前提 */
const apiBaseUrl = ref('');

const loading = ref(false);
const saving = ref(false);
const saved = ref(false);

/** API 地址是否为空（trim 后） */
const apiBaseUrlMissing = computed(() => String(apiBaseUrl.value ?? '').trim() === '');

/** 同步开着但 API 地址没填：给出明确警告（后端也不会发确认邮件） */
const syncOnWithoutBaseUrl = computed(
  () => syncEnabled.value === 'true' && apiBaseUrlMissing.value,
);

/** 休眠提醒开着但 API 地址没填：同样给出警告（后端也不会发提醒邮件） */
const noticeOnWithoutBaseUrl = computed(
  () => noticeEnabled.value === 'true' && apiBaseUrlMissing.value,
);

/** API 地址为空时不允许「开启」；已经开启的旧配置仍然可以关闭 */
const syncBlocked = computed(() => syncEnabled.value !== 'true' && apiBaseUrlMissing.value);
const noticeBlocked = computed(() => noticeEnabled.value !== 'true' && apiBaseUrlMissing.value);

async function loadSettings() {
  loading.value = true;
  try {
    const [linkRes, basicRes] = await Promise.all([
      request.get('/admin/settings', { params: { type: 'link' } }).catch((e) => {
        console.error('Failed to load link security settings:', e);
        return null;
      }),
      request.get('/admin/settings', { params: { type: 'basic' } }).catch((e) => {
        console.error('Failed to load basic settings:', e);
        return null;
      }),
    ]);

    if (linkRes?.code === 200 && linkRes.data) {
      // 开关 fail-closed：只有归一化后等于 "true" 才算开启（doc/link_security.md 第 1 节）
      securityEnabled.value = normalizeLinkSwitch(linkRes.data.link_security_enabled);
      syncEnabled.value = normalizeLinkSwitch(linkRes.data.link_sync_enabled);
      noticeEnabled.value = normalizeLinkSwitch(linkRes.data.link_dormant_notice_enabled);
      dormantDays.value = String(resolveLinkDormantDays(linkRes.data.link_dormant_days));
    }
    if (basicRes?.code === 200 && basicRes.data) {
      apiBaseUrl.value = String(basicRes.data.verify_base_url ?? '').trim();
    }
  } finally {
    loading.value = false;
  }
}

async function saveSettings() {
  // 休眠天数按写入路径口径校验（脏值直接拦下，不静默改数）
  const daysError = validateLinkDormantDays(dormantDays.value);
  if (daysError) {
    toast.error(daysError);
    return;
  }
  const days = String(resolveLinkDormantDays(dormantDays.value));

  saving.value = true;
  saved.value = false;
  try {
    const res = await request.put('/admin/settings', {
      link_security_enabled: normalizeLinkSwitch(securityEnabled.value),
      link_dormant_days: days,
      link_sync_enabled: normalizeLinkSwitch(syncEnabled.value),
      link_dormant_notice_enabled: normalizeLinkSwitch(noticeEnabled.value),
    });
    if (res.code === 200) {
      dormantDays.value = days;
      saved.value = true;
      toast.success('设置已保存');
      setTimeout(() => {
        saved.value = false;
      }, 3000);
    }
  } catch (e) {
    console.error('Failed to save link security settings:', e);
  } finally {
    saving.value = false;
  }
}

const logout = () => {
  localStorage.removeItem('token');
  router.push('/login');
};

onMounted(() => {
  loadSettings();
});
</script>
