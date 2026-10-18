'use client';

import { useEffect } from 'react';

export function ServiceWorker() {
  useEffect(() => {
    try {
      if (localStorage.getItem('erp.large') === 'true') document.documentElement.dataset.largeText = 'true';
    } catch {
      /* stockage indisponible */
    }
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, []);
  return null;
}
