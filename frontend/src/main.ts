import { mount } from 'svelte';
import Comments from './comment/Comments.svelte';

const momo = {
  init: (options: { el:string, apiUrl: string; slugId: string; lang?: string; title?: string }) => {
    const target = document.querySelector(options.el);
    if (!target) {
      console.error(`Target element ${options.el} not found.`);
      return;
    }

    // 实例化 Svelte 组件
    mount(Comments, {
      target: target,
      props: {
        apiUrl: options.apiUrl,
        postSlug: options.slugId,
        language: options.lang || 'zh-cn',
        postTitle: options.title || document.title,
      }
    });
  }
};

// 挂载到全局 window 对象供 CDN 使用
(window as any).momo = momo;

export default momo;