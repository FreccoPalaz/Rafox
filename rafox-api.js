/* =====================================================================
   RAFOX API — unico punto di contatto tra l'app e il backend.

   COME COLLEGARE IL BACKEND
   -------------------------
   Cambia solo BASE qui sotto:

     sviluppo in locale   'http://localhost:8080'
     backend pubblicato   'https://tuo-backend.onrender.com'
     nessun backend       null   (l'app resta in modalità solo-mercati)

   Nota: una pagina servita in HTTPS non può chiamare un indirizzo
   http://localhost — il browser lo blocca. Perciò in locale vanno
   aperti in locale sia il sito sia il backend.
   ===================================================================== */
(function (global) {
  'use strict';

  const BASE = null;   // <— METTI QUI L'INDIRIZZO DEL TUO BACKEND

  const TOKEN_KEY = 'rfx.token';

  /* Il token di sessione sta in localStorage: è un'informazione di accesso,
     non una credenziale di exchange. Le API secret di Binance non passano
     mai da qui — quelle vivono solo sul server. */
  let token = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch { token = null; }

  function setToken(t) {
    token = t;
    try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {}
  }

  class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }

  async function request(path, { method = 'GET', body = null, auth = true } = {}) {
    if (!BASE) throw new ApiError('Backend non configurato', 0);

    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (auth && token) headers['Authorization'] = 'Bearer ' + token;

    let res;
    try {
      res = await fetch(BASE + path, {
        method, headers, body: body ? JSON.stringify(body) : undefined
      });
    } catch {
      throw new ApiError('Server non raggiungibile', 0);
    }

    if (res.status === 401) {
      setToken(null);
      throw new ApiError('Sessione scaduta, rifai l\u2019accesso', 401);
    }

    let data = null;
    try { data = await res.json(); } catch { data = null; }

    if (!res.ok) {
      const detail = data && data.detail;
      throw new ApiError(
        typeof detail === 'string' ? detail : 'Richiesta non riuscita (' + res.status + ')',
        res.status
      );
    }
    return data;
  }

  global.RafoxAPI = {
    configured: () => Boolean(BASE),
    loggedIn: () => Boolean(token),
    logout: () => setToken(null),

    async register(email, password) {
      const d = await request('/api/auth/register',
        { method: 'POST', body: { email, password }, auth: false });
      setToken(d.token);
      return d;
    },

    async login(email, password) {
      const d = await request('/api/auth/login',
        { method: 'POST', body: { email, password }, auth: false });
      setToken(d.token);
      return d;
    },

    me:        () => request('/api/auth/me'),
    accounts:  () => request('/api/accounts'),
    account:   (id) => request('/api/accounts/' + id),
    history:   (id) => request('/api/accounts/' + id + '/history'),
    audit:     (id) => request('/api/accounts/' + id + '/audit?limit=40'),
    resetDemo: (id) => request('/api/accounts/' + id + '/reset', { method: 'POST' }),

    strategies: () => request('/api/bot/strategies'),
    regime: (symbols, minutes) => request(
      '/api/market/regime?symbols=' + symbols.join(',') +
        (minutes ? '&duration_minutes=' + minutes : ''),
      { auth: false }
    ),
    botStatus:  (accountId) => request('/api/bot/status?account_id=' + accountId),
    botStart:   (payload) => request('/api/bot/start', { method: 'POST', body: payload }),
    botStop:    (accountId) => request('/api/bot/stop?account_id=' + accountId, { method: 'POST' }),
    botCloseAll:(accountId) => request('/api/bot/close-all?account_id=' + accountId, { method: 'POST' }),

    ApiError
  };
})(window);
