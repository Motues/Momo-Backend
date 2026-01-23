<script lang="ts">
  import { onMount } from 'svelte';
  import CommentItem from './CommentItem.svelte';
  import i18nit from '../i18n/translation';

  export let postSlug: string;
  export let language: string = 'zh-cn';
  export let postTitle: string;
  export let apiUrl: string;

  const t = i18nit(language);

  let comments: any[] = [];
  let loading = true;
  let error = '';
  let page = 1;
  let limit = 20;
  let hasMore = false;

  let author = '';
  let email = '';
  let url = '';
  let content = '';

  let submitting = false;

  let replyingToId: number | null = null;

  const STORAGE_KEY = 'momo_comment_user_info';

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

  function getWordCount(text: string): { chars: number; words: number } {
    const chars = text.length;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    return { chars, words };
  }

  function isContentWithinLimit(text: string): boolean {
    const { chars, words } = getWordCount(text);
    return chars <= 2000 && words <= 1000;
  }

  async function loadComments() {
    loading = true;
    try {
      const res = await fetch(
        `${apiUrl}/api/comments?post_slug=${encodeURIComponent(postSlug)}&nested=true&page=${page}&limit=${limit}`
      );
      if (!res.ok) throw new Error(t('comments.loadFailed'));
      const data = await res.json();
      comments = data.data;
      hasMore = data.pagination.total > page * limit;
    } catch (err: any) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  async function submitComment(parentId: number | null = null, replyData: any = null) {
    if (submitting) return;
    
    let submitAuthor, submitEmail, submitUrl, submitContent;
    
    if (replyData) {
      submitAuthor = replyData.author;
      submitEmail = replyData.email;
      submitUrl = replyData.url;
      submitContent = replyData.content;
    } else {
      submitAuthor = author;
      submitEmail = email;
      submitUrl = url;
      submitContent = content;
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
        }),
      });
      const data = await res.json();
      alert(data.message || t('comments.submitSuccess'));
      
      if (!replyData) {
        content = '';
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
    loadComments();
  });
</script>

<div class="comment-container">
  <div class="comment-form-wrapper">
    <form on:submit|preventDefault={() => submitComment()} class="comment-form">
      <div class="form-grid">
        <div class="form-group">
          <label for="author" class="form-label">{t('comments.name')}<span class="required">*</span></label>
          <input id="author" type="text" placeholder={t('comments.required')} bind:value={author} class="form-input" />
        </div>
        <div class="form-group">
          <label for="email" class="form-label">{t('comments.email')}<span class="required">*</span></label>
          <input id="email" type="email" placeholder={t('comments.required')} bind:value={email} class="form-input" />
        </div>
        <div class="form-group">
          <label for="url" class="form-label">{t('comments.site')}</label>
          <input id="url" type="url" placeholder={t('comments.optional')} bind:value={url} class="form-input" />
        </div>
      </div>

      <div class="textarea-wrapper">
        <textarea placeholder={t('comments.welcome')} class="form-textarea" bind:value={content}></textarea>
        <div class="textarea-footer">
          {#if !isContentWithinLimit(content)}
            <span class="error-text">{t('comments.contentTooLong') || '内容超出限制'}</span>
          {/if}
        </div>
      </div>

      <div class="form-footer">
        <button type="submit" disabled={submitting || !isContentWithinLimit(content)} class="btn-submit">
          {submitting ? t('comments.sending') : t('comments.send')}
        </button>
      </div>
    </form>
  </div>

  <div class="comment-list-wrapper">
    {#if loading}
      <p class="status-message">{t('comments.loading')}</p>
    {:else if error}
      <p class="status-message error">{t('comments.loadFailed')}{error}</p>
    {:else}
      <h4 class="comments-count">{comments.length} {t('comments.comments')}</h4>

      <div class="comments-list">
        {#each comments as c}
          <CommentItem {c} {postSlug} {author} {email} {url} {language} {apiUrl}
            on:reply={(e) => setReplyingTo(e.detail)} 
            on:cancel={() => setReplyingTo(null)}
            on:submit={async (e) => {
              await submitComment(e.detail.parentId, e.detail);
            }}
            on:delete={handleCommentDelete}
            replyingToId={replyingToId} />
        {/each}
      </div>

      {#if hasMore}
        <div class="load-more-wrapper">
          <button on:click={() => { page++; loadComments(); }} class="btn-load-more">
            {t('comments.loadMore')}
          </button>
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
.comment-container {
  --text-color: var(--momo-text-color, #000000);
  --button-border-color: var(--momo-button-border-color, #e5e5e5);
  --button-hover-bg-color: var(--momo-button-hover-bg-color, #f5f5f5);
  --link-color: var(--momo-link-color, #003b6e);
}
:global([data-theme="dark"]) .comment-container {
  --text-color: var(--momo-text-color, #ffffff);
  --button-border-color: var(--momo-button-border-color, #3d3d3d);
  --button-hover-bg-color: var(--momo-button-hover-bg-color, #262626);
  --link-color: var(--momo-link-color, #57ace7);
}
.comment-container {
  margin-left: auto;
  margin-right: auto;
}

.comment-form-wrapper {
  margin-top: 1rem;
}

.comment-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.75rem;
}

.form-label {
  display: block;
  font-size: 0.875rem;
  color: var(--text-color);
  margin-bottom: 0.25rem;
}

.required {
  color: #ef4444;
}

.form-input, .form-textarea {
  width: 100%;
  border-radius: 0.25rem;
  color: var(--text-color);
  border: 1px solid var(--button-border-color);
  font-size: 0.875rem;
  background: transparent;
  box-sizing: border-box;
  font-family: inherit;
}

.form-input::placeholder,
.form-textarea::placeholder {
  color: color-mix(in srgb, var(--text-color) 50%, transparent);
}

.form-input:focus, .form-textarea:focus {
  outline: none;
  border-color: var(--link-color);
}

.form-input {
  padding: 0.5rem;
}

.form-textarea {
  padding: 0.75rem;
  min-height: 100px;
  resize: vertical;
}

.textarea-footer {
  text-align: right;
  font-size: 0.875rem;
  color: color-mix(in srgb, var(--text-color) 80%, transparent);
  margin-top: 0.25rem;
}

.error-text {
  color: #ef4444;
  margin-left: 0.5rem;
}

.form-footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
}

.btn-submit {
  border-radius: 0.25rem;
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-color);
  border: 1px solid var(--button-border-color);
  background: transparent;
  cursor: pointer;
  transition: background-color 0.2s;
}

.btn-submit:hover {
  background-color: var(--button-hover-bg-color);
}

.comments-count {
  color: var(--text-color);
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 1rem;
}

.comments-list {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.status-message {
  color: var(--text-color);
  text-align: center;
}

.status-message.error {
  color: #ef4444;
}

.load-more-wrapper {
  display: flex;
  justify-content: center;
  margin-top: 1.5rem;
}

.btn-load-more {
  background: none;
  border: none;
  color: #4f46e5;
  font-size: 0.875rem;
  cursor: pointer;
  text-decoration: none;
}

.btn-load-more:hover {
  text-decoration: underline;
}
</style>