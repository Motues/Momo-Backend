<template>
  <div ref="rootRef" class="relative w-full" :style="{ height: `${height}px` }">
    <svg
      :viewBox="`0 0 ${width} ${height}`"
      width="100%"
      :height="height"
      class="block"
      role="img"
      aria-label="多序列趋势折线图"
      @mousemove="onMove"
      @mouseleave="clearHover"
    >
      <!-- Y 轴刻度与横向网格线 -->
      <g v-for="tick in yTicks" :key="`y-${tick.value}`">
        <line :x1="plot.left" :x2="plot.right" :y1="tick.y" :y2="tick.y" stroke="#f1f5f9" stroke-width="1" />
        <text
          class="axis-label-y"
          :x="plot.left - 8"
          :y="tick.y + 4"
          text-anchor="end"
          font-size="11"
          fill="#94a3b8"
        >{{ tick.value }}</text>
      </g>

      <!-- 底部轴线 -->
      <line :x1="plot.left" :x2="plot.right" :y1="plot.bottom" :y2="plot.bottom" stroke="#e2e8f0" stroke-width="1" />

      <!-- X 轴标签 -->
      <text
        v-for="label in xLabels"
        :key="`x-${label.index}`"
        class="axis-label-x"
        :x="label.x"
        :y="plot.bottom + (rotate ? 16 : 17)"
        :text-anchor="label.anchor"
        :transform="label.transform"
        font-size="11"
        fill="#94a3b8"
      >{{ label.text }}</text>

      <text v-if="!hasData" :x="width / 2" :y="height / 2" text-anchor="middle" font-size="12" fill="#9ca3af">
        暂无数据
      </text>

      <template v-else>
        <!-- 每个序列一条线：多序列共用同一根 Y 轴（取全局最大值），因此可直接比较 -->
        <path
          v-for="line in seriesPaths"
          :key="`line-${line.name}`"
          class="line-path"
          :data-series="line.name"
          :d="line.d"
          fill="none"
          :stroke="line.color"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />

        <!-- 悬浮指示：竖向参考线 + 各序列高亮点 -->
        <template v-if="hoverIndex !== null">
          <line
            :x1="xPositions[hoverIndex]"
            :x2="xPositions[hoverIndex]"
            :y1="plot.top"
            :y2="plot.bottom"
            stroke="#cbd5e1"
            stroke-width="1"
            stroke-dasharray="4 3"
          />
          <circle
            v-for="point in hoverPoints"
            :key="`hp-${point.name}`"
            :cx="point.x"
            :cy="point.y"
            r="4"
            :fill="point.color"
            stroke="#ffffff"
            stroke-width="2"
          />
        </template>
      </template>
    </svg>

    <!-- 悬浮提示：一次展示全部序列的数值 -->
    <div
      v-if="hoverIndex !== null"
      class="chart-tooltip pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-gray-800/95 px-2.5 py-1.5 text-xs text-white shadow-lg"
      :style="tooltipStyle"
    >
      <div class="mb-1 text-gray-300">{{ rawLabels[hoverIndex] }}</div>
      <div v-for="item in tooltipItems" :key="`tip-${item.name}`" class="flex items-center gap-2">
        <span class="inline-block w-2 h-2 rounded-full" :style="{ background: item.color }"></span>
        <span>{{ item.name }}</span>
        <span class="ml-3 font-medium tabular-nums">{{ item.value }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * 自研多序列折线图（替代 echarts 的多 line 序列）。
 *
 * 与 LineAreaChart 共用 utils/chart.js 里的刻度、单调三次插值与标签抽稀算法，
 * 差别只有两点：多序列共用一根 Y 轴；tooltip 一次列出全部序列的数值。
 * 不画面积填充 —— 三条线叠加时填充会互相遮挡（认证记录页的签发/通过/失败就是这种场景）。
 */
import { computed, ref } from 'vue';
import { useElementSize } from '../../composables/useElementSize';
import { buildScale, buildXLabels, smoothLine } from '../../utils/chart';

const props = defineProps({
  labels: { type: Array, default: () => [] },
  /** [{ name, values: number[], color }] */
  series: { type: Array, default: () => [] },
  /** 悬浮提示里展示的原始标签（如 2024-05-06），默认与 labels 相同 */
  rawLabels: { type: Array, default: () => [] },
  height: { type: Number, default: 260 },
});

const rootRef = ref(null);
const { width } = useElementSize(rootRef, { width: 480, height: props.height });

const rawLabels = computed(() => (props.rawLabels?.length ? props.rawLabels : props.labels) || []);
const rotate = computed(() => (props.labels || []).length > 14);
const hasData = computed(() => (props.labels || []).length > 0 && (props.series || []).length > 0);

const plot = computed(() => {
  const left = 40;
  const right = Math.max(50, width.value - 16);
  const top = 16;
  const bottom = props.height - (rotate.value ? 46 : 34);
  return { left, right, top, bottom, width: right - left, height: bottom - top };
});

/** 多序列共用一根 Y 轴：比例尺取全部序列的全局最大值 */
const scale = computed(() =>
  buildScale((props.series || []).flatMap((item) => (item.values || []).map((value) => Number(value) || 0))),
);

/** X 轴位置只由标签个数决定，各序列共用 */
const xPositions = computed(() => {
  const count = (props.labels || []).length;
  const { left, width: plotWidth } = plot.value;
  const stepX = count > 1 ? plotWidth / (count - 1) : 0;
  return Array.from({ length: count }, (_, index) => (count > 1 ? left + stepX * index : left + plotWidth / 2));
});

const seriesPaths = computed(() =>
  (props.series || []).map((item) => {
    const max = scale.value.max || 1;
    const points = (item.values || []).map((value, index) => ({
      x: xPositions.value[index] ?? 0,
      y: plot.value.bottom - ((Number(value) || 0) / max) * plot.value.height,
    }));
    return { name: item.name, color: item.color || '#3b82f6', points, d: smoothLine(points) };
  }),
);

const yTicks = computed(() => {
  const { ticks, max } = scale.value;
  const { bottom, height: plotHeight } = plot.value;
  return ticks.map((value) => ({ value, y: bottom - (value / (max || 1)) * plotHeight }));
});

const xLabels = computed(() =>
  buildXLabels({
    labels: props.labels || [],
    points: seriesPaths.value[0]?.points || [],
    plotWidth: plot.value.width,
    bottom: plot.value.bottom,
    rotate: rotate.value,
  }),
);

const hoverIndex = ref(null);

const onMove = (event) => {
  const count = (props.labels || []).length;
  if (count === 0) return;
  const rect = rootRef.value?.getBoundingClientRect?.();
  const x = rect ? event.clientX - rect.left : 0;
  const stepX = count > 1 ? plot.value.width / (count - 1) : plot.value.width;
  const index = Math.round((x - plot.value.left) / stepX);
  hoverIndex.value = Math.min(count - 1, Math.max(0, index));
};

const clearHover = () => {
  hoverIndex.value = null;
};

const hoverPoints = computed(() => {
  if (hoverIndex.value === null) return [];
  return seriesPaths.value
    .map((line) => ({
      name: line.name,
      color: line.color,
      x: line.points[hoverIndex.value]?.x ?? 0,
      y: line.points[hoverIndex.value]?.y ?? 0,
    }))
    .filter((point) => Number.isFinite(point.y));
});

const tooltipItems = computed(() => {
  if (hoverIndex.value === null) return [];
  return (props.series || []).map((item) => ({
    name: item.name,
    color: item.color || '#3b82f6',
    value: Number(item.values?.[hoverIndex.value]) || 0,
  }));
});

const tooltipStyle = computed(() => {
  const x = xPositions.value[hoverIndex.value];
  const ys = hoverPoints.value.map((point) => point.y);
  if (x === undefined || ys.length === 0) return {};
  return { left: `${x}px`, top: `${Math.min(...ys) - 14}px` };
});
</script>
