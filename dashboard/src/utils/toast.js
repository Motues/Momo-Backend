const styles = {
  success: { bg: '#ecfdf5', border: '#bbf7d0', text: '#166534', icon: '#22c55e', iconClass: 'fa-circle-check' },
  warning: { bg: '#fffbeb', border: '#fde68a', text: '#92400e', icon: '#f59e0b', iconClass: 'fa-circle-exclamation' },
  error: { bg: '#fef2f2', border: '#fecaca', text: '#991b1b', icon: '#ef4444', iconClass: 'fa-circle-xmark' },
  info: { bg: '#eff6ff', border: '#bfdbfe', text: '#1e40af', icon: '#3b82f6', iconClass: 'fa-circle-info' },
};

let toastId = 0;

function show(message, type = 'info', duration = 3000) {
  const s = styles[type];
  const id = `toast-${++toastId}`;

  const el = document.createElement('div');
  el.id = id;
  // 使用 textContent 而非 innerHTML：message 可能来自服务端响应，
  // 直接 innerHTML 会形成 DOM XSS 注入点。
  const icon = document.createElement('i');
  icon.className = `fa-solid ${s.iconClass}`;
  icon.style.flexShrink = '0';
  const text = document.createElement('span');
  text.textContent = message === undefined || message === null ? '' : String(message);
  el.appendChild(icon);
  el.appendChild(text);
  Object.assign(el.style, {
    position: 'fixed',
    top: '16px',
    right: '16px',
    zIndex: '9999',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 16px',
    borderRadius: '8px',
    border: `1px solid ${s.border}`,
    backgroundColor: s.bg,
    color: s.text,
    fontSize: '14px',
    fontWeight: '500',
    lineHeight: '1.4',
    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
    opacity: '0',
    transform: 'translateX(100%)',
    transition: 'opacity 0.25s ease, transform 0.25s ease',
    maxWidth: '360px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  });
  document.body.appendChild(el);

  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateX(0)';
  });

  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(100%)';
    setTimeout(() => el.remove(), 250);
  }, duration);
}

export function toast(message, type) {
  show(message, type);
}

toast.success = (msg) => show(msg, 'success');
toast.error = (msg) => show(msg, 'error');
toast.warning = (msg) => show(msg, 'warning');
toast.info = (msg) => show(msg, 'info');

export default toast;
