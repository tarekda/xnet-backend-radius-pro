require('dotenv').config();
const axios = require('axios');
const https = require('https');

async function testHsiProvider(name, baseUrl, user, pass) {
  const agent = new https.Agent({ keepAlive: false, rejectUnauthorized: false });
  if (name === 'idm') {
    // IDM cookie login
    class CookieJar {
      constructor() { this.values = new Map(); }
      update(setCookie) {
        const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
        for (const header of headers) {
          const first = header.split(';', 1)[0];
          const sep = first.indexOf('=');
          if (sep <= 0) continue;
          this.values.set(first.slice(0, sep), first.slice(sep + 1));
        }
      }
      header() { return [...this.values].map(([k, v]) => `${k}=${v}`).join('; '); }
      get(name) { return this.values.get(name); }
    }
    const client = axios.create({ baseURL: baseUrl, timeout: 15000, httpsAgent: agent });
    const jar = new CookieJar();
    async function req(config) {
      const headers = { ...(config.headers || {}) };
      const cookie = jar.header();
      if (cookie) headers.Cookie = cookie;
      const res = await client.request({ ...config, headers, maxRedirects: 0, validateStatus: () => true });
      jar.update(res.headers['set-cookie']);
      return res;
    }
    const loginPath = '/login/?next=/user/list/';
    await req({ method: 'get', url: loginPath });
    const form = new URLSearchParams({ 'login-username': user, 'login-password': pass });
    await req({ method: 'post', url: loginPath, data: form.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: baseUrl + loginPath } });
    
    const pageSize = 500;
    const allUsers = [];
    for (let pageIndex = 1; pageIndex <= 50; pageIndex++) {
      const res = await req({ method: 'get', url: '/api/user/list/', params: { pageIndex, pageSize }, headers: { 'X-CSRFToken': jar.get('csrftoken') || '', Referer: baseUrl + '/user/list/' } });
      if (res.status !== 200) break;
      const payload = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
      const rows = payload?.data || [];
      allUsers.push(...rows);
      const total = Number(payload?.itemscount ?? 0);
      if (rows.length === 0 || rows.length < pageSize) break;
      if (Number.isFinite(total) && pageIndex * pageSize >= total) break;
    }
    const online = allUsers.filter(u => String(u.status).toLowerCase() === 'green' || (u.ip && u.ip !== 'N/A')).length;
    console.log(`${name.toUpperCase()}: ${allUsers.length} total, ${online} online`);
  } else {
    // Proradius REST API (Terra 1, Terra 2, MISP)
    const resp = await axios.post(baseUrl + '/api/token/', { username: user, password: pass }, { timeout: 10000, httpsAgent: agent });
    const token = resp.data.access;
    const pageSize = 1000;
    const allUsers = [];
    for (let pageIndex = 1; pageIndex <= 50; pageIndex++) {
      const res = await axios.get(baseUrl + '/api/users', {
        headers: { Authorization: `Bearer ${token}` },
        params: { pageIndex, pageSize, sortField: 'username', sortOrder: 'asc', usersFilter: 'my' },
        timeout: 10000, httpsAgent: agent, validateStatus: () => true
      });
      if (res.status !== 200) break;
      const body = res.data?.body ?? res.data;
      const rows = Array.isArray(body?.data) ? body.data : [];
      allUsers.push(...rows);
      const total = Number(body?.itemscount ?? 0);
      if (rows.length === 0 || rows.length < pageSize) break;
      if (Number.isFinite(total) && pageIndex * pageSize >= total) break;
    }
    const online = allUsers.filter(u => String(u.status).toLowerCase() === 'green' || (u.ip && u.ip !== 'N/A')).length;
    console.log(`${name.toUpperCase()}: ${allUsers.length} total, ${online} online`);
  }
}

async function main() {
  await testHsiProvider('idm', 'https://newhsipro.idm.net.lb', process.env.IDM_USERNAME.trim(), process.env.IDM_PASSWORD.trim());
  await testHsiProvider('terra', 'https://acppro.terra.net.lb', process.env.TERRA_USERNAME.trim(), process.env.TERRA_PASSWORD.trim());
  await testHsiProvider('terra2', 'https://acppro.terra.net.lb', process.env.TERRA2_USERNAME.trim(), process.env.TERRA2_PASSWORD.trim());
  await testHsiProvider('misp', 'https://misp.cloud', process.env.MISP_USERNAME.trim(), process.env.MISP_PASSWORD.trim());
}

main().catch(e => console.error('FAILED:', e.message));
