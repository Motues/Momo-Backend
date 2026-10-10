/**
 * 自研 SVG 图表共用的几何与插值计算。
 *
 * 抽出来的原因：LineAreaChart（单序列面积折线）与 MultiLineChart（多序列折线）
 * 必须共用同一套刻度、插值与标签抽稀算法 —— 各写一份必然会漂移，
 * 而 charts.test.js 是直接断言具体坐标的。
 */

export const round = (value) => Math.round(value * 100) / 100;

/** 取「整数间隔」的刻度步长：minInterval = 1，步长只从 1/2/2.5/3/4/5/10 中选 */
export const niceStep = (max) => {
  if (!(max > 0)) return 1;
  const rough = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const factor =
    normalized <= 1 ? 1
      : normalized <= 2 ? 2
        : normalized <= 2.5 ? 2.5
          : normalized <= 3 ? 3
            : normalized <= 4 ? 4
              : normalized <= 5 ? 5 : 10;
  return Math.max(1, factor * magnitude);
};

/**
 * 由若干数值序列算出 Y 轴比例尺（多序列取全局最大值，保证共用同一根 Y 轴）。
 * @returns {{ max: number, step: number, ticks: number[] }}
 */
export const buildScale = (values) => {
  const max = (values || []).reduce((acc, value) => Math.max(acc, Number(value) || 0), 0);
  const step = niceStep(max);
  const maxTick = Math.max(step, Math.ceil(max / step) * step);
  const ticks = [];
  for (let value = 0; value <= maxTick + 1e-9; value += step) {
    ticks.push(Math.round(value * 1000) / 1000);
  }
  return { max: maxTick, step, ticks };
};

/**
 * 单调三次插值（Fritsch–Carlson）：由数据点生成平滑曲线，
 * 避免普通样条在拐点处的过冲造成虚假波峰/波谷。
 */
export const smoothLine = (pts) => {
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

/** 把平滑曲线闭合回基线，得到面积路径 */
export const closeAreaPath = (linePath, pts, baseline) => {
  if (!linePath || !pts || pts.length === 0) return '';
  const first = pts[0];
  const last = pts[pts.length - 1];
  return `${linePath} L ${round(last.x)} ${round(baseline)} L ${round(first.x)} ${round(baseline)} Z`;
};

/**
 * X 轴标签：宽度不足时按间隔抽稀，避免文字互相压叠；超过 14 个标签时旋转 45°。
 * @returns {{ index: number, text: string, x: number, anchor: string, transform?: string }[]}
 */
export const buildXLabels = ({ labels, points, plotWidth, bottom, rotate }) => {
  const count = (labels || []).length;
  if (count === 0) return [];

  const perLabel = rotate ? 30 : 46;
  const stride = Math.max(1, Math.ceil((count * perLabel) / Math.max(plotWidth, 1)));

  return labels
    .map((text, index) => {
      if (index % stride !== 0) return null;
      const point = points[index];
      if (!point) return null;
      return {
        index,
        text,
        x: point.x,
        anchor: rotate ? 'end' : 'middle',
        transform: rotate ? `rotate(-45 ${point.x} ${bottom + 16})` : undefined,
      };
    })
    .filter(Boolean);
};
