import axios from 'axios';

// 全局 axios 实例，baseURL=/api 由 vite proxy 转发到后端 3000 端口
const client = axios.create({
  baseURL: '/api',
  timeout: 30000,
});

// 请求拦截器：可在此注入鉴权头等
client.interceptors.request.use(
  (config) => config,
  (error) => Promise.reject(error),
);

// 响应拦截器：统一处理后端返回的错误
client.interceptors.response.use(
  (response) => response.data,
  (error) => {
    console.error('[API Error]', error?.response?.status, error?.message);
    return Promise.reject(error);
  },
);

export default client;
