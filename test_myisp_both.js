const axios = require('axios');
const https = require('https');

async function testAccount(username, password, resellerId, label) {
  console.log(`\n=== Testing ${label} ===`);
  try {
    const baseUrl = 'https://pi.myisp.live';
    const client = axios.create({ baseURL: baseUrl, httpsAgent: new https.Agent({ keepAlive: false }), timeout: 30000 });
    
    const t0 = Date.now();
    const loginPage = await client.get('/login.php');
    console.log(`GET /login.php => ${loginPage.status} in ${Date.now()-t0}ms`);
    
    const csrfMatch = loginPage.data.match(/name=.csrf_token.[^>]*value=.([^"']+)/i);
    const csrf = csrfMatch ? csrfMatch[1] : '';
    if (!csrf) { console.error('No CSRF token!'); return; }
    
    let cookies = loginPage.headers['set-cookie'] || [];
    let cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
    
    const form = new URLSearchParams();
    form.append('login_username', username);
    form.append('login_password', password);
    form.append('captcha', '');
    form.append('csrf_token', csrf);
    
    const t1 = Date.now();
    const check = await client.post('/checklogin.php', form.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookieStr, 'X-Requested-With': 'XMLHttpRequest' },
      validateStatus: () => true
    });
    console.log(`POST /checklogin.php => ${check.status} data="${check.data}" in ${Date.now()-t1}ms`);
    
    const t2 = Date.now();
    const login = await client.post('/login.php', form.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookieStr },
      maxRedirects: 0,
      validateStatus: () => true
    });
    console.log(`POST /login.php => ${login.status} location="${login.headers.location}" in ${Date.now()-t2}ms`);
    
    if (login.headers['set-cookie']) {
      cookies = cookies.concat(login.headers['set-cookie']);
      cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
    }
    
    const t3 = Date.now();
    const exportRes = await client.get('/export-users.php', {
      params: { resellerId },
      headers: { 'Cookie': cookieStr },
      maxRedirects: 0,
      validateStatus: () => true
    });
    console.log(`GET /export-users.php => ${exportRes.status} content-type="${exportRes.headers['content-type']}" in ${Date.now()-t3}ms`);
    console.log(`TOTAL: ${Date.now()-t0}ms`);
  } catch(e) {
    console.error(`FAILED: ${e.message}`);
  }
}

async function main() {
  // Test both accounts
  await testAccount(
    process.env.MYISP_1_USERNAME.trim(),
    process.env.MYISP_1_PASSWORD.trim(),
    '94',
    'MyISP Account 1'
  );
  await testAccount(
    process.env.MYISP_2_USERNAME.trim(),
    process.env.MYISP_2_PASSWORD.trim(),
    process.env.MYISP_2_RESELLER_ID || '96',
    'MyISP Account 2'
  );
}

main();
