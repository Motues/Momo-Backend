<template>
  <AdminLayout :baseUrl="apiUrl" @logout="logout" @refresh="refresh">
    <div v-if="loading" class="flex justify-center py-20">
      <div class="animate-spin rounded-full h-10 w-10 border-4 border-blue-500 border-t-transparent"></div>
    </div>

    <template v-else>
      <!-- 时间范围与窗口平移（对应参考图右上角的日期区间与左右箭头） -->
      <div class="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div class="flex items-center gap-3">
          <div class="flex gap-1 bg-gray-100 rounded-lg p-0.5">
            <button v-for="opt in rangeOptions" :key="opt.value"
              @click="switchRange(opt.value)"
              :class="['px-3 py-1 text-xs rounded-md transition-all font-medium',
                days === opt.value ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700']">
              {{ opt.label }}
            </button>
          </div>
          <span class="text-xs text-gray-500 font-mono">{{ rangeText }}</span>
        </div>

        <div class="flex items-center gap-2">
          <div class="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5">
            <button @click="shiftWindow(1)" :disabled="!canShiftBack" title="上一时间段"
              class="w-7 h-7 flex items-center justify-center rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white text-gray-600">
              <i class="fa-solid fa-chevron-left text-xs"></i>
            </button>
            <button @click="shiftWindow(-1)" :disabled="offset === 0" title="下一时间段"
              class="w-7 h-7 flex items-center justify-center rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white text-gray-600">
              <i class="fa-solid fa-chevron-right text-xs"></i>
            </button>
          </div>
        </div>
      </div>

      <!-- 指标卡 -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div v-for="card in statCards" :key="card.key"
          class="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <div class="flex items-start justify-between">
            <div>
              <p class="text-xs font-medium uppercase tracking-wider text-gray-500">{{ card.label }}</p>
              <p class="text-2xl font-bold mt-1 text-gray-800" :title="card.rawTitle">{{ card.value }}</p>
              <p v-if="card.sub" class="text-[10px] text-gray-400 mt-0.5">{{ card.sub }}</p>
            </div>
            <div :class="['w-10 h-10 rounded-lg flex items-center justify-center', card.iconBg]">
              <i :class="[card.icon, card.iconColor]"></i>
            </div>
          </div>
          <p class="mt-2 text-xs text-gray-400 flex items-center gap-1">
            <span v-if="card.delta === null">较上一周期无对照数据</span>
            <template v-else>
              <span :class="['inline-flex items-center font-medium', card.deltaClass]">
                <i :class="['mr-0.5', card.delta >= 0 ? 'fa-solid fa-arrow-up' : 'fa-solid fa-arrow-down']"></i>{{ Math.abs(card.delta) }}%
              </span>
              <span>较上一周期</span>
            </template>
          </p>
        </div>
      </div>

      <!-- 趋势 -->
      <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-5 mb-6">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-4">
          <h3 class="text-sm font-semibold text-gray-700">认证趋势</h3>
          <div class="flex items-center gap-4">
            <span v-for="item in trendLegend" :key="item.name" class="flex items-center gap-1.5 text-xs text-gray-500">
              <span class="inline-block w-2.5 h-2.5 rounded-full" :style="{ background: item.color }"></span>{{ item.name }}
            </span>
          </div>
        </div>
        <MultiLineChart :labels="trendLabels" :raw-labels="trendRawLabels" :series="trendSeries" :height="260" />
      </div>

      <!-- Top 榜单：地区/运营商仅 Cloudflare 部署有数据（geoSupported），其余端自动隐藏 -->
      <div :class="['grid grid-cols-1 gap-4 mb-6', topPanels.length > 1 ? 'lg:grid-cols-3' : '']">
        <div v-for="panel in topPanels" :key="panel.key"
          class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <div class="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <h3 class="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <i :class="[panel.icon, 'text-gray-400']"></i>{{ panel.title }}
            </h3>
            <span class="text-[10px] text-gray-400 uppercase tracking-wider">占比</span>
          </div>
          <ul class="divide-y divide-gray-50">
            <li v-for="item in panel.items" :key="item.key" class="px-5 py-3 flex items-center gap-3">
              <div class="flex-1 min-w-0">
                <p class="text-sm text-gray-700 truncate" :title="item.sub || item.label">{{ item.label }}</p>
                <p v-if="item.sub" class="text-[10px] text-gray-400 truncate font-mono">{{ item.sub }}</p>
              </div>
              <div class="text-right shrink-0">
                <p class="text-sm text-gray-700 tabular-nums">{{ item.count.toLocaleString('zh-CN') }}</p>
                <p class="text-[10px] text-gray-400 tabular-nums">{{ item.percent }}%</p>
              </div>
            </li>
            <li v-if="panel.items.length === 0" class="px-5 py-8 text-center text-sm text-gray-400">暂无数据</li>
          </ul>
        </div>
      </div>

      <!-- 认证明细 -->
      <div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div class="px-5 py-4 border-b border-gray-200 bg-gray-50/50 flex flex-col sm:flex-row sm:items-center gap-3">
          <h3 class="text-sm font-semibold text-gray-700 mr-auto flex items-center gap-2">
            <i class="fa-solid fa-fingerprint text-gray-400"></i>认证明细
          </h3>
          <SelectMenu v-model="eventFilter" class="shrink-0" accent="blue" title="按认证结果筛选"
            :options="[
              { label: '全部事件', value: 'all' },
              { label: '签发挑战', value: 'challenge' },
              { label: '校验通过', value: 'pass' },
              { label: '校验失败', value: 'fail' },
            ]"
            @change="applyFilters" />
          <div class="relative">
            <i class="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs"></i>
            <input v-model="ipFilter" type="text" placeholder="来源 IP 前缀"
              class="w-40 pl-8 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm font-mono"
              @keydown.enter="applyFilters" />
          </div>
          <div class="relative">
            <i class="fa-solid fa-link absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs"></i>
            <input v-model="slugFilter" type="text" placeholder="文章标识"
              class="w-44 pl-8 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
              @keydown.enter="applyFilters" />
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

        <div class="overflow-x-auto">
          <table class="data-table w-full text-left">
            <thead>
              <tr class="border-b bg-gray-50 border-gray-200">
                <th class="px-4 py-3 text-xs font-semibold uppercase text-gray-500 whitespace-nowrap">时间</th>
                <th class="px-4 py-3 text-xs font-semibold uppercase text-gray-500">事件</th>
                <th class="px-4 py-3 text-xs font-semibold uppercase text-gray-500">原因</th>
                <th class="px-4 py-3 text-xs font-semibold uppercase text-gray-500 whitespace-nowrap">耗时</th>
                <th class="px-4 py-3 text-xs font-semibold uppercase text-gray-500 whitespace-nowrap">来源 IP</th>
                <th v-if="overview.geoSupported" class="px-4 py-3 text-xs font-semibold uppercase text-gray-500 whitespace-nowrap">地区</th>
                <th class="px-4 py-3 text-xs font-semibold uppercase text-gray-500">文章</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <tr v-for="row in records.list" :key="row.id" class="hover:bg-gray-50 transition-colors">
                <td class="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{{ formatDateTime(row.createdAt) }}</td>
                <td class="px-4 py-3">
                  <span :class="['inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap', eventBadge(row.event).cls]">
                    <i :class="[eventBadge(row.event).icon, 'mr-1']"></i>{{ eventBadge(row.event).label }}
                  </span>
                </td>
                <td class="px-4 py-3 text-xs text-gray-600">
                  <span v-if="row.reason" :title="row.reason">{{ reasonLabel(row.reason) }}</span>
                  <span v-else class="text-gray-300">—</span>
                </td>
                <td class="px-4 py-3 text-xs text-gray-600 whitespace-nowrap tabular-nums">{{ formatDuration(row.elapsedMs) }}</td>
                <td class="px-4 py-3 text-xs text-gray-600 font-mono whitespace-nowrap">{{ row.ipAddress || '—' }}</td>
                <td v-if="overview.geoSupported" class="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">
                  <template v-if="row.country || row.network">
                    <span :title="row.network ? `${row.network}${row.asn ? ` (AS${row.asn})` : ''}` : row.country">
                      {{ row.country ? countryLabel(row.country) : row.network }}
                    </span>
                  </template>
                  <span v-else class="text-gray-300">—</span>
                </td>
                <td class="px-4 py-3 text-xs text-gray-500">
                  <span class="block max-w-[220px] truncate" :title="row.postSlug">{{ row.postSlug || '—' }}</span>
                </td>
              </tr>
              <tr v-if="records.list.length === 0">
                <td :colspan="overview.geoSupported ? 7 : 6" class="px-4 py-10 text-center text-sm text-gray-400">
                  {{ hasFilters ? '没有符合条件的认证记录' : '该时间段内没有认证记录' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 分页 -->
        <div class="px-5 py-4 border-t border-gray-200 flex items-center justify-between gap-3">
          <span class="text-xs text-gray-500">
            共 <strong class="text-gray-700">{{ records.total.toLocaleString('zh-CN') }}</strong> 条记录
          </span>
          <div class="flex items-center gap-2">
            <button @click="fetchRecords(records.page - 1)" :disabled="records.page <= 1"
              class="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              上一页
            </button>
            <span class="text-xs text-gray-500 tabular-nums">{{ records.page }} / {{ totalPages }}</span>
            <button @click="fetchRecords(records.page + 1)" :disabled="records.page >= totalPages"
              class="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              下一页
            </button>
          </div>
        </div>
      </div>
    </template>
  </AdminLayout>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import toast from '../utils/toast';
import request from '../utils/request';
import AdminLayout from '../components/AdminLayout.vue';
import SelectMenu from '../components/SelectMenu.vue';
import MultiLineChart from '../components/charts/MultiLineChart.vue';
import { bucketAxisLabel, bucketTooltipLabel, formatLocalDate } from '../utils/time';

/**
 * 认证记录页：统计评论区无感验证（人机验证）的每一次认证。
 *
 * 数据来自 GET /admin/verify/overview（指标卡 + 趋势 + Top 榜单）与
 * GET /admin/verify/records（明细分页）。三端接口结构一致，但只有 Cloudflare
 * Worker 部署返回地区/运营商数据（geoSupported），其余端自动隐藏这两块。
 */
const router = useRouter();
const apiUrl = ref(localStorage.getItem('apiUrl') || window.location.origin);

const loading = ref(false);

const rangeOptions = [
  { label: '24小时', value: 1 },
  { label: '7天', value: 7 },
  { label: '30天', value: 30 },
  { label: '90天', value: 90 },
  { label: '全部', value: 0 },
];

const days = ref(30);
const offset = ref(0);
const pageSize = 20;

const emptyOverview = () => ({
  range: { days: 30, offset: 0, from: '', to: '', bucket: 'day' },
  summary: {
    challenges: 0, challengesDelta: null,
    verified: 0, verifiedDelta: null,
    failed: 0, failedDelta: null,
    avgDurationMs: null, avgDurationDelta: null,
    passRate: null,
  },
  trend: [],
  geoSupported: false,
  topCountries: [],
  topNetworks: [],
  topReasons: [],
});

const overview = ref(emptyOverview());
const records = ref({ list: [], total: 0, page: 1, pageSize });

const eventFilter = ref('all');
const ipFilter = ref('');
const slugFilter = ref('');

const totalPages = computed(() =>
  Math.max(1, Math.ceil((records.value.total || 0) / (records.value.pageSize || pageSize))),
);

const hasFilters = computed(() =>
  eventFilter.value !== 'all' || ipFilter.value.trim() !== '' || slugFilter.value.trim() !== '',
);

/** 当前窗口总事件数：为 0 说明已经翻到没有数据的时间段，不再允许继续往前翻 */
const windowTotal = computed(() => {
  const s = overview.value.summary;
  return s.challenges + s.verified + s.failed;
});

const canShiftBack = computed(() => windowTotal.value > 0 && offset.value < 120);

/**
 * 区间文本：后端返回的 from / to 是 UTC 时刻，这里换算成浏览器本地时区显示，
 * 与明细列表的时间列（toLocaleString）保持同一口径。
 */
const rangeText = computed(() => {
  const { from, to } = overview.value.range;
  if (!from || !to) return '';
  const start = formatLocalDate(from);
  const end = formatLocalDate(to);
  return start && end ? `${start} ~ ${end}` : '';
});

/** 环比颜色按「指标变好/变坏」着色：失败数与耗时上升是坏事，其余上升是好事 */
const deltaClassFor = (key, delta) => {
  if (delta === null || delta === 0) return 'text-gray-400';
  const rising = delta > 0;
  const good = key === 'failed' || key === 'avgDurationMs' ? !rising : rising;
  return good ? 'text-emerald-600' : 'text-red-500';
};

const formatCount = (value) => Number(value || 0).toLocaleString('zh-CN');

const formatDuration = (ms) => {
  if (ms === null || ms === undefined) return '—';
  const value = Number(ms);
  if (!Number.isFinite(value)) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
};

const statCards = computed(() => {
  const s = overview.value.summary;
  const cards = [
    {
      key: 'challenges', label: '认证挑战数', value: formatCount(s.challenges), delta: s.challengesDelta,
      icon: 'fa-solid fa-shield-halved', iconBg: 'bg-blue-50', iconColor: 'text-blue-500',
    },
    {
      key: 'verified', label: '通过', value: formatCount(s.verified), delta: s.verifiedDelta,
      icon: 'fa-solid fa-circle-check', iconBg: 'bg-emerald-50', iconColor: 'text-emerald-500',
    },
    {
      key: 'failed', label: '失败', value: formatCount(s.failed), delta: s.failedDelta,
      icon: 'fa-solid fa-circle-xmark', iconBg: 'bg-red-50', iconColor: 'text-red-500',
    },
    {
      key: 'avgDurationMs', label: '平均耗时', value: formatDuration(s.avgDurationMs), delta: s.avgDurationDelta,
      icon: 'fa-solid fa-stopwatch', iconBg: 'bg-amber-50', iconColor: 'text-amber-500',
    },
  ];
  return cards.map((card) => ({
    ...card,
    rawTitle: card.key === 'avgDurationMs'
      ? (s.avgDurationMs === null ? '暂无解题耗时数据' : `${formatCount(s.avgDurationMs)} ms`)
      : card.value,
    deltaClass: deltaClassFor(card.key, card.delta),
    // 「通过率」单独展示在通过卡片的副标题里，避免再加第五张卡片
    sub: card.key === 'verified' && s.passRate !== null ? `通过率 ${s.passRate}%` : '',
  }));
});

const trendSeries = computed(() => [
  { name: '签发', values: overview.value.trend.map((item) => item.challenges), color: '#3b82f6' },
  { name: '通过', values: overview.value.trend.map((item) => item.verified), color: '#10b981' },
  { name: '失败', values: overview.value.trend.map((item) => item.failed), color: '#ef4444' },
]);

const trendLegend = computed(() => trendSeries.value.map((item) => ({ name: item.name, color: item.color })));

/**
 * X 轴标签：后端的分桶键是 UTC，这里换算成浏览器本地时区后显示 ——
 * 小时粒度取 HH:00，日粒度取 MM-DD，月粒度取「M月 / YY年」。
 */
const trendLabels = computed(() => overview.value.trend.map((item) => bucketAxisLabel(item.date)));

/** 悬浮提示展示分桶起点的完整本地时间（如 `2024-05-06 13:00`） */
const trendRawLabels = computed(() => overview.value.trend.map((item) => bucketTooltipLabel(item.date)));

const COUNTRY_NAMES = {
  US: '美国', GB: '英国', FR: '法国', DE: '德国', PT: '葡萄牙', CN: '中国', HK: '中国香港',
  TW: '中国台湾', JP: '日本', KR: '韩国', SG: '新加坡', IN: '印度', CA: '加拿大', AU: '澳大利亚',
  BR: '巴西', RU: '俄罗斯', NL: '荷兰', ES: '西班牙', IT: '意大利', SE: '瑞典', CH: '瑞士',
  PL: '波兰', VN: '越南', TH: '泰国', MY: '马来西亚', ID: '印度尼西亚', PH: '菲律宾',
  TR: '土耳其', MX: '墨西哥', ZA: '南非', AE: '阿联酋', UA: '乌克兰', IE: '爱尔兰', FI: '芬兰',
};

/** 国家码 → 「国旗 emoji + 中文名」；字典里没有就原样显示国家码 */
const countryLabel = (code) => {
  const value = String(code || '').toUpperCase();
  if (value.length !== 2) return code || '未知';
  const flag = String.fromCodePoint(...value.split('').map((char) => 0x1f1e6 + char.charCodeAt(0) - 65));
  return `${flag} ${COUNTRY_NAMES[value] || value}`;
};

const REASON_LABELS = {
  honeypot: '蜜罐命中（脚本特征）',
  'missing challenge': '缺少挑战参数',
  'bad signature': '签名校验失败',
  'malformed prefix': '挑战载荷无法解析',
  'malformed payload': '挑战载荷格式错误',
  PROTOCOL_OUTDATED: '前后端协议版本不匹配',
  'slug mismatch': '文章标识不匹配',
  'challenge expired': '挑战已过期',
  'challenge from the future': '挑战时间异常',
  'ip mismatch': 'IP 不一致',
  'implausible timing': '解题耗时不可信',
  'challenge already used': '挑战已被使用（重放）',
};

const reasonLabel = (reason) => REASON_LABELS[reason] || reason || '未知原因';

const eventBadge = (event) => {
  switch (event) {
    case 'challenge':
      return { label: '签发', cls: 'bg-blue-50 text-blue-700', icon: 'fa-solid fa-paper-plane' };
    case 'pass':
      return { label: '通过', cls: 'bg-emerald-50 text-emerald-700', icon: 'fa-solid fa-check' };
    case 'fail':
      return { label: '失败', cls: 'bg-red-50 text-red-700', icon: 'fa-solid fa-xmark' };
    default:
      return { label: event, cls: 'bg-gray-100 text-gray-600', icon: 'fa-solid fa-circle-info' };
  }
};

const topPanels = computed(() => {
  const data = overview.value;
  const panels = [];

  // 地区/运营商只有 Cloudflare 部署有数据源，Node / Go 返回 geoSupported: false
  if (data.geoSupported) {
    panels.push({
      key: 'country',
      title: '来源地区 Top 5',
      icon: 'fa-solid fa-location-dot',
      items: data.topCountries.map((item) => ({
        key: `c-${item.name}`,
        label: countryLabel(item.name),
        sub: item.name,
        count: Number(item.count || 0),
        percent: item.percent,
      })),
    });
    panels.push({
      key: 'network',
      title: '网络运营商 Top 5',
      icon: 'fa-solid fa-tower-broadcast',
      items: data.topNetworks.map((item) => ({
        key: `n-${item.name}`,
        label: item.name,
        sub: item.asn ? `AS${item.asn}` : '',
        count: Number(item.count || 0),
        percent: item.percent,
      })),
    });
  }

  panels.push({
    key: 'reason',
    title: '失败原因 Top 5',
    icon: 'fa-solid fa-triangle-exclamation',
    items: data.topReasons.map((item) => ({
      key: `r-${item.reason}`,
      label: reasonLabel(item.reason),
      sub: item.reason,
      count: Number(item.count || 0),
      percent: item.percent,
    })),
  });

  return panels;
});

const formatDateTime = (iso) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
};

const fetchOverview = async () => {
  try {
    const res = await request.get('/admin/verify/overview', {
      params: { days: days.value, offset: offset.value },
    });
    if (res.data) {
      overview.value = {
        ...emptyOverview(),
        ...res.data,
        summary: { ...emptyOverview().summary, ...res.data.summary },
        trend: res.data.trend || [],
        topCountries: res.data.topCountries || [],
        topNetworks: res.data.topNetworks || [],
        topReasons: res.data.topReasons || [],
      };
    }
  } catch (error) {
    toast.error('加载认证统计失败');
  }
};

const fetchRecords = async (page = 1, silent = true) => {
  try {
    const params = { page, pageSize, days: days.value };
    if (eventFilter.value !== 'all') params.event = eventFilter.value;
    if (ipFilter.value.trim()) params.ip = ipFilter.value.trim();
    if (slugFilter.value.trim()) params.slug = slugFilter.value.trim();

    const res = await request.get('/admin/verify/records', { params });
    if (res.data) {
      records.value = {
        list: res.data.list || [],
        total: res.data.total || 0,
        page: res.data.page || page,
        pageSize: res.data.pageSize || pageSize,
      };
    }
  } catch (error) {
    if (!silent) toast.error('加载认证明细失败');
  }
};

const fetchAll = async () => {
  loading.value = true;
  await Promise.all([fetchOverview(), fetchRecords(1)]);
  loading.value = false;
};

/** 静默刷新（切范围/翻页/翻窗口时用，避免整页闪 loading） */
const refresh = async () => {
  await Promise.all([fetchOverview(), fetchRecords(records.value.page)]);
};

const switchRange = async (value) => {
  if (days.value === value) return;
  days.value = value;
  // 换窗口长度后原来的偏移没有意义，回到当前窗口
  offset.value = 0;
  await Promise.all([fetchOverview(), fetchRecords(1)]);
};

const shiftWindow = async (step) => {
  const next = offset.value + step;
  if (next < 0) return;
  offset.value = next;
  await Promise.all([fetchOverview(), fetchRecords(1)]);
};

const applyFilters = async () => {
  await fetchRecords(1, false);
};

const resetFilters = async () => {
  eventFilter.value = 'all';
  ipFilter.value = '';
  slugFilter.value = '';
  await fetchRecords(1, false);
};

const logout = () => {
  localStorage.removeItem('token');
  router.push('/login');
};

onMounted(fetchAll);
</script>
