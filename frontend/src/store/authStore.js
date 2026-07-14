import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import api from '../services/api';

const useAuthStore = create(
  persist(
    (set, get) => ({
      user:         null,
      accessToken:  null,
      refreshToken: null,
      tenants:      [],
      activeTenant: null,

      login: async (username, password) => {
        const { data } = await api.post('/auth/login', { username, password });
        set({
          user:         data.user,
          accessToken:  data.accessToken,
          refreshToken: data.refreshToken,
          tenants:      data.tenants || [],
          activeTenant: data.tenants?.[0] || null,
        });
        return data;
      },

      logout: async () => {
        try {
          await api.post('/auth/logout', { refreshToken: get().refreshToken });
        } catch {}
        set({ user: null, accessToken: null, refreshToken: null, tenants: [], activeTenant: null });
      },

      setActiveTenant: (tenant) => set({ activeTenant: tenant }),

      refreshAccessToken: async () => {
        const { refreshToken } = get();
        if (!refreshToken) throw new Error('Nema refresh tokena');
        const { data } = await api.post('/auth/refresh', { refreshToken });
        set({ accessToken: data.accessToken, refreshToken: data.refreshToken });
        return data.accessToken;
      },

      // Proveri da li korisnik ima određenu dozvolu za aktivni tenant
      hasPerm: (perm) => {
        const { user, activeTenant } = get();
        if (!user) return false;
        if (user.role === 'superadmin') return true;
        if (!activeTenant) return false;
        return !!activeTenant[perm];
      },
    }),
    {
      name:    'sm-auth',
      partialize: (s) => ({
        user: s.user, accessToken: s.accessToken,
        refreshToken: s.refreshToken, tenants: s.tenants, activeTenant: s.activeTenant,
      }),
    }
  )
);

export default useAuthStore;
