<script lang="ts">
  import { onMount } from 'svelte';
  import CommentItem from './CommentItem.svelte';
  import SilentVerify from '../verify/SilentVerify.svelte';
  import i18nit from '../i18n/translation';
  import { parseMarkdown, validateMarkdown } from '../utils/markdown';
  import { fly } from 'svelte/transition';

  export let postSlug: string;
  export let language: string = 'zh-cn';
  export let postTitle: string;
  export let apiUrl: string;

  const t = i18nit(language);

  let comments: any[] = [];
  let loading = true;
  let loadingMore = false;
  let error = '';
  let page = 1;
  let limit = 20;
  let hasMore = false;

  let bloggerBadgeEnabled = false;
  let bloggerBadgeText = '';
  let placeholderName = '';
  let placeholderEmail = '';
  let placeholderContent = '';
  let placeholderUrl = '';
  let adminCommentKeyConfigured = false;
  let adminEmailHash = '';
  let adminKey = '';
  let isAdminEmail = false;

  // 无感验证（Turnstile 风格）：默认关闭，由后端 verify_enabled 决定是否渲染
  let verifyEnabled = false;
  let verifyHoneypot = '';
  let verifyTicket: string | null = null;
  let verifyComponent: SilentVerify;

  /** 把后端下发的字符串开关解析为布尔值 */
  function parseBool(value: any): boolean {
    return value === true || value === 'true';
  }

  $: if (email && adminEmailHash) {
    sha256(email).then(hash => { isAdminEmail = hash === adminEmailHash; });
  } else {
    isAdminEmail = false;
  }

  let author = '';
  let email = '';
  let url = '';
  let content = '';

  let submitting = false;

  let replyingToId: number | null = null;

  let showPreview = false;
  let previewHtml = '';
  let markdownWarnings: string[] = [];

  function togglePreview() {
    if (!showPreview) {
      previewHtml = parseMarkdown(content);
      markdownWarnings = validateMarkdown(content);
    }
    showPreview = !showPreview;
  }

  async function sha256(str: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(str.toLowerCase().trim());
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  const STORAGE_KEY = 'momo_comment_user_info';
  const STORAGE_KEY_DRAFT = 'momo_comment_draft';
  let loaded = false;

  function loadUserInfoFromStorage() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const userInfo = JSON.parse(stored);
        author = userInfo.author || '';
        email = userInfo.email || '';
        url = userInfo.url || '';
      }
    } catch (e) {
      console.warn('Failed to load user info from localStorage:', e);
    }
  }

  function saveUserInfoToStorage() {
    try {
      const userInfo = { author, email, url };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(userInfo));
    } catch (e) {
      console.warn('Failed to save user info to localStorage:', e);
    }
  }

  // Auto-save user info and content draft on every change
  $: if (loaded) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ author, email, url }));
    if (content) {
      localStorage.setItem(STORAGE_KEY_DRAFT, content);
    } else {
      localStorage.removeItem(STORAGE_KEY_DRAFT);
    }
  }

  function getWordCount(text: string): { chars: number; words: number } {
    const chars = text.length;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    return { chars, words };
  }

  function isContentWithinLimit(text: string): boolean {
    const { chars, words } = getWordCount(text);
    return chars <= 2000 && words <= 1000;
  }

  function countComments(comments: any[]): number {
    let count = 0;
    for (const c of comments) {
      count += 1;
      if (c.replies && c.replies.length > 0) {
        count += countComments(c.replies);
      }
    }
    return count;
  }

  async function loadComments(loadMore = false) {
    if (loadMore) {
      loadingMore = true;
    } else {
      loading = true;
    }
    try {
      const res = await fetch(
        `${apiUrl}/api/comments?post_slug=${encodeURIComponent(postSlug)}&nested=true&page=${page}&limit=${limit}`
      );
      if (!res.ok) throw new Error(t('comments.loadFailed'));
      const data = await res.json();
      const newComments = data.data?.comments || [];
      if (page === 1) {
        comments = newComments;
      } else {
        comments = [...comments, ...newComments];
      }
      hasMore = data.data.pagination.totalPage > page;
      bloggerBadgeEnabled = data.data.blogger_badge_enabled === 'true';
      bloggerBadgeText = data.data.blogger_badge_text || '';
      placeholderName = data.data.placeholder_name || '';
      placeholderEmail = data.data.placeholder_email || '';
      placeholderContent = data.data.placeholder_content || '';
      placeholderUrl = data.data.placeholder_url || '';
      adminCommentKeyConfigured = data.data.admin_comment_key_configured === 'true';
      adminEmailHash = data.data.admin_email_hash || '';
      if (!adminCommentKeyConfigured) adminKey = '';
      verifyEnabled = parseBool(data.data.verify_enabled);
      verifyHoneypot = data.data.verify_honeypot || '';
    } catch (err: any) {
      error = err.message;
    } finally {
      if (loadMore) {
        loadingMore = false;
      } else {
        loading = false;
      }
    }
  }

  async function submitComment(parentId: number | null = null, replyData: any = null) {
    if (submitting) return;
    
    let submitAuthor, submitEmail, submitUrl, submitContent, submitAdminKey;
    
    if (replyData) {
      submitAuthor = replyData.author;
      submitEmail = replyData.email;
      submitUrl = replyData.url;
      submitContent = replyData.content;
      submitAdminKey = replyData.admin_key;
    } else {
      submitAuthor = author;
      submitEmail = email;
      submitUrl = url;
      submitContent = content;
      submitAdminKey = adminKey;
    }

    if (!submitAuthor || !submitEmail || !submitContent) {
      alert(t('comments.fillRequired'));
      return;
    }

    if (!isContentWithinLimit(submitContent)) {
      alert(t('comments.contentTooLong'));
      return;
    }

    if (!parentId) {
      submitting = true;
    }
    
    try {
      const res = await fetch(`${apiUrl}/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          post_slug: postSlug,
          author: submitAuthor,
          email: submitEmail,
          url: submitUrl || null,
          content: submitContent,
          parent_id: parentId,
          post_url: window.location.href,
          post_title: postTitle,
          admin_key: submitAdminKey || undefined,
          verify_ticket: verifyTicket || undefined,
        }),
      });
      const data = await res.json();

      // 人机验证票据失效：重置状态并让验证框重新验证
      if (res.status === 403 && (data.reason === 'VERIFY_REQUIRED' || data.code === 'VERIFY_REQUIRED')) {
        verifyTicket = null;
        verifyComponent?.retry();
        alert(t('comments.verifyFailed') + '，' + t('comments.verifyRetry'));
        return;
      }

      if (data.message && data.message.includes('Verification email sent')) {
        alert(t('comments.submitSuccess') + ' ' + t('comments.verificationRequired'));
      } else {
        alert(data.message || t('comments.submitSuccess'));
      }
      
      if (!replyData) {
        content = '';
        localStorage.removeItem(STORAGE_KEY_DRAFT);
        saveUserInfoToStorage();
      }
      replyingToId = null;
      
      await loadComments();
    } catch (err) {
      alert(t('comments.submitFailed'));
    } finally {
      if (!parentId) {
        submitting = false;
      }
    }
  }

  async function handleCommentDelete(e: CustomEvent) {
    await loadComments();
  }

  function setReplyingTo(id: number | null) {
    replyingToId = id;
  }

  onMount(() => {
    loadUserInfoFromStorage();
    const draft = localStorage.getItem(STORAGE_KEY_DRAFT);
    if (draft) content = draft;
    loaded = true;
    loadComments();
  });
</script>

<div class="mt-4 mx-auto comment-container" id="comments">
  <!-- <div class="my-6 border border-[var(--text-color)]/70"></div> -->
  <!-- 评论输入 -->
  <div data-aos="fade-up" class="mt-4">
    <form on:submit|preventDefault={() => submitComment()} class="space-y-4">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div class="">
          <label for="author" class="block text-sm text-[var(--text-color)] mb-1">{t('comments.name')}<span class="text-red-500">*</span></label>
          <input id="author" type="text" placeholder={placeholderName || t('comments.required')} bind:value={author}
            class="rounded w-full text-[var(--text-color)] border border-[var(--button-border-color)]  focus:outline-none focus:border-[var(--link-color)] text-sm p-2" />
        </div>
        <div class="">
          <label for="email" class="block text-sm text-[var(--text-color)] mb-1">{t('comments.email')}<span class="text-red-500">*</span></label>
          <input id="email" type="email" placeholder={placeholderEmail || t('comments.required')} bind:value={email}
            class="rounded w-full text-[var(--text-color)] border border-[var(--button-border-color)]  focus:outline-none focus:border-[var(--link-color)] text-sm p-2" />
        </div>
        <div class="">
          <label for="url" class="block text-sm text-[var(--text-color)] mb-1">{t('comments.site')}</label>
          <input id="url" type="url" placeholder={placeholderUrl || t('comments.optional')} bind:value={url}
            class="rounded w-full text-[var(--text-color)] border border-[var(--button-border-color)]  focus:outline-none focus:border-[var(--link-color)] text-sm p-2" />
        </div>

        {#if adminCommentKeyConfigured && isAdminEmail}
          <div>
            <label for="admin-key" class="block text-sm text-[var(--text-color)] mb-1">管理员验证密钥<span class="text-red-500">*</span></label>
            <input id="admin-key" type="password" placeholder="请输入管理员评论密钥" bind:value={adminKey}
              class="rounded w-full text-[var(--text-color)] border border-[var(--button-border-color)] focus:outline-none focus:border-[var(--link-color)] text-sm p-2" />
          </div>
        {/if}
      </div>

      <div>
        {#if showPreview}
          <div class="rounded border text-[var(--text-color)] border-[var(--button-border-color)] p-3 min-h-[100px] text-sm leading-relaxed markdown-preview">
            {#if content.trim() === ''}
              <p>{t('comments.preview') || '预览'}</p>
            {:else}
              <div>{@html previewHtml}</div>
            {/if}
          </div>
          {#if markdownWarnings.length > 0}
            <div class="mt-1 text-xs text-amber-500">
              {#each markdownWarnings as warning}
                <p>{warning === 'codeFence' ? (t('comments.codeFence') || '代码块标记 ``` 未闭合') : (t('comments.inlineCode') || '行内代码标记 ` 未闭合')}</p>
              {/each}
            </div>
          {/if}
        {:else}
          <textarea placeholder={placeholderContent || t('comments.welcome')}
            class="rounded w-full border text-[var(--text-color)] border-[var(--button-border-color)] focus:outline-none focus:border-[var(--link-color)] text-sm p-3 min-h-[100px]"
            bind:value={content}></textarea>
        {/if}

        <div class="text-right text-sm text-[var(--text-color)]/70 mt-1">
          {#if !isContentWithinLimit(content)}
            <span class="text-red-500 ml-2">{t('comments.contentTooLong') || '内容超出限制'}</span>
          {/if}
        </div>
      </div>

      <div class="relative flex flex-wrap justify-end items-center gap-3">
        {#if verifyEnabled}
          <SilentVerify
            bind:this={verifyComponent}
            {apiUrl}
            {postSlug}
            {language}
            honeypotField={verifyHoneypot}
            onTicket={(ticket) => (verifyTicket = ticket)}
          />
        {/if}
        <button
          type="button"
          on:click={togglePreview}
          disabled={!showPreview && !content.trim()}
          class="rounded px-4 py-2 text-sm font-medium text-[var(--text-color)] border border-[var(--button-border-color)] hover:bg-[var(--button-hover-bg-color)] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {showPreview ? t('comments.write') : t('comments.preview')}
        </button>
        <button type="submit" disabled={submitting || !isContentWithinLimit(content) || (verifyEnabled && !verifyTicket)}
          class="rounded px-4 py-2 text-sm font-medium text-[var(--text-color)] border border-[var(--button-border-color)] hover:bg-[var(--button-hover-bg-color)] disabled:opacity-50">
          {submitting ? t('comments.sending') : t('comments.send')}
        </button>
      </div>
    </form>
  </div>

  <!-- 评论区 -->
  <div class="" id="comments-content">
    {#if !loadingMore && loading}
      <p data-aos="fade-up" class="text-[var(--text-color)] text-center">{t('comments.loading') || '正在加载评论...'}</p>
    {:else if error}
      <p data-aos="fade-up" class="text-red-500 text-center">{t('comments.loadFailed') || '加载失败：'}{error}</p>
    {:else}
      <h4 data-aos="fade-up" class="text-[var(--text-color)] text-base font-semibold mb-4">{countComments(comments)} {t('comments.comments')}</h4>

      <div class="space-y-6">
        {#each comments as c}
          <div in:fly={{ y: 24, duration: 400, opacity: 0 }}>
            <CommentItem {c} {postSlug} {author} {email} {url} {language} {apiUrl}
              {bloggerBadgeEnabled} {bloggerBadgeText} {adminCommentKeyConfigured} {adminEmailHash}
              on:reply={(e) => setReplyingTo(e.detail)}
              on:cancel={() => setReplyingTo(null)}
              on:submit={async (e) => {
                await submitComment(e.detail.parentId, e.detail);
              }}
              on:delete={handleCommentDelete}
              replyingToId={replyingToId}
              on:userInfoChange={(e) => {
                author = e.detail.author;
                email = e.detail.email;
                url = e.detail.url;
              }} />
          </div>
        {/each}
      </div>

      {#if hasMore}
        <div class="flex justify-center mt-8">
          <button on:click={() => { page++; loadComments(true); }}
            disabled={loadingMore}
            class="px-6 py-2.5 w-full text-sm font-medium text-[var(--text-color)] bg-transparent hover:bg-[var(--button-hover-bg-color)] active:bg-[var(--button-hover-bg-color)] transition-all duration-300 ease-in-out disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2">
            {#if loadingMore}
              <svg class="animate-spin h-4 w-4 text-[var(--text-color)]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            {/if}
            {loadingMore ? (t('comments.loading') || '加载中...') : (t('comments.loadMore') || '加载更多')}
          </button>
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .markdown-preview :global(h1),
  .markdown-preview :global(h2),
  .markdown-preview :global(h3),
  .markdown-preview :global(h4) {
    margin-top: 1rem;
    margin-bottom: 0.5rem;
    font-weight: 600;
    line-height: 1.3;
  }
  .markdown-preview :global(h1) { font-size: 1.5rem; }
  .markdown-preview :global(h2) { font-size: 1.25rem; }
  .markdown-preview :global(h3) { font-size: 1.1rem; }
  .markdown-preview :global(p) { margin-bottom: 0.5rem; }
  .markdown-preview :global(ul),
  .markdown-preview :global(ol) {
    margin-bottom: 0.5rem;
    padding-left: 1.5rem;
  }
  .markdown-preview :global(ul) { list-style-type: disc; }
  .markdown-preview :global(ol) { list-style-type: decimal; }
  .markdown-preview :global(li) { margin-bottom: 0.25rem; }
  .markdown-preview :global(blockquote) {
    border-left: 3px solid var(--link-color, #6366f1);
    padding-left: 0.75rem;
    margin: 0.5rem 0;
    opacity: 0.85;
  }
  .markdown-preview :global(pre) {
    background: color-mix(in srgb, var(--text-color) 8%, transparent);
    border-radius: 4px;
    padding: 0.75rem;
    overflow-x: auto;
    margin: 0.5rem 0;
    font-size: 0.85rem;
  }
  .markdown-preview :global(code) {
    background: color-mix(in srgb, var(--text-color) 6%, transparent);
    border-radius: 3px;
    padding: 0.15rem 0.3rem;
    font-size: 0.85rem;
    font-family: monospace;
  }
  .markdown-preview :global(pre code) {
    background: none;
    padding: 0;
    border-radius: 0;
  }
  .markdown-preview :global(a) {
    color: var(--link-color, #6366f1);
    text-decoration: underline;
  }
  .markdown-preview :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 4px;
    margin: 0.5rem 0;
  }
  .markdown-preview :global(hr) {
    border: none;
    border-top: 1px solid var(--button-border-color, #ddd);
    margin: 1rem 0;
  }
  .markdown-preview :global(table) {
    border-collapse: collapse;
    width: 100%;
    margin: 0.5rem 0;
    font-size: 0.9rem;
  }
  .markdown-preview :global(th),
  .markdown-preview :global(td) {
    border: 1px solid var(--button-border-color, #ddd);
    padding: 0.4rem 0.6rem;
    text-align: left;
  }
  .markdown-preview :global(th) {
    font-weight: 600;
    background: color-mix(in srgb, var(--text-color) 4%, transparent);
  }
  .markdown-preview :global(del) {
    text-decoration: line-through;
    opacity: 0.7;
  }
</style>

