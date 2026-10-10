import { onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * 追踪元素尺寸（ResizeObserver）。
 *
 * 图表用「测量到的像素宽度」作为 SVG viewBox 的宽度，这样 SVG 用户坐标
 * 与 CSS 像素 1:1 对应：既能让矢量图随容器自适应，又能在 HTML 气泡层里
 * 直接使用像素定位，不需要额外换算缩放比例。
 *
 * 拿不到宽度时（例如非浏览器环境、单元测试）回退到 fallbackWidth，
 * 保证组件仍能渲染出结构完整的图表。
 */
export function useElementSize(elementRef, { width: fallbackWidth = 480, height: fallbackHeight = 260 } = {}) {
  const width = ref(fallbackWidth);
  const height = ref(fallbackHeight);
  let observer = null;

  const measure = () => {
    const el = elementRef.value;
    if (!el) return;
    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    const nextWidth = el.clientWidth || rect?.width || 0;
    const nextHeight = el.clientHeight || rect?.height || 0;
    if (nextWidth > 0) width.value = Math.round(nextWidth);
    if (nextHeight > 0) height.value = Math.round(nextHeight);
  };

  onMounted(() => {
    measure();
    if (typeof ResizeObserver !== 'undefined' && elementRef.value) {
      observer = new ResizeObserver(measure);
      observer.observe(elementRef.value);
    }
  });

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
  });

  return { width, height, measure };
}

export default useElementSize;
