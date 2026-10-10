<template>
  <div ref="rootRef" class="relative w-full" :style="{ height: `${height}px` }">
    <svg
      :viewBox="`0 0 ${width} ${height}`"
      width="100%"
      :height="height"
      class="block"
      role="img"
      aria-label="评论状态分布环形图"
      @mouseleave="clearHover"
    >
      <!-- 无数据：灰色占位环 -->
      <template v-if="total === 0">
        <circle
          :cx="cx"
          :cy="cy"
          :r="(outerRadius + innerRadius) / 2"
          fill="none"
          stroke="#e5e7eb"
          :stroke-width="outerRadius - innerRadius"
        />
        <text :x="cx" :y="cy + 4" text-anchor="middle" font-size="12" fill="#9ca3af">暂无数据</text>
      </template>

      <template v-else>
        <!-- 扇区 -->
        <path
          v-for="slice in visibleSlices"
          :key="slice.name"
          :d="slice.path"
          :fill="slice.color"
          :class="[
            'transition-opacity duration-150',
            hoverIndex !== null && hoverIndex !== slice.index ? 'opacity-50' : 'opacity-100',
          ]"
          @mousemove="onSliceMove($event, slice)"
        />

        <!-- 引导线与双行标签（名称 / 占比） -->
        <g v-for="slice in labeledSlices" :key="`label-${slice.name}`" class="pointer-events-none">
          <polyline :points="slice.leader" fill="none" :stroke="slice.color" stroke-width="1" />
          <text
            :x="slice.labelX"
            :y="slice.labelY - 1"
            :text-anchor="slice.anchor"
            font-size="11"
            font-weight="500"
            fill="#475569"
          >{{ slice.name }}</text>
          <text
            :x="slice.labelX"
            :y="slice.labelY + 11"
            :text-anchor="slice.anchor"
            font-size="11"
            fill="#94a3b8"
          >{{ slice.percentText }}</text>
        </g>
      </template>
    </svg>

    <!-- 悬浮提示 -->
    <div
      v-if="hoverInfo"
      class="chart-tooltip pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md bg-gray-800/95 px-2.5 py-1.5 text-xs text-white shadow-lg"
      :style="{ left: `${hoverInfo.x}px`, top: `${hoverInfo.y}px` }"
    >
      {{ hoverInfo.name }}: {{ hoverInfo.value }} ({{ hoverInfo.percentText }})
    </div>
  </div>
</template>

<script setup>
/**
 * 自研环形图（替代 echarts 的 pie/doughnut）。
 *
 * 与 echarts 版本一致的视觉特征：内外半径比 0.64（原配置 45%/70%）、
 * 扇区间白色分隔、外部引导线 + 「名称 / 百分比」双行标签、悬浮显示数值与占比。
 * 使用 SVG 绘制：矢量清晰、体积几乎为零、宽度随容器自适应。
 */
import { computed, ref } from 'vue';
import { useElementSize } from '../../composables/useElementSize';

const props = defineProps({
  /** [{ name, value, color }] */
  data: { type: Array, default: () => [] },
  height: { type: Number, default: 260 },
});

const FALLBACK_COLORS = ['#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#8b5cf6'];
const LABEL_GAP = 16;
const LEADER_ELBOW = 6;

const rootRef = ref(null);
const { width } = useElementSize(rootRef, { width: 480, height: props.height });

const cx = computed(() => width.value / 2);
const cy = computed(() => props.height / 2);
const outerRadius = computed(() =>
  Math.max(32, Math.min(width.value / 2 - 58, props.height / 2 - 42)),
);
const innerRadius = computed(() => outerRadius.value * 0.64);

const total = computed(() => props.data.reduce((sum, item) => sum + Math.max(0, Number(item?.value) || 0), 0));

/** 极坐标 → 直角坐标；角度 0° 指向 12 点方向，顺时针为正 */
const polar = (radius, angle) => {
  const rad = ((angle - 90) * Math.PI) / 180;
  return { x: cx.value + radius * Math.cos(rad), y: cy.value + radius * Math.sin(rad) };
};

const round = (n) => Math.round(n * 100) / 100;

/** 圆环扇区路径；按 ≤90° 分段，天然支持整圆（单扇区 100%）场景 */
const sectorPath = (startAngle, endAngle, rOuter, rInner) => {
  const sweep = endAngle - startAngle;
  if (sweep <= 0 || rOuter <= rInner) return '';
  const segments = Math.max(1, Math.ceil(sweep / 90));
  const step = sweep / segments;

  const parts = [];
  const outerStart = polar(rOuter, startAngle);
  parts.push(`M ${round(outerStart.x)} ${round(outerStart.y)}`);
  for (let i = 1; i <= segments; i += 1) {
    const point = polar(rOuter, startAngle + step * i);
    parts.push(`A ${round(rOuter)} ${round(rOuter)} 0 0 1 ${round(point.x)} ${round(point.y)}`);
  }

  const innerEnd = polar(rInner, endAngle);
  parts.push(`L ${round(innerEnd.x)} ${round(innerEnd.y)}`);
  for (let i = segments - 1; i >= 0; i -= 1) {
    const point = polar(rInner, startAngle + step * i);
    parts.push(`A ${round(rInner)} ${round(rInner)} 0 0 0 ${round(point.x)} ${round(point.y)}`);
  }
  parts.push('Z');
  return parts.join(' ');
};

const formatPercent = (value) => {
  if (total.value <= 0) return '0%';
  const percent = (value / total.value) * 100;
  const rounded = Math.round(percent * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
};

const slices = computed(() => {
  let angle = 0;
  return (props.data || []).map((item, index) => {
    const value = Math.max(0, Number(item?.value) || 0);
    const sweep = total.value > 0 ? (value / total.value) * 360 : 0;
    const startAngle = angle;
    const endAngle = angle + sweep;
    angle = endAngle;

    const midAngle = (startAngle + endAngle) / 2;
    const color = item?.color || FALLBACK_COLORS[index % FALLBACK_COLORS.length];
    const direction = Math.cos(((midAngle - 90) * Math.PI) / 180);
    const anchor = direction > 0.15 ? 'start' : direction < -0.15 ? 'end' : 'middle';

    const leaderStart = polar(outerRadius.value + 1, midAngle);
    const leaderCorner = polar(outerRadius.value + LABEL_GAP - LEADER_ELBOW, midAngle);
    const leaderEnd = {
      x: leaderCorner.x + (anchor === 'start' ? LEADER_ELBOW : anchor === 'end' ? -LEADER_ELBOW : 0),
      y: leaderCorner.y,
    };

    return {
      index,
      name: item?.name ?? '',
      value,
      color,
      percentText: formatPercent(value),
      path: value > 0 ? sectorPath(startAngle, endAngle, outerRadius.value, innerRadius.value) : '',
      anchor,
      labelX: leaderEnd.x + (anchor === 'start' ? 4 : anchor === 'end' ? -4 : 0),
      labelY: leaderEnd.y,
      leader: `${round(leaderStart.x)},${round(leaderStart.y)} ${round(leaderCorner.x)},${round(leaderCorner.y)} ${round(leaderEnd.x)},${round(leaderEnd.y)}`,
    };
  });
});

/** 值为 0 的扇区没有可见面积，echarts 下也不渲染，这里直接跳过 */
const visibleSlices = computed(() => slices.value.filter((slice) => slice.path));
const labeledSlices = computed(() => visibleSlices.value);

const hoverIndex = ref(null);
const hoverInfo = ref(null);

const onSliceMove = (event, slice) => {
  hoverIndex.value = slice.index;
  const rect = rootRef.value?.getBoundingClientRect?.();
  hoverInfo.value = {
    x: rect ? event.clientX - rect.left : 0,
    y: rect ? event.clientY - rect.top - 12 : 0,
    name: slice.name,
    value: slice.value,
    percentText: slice.percentText,
  };
};

const clearHover = () => {
  hoverIndex.value = null;
  hoverInfo.value = null;
};
</script>
