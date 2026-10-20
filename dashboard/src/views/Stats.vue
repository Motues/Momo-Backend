<template>
  <AdminLayout :baseUrl="apiUrl" @logout="logout" @refresh="refreshAll">
    <div v-if="loading" class="flex justify-center py-20">
      <div class="animate-spin rounded-full h-10 w-10 border-4 border-blue-500 border-t-transparent"></div>
    </div>

    <template v-else>
      <!-- 待审核提醒：有积压时置顶，一键跳到待审核列表 -->
      <div v-if="pendingCount > 0"
        class="pending-alert mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-5 py-4">
        <div class="w-9 h-9 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
          <i class="fa-solid fa-triangle-exclamation text-amber-500"></i>
        </div>
        <div class="flex-1 min-w-[200px]">
          <p class="text-sm font-semibold text-amber-800">有 {{ formatCount(pendingCount) }} 条评论等待审核</p>
          <p class="text-xs text-amber-700/80 mt-0.5">
            占全部评论的 {{ formatPercent(pendingShare) }}，未通过前不会出现在评论区。
          </p>
        </div>
        <button @click="goComments('pending')"
          class="shrink-0 px-4 py-2 rounded-lg bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 transition-colors">
          立即处理
        </button>
      </div>

      <!-- 核心指标 -->
      <div class="grid grid-cols-2 xl:grid-cols-4 gap-4 mb-4">
        <button v-for="card in primaryCards" :key="card.key" @click="card.action()"
          class="stat-card text-left bg-white rounded-lg shadow-sm border border-gray-200 p-5 transition-all hover:shadow-md"
          :class="card.hoverBorder" :title="card.title">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-xs font-medium uppercase tracking-wider text-gray-500">{{ card.label }}</p>
              <p class="text-2xl font-bold mt-1 tabular-nums" :class="card.valueClass">{{ card.value }}</p>
              <p class="text-[11px] text-gray-400 mt-1 truncate">{{ card.sub }}</p>
            </div>
            <div :class="['w-10 h-10 rounded-lg flex items-center justify-center shrink-0', card.iconBg]">
              <i :class="['fa-solid', card.icon, card.iconColor]"></i>
            </div>
          </div>
        </button>
      </div>

      <!-- 近期动态指标（含环比） -->
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        <div v-for="item in recentCards" :key="item.key"
          class="recent-card bg-white rounded-lg shadow-sm border border-gray-200 px-5 py-4" :title="item.title">
          <div class="flex items-center justify-between">
            <p class="text-xs font-medium text-gray-500">{{ item.label }}</p>
            <i :class="['fa-solid', item.icon, 'text-gray-300']"></i>
          </div>
          <div class="flex items-end gap-2 mt-1">
            <p class="text-xl font-bold text-gray-800 tabular-nums">{{ item.value }}</p>
            <span v-if="item.delta !== null" class="mb-0.5 inline-flex items-center text-xs font-medium"
              :class="item.delta >= 0 ? 'text-emerald-600' : 'text-red-500'">
              <i :class="['fa-solid mr-0.5 text-[10px]', item.delta >= 0 ? 'fa-arrow-up' : 'fa-arrow-down']"></i>{{ Math.abs(item.delta) }}%
            </span>
            <span v-else-if="item.showDeltaNote" class="mb-0.5 text-[11px] text-gray-400">暂无可比数据</span>
          </div>
          <p class="text-[11px] text-gray-400 mt-1">{{ item.sub }}</p>
        </div>
      </div>

      <!-- 趋势 + 状态分布 -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div class="lg:col-span-2 bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <div class="flex flex-wrap items-start justify-between gap-3 mb-4">
            <div>
              <h3 class="text-sm font-semibold text-gray-700">评论趋势</h3>
              <p class="text-[11px] text-gray-400 mt-0.5">{{ rangeHint }}</p>
            </div>
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

        <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <div class="flex items-start justify-between gap-3 mb-3">
            <div>
              <h3 class="text-sm font-semibold text-gray-700">评论状态分布</h3>
              <p class="text-[11px] text-gray-400 mt-0.5">通过率 {{ passRateText }}</p>
            </div>
            <span class="text-[11px] text-gray-400 tabular-nums">{{ formatCount(statusTotal) }} 条已判定</span>
          </div>
          <DonutChart :data="statusSlices" :height="240" />
        </div>
      </div>

      <!-- 榜单与动态 -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <!-- 热门文章 -->
        <section class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden flex flex-col">
          <header class="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <h3 class="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <i class="fa-solid fa-fire text-gray-400"></i>热门文章 Top 5
            </h3>
            <span class="text-[10px] text-gray-400 uppercase tracking-wider">评论数</span>
          </header>
          <ul class="divide-y divide-gray-50 flex-1">
            <li v-for="(post, index) in stats.topPosts" :key="post.postSlug"
              @click="goPostComments(post.postSlug)"
              class="post-row px-5 py-3 flex items-center gap-3 cursor-pointer hover:bg-blue-50/40 transition-colors">
              <span class="w-4 text-xs font-semibold tabular-nums shrink-0"
                :class="index < 3 ? 'text-blue-600' : 'text-gray-400'">{{ index + 1 }}</span>
              <div class="flex-1 min-w-0">
                <p class="text-sm text-gray-700 truncate" :title="post.postSlug">{{ post.postSlug }}</p>
                <p class="text-[10px] text-gray-400">最后评论 {{ formatDate(post.lastCommentDate) }}</p>
              </div>
              <span class="text-sm font-medium text-gray-700 tabular-nums shrink-0">{{ formatCount(post.count) }}</span>
            </li>
            <li v-if="!stats.topPosts.length" class="px-5 py-8 text-center text-sm text-gray-400">暂无数据</li>
          </ul>
        </section>

        <!-- 热门评论者 -->
        <section class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden flex flex-col">
          <header class="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <h3 class="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <i class="fa-solid fa-users text-gray-400"></i>热门评论者 Top 5
            </h3>
            <span class="text-[10px] text-gray-400 uppercase tracking-wider">评论数</span>
          </header>
          <ul class="divide-y divide-gray-50 flex-1">
            <li v-for="(item, index) in stats.topCommenters" :key="`${item.author}|${item.email}`"
              @click="goUserComments(item)"
              class="commenter-row px-5 py-3 flex items-center gap-3 cursor-pointer hover:bg-blue-50/40 transition-colors">
              <span class="w-4 text-xs font-semibold tabular-nums shrink-0"
                :class="index < 3 ? 'text-blue-600' : 'text-gray-400'">{{ index + 1 }}</span>
              <div class="flex-1 min-w-0">
                <p class="text-sm font-medium text-gray-800 truncate" :title="item.author">{{ item.author }}</p>
                <p class="text-[10px] text-gray-400 truncate" :title="item.email">{{ item.email }}</p>
              </div>
              <div class="text-right shrink-0">
                <p class="text-sm font-medium text-gray-700 tabular-nums">{{ formatCount(item.count) }}</p>
                <p class="text-[10px] text-gray-400">{{ formatDate(item.lastCommentDate) }}</p>
              </div>
            </li>
            <li v-if="!stats.topCommenters.length" class="px-5 py-8 text-center text-sm text-gray-400">暂无数据</li>
          </ul>
        </section>

        <!-- 最新评论动态 -->
        <section class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden flex flex-col">
          <header class="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <h3 class="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <i class="fa-solid fa-bolt text-gray-400"></i>最新评论动态
            </h3>
            <button @click="goComments()" class="text-[11px] text-blue-600 hover:text-blue-700">查看全部</button>
          </header>
          <ul class="divide-y divide-gray-50 flex-1">
            <li v-for="comment in stats.latestComments" :key="comment.id"
              @click="goPostComments(comment.postSlug)"
              class="latest-row px-5 py-3 cursor-pointer hover:bg-blue-50/40 transition-colors">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium text-gray-800 truncate" :title="comment.author">{{ comment.author }}</span>
                <span :class="['shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium', statusMeta(comment.status).cls]">
                  {{ statusMeta(comment.status).label }}
                </span>
                <span class="ml-auto text-[10px] text-gray-400 shrink-0">{{ formatDate(comment.pubDate) }}</span>
              </div>
              <p class="text-xs text-gray-500 mt-1 line-clamp-2">{{ comment.contentText }}</p>
              <p class="text-[10px] text-gray-400 mt-0.5 truncate" :title="comment.postSlug">{{ comment.postSlug }}</p>
            </li>
            <li v-if="!stats.latestComments.length" class="px-5 py-8 text-center text-sm text-gray-400">暂无数据</li>
          </ul>
        </section>
      </div>

      <!-- 客户端分布 -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <section v-for="panel in distributionPanels" :key="panel.key"
          class="distribution-panel bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <header class="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <h3 class="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <i :class="['fa-solid', panel.icon, 'text-gray-400']"></i>{{ panel.title }}
            </h3>
            <span class="text-[10px] text-gray-400 uppercase tracking-wider">占比</span>
          </header>
          <ul class="px-5 py-4 space-y-3">
            <li v-for="item in panel.items" :key="item.name" class="distribution-row">
              <div class="flex items-center justify-between text-xs mb-1 gap-2">
                <span class="text-gray-600 truncate" :title="item.name">{{ item.name }}</span>
                <span class="text-gray-500 tabular-nums shrink-0">
                  {{ formatCount(item.count) }} · {{ formatPercent(item.percent) }}
                </span>
              </div>
              <div class="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                <div class="h-full rounded-full" :class="panel.barClass" :style="{ width: `${item.bar}%` }"></div>
              </div>
            </li>
            <li v-if="!panel.items.length" class="py-6 text-center text-sm text-gray-400">暂无数据</li>
          </ul>
        </section>
      </div>

      <!-- 人机验证概览：后端未开启认证记录时整块隐藏 -->
      <section v-if="verify" class="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-4">
          <h3 class="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <i class="fa-solid fa-fingerprint text-gray-400"></i>人机验证概览
          </h3>
          <div class="flex items-center gap-3">
            <span class="text-[11px] text-gray-400">近 {{ VERIFY_DAYS }} 天</span>
            <router-link to="/verify-records" class="text-[11px] text-blue-600 hover:text-blue-700">
              查看全部 <i class="fa-solid fa-arrow-right text-[10px]"></i>
            </router-link>
          </div>
        </div>
        <div class="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <div v-for="item in verifyMetrics" :key="item.key">
            <p class="text-xs text-gray-500">{{ item.label }}</p>
            <p class="text-lg font-bold text-gray-800 tabular-nums mt-0.5">{{ item.value }}</p>
            <p class="text-[11px] text-gray-400 mt-0.5 truncate" :title="item.sub">{{ item.sub }}</p>
          </div>
        </div>
      </section>
    </template>
  </AdminLayout>
</template>

<script setup>
/**
 * 数据统计（管理后台首页）。
 *
 * 数据全部来自两个只读接口：
 *  - `GET /admin/stats/overview?range=N`：总数、状态分布、趋势、榜单、客户端分布、最新动态；
 *  - `GET /admin/verify/overview?days=30`：人机验证概览（失败时静默隐藏，不影响其它统计）。
 *
 * 时间口径统一是 **UTC**（趋势分桶、今日、近 7 天、窗口指标全部由后端按 UTC 切分），
 * 因此这里只做展示，不在前端重新算「今天」—— 否则浏览器时区与后端会给出两个答案。
 */
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import toast from '../utils/toast';
import request from '../utils/request';
import AdminLayout from '../components/AdminLayout.vue';
import DonutChart from '../components/charts/DonutChart.vue';
import LineAreaChart from '../components/charts/LineAreaChart.vue';
import { bucketAxisLabel, bucketTooltipLabel } from '../utils/time';

const router = useRouter();
const loading = ref(false);
const apiUrl = ref(localStorage.getItem('apiUrl') || window.location.origin);
const selectedRange = ref(7);
const verify = ref(null);

/** 人机验证概览固定看最近 30 天（与认证记录页默认窗口一致） */
const VERIFY_DAYS = 30;

const rangeOptions = [
  { label: '7天', value: 7 },
  { label: '14天', value: 14 },
  { label: '1个月', value: 30 },
  { label: '1年', value: 0 },
];

/** 窗口的中文说法，用于「近 N 天新增」这类卡片标题 */
const RANGE_LABELS = { 7: '近 7 天', 14: '近 14 天', 30: '近 30 天', 0: '近 12 个月' };

const EMPTY_STATS = {
  totalComments: 0,
  totalUsers: 0,
  totalPosts: 0,
  statusDistribution: { approved: 0, pending: 0, deleted: 0 },
  recentComments: [],
  topCommenters: [],
  windowComments: 0,
  prevWindowComments: 0,
  commentsDelta: null,
  windowUsers: 0,
  prevWindowUsers: 0,
  usersDelta: null,
  todayComments: 0,
  last7DaysComments: 0,
  topPosts: [],
  deviceDistribution: [],
  browserDistribution: [],
  osDistribution: [],
  latestComments: [],
};

const stats = ref({ ...EMPTY_STATS });

const STATUS_META = {
  approved: { label: '已通过', cls: 'bg-emerald-50 text-emerald-700' },
  pending: { label: '待审核', cls: 'bg-amber-50 text-amber-700' },
  deleted: { label: '已删除', cls: 'bg-red-50 text-red-600' },
  rejected: { label: '已拒绝', cls: 'bg-gray-100 text-gray-600' },
};

const statusMeta = (status) => STATUS_META[status] || { label: status || '未知', cls: 'bg-gray-100 text-gray-600' };

/* ---------- 数字格式化 ---------- */
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const formatCount = (value) => num(value).toLocaleString('zh-CN');

const formatPercent = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const rounded = Math.round(n * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
};

/** 保留一位小数；分母为 0 时给「—」而不是 0 或 Infinity */
const formatAverage = (total, parts) => (parts > 0 ? (total / parts).toFixed(1) : '—');

/* ---------- 派生指标 ---------- */
const statusTotal = computed(() => {
  const sd = stats.value.statusDistribution;
  return num(sd.approved) + num(sd.pending) + num(sd.deleted);
});

const pendingCount = computed(() => num(stats.value.statusDistribution.pending));

/** 待审核占全部评论的比例（含 rejected 之外的所有状态，故分母用评论总数） */
const pendingShare = computed(() =>
  num(stats.value.totalComments) > 0 ? (pendingCount.value / num(stats.value.totalComments)) * 100 : 0
);

/**
 * 通过率：已通过 ÷ 已判定（通过 + 待审核 + 已删除）。
 * 分母刻意不含 `rejected`（不计入任何状态桶），也没有可比数据时给「—」。
 */
const passRate = computed(() => (statusTotal.value > 0 ? (num(stats.value.statusDistribution.approved) / statusTotal.value) * 100 : null));
const passRateText = computed(() => (passRate.value === null ? '—' : formatPercent(passRate.value)));

const rangeLabel = computed(() => RANGE_LABELS[selectedRange.value] || `近 ${selectedRange.value} 天`);

const rangeHint = computed(() =>
  selectedRange.value === 0 ? '最近 12 个月，按月分桶（UTC）' : `最近 ${selectedRange.value} 天，按 UTC 日分桶`
);

/** 顶部四张可跳转的核心指标卡 */
const primaryCards = computed(() => [
  {
    key: 'comments',
    label: '评论总数',
    value: formatCount(stats.value.totalComments),
    sub: `通过率 ${passRateText.value}`,
    title: '全部评论（含待审核与已删除）',
    valueClass: 'text-gray-800',
    icon: 'fa-comments',
    iconBg: 'bg-blue-50',
    iconColor: 'text-blue-500',
    hoverBorder: 'hover:border-blue-200',
    action: () => goComments(),
  },
  {
    key: 'users',
    label: '评论用户',
    value: formatCount(stats.value.totalUsers),
    sub: `人均 ${formatAverage(num(stats.value.totalComments), num(stats.value.totalUsers))} 条评论`,
    title: '按「昵称 + 邮箱」去重的评论者数',
    valueClass: 'text-gray-800',
    icon: 'fa-users',
    iconBg: 'bg-emerald-50',
    iconColor: 'text-emerald-500',
    hoverBorder: 'hover:border-emerald-200',
    action: () => goUsers(),
  },
  {
    key: 'posts',
    label: '文章数',
    value: formatCount(stats.value.totalPosts),
    sub: `篇均 ${formatAverage(num(stats.value.totalComments), num(stats.value.totalPosts))} 条评论`,
    title: '至少有一条评论的文章数',
    valueClass: 'text-gray-800',
    icon: 'fa-file-lines',
    iconBg: 'bg-violet-50',
    iconColor: 'text-violet-500',
    hoverBorder: 'hover:border-violet-200',
    action: () => goComments(),
  },
  {
    key: 'pending',
    label: '待审核',
    value: formatCount(pendingCount.value),
    sub: `占全部 ${formatPercent(pendingShare.value)}`,
    title: '点击进入待审核列表',
    valueClass: 'text-amber-600',
    icon: 'fa-clock',
    iconBg: 'bg-amber-50',
    iconColor: 'text-amber-500',
    hoverBorder: 'hover:border-amber-200',
    action: () => goComments('pending'),
  },
]);

/** 近期动态指标：今日 / 近 7 天 / 当前窗口 / 活跃用户（后两项带环比） */
const recentCards = computed(() => {
  const stats7 = num(stats.value.last7DaysComments);
  return [
    {
      key: 'today',
      label: '今日新增',
      value: formatCount(stats.value.todayComments),
      delta: null,
      showDeltaNote: false,
      sub: 'UTC 日 00:00 起',
      icon: 'fa-calendar-day',
      title: '按 UTC 日切分（与趋势分桶同一时区口径）',
    },
    {
      key: 'week',
      label: '近 7 天新增',
      value: formatCount(stats7),
      delta: null,
      showDeltaNote: false,
      sub: `日均 ${(stats7 / 7).toFixed(1)} 条`,
      icon: 'fa-calendar-week',
      title: '最近 7 个 UTC 日（含今天）',
    },
    {
      key: 'window',
      label: '本周期新增',
      value: formatCount(stats.value.windowComments),
      delta: stats.value.commentsDelta,
      showDeltaNote: true,
      sub: `${rangeLabel.value} · 上一周期 ${formatCount(stats.value.prevWindowComments)} 条`,
      icon: 'fa-chart-line',
      title: '当前时间范围内的新增评论，与上一个等长窗口比较；上一窗口无数据时不给环比',
    },
    {
      key: 'active',
      label: '本周期活跃用户',
      value: formatCount(stats.value.windowUsers),
      delta: stats.value.usersDelta,
      showDeltaNote: true,
      sub: `${rangeLabel.value} · 上一周期 ${formatCount(stats.value.prevWindowUsers)} 人`,
      icon: 'fa-user-clock',
      title: '窗口内出现过的评论者（昵称 + 邮箱去重）',
    },
  ];
});

/** 分布面板：把 Top 5 换算成占比，长尾合并成「其他」 */
const withShare = (list) => {
  const total = num(stats.value.totalComments);
  const items = (list || []).map((item) => ({
    name: item.name,
    count: num(item.count),
  }));
  const max = Math.max(1, ...items.map((item) => item.count));
  const rows = items.map((item) => ({
    ...item,
    percent: total > 0 ? (item.count / total) * 100 : 0,
    bar: (item.count / max) * 100,
  }));
  const shown = rows.reduce((sum, row) => sum + row.count, 0);
  // 只有在拿到分布数据时才补「其他」：整块为空说明该字段缺失（旧后端），
  // 此时凭空造一条「其他 100%」反而会误导。
  if (items.length > 0 && total > shown) {
    const rest = total - shown;
    rows.push({
      name: '其他',
      count: rest,
      percent: total > 0 ? (rest / total) * 100 : 0,
      bar: (rest / max) * 100,
    });
  }
  return rows;
};

const distributionPanels = computed(() => [
  {
    key: 'device',
    title: '设备分布',
    icon: 'fa-mobile-screen-button',
    barClass: 'bg-blue-500',
    items: withShare(stats.value.deviceDistribution),
  },
  {
    key: 'browser',
    title: '浏览器分布',
    icon: 'fa-globe',
    barClass: 'bg-violet-500',
    items: withShare(stats.value.browserDistribution),
  },
  {
    key: 'os',
    title: '操作系统分布',
    icon: 'fa-desktop',
    barClass: 'bg-emerald-500',
    items: withShare(stats.value.osDistribution),
  },
]);

/** 环比文案：后端用 null 表示「上一窗口没有数据」 */
const deltaText = (delta) => {
  if (delta === null || delta === undefined) return '上一周期无对照数据';
  return `较上一周期 ${delta >= 0 ? '↑' : '↓'} ${Math.abs(delta)}%`;
};

const verifyMetrics = computed(() => {
  const summary = verify.value?.summary;
  if (!summary) return [];
  const avgMs = summary.avgDurationMs;
  return [
    {
      key: 'passRate',
      label: '通过率',
      value: summary.passRate === null || summary.passRate === undefined ? '—' : formatPercent(summary.passRate),
      sub: '通过 ÷ (通过 + 失败)',
    },
    {
      key: 'challenges',
      label: '签发挑战',
      value: formatCount(summary.challenges),
      sub: deltaText(summary.challengesDelta),
    },
    {
      key: 'verified',
      label: '校验通过',
      value: formatCount(summary.verified),
      sub: deltaText(summary.verifiedDelta),
    },
    {
      key: 'failed',
      label: '校验失败',
      value: formatCount(summary.failed),
      sub: deltaText(summary.failedDelta),
    },
    {
      key: 'duration',
      label: '平均耗时',
      value: avgMs === null || avgMs === undefined ? '—' : `${(num(avgMs) / 1000).toFixed(1)} s`,
      sub: deltaText(summary.avgDurationDelta),
    },
  ];
});

/* ---------- 图表数据 ---------- */
/** 环形图数据：与 echarts 版本保持同一套配色与顺序 */
const statusSlices = computed(() => {
  const sd = stats.value.statusDistribution;
  return [
    { name: '已通过', value: Number(sd.approved) || 0, color: '#10b981' },
    { name: '待审核', value: Number(sd.pending) || 0, color: '#f59e0b' },
    { name: '已删除', value: Number(sd.deleted) || 0, color: '#ef4444' },
  ];
});

/** X 轴展示标签：后端分桶键是 UTC，换算成本地时区后显示（日粒度 MM-DD，月粒度「M月 / YY年」） */
const trendLabels = computed(() =>
  (stats.value.recentComments || []).map((item) => bucketAxisLabel(item.date)),
);

/** 悬浮提示使用的完整本地时间 */
const trendRawLabels = computed(() =>
  (stats.value.recentComments || []).map((item) => bucketTooltipLabel(item.date)),
);

const trendValues = computed(() => (stats.value.recentComments || []).map((item) => item.count ?? 0));

/* ---------- 数据加载 ---------- */
const switchRange = async (range) => {
  selectedRange.value = range;
  await fetchStats(true);
};

const fetchStats = async (silent = false) => {
  if (!silent) loading.value = true;
  try {
    const res = await request.get(`/admin/stats/overview?range=${selectedRange.value}`);
    if (res.data) {
      const data = res.data;
      stats.value = {
        ...EMPTY_STATS,
        ...data,
        statusDistribution: { ...EMPTY_STATS.statusDistribution, ...data.statusDistribution },
        recentComments: data.recentComments || [],
        topCommenters: data.topCommenters || [],
        topPosts: data.topPosts || [],
        latestComments: data.latestComments || [],
        deviceDistribution: data.deviceDistribution || [],
        browserDistribution: data.browserDistribution || [],
        osDistribution: data.osDistribution || [],
      };
    }
  } catch (error) {
    if (!silent) toast.error('加载统计数据失败');
  } finally {
    if (!silent) loading.value = false;
  }
};

/**
 * 人机验证概览是**附加信息**：后端没开启认证记录、或旧版本没有这个接口时静默隐藏，
 * 既不弹错误提示，也不影响首页其它统计的可用性。
 */
const fetchVerify = async () => {
  try {
    const res = await request.get(`/admin/verify/overview?days=${VERIFY_DAYS}`);
    verify.value = res.data || null;
  } catch (error) {
    verify.value = null;
  }
};

const refreshAll = () => {
  fetchStats();
  fetchVerify();
};

/* ---------- 展示与跳转 ---------- */
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

/** 评论管理页支持按文章标识精确筛选（Top 文章 / 动态流点击） */
const goPostComments = (postSlug) => {
  if (!postSlug) return;
  router.push({ path: '/comments', query: { slug: postSlug } });
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
  fetchVerify();
});
</script>
