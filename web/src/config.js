// The signaling Worker also serves this built app in prod, so same-origin by
// default (apiBase ''). In dev, wrangler serves the Worker separately on :8787.
// Override either with VITE_API_BASE at build time if you host them apart.
const DEFAULT = import.meta.env.DEV ? 'http://localhost:8787' : '';
const API = (import.meta.env.VITE_API_BASE || DEFAULT).replace(/\/$/, '');

export const apiBase = API; // '' means same origin (relative /rooms, /room/:id/ws)
export const wsBase = API
  ? API.replace(/^http/, 'ws')
  : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
