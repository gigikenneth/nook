// Points at the signaling Worker. In dev, wrangler serves it on :8787.
// In prod, set VITE_API_BASE to the deployed Worker URL at build time.
const API = (import.meta.env.VITE_API_BASE || 'http://localhost:8787').replace(/\/$/, '');

export const apiBase = API;
export const wsBase = API.replace(/^http/, 'ws');
