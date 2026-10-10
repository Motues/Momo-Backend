<template>
  <div ref="rootRef" class="relative" :class="{ 'opacity-60': disabled }">
    <!-- 触发器：外观与站内 input 保持一致，完全自定义，不使用浏览器原生 select -->
    <button
      type="button"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="isOpen"
      :disabled="disabled"
      :title="title || selectedLabel"
      :class="[
        'w-full flex items-center justify-between gap-2 px-3 py-2 border border-gray-300 rounded-lg bg-white text-sm text-left transition-colors',
        'hover:border-gray-400 focus:outline-none focus:ring-2 focus:border-transparent',
        disabled ? 'cursor-not-allowed bg-gray-50' : 'cursor-pointer',
        isOpen ? ['ring-2', 'border-transparent'] : '',
        accent.ring,
      ]"
      @click="toggle"
      @keydown="onKeydown"
    >
      <span class="truncate" :class="hasSelection ? 'text-gray-800' : 'text-gray-400'">
        {{ selectedLabel }}
      </span>
      <i
        class="fa-solid fa-chevron-down text-[10px] shrink-0 transition-transform duration-150"
        :class="[isOpen ? 'rotate-180' : '', accent.text]"
      ></i>
    </button>

    <!-- 下拉面板 -->
    <Transition name="select-menu">
      <ul
        v-if="isOpen"
        role="listbox"
        class="absolute z-50 mt-1 w-full max-h-60 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
      >
        <li
          v-for="(opt, index) in normalizedOptions"
          :key="String(opt.value)"
          role="option"
          :aria-selected="opt.value === modelValue"
          :class="[
            'flex items-start gap-2 px-3 py-2 text-sm cursor-pointer transition-colors',
            opt.value === modelValue ? ['font-medium', accent.text, accent.soft] : 'text-gray-700',
            index === activeIndex ? 'bg-gray-100' : '',
          ]"
          @click="choose(opt)"
          @mousemove="activeIndex = index"
        >
          <span class="flex-1 text-left leading-snug break-words">{{ opt.label }}</span>
          <i v-if="opt.value === modelValue" class="fa-solid fa-check text-xs mt-0.5 shrink-0" :class="accent.text"></i>
        </li>
        <li v-if="normalizedOptions.length === 0" class="px-3 py-2 text-xs text-gray-400">无可选项</li>
      </ul>
    </Transition>
  </div>
</template>

<script setup>
/**
 * 自定义下拉选择器。
 *
 * 替代浏览器原生 <select>：原生控件的下拉面板由操作系统绘制，各平台样式不一致，
 * 也无法与站内 tailwind 风格对齐，因此这里用 button + 绝对定位面板自绘。
 *
 * 用法：
 *   <SelectMenu v-model="form.email_secure" class="w-full" accent="emerald"
 *     :options="[{ label: '是 (端口 465)', value: 'true' }]" />
 *
 * 支持键盘操作：↑/↓ 移动高亮、Enter/Space 选中、Esc 关闭、点击空白处关闭。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps({
  modelValue: { type: [String, Number, Boolean], default: '' },
  /** 支持字符串数组，或 { label, value } 对象数组 */
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: '请选择' },
  disabled: { type: Boolean, default: false },
  /** 自定义 tooltip；默认展示当前选中项全文 */
  title: { type: String, default: '' },
  accent: { type: String, default: 'blue' },
});

const emit = defineEmits(['update:modelValue', 'change']);

// Tailwind 需要静态字面量类名，因此不能用字符串拼接
const ACCENTS = {
  blue: { ring: 'focus:ring-blue-500', text: 'text-blue-600', soft: 'bg-blue-50/70' },
  emerald: { ring: 'focus:ring-emerald-500', text: 'text-emerald-600', soft: 'bg-emerald-50/70' },
  purple: { ring: 'focus:ring-purple-500', text: 'text-purple-600', soft: 'bg-purple-50/70' },
};

const accent = computed(() => ACCENTS[props.accent] || ACCENTS.blue);

const normalizedOptions = computed(() =>
  props.options.map((opt) =>
    opt && typeof opt === 'object'
      ? { label: String(opt.label ?? opt.value ?? ''), value: opt.value }
      : { label: String(opt), value: opt },
  ),
);

const hasSelection = computed(() => normalizedOptions.value.some((opt) => opt.value === props.modelValue));
const selectedLabel = computed(
  () => normalizedOptions.value.find((opt) => opt.value === props.modelValue)?.label ?? props.placeholder,
);

const rootRef = ref(null);
const isOpen = ref(false);
const activeIndex = ref(-1);

const open = () => {
  if (props.disabled) return;
  isOpen.value = true;
  const current = normalizedOptions.value.findIndex((opt) => opt.value === props.modelValue);
  activeIndex.value = current >= 0 ? current : 0;
};

const close = () => {
  isOpen.value = false;
  activeIndex.value = -1;
};

const toggle = () => (isOpen.value ? close() : open());

const choose = (opt) => {
  if (opt.value !== props.modelValue) {
    emit('update:modelValue', opt.value);
    emit('change', opt.value);
  }
  close();
};

const move = (delta) => {
  const count = normalizedOptions.value.length;
  if (count === 0) return;
  activeIndex.value = (activeIndex.value + delta + count) % count;
};

const onKeydown = (event) => {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      isOpen.value ? move(1) : open();
      break;
    case 'ArrowUp':
      event.preventDefault();
      isOpen.value ? move(-1) : open();
      break;
    case 'Enter':
    case ' ':
      event.preventDefault();
      if (!isOpen.value) {
        open();
      } else if (normalizedOptions.value[activeIndex.value]) {
        choose(normalizedOptions.value[activeIndex.value]);
      }
      break;
    case 'Escape':
      if (isOpen.value) {
        event.preventDefault();
        close();
      }
      break;
    case 'Tab':
      close();
      break;
    default:
      break;
  }
};

const onDocumentPointerDown = (event) => {
  if (!isOpen.value) return;
  if (rootRef.value && !rootRef.value.contains(event.target)) close();
};

onMounted(() => document.addEventListener('mousedown', onDocumentPointerDown));
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocumentPointerDown));

watch(
  () => props.disabled,
  (value) => {
    if (value) close();
  },
);
</script>

<style scoped>
.select-menu-enter-active,
.select-menu-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.select-menu-enter-from,
.select-menu-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
