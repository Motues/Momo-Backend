<template>
  <AdminLayout :baseUrl="apiUrl" @logout="logout" @refresh="fetchMails(pagination.page)">
    <div v-if="loading" class="flex justify-center py-20">
      <div class="animate-spin rounded-full h-10 w-10 border-4 border-blue-500 border-t-transparent"></div>
    </div>

    <template v-else>
      <div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <!-- 筛选栏 -->
        <div class="px-5 py-4 border-b border-gray-200 bg-gray-50/50 flex flex-col sm:flex-row sm:items-center gap-3">
          <div class="flex items-center gap-2 flex-1 flex-wrap">
            <SelectMenu v-model="statusFilter" class="shrink-0" accent="blue" title="按发送状态筛选"
              :options="[
                { label: '全部状态', value: 'all' },
                { label: '发送成功', value: 'sent' },
                { label: '发送失败', value: 'failed' },
              ]"
              data-test="mail-status-filter" @change="applyFilters" />
            <SelectMenu v-model="typeFilter" class="shrink-0" accent="blue" title="按邮件类型筛选"
              :options="typeOptions"
              data-test="mail-type-filter" @change="applyFilters" />
            <div class="relative">
              <i class="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs"></i>
              <input v-model="searchKeyword" type="text" placeholder="收件人或主题"
                class="w-52 pl-8 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                data-test="mail-search" @keydown.enter="applyFilters" />
            </div>
            <button @click="applyFilters"
              class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium">
              查询
            </button>
            <button v-if="hasFilters" @click="resetFilters"
              class="px-3 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-100 transition-colors">
              重置
            </button>
          </div>
          <span class="text-xs text-gray-400 whitespace-nowrap">
            {{ retentionDays > 0 ? `仅保留最近 ${retentionDays} 天` : '永久保留' }}
          </span>
        </div>

        <!-- 记录表 -->
        <div class="overflow-x-auto">
          <table class="data-table w-full text-left">
            <thead>
              <tr class="border-b bg-gray-50 border-gray-200">
                <th class="px-4 py-3 text-xs font-semibold uppercase text-gray-500">时间</th>
                <th class="px-4 py-3 text-xs font-semibold uppercase text-gray-500">类型</th>
                <th class="px-4 py-3 text-xs font-semibold uppercase text-gray-500">状态</th>
                <th class="px-4 py-3 text-xs font-semibold uppercase text-gray-500">收件人</th>
                <th class="px-4 py-3 text-xs font-semibold uppercase text-gray-500">主题</th>
                <th class="px-4 py-3 text-xs font-semibold uppercase text-gray-500">错误信息</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <tr v-for="mail in mails" :key="mail.id" class="hover:bg-gray-50 transition-colors"
                data-test="mail-row">
                <td class="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">{{ formatDateTime(mail.createdAt) }}</td>
                <td class="px-4 py-3">
                  <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600 border border-gray-200 whitespace-nowrap">
                    {{ typeLabel(mail.type) }}
                  </span>
                </td>
                <td class="px-4 py-3">
                  <span :class="['inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border whitespace-nowrap',
                    mail.status === 'sent'
                      ? 'bg-emerald-50 text-emerald-600 border-emerald-200'
                      : 'bg-red-50 text-red-600 border-red-200']"
                    :data-test="`mail-status-${mail.status}`">
                    <i :class="['mr-1', mail.status === 'sent' ? 'fa-solid fa-check' : 'fa-solid fa-xmark']"></i>
                    {{ mail.status === 'sent' ? '成功' : '失败' }}
                  </span>
                </td>
                <td class="px-4 py-3">
                  <span class="block text-sm text-gray-600 max-w-[220px] truncate" :title="mail.recipient">{{ mail.recipient }}</span>
                </td>
                <td class="px-4 py-3">
                  <span class="block text-sm text-gray-700 max-w-[320px] truncate" :title="mail.subject">{{ mail.subject }}</span>
                </td>
                <td class="px-4 py-3">
                  <span v-if="mail.error" class="block text-xs text-red-500 max-w-[280px] truncate font-mono"
                    :title="mail.error" data-test="mail-error">{{ mail.error }}</span>
                  <span v-else class="text-xs text-gray-300">—</span>
                </td>
              </tr>
              <tr v-if="mails.length === 0">
                <td colspan="6" class="px-5 py-8 text-center text-sm text-gray-400">
                  {{ hasFilters ? '没有符合条件的邮件记录' : '暂无邮件记录' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 分页 -->
        <div class="px-5 py-4 border-t flex items-center justify-between bg-gray-50 border-gray-200">
          <span class="text-xs text-gray-500">共 {{ total }} 条 · {{ totalPages }} 页</span>
          <div class="flex items-center space-x-1">
            <button @click="fetchMails(pagination.page - 1)" :disabled="pagination.page <= 1"
              class="px-3 py-1 text-xs font-medium rounded border disabled:opacity-40 transition-colors border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
              上一页
            </button>
            <span class="px-4 text-xs font-bold text-gray-700">{{ pagination.page }}</span>
            <button @click="fetchMails(pagination.page + 1)" :disabled="pagination.page >= totalPages"
              class="px-3 py-1 text-xs font-medium rounded border disabled:opacity-40 transition-colors border-gray-300 bg-white text-gray-700 hover:bg-gray-50">
              下一页
            </button>
          </div>
        </div>
      </div>
    </template>
  </AdminLayout>
</template>

<script setup>
/**
 * 邮件管理（侧边栏入口）
 *
 * 展示**外发邮件日志**：只记真正尝试发送的邮件（SMTP 未配置、邮件通知关闭导致的跳过不记），
 * 成功与失败都留痕，失败带错误信息。保留天数由后端下发 retentionDays
 * （设置项 `mail_log_retention_days`，0 = 永久保留）。
 */
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import request from '../utils/request';
import toast from '../utils/toast';
import AdminLayout from '../components/AdminLayout.vue';
import SelectMenu from '../components/SelectMenu.vue';

const router = useRouter();
const loading = ref(false);
const apiUrl = ref(localStorage.getItem('apiUrl') || window.location.origin);
const mails = ref([]);
const total = ref(0);
const retentionDays = ref(30);
const pagination = ref({ page: 1, pageSize: 20 });
const statusFilter = ref('all');
const typeFilter = ref('all');
const searchKeyword = ref('');

/** 邮件类型（与后端 / doc/link_security.md 的枚举逐字对应） */
const TYPE_OPTIONS = [
  { label: '全部类型', value: 'all' },
  { label: '邮箱验证', value: 'verify' },
  { label: '链接同步确认', value: 'link_sync' },
  { label: '休眠提醒', value: 'dormant_notice' },
  { label: '新评论通知', value: 'comment_notify' },
  { label: '回复通知', value: 'reply_notify' },
  { label: '测试邮件', value: 'test' },
];

const typeOptions = TYPE_OPTIONS;
const TYPE_LABELS = Object.fromEntries(
  TYPE_OPTIONS.filter((option) => option.value !== 'all').map((option) => [option.value, option.label])
);

const typeLabel = (type) => TYPE_LABELS[type] || type || '未知';

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / (pagination.value.pageSize || 20))));
const hasFilters = computed(
  () => statusFilter.value !== 'all' || typeFilter.value !== 'all' || searchKeyword.value.trim() !== ''
);

const fetchMails = async (page = 1) => {
  loading.value = true;
  try {
    const params = { page, pageSize: pagination.value.pageSize };
    if (statusFilter.value !== 'all') params.status = statusFilter.value;
    if (typeFilter.value !== 'all') params.type = typeFilter.value;
    const keyword = searchKeyword.value.trim();
    if (keyword) params.search = keyword;
    const res = await request.get('/admin/mails', { params });
    if (res.data) {
      mails.value = res.data.list || [];
      total.value = res.data.total || 0;
      pagination.value = {
        page: res.data.page || page,
        pageSize: res.data.pageSize || pagination.value.pageSize,
      };
      // 0 是合法值（永久保留），不能用 falsy 判断，否则会被默认的 30 覆盖
      if (typeof res.data.retentionDays === 'number') retentionDays.value = res.data.retentionDays;
    }
  } catch (error) {
    toast.error('加载邮件记录失败');
  } finally {
    loading.value = false;
  }
};

const applyFilters = () => fetchMails(1);

const resetFilters = () => {
  statusFilter.value = 'all';
  typeFilter.value = 'all';
  searchKeyword.value = '';
  fetchMails(1);
};

const formatDateTime = (str) => {
  if (!str) return '-';
  return new Date(str).toLocaleString('zh-CN');
};

const logout = () => {
  localStorage.removeItem('token');
  router.push('/login');
};

onMounted(() => fetchMails(1));
</script>
