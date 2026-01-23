<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import i18nit from '../i18n/translation';
  import { formatFullDate } from '../utils/time'

  export let c: any;
  export let postSlug: string;
  export let replyingToId: number | null = null;
  export let author: string = '';
  export let email: string = '';
  export let url: string = '';
  export let language: string = 'zh-cn';
  export let apiUrl: string;

  const t = i18nit(language);

  let replyAuthor = '';
  let replyEmail = '';
  let replyUrl = '';
  let replyContent = '';
  
  let replySubmitting = false;
  
  const dispatch = createEventDispatcher();
  
  const avatarUrl = c.avatar;

  function getWordCount(text: string): { chars: number; words: number } {
    const chars = text.length;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    return { chars, words };
  }

  function isContentWithinLimit(text: string): boolean {
    const { chars, words } = getWordCount(text);
    return chars <= 2000 && words <= 1000;
  }

  function isValidHtml(str: string): boolean {
    if (!str.includes('<') || !str.includes('>')) return false;
    
    const tagRegex = /<([a-z][a-z0-9]*)\b[^>]*>(.*?)<\/\1>/i;
    return tagRegex.test(str);
  }
</script>



<div class="comment-item-container">
  {#if c.url}
    <a href={c.url} target="_blank" class="comment-avatar-link">
      <img src={avatarUrl} alt="avatar" class="comment-avatar"/>
    </a>
  {:else}
    <img src={avatarUrl} alt="avatar" class="comment-avatar"/>
  {/if}

  <div class="comment-main">
    <div class="comment-header">
      <span class="comment-author">{c.author}</span>
      <span class="comment-date">{formatFullDate(new Date(c.pubDate), language)}</span>
    </div>

    <div class="comment-content">
      {#if c.contentHtml && typeof c.contentHtml === 'string' && isValidHtml(c.contentHtml)}
        <div class="html-content">{@html c.contentHtml}</div>
      {:else if c.contentText && typeof c.contentText === 'string' && c.contentText.trim() !== ''}
        <p class="text-content">
          {c.contentText}
        </p>
      {:else if c.contentHtml && typeof c.contentHtml === 'string' && c.contentHtml.trim() !== ''}
        <p class="text-content">
          {c.contentHtml}
        </p>
      {:else}
        <p class="text-content empty-text">
          {t('comments.noContent')}
        </p>
      {/if}
    </div>

    <div class="comment-actions">
      <button on:click={() => {
        dispatch('reply', c.id);
        replyAuthor = author;
        replyEmail = email;
        replyUrl = url;
      }} class="action-link">
        {t('comments.reply')}
      </button>
    </div>

    {#if replyingToId === c.id}
      <div class="reply-form-wrapper">
        <form on:submit|preventDefault={() => {
          if (replySubmitting) return;
          if (!replyAuthor || !replyEmail || !replyContent) {
            alert(t('comments.fillRequired'));
            return;
          }
          if (!isContentWithinLimit(replyContent)) {
            alert(t('comments.contentTooLong'));
            return;
          }
          replySubmitting = true;
          dispatch('submit', {
            parentId: c.id,
            author: replyAuthor,
            email: replyEmail,
            url: replyUrl,
            content: replyContent,
            post_url: window.location.href,
          });
          replyContent = '';
        }} class="reply-form">
          <div class="reply-grid">
            <div class="form-group">
              <label for="reply-author-{c.id}" class="reply-label">{t('comments.name')}<span class="required">*</span></label>
              <input id="reply-author-{c.id}" type="text" placeholder={t('comments.required')} bind:value={replyAuthor} class="reply-input" />
            </div>
            <div class="form-group">
              <label for="reply-email-{c.id}" class="reply-label">{t('comments.email')}<span class="required">*</span></label>
              <input id="reply-email-{c.id}" type="email" placeholder={t('comments.required')} bind:value={replyEmail} class="reply-input" />
            </div>
            <div class="form-group">
              <label for="reply-url-{c.id}" class="reply-label">{t('comments.site')}</label>
              <input id="reply-url-{c.id}" type="url" placeholder={t('comments.optional')} bind:value={replyUrl} class="reply-input" />
            </div>
          </div>

          <div class="reply-textarea-container">
            <textarea placeholder={t('comments.replyPlaceholder')} class="reply-textarea" bind:value={replyContent}></textarea>
            <div class="reply-footer-info">
              {#if !isContentWithinLimit(replyContent)}
                <span class="error-text">{t('comments.contentTooLong')}</span>
              {/if}
            </div>
          </div>

          <div class="reply-buttons">
            <button type="button" on:click={() => { dispatch('cancel'); replySubmitting = false; }} class="btn-cancel">
              {t('comments.cancel')}
            </button>
            <button type="submit" disabled={replySubmitting || !isContentWithinLimit(replyContent)} class="btn-submit-reply">
              {replySubmitting ? t('comments.sending') : t('comments.reply')}
            </button>
          </div>
        </form>
      </div>
    {/if}

    {#if c.replies && c.replies.length}
      <div class="nested-replies">
        {#each c.replies as reply}
          <div class="nested-item">
            <svelte:self c={reply} {postSlug} {author} {email} {url} {language}
              on:reply={(e) => dispatch('reply', e.detail)} 
              on:cancel={() => dispatch('cancel')}
              on:submit={(e) => dispatch('submit', e.detail)}
              on:delete={(e) => dispatch('delete', e.detail)}
              replyingToId={replyingToId} />
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
.comment-item-container {
  display: flex;
  gap: 0.75rem;
  width: 100%;
  max-width: 100%;
}

.comment-avatar-link, .comment-avatar {
  width: 2.5rem;
  height: 2.5rem;
  flex-shrink: 0;
}

.comment-avatar {
  border-radius: 0.25rem;
  object-fit: cover;
}

.comment-main {
  flex: 1;
  min-width: 0;
}

.comment-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.comment-author {
  font-weight: 600;
  color: var(--text-color);
}

.comment-date {
  font-size: 0.875rem;
  color: color-mix(in srgb, var(--text-color) 80%, transparent);
}

.comment-content {
  margin-top: 0.25rem;
  color: var(--text-color);
  line-height: 1.625;
  width: 100%;
  max-width: 100%;
  min-width: 0;
}

.html-content, .text-content {
  word-wrap: break-word;
  word-break: break-word;
  max-width: 100%;
}

.text-content {
  white-space: pre-wrap;
  overflow: hidden;
  margin: 0;
}

.empty-text {
  color: color-mix(in srgb, var(--text-color) 50%, transparent);
}

.comment-actions {
  margin-top: 0.25rem;
  display: flex;
  align-items: center;
  gap: 1rem;
  font-size: 0.875rem;
  color: var(--text-color);
}

.action-link {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: inherit;
  font-size: inherit;
}

.action-link:hover {
  color: var(--link-color);
}

.reply-form-wrapper {
  margin-top: 1rem;
  padding-left: 1rem;
  border-left: 2px solid #e5e7eb;
}

.reply-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem; 
}

.reply-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.5rem;
}

.reply-label {
  display: block;
  font-size: 0.75rem;
  color: var(--text-color);
  margin-bottom: 0.25rem;
}

.required {
  color: #ef4444;
}

.reply-input, .reply-textarea {
  width: 100%;
  border-radius: 0.25rem;
  color: var(--text-color);
  border: 1px solid var(--button-border-color);
  font-size: 0.875rem;
  background: transparent;
  box-sizing: border-box;
  font-family: inherit;
}

.reply-input:focus, .reply-textarea:focus {
  outline: none;
  border-color: var(--link-color);
}

.reply-input {
  padding: 0.25rem;
}

.reply-textarea {
  padding: 0.5rem;
  min-height: 80px;
  resize: vertical;
}

.reply-footer-info {
  text-align: right;
  font-size: 0.75rem;
  color: color-mix(in srgb, var(--text-color) 80%, transparent);
  margin-top: 0.25rem;
}

.error-text {
  color: #ef4444;
  margin-left: 0.5rem;
}

.reply-buttons {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.btn-cancel, .btn-submit-reply {
  border-radius: 0.25rem;
  padding: 0.25rem 0.75rem;
  font-size: 0.875rem;
  border: 1px solid var(--button-border-color);
  background: transparent;
  color: var(--text-color);
  cursor: pointer;
}

.btn-submit-reply {
  font-weight: 500;
}

.btn-cancel:hover, .btn-submit-reply:hover:not(:disabled) {
  background-color: var(--button-hover-bg-color);
}

.btn-submit-reply:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.nested-replies {
  padding-left: 1.5rem; 
  margin-top: 1rem;
  border-left: 1px solid color-mix(in srgb, var(--text-color) 50%, transparent);
  display: flex;
  flex-direction: column;
  gap: 1rem; 
  width: 100%;
}

.nested-item {
  width: 100%;
  max-width: 100%;
  overflow: hidden;
}
</style>