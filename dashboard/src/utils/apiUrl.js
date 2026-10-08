/**
 * 后端 API 地址校验。
 *
 * 面板会把管理员 token 附加到每次请求上，因此 apiUrl 一旦被改写为攻击者地址，
 * token 就会被直接外发。这里限制：
 *  - 必须显式带 http/https scheme（或使用以 / 开头的同源相对路径），
 *    否则 axios 会把它当作相对路径而静默失败；
 *  - https 地址一律允许；
 *  - http 地址仅允许「与当前面板同源」或本机调试地址（localhost / 127.0.0.1 / [::1]）。
 */
export function isAllowedApiUrl(value) {
  if (typeof value !== 'string') return false
  const raw = value.trim()
  if (!raw) return false

  // 同源相对路径（如 /api）
  if (raw.startsWith('/') && !raw.startsWith('//')) return true

  // 必须显式带 scheme
  if (!/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(raw)) return false

  let url
  try {
    url = new URL(raw, window.location.origin)
  } catch {
    return false
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.protocol === 'https:') return true

  const host = (url.hostname || '').toLowerCase()
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true

  return url.origin === window.location.origin
}

/** 归一化（去掉结尾斜杠）并校验；不合法返回 null */
export function normalizeApiUrl(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim().replace(/\/+$/, '')
  if (!raw) return null
  return isAllowedApiUrl(raw) ? raw : null
}

/** 供 UI 提示的一句话说明 */
export const API_URL_REQUIREMENT = '出于安全考虑，仅支持 https、与面板同源或本机 (localhost/127.0.0.1) 的地址'
