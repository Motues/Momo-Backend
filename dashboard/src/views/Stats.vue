<template>
  <AdminLayout :baseUrl="apiUrl" @logout="logout" @refresh="fetchStats">
    <div v-if="loading" class="flex justify-center py-20">
      <div class="animate-spin rounded-full h-10 w-10 border-4 border-blue-500 border-t-transparent"></div>
    </div>

    <template v-else>
      <!-- Stat Cards -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div @click="goComments()"
          class="bg-white rounded-lg shadow-sm border border-gray-200 p-5 cursor-pointer transition-all hover:shadow-md hover:border-blue-200">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-xs font-medium uppercase tracking-wider text-gray-500">评论总数</p>
              <p class="text-2xl font-bold mt-1 text-gray-800">{{ stats.totalComments }}</p>
            </div>
            <div class="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
              <i class="fa-solid fa-comments text-blue-500"></i>
            </div>
          </div>
        </div>
        <div @click="goUsers()"
          class="bg-white rounded-lg shadow-sm border border-gray-200 p-5 cursor-pointer transition-all hover:shadow-md hover:border-green-200">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-xs font-medium uppercase tracking-wider text-gray-500">评论用户</p>
              <p class="text-2xl font-bold mt-1 text-gray-800">{{ stats.totalUsers }}</p>
            </div>
            <div class="w-10 h-10 rounded-lg bg-green-50 flex items-center justify-center">
              <i class="fa-solid fa-users text-green-500"></i>
            </div>
          </div>
        </div>
        <div @click="goComments()"
          class="bg-white rounded-lg shadow-sm border border-gray-200 p-5 cursor-pointer transition-all hover:shadow-md hover:border-purple-200">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-xs font-medium uppercase tracking-wider text-gray-500">文章数</p>
              <p class="text-2xl font-bold mt-1 text-gray-800">{{ stats.totalPosts }}</p>
            </div>
            <div class="w-10 h-10 rounded-lg bg-purple-50 flex items-center justify-center">
              <i class="fa-solid fa-file-lines text-purple-500"></i>
            </div>
          </div>
        </div>
        <div @click="goComments('pending')"
          class="bg-white rounded-lg shadow-sm border border-gray-200 p-5 cursor-pointer transition-all hover:shadow-md hover:border-amber-200">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-xs font-medium uppercase tracking-wider text-gray-500">待审核</p>
              <p class="text-2xl font-bold mt-1 text-amber-600">{{ stats.statusDistribution.pending }}</p>
            </div>
            <div class="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center">
              <i class="fa-solid fa-clock text-amber-500"></i>
            </div>
          </div>
        </div>
      </div>

      <!-- Charts Row -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <!-- Status Distribution -->
        <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <h3 class="text-sm font-semibold text-gray-700 mb-4">评论状态分布</h3>
          <DonutChart :data="statusSlices" :height="260" />
        </div>

        <!-- Trend Chart with Range Selector -->
        <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-sm font-semibold text-gray-700">评论趋势</h3>
            <div class="flex gap-1 bg-gray-100 rounded-lg p-0.5">
              <button v-for="opt in rangeOptions" :key="opt.value"
                @click="switchRange(opt.value)"
                :class="['px-3 py-1 text-xs rounded-md transition-all font-medium',
                  selectedRange === opt.value
                    ? 'bg-white text-blue-600 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700']">
                {{ opt.label }}
              </button>
            </div>
          </div>
          <LineAreaChart :labels="trendLabels" :values="trendValues" :raw-labels="trendRawLabels" :height="260" />
        </div>
      </div>

      <!-- Top Commenters -->
      <div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div class="px-5 py-4 border-b border-gray-100">
          <h3 class="text-sm font-semibold text-gray-700">热门评论者 Top 5</h3>
        </div>
        <div class="overflow-x-auto">
          <table class="data-table w-full text-left">
            <thead>
              <tr class="border-b bg-gray-50 border-gray-200">
                <th class="px-5 py-3 text-xs font-semibold uppercase text-gray-500">#</th>
                <th class="px-5 py-3 text-xs font-semibold uppercase text-gray-500">作者</th>
                <th class="px-5 py-3 text-xs font-semibold uppercase text-gray-500">邮箱</th>
                <th class="px-5 py-3 text-xs font-semibold uppercase text-gray-500">评论数</th>
                <th class="px-5 py-3 text-xs font-semibold uppercase text-gray-500">最后评论</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <tr v-for="(item, index) in stats.topCommenters" :key="index"
                @click="goUserComments(item)"
                class="hover:bg-blue-50/40 transition-colors cursor-pointer">
                <td class="px-5 py-3 text-sm text-gray-500">{{ index + 1 }}</td>
                <td class="px-5 py-3">
                  <span class="block text-sm font-medium text-gray-800 max-w-[160px] truncate" :title="item.author">{{ item.author }}</span>
                </td>
                <td class="px-5 py-3">
                  <span class="block text-sm text-gray-500 max-w-[220px] truncate" :title="item.email">{{ item.email }}</span>
                </td>
                <td class="px-5 py-3">
                  <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700">{{ item.count }}</span>
                </td>
                <td class="px-5 py-3 text-sm text-gray-500">{{ formatDate(item.lastCommentDate) }}</td>
              </tr>
              <tr v-if="stats.topCommenters.length === 0">
                <td colspan="5" class="px-5 py-8 text-center text-sm text-gray-400">暂无数据</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </AdminLayout>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import toast from '../utils/toast';
import request from '../utils/request';
import AdminLayout from '../components/AdminLayout.vue';
import DonutChart from '../components/charts/DonutChart.vue';
import LineAreaChart from '../components/charts/LineAreaChart.vue';

const router = useRouter();
const loading = ref(false);
const apiUrl = ref(localStorage.getItem('apiUrl') || window.location.origin);
const selectedRange = ref(7);

const rangeOptions = [
  { label: '7天', value: 7 },
  { label: '14天', value: 14 },
  { label: '1个月', value: 30 },
  { label: '1年', value: 0 },
];

const stats = ref({
  totalComments: 0,
  totalUsers: 0,
  totalPosts: 0,
  statusDistribution: { approved: 0, pending: 0, deleted: 0 },
  recentComments: [],
  topCommenters: []
});

/** 环形图数据：与 echarts 版本保持同一套配色与顺序 */
const statusSlices = computed(() => {
  const sd = stats.value.statusDistribution;
  return [
    { name: '已通过', value: Number(sd.approved) || 0, color: '#10b981' },
    { name: '待审核', value: Number(sd.pending) || 0, color: '#f59e0b' },
    { name: '已删除', value: Number(sd.deleted) || 0, color: '#ef4444' },
  ];
});

/** X 轴展示标签：日粒度取 MM-DD，月粒度取「M月 / YY年」 */
const trendLabels = computed(() =>
  (stats.value.recentComments || []).map((item) => {
    if (item.date?.length === 7) {
      const parts = item.date.split('-');
      const month = parseInt(parts[1]);
      if (month === 1) return `${parts[0].slice(2)}年`;
      return `${month}月`;
    }
    return item.date?.slice(5) || '';
  }),
);

/** 悬浮提示使用的原始日期 */
const trendRawLabels = computed(() => (stats.value.recentComments || []).map((item) => item.date ?? ''));

const trendValues = computed(() => (stats.value.recentComments || []).map((item) => item.count ?? 0));

const switchRange = async (range) => {
  selectedRange.value = range;
  await fetchStats(true);
};

const fetchStats = async (silent = false) => {
  if (!silent) loading.value = true;
  try {
    const range = selectedRange.value;
    const res = await request.get(`/admin/stats/overview?range=${range}`);
    if (res.data) {
      stats.value = {
        totalComments: 0,
        totalUsers: 0,
        totalPosts: 0,
        statusDistribution: { approved: 0, pending: 0, deleted: 0 },
        recentComments: [],
        topCommenters: [],
        ...res.data,
        statusDistribution: { approved: 0, pending: 0, deleted: 0, ...res.data.statusDistribution },
        recentComments: res.data.recentComments || [],
        topCommenters: res.data.topCommenters || [],
      };
    }
    if (!silent) loading.value = false;
  } catch (error) {
    if (!silent) loading.value = false;
    if (!silent) toast.error('加载统计数据失败');
  }
};

const formatDate = (str) => {
  if (!str) return '-';
  return new Date(str).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

const goComments = (status) => {
  router.push(status ? `/comments?status=${status}` : '/comments');
};

const goUsers = () => {
  router.push('/users');
};

const goUserComments = (user) => {
  router.push({
    path: '/user-comments',
    query: { author: user.author, email: user.email }
  });
};

const logout = () => {
  localStorage.removeItem('token');
  router.push('/login');
};

onMounted(() => {
  fetchStats();
});
</script>
