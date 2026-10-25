<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4" data-test="mail-preview-modal">
    <div class="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" @click="$emit('close')"></div>

    <div class="relative bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col border border-slate-200 overflow-hidden">
      <header class="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-4 shrink-0">
        <div class="min-w-0">
          <h3 class="text-sm md:text-base font-semibold text-slate-800 flex items-center gap-2">
            <i class="fa-solid fa-eye text-teal-500"></i>
            {{ title }}
          </h3>
          <p class="mt-1 text-xs text-slate-500 truncate" :title="preview.subject" data-test="mail-preview-subject">
            主题：{{ preview.subject }}
          </p>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <div class="flex rounded-md border border-slate-200 overflow-hidden" role="group" aria-label="预览宽度">
            <button v-for="option in widthOptions" :key="option.value" type="button"
              class="px-2.5 py-1 text-xs transition-colors"
              :class="width === option.value
                ? 'bg-teal-50 text-teal-600 font-medium'
                : 'text-slate-500 hover:bg-slate-50'"
              :aria-pressed="width === option.value"
              :data-test="`mail-preview-width-${option.value}`"
              @click="width = option.value">
              <i :class="[option.icon, 'me-1']"></i>{{ option.label }}
            </button>
          </div>
          <button type="button" @click="$emit('close')" title="关闭预览" data-test="mail-preview-close"
            class="w-7 h-7 flex items-center justify-center rounded-md hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
            <i class="fa-solid fa-xmark text-base"></i>
          </button>
        </div>
      </header>

      <div class="flex-1 overflow-auto bg-slate-100 p-4 flex justify-center">
        <!--
          sandbox=""（不放行任何能力）：模板是管理员自己写的 HTML，预览也不能执行脚本 /
          提交表单 / 读取同源数据；样式与图片照常显示。
        -->
        <iframe :srcdoc="preview.html" :style="{ width: frameWidth }" sandbox="" referrerpolicy="no-referrer"
          class="h-[60vh] min-h-[320px] bg-white rounded border border-slate-200 shadow-sm"
          :title="`${title}预览`" data-test="mail-preview-frame"></iframe>
      </div>

      <footer class="px-5 py-3 border-t border-slate-100 bg-slate-50/60 shrink-0">
        <p class="text-[11px] leading-relaxed text-slate-500" data-test="mail-preview-hint">
          <span v-if="preview.isDefault" class="text-teal-600 font-medium">模板留空，这里预览的是内置默认模板。</span>
          <span v-else>按面板里当前的模板渲染（不保存也会生效）。</span>
          演示数据不会写入数据库，也不会发送邮件；表情短代码（<code class="bg-white px-1 rounded border border-slate-200">:name:</code>）
          只有在真实发信时才会被替换成表情图，预览里仍显示为文字。
        </p>
      </footer>
    </div>
  </div>
</template>

<script setup>
/**
 * 邮件模板预览弹窗。
 *
 * 纯前端渲染（见 `utils/mailTemplates.js`）：把当前模板 + 演示数据拼成 HTML，
 * 用 `sandbox=""` 的 iframe 展示，避免模板里的脚本/表单在管理面板里执行。
 */
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { buildMailPreview } from '../utils/mailTemplates';

const props = defineProps({
  kind: { type: String, required: true },
  title: { type: String, default: '邮件模板预览' },
  /** 面板里当前的模板文本；空串时预览默认模板 */
  template: { type: String, default: '' },
  /** 站点名称，只用于邮件主题预览 */
  siteName: { type: String, default: '' },
});

const emit = defineEmits(['close']);

const width = ref('desktop');
const widthOptions = [
  { value: 'desktop', label: '桌面', icon: 'fa-solid fa-desktop' },
  { value: 'mobile', label: '手机', icon: 'fa-solid fa-mobile-screen' },
];

/** 邮件正文都是 600px 左右；桌面按 640、手机按 375，窄屏时自动收窄 */
const frameWidth = computed(() => (width.value === 'mobile' ? '375px' : '640px'));

const preview = computed(() => buildMailPreview({
  kind: props.kind,
  template: props.template,
  siteName: props.siteName,
}));

const onKeydown = (event) => {
  if (event.key === 'Escape') emit('close');
};

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>
