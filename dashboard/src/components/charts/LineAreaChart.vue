<template>
  <div ref="rootRef" class="relative w-full" :style="{ height: `${height}px` }">
    <svg
      :viewBox="`0 0 ${width} ${height}`"
      width="100%"
      :height="height"
      class="block"
      role="img"
      aria-label="评论趋势折线图"
      @mousemove="onMove"
      @mouseleave="clearHover"
    >
      <defs>
        <linearGradient :id="gradientId" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(59,130,246,0.25)" />
          <stop offset="100%" stop-color="rgba(59,130,246,0.02)" />
        </linearGradient>
      </defs>

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

      <text v-if="points.length === 0" :x="width / 2" :y="height / 2" text-anchor="middle" font-size="12" fill="#9ca3af">
        暂无数据
      </text>

      <template v-else>
        <path v-if="areaPath" class="area-path" :d="areaPath" :fill="`url(#${gradientId})`" stroke="none" />
        <path class="line-path" :d="linePath" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />

        <circle
          v-for="point in points"
          :key="`p-${point.index}`"
          class="data-point"
          :cx="point.x"
          :cy="point.y"
          r="3"
          fill="#3b82f6"
          stroke="#ffffff"
          stroke-width="1.5"
        />

        <!-- 悬浮指示：竖向参考线 + 高亮点 -->
        <template v-if="hoverIndex !== null">
          <line
            :x1="points[hoverIndex].x"
            :x2="points[hoverIndex].x"
            :y1="plot.top"
            :y2="plot.bottom"
            stroke="#93c5fd"
            stroke-width="1"
            stroke-dasharray="4 3"
          />
          <circle :cx="points[hoverIndex].x" :cy="points[hoverIndex].y" r="5" fill="#3b82f6" stroke="#ffffff" stroke-width="2" />
        </template>
      </template>
    </svg>

    <!-- 悬浮提示 -->
    <div
      v-if="hoverIndex !== null"
      class="chart-tooltip pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-gray-800/95 px-2.5 py-1.5 text-xs text-white shadow-lg"
      :style="tooltipStyle"
    >
      <div>{{ rawLabels[hoverIndex] }}</div>
      <div>评论数: {{ values[hoverIndex] }}</div>
    </div>
  </div>
</template>

<script setup>
/**
 * 自研面积折线图（替代 echarts 的 line + areaStyle）。
 *
 * 与 echarts 版本一致的视觉特征：平滑曲线、圆点标记、自上而下的蓝色渐变填充、
 * X 轴标签超过 14 个时旋转 45°、Y 轴按整数间隔取值（minInterval: 1）、
 * 悬浮显示原始日期与评论数。
 *
 * 曲线使用单调三次插值（Fritsch–Carlson），保证不会越过数据点造成虚假波峰/波谷。
 * 所有几何计算都基于实测像素宽度，容器尺寸变化时自动重算。
 */
import { computed, ref, useId } from 'vue';
import { useElementSize } from '../../composables/useElementSize';

const props = defineProps({
  labels: { type: Array, default: () => [] },
  values: { type: Array, default: () => [] },
  /** 悬浮提示里展示的原始标签（如 2024-05-06），默认与 labels 相同 */
  rawLabels: { type: Array, default: () => [] },
  height: { type: Number, default: 260 },
});

const gradientId = `line-area-gradient-${useId()}`;

const rootRef = ref(null);
const { width } = useElementSize(rootRef, { width: 480, height: props.height });

const numericValues = computed(() => (props.values || []).map((value) => Number(value) || 0));
const rawLabels = computed(() => (props.rawLabels?.length ? props.rawLabels : props.labels) || []);

const rotate = computed(() => (props.labels || []).length > 14);

const plot = computed(() => {
  const left = 40;
  const right = Math.max(50, width.value - 16);
  const top = 16;
  const bottom = props.height - (rotate.value ? 46 : 34);
  return { left, right, top, bottom, width: right - left, height: bottom - top };
});

/** 取「整数间隔」的刻度步长：minInterval = 1，步长只从 1/2/2.5/3/4/5/10 中选 */
const niceStep = (max) => {
  if (!(max > 0)) return 1;
  const rough = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 3 ? 3 : normalized <= 4 ? 4 : normalized <= 5 ? 5 : 10;
  return Math.max(1, factor * magnitude);
};

const scale = computed(() => {
  const max = numericValues.value.reduce((acc, value) => Math.max(acc, value), 0);
  const step = niceStep(max);
  const maxTick = Math.max(step, Math.ceil(max / step) * step);
  const ticks = [];
  for (let value = 0; value <= maxTick + 1e-9; value += step) {
    ticks.push(Math.round(value * 1000) / 1000);
  }
  return { max: maxTick, step, ticks };
});

const points = computed(() => {
  const count = numericValues.value.length;
  if (count === 0) return [];
  const { left, width: plotWidth, height: plotHeight, bottom } = plot.value;
  const stepX = count > 1 ? plotWidth / (count - 1) : 0;
  const max = scale.value.max || 1;
  return numericValues.value.map((value, index) => ({
    index,
    x: count > 1 ? left + stepX * index : left + plotWidth / 2,
    y: bottom - (value / max) * plotHeight,
  }));
});

const yTicks = computed(() => {
  const { ticks, max } = scale.value;
  const { bottom, height: plotHeight } = plot.value;
  return ticks.map((value) => ({ value, y: bottom - (value / (max || 1)) * plotHeight }));
});

/** 标签密度自适应：宽度不足时按间隔抽稀，避免文字互相压叠 */
const xLabels = computed(() => {
  const labels = props.labels || [];
  const count = labels.length;
  if (count === 0) return [];
  const perLabel = rotate.value ? 30 : 46;
  const stride = Math.max(1, Math.ceil((count * perLabel) / Math.max(plot.value.width, 1)));
  return labels
    .map((text, index) => {
      if (index % stride !== 0) return null;
      const point = points.value[index];
      if (!point) return null;
      return {
        index,
        text,
        x: point.x,
        anchor: rotate.value ? 'end' : 'middle',
        transform: rotate.value ? `rotate(-45 ${point.x} ${plot.value.bottom + 16})` : undefined,
      };
    })
    .filter(Boolean);
});

const round = (value) => Math.round(value * 100) / 100;

/** 单调三次插值：由数据点生成平滑曲线，避免普通样条在拐点处的过冲 */
const smoothLine = (pts) => {
  const count = pts.length;
  if (count === 0) return '';
  if (count === 1) return `M ${round(pts[0].x)} ${round(pts[0].y)}`;

  const dx = [];
  const slope = [];
  for (let i = 0; i < count - 1; i += 1) {
    dx[i] = pts[i + 1].x - pts[i].x;
    slope[i] = dx[i] === 0 ? 0 : (pts[i + 1].y - pts[i].y) / dx[i];
  }

  const tangents = new Array(count);
  tangents[0] = slope[0];
  tangents[count - 1] = slope[count - 2];
  for (let i = 1; i < count - 1; i += 1) {
    if (slope[i - 1] * slope[i] <= 0) {
      tangents[i] = 0;
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      tangents[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
    }
  }

  let path = `M ${round(pts[0].x)} ${round(pts[0].y)}`;
  for (let i = 0; i < count - 1; i += 1) {
    const c1x = pts[i].x + dx[i] / 3;
    const c1y = pts[i].y + (tangents[i] * dx[i]) / 3;
    const c2x = pts[i + 1].x - dx[i] / 3;
    const c2y = pts[i + 1].y - (tangents[i + 1] * dx[i]) / 3;
    path += ` C ${round(c1x)} ${round(c1y)}, ${round(c2x)} ${round(c2y)}, ${round(pts[i + 1].x)} ${round(pts[i + 1].y)}`;
  }
  return path;
};

const linePath = computed(() => smoothLine(points.value));

const areaPath = computed(() => {
  const pts = points.value;
  if (pts.length === 0) return '';
  const base = plot.value.bottom;
  const first = pts[0];
  const last = pts[pts.length - 1];
  return `${smoothLine(pts)} L ${round(last.x)} ${round(base)} L ${round(first.x)} ${round(base)} Z`;
});

const hoverIndex = ref(null);

const onMove = (event) => {
  const count = points.value.length;
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

const tooltipStyle = computed(() => {
  const point = points.value[hoverIndex.value];
  if (!point) return {};
  return { left: `${point.x}px`, top: `${point.y - 14}px` };
});
</script>
