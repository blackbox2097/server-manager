import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
});

// Request interceptor — dodaj JWT
api.interceptors.request.use((config) => {
  // Importuj store dinamički da izbegnemo circular dependency
  const token = JSON.parse(localStorage.getItem('sm-auth') || '{}')?.state?.accessToken;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Response interceptor — automatski refresh pri 401
let isRefreshing = false;
let failedQueue  = [];

function processQueue(error, token = null) {
  failedQueue.forEach(({ resolve, reject }) => error ? reject(error) : resolve(token));
  failedQueue = [];
}

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;

    if (error.response?.status === 401 && !original._retry && !original.url?.includes('/auth/')) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then(token => {
          original.headers.Authorization = `Bearer ${token}`;
          return api(original);
        });
      }

      original._retry = true;
      isRefreshing    = true;

      try {
        const { default: useAuthStore } = await import('../store/authStore');
        const newToken = await useAuthStore.getState().refreshAccessToken();
        processQueue(null, newToken);
        original.headers.Authorization = `Bearer ${newToken}`;
        return api(original);
      } catch (err) {
        processQueue(err, null);
        const { default: useAuthStore } = await import('../store/authStore');
        useAuthStore.getState().logout();
        window.location.href = '/login';
        return Promise.reject(err);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

export default api;
