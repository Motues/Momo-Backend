import axios from 'axios'
import toast from './toast'
import router from '../router'
import { isAllowedApiUrl } from './apiUrl'

const service = axios.create({
  timeout: 10000 // 建议超时时间稍微设长一点，以应对不同网络环境
})

// 请求拦截器：动态配置 baseURL 和添加 token
service.interceptors.request.use(
  config => {
    // 动态获取 LocalStorage 中的 API 地址
    const apiUrl = localStorage.getItem('apiUrl')
    if (apiUrl) {
      if (isAllowedApiUrl(apiUrl)) {
        config.baseURL = apiUrl
      } else {
        // 已保存的地址不合法（例如被恶意脚本改写）：丢弃并清除，
        // 避免把管理员 token 发送到攻击者控制的地址
        console.warn('Ignoring unsafe apiUrl from localStorage')
        localStorage.removeItem('apiUrl')
      }
    }

    // 处理 Token
    const token = localStorage.getItem('token')
    if (token) {
      config.headers['Authorization'] = `Bearer ${token}`
    }
    return config
  },
  error => Promise.reject(error)
)

// 响应拦截器：处理错误码和 Token 过期
service.interceptors.response.use(
  response => {
    const res = response.data
    if (res.code && res.code !== 200) {
      if (res.code === 401) {
        toast.error('登录已过期或凭证无效，请重新登录')
        localStorage.removeItem('token')
        router.push('/login')
        return Promise.reject(new Error(res.message || 'Unauthorized'))
      }
      if (res.code !== 400) {
        toast.error(res.message || 'Error')
      }
      return Promise.reject(new Error(res.message || 'Error'))
    }
    return res
  },
  error => {
    if (error.response && error.response.data) {
      const res = error.response.data
      if (res.code === 401) {
        toast.error('登录已过期或凭证无效，请重新登录')
        localStorage.removeItem('token')
        router.push('/login')
        return Promise.reject(error)
      }
      if (res.code === 400 || error.response.status === 401) {
        return Promise.reject(new Error(res.message || error.message))
      }
    }

    toast.error(error.message || '网络或接口错误，请检查 API 地址是否正确')
    return Promise.reject(error)
  }
)

export default service