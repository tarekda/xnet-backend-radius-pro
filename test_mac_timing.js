const axios = require('axios');
const https = require('https');

async function testAccount(username, password, resellerId, label) {
  console.log(`\n=== Testing ${label} ===`);
  try {
    const baseUrl = 'https://pi.myisp.live';
    const client = axios.create({ baseURL: baseUrl, httpsAgent: new https.Agent({ keepAlive: false }), timeout: 30000 });
    
    // Login
    const loginPage = await client.get('/login.php');
    const csrfMatch = loginPage.data.match(/name=.csrf_token.[^>]*value=.([^"']+)/i);
    const csrf = csrfMatch ? csrfMatch[1] : '';
    let cookies = loginPage.headers['set-cookie'] || [];
    let cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
    
    const form = new URLSearchParams();
    form.append('login_username', username);
    form.append('login_password', password);
    form.append('captcha', '');
    form.append('csrf_token', csrf);
    
    await client.post('/checklogin.php', form.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookieStr, 'X-Requested-With': 'XMLHttpRequest' }, validateStatus: () => true });
    const login = await client.post('/login.php', form.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookieStr }, maxRedirects: 0, validateStatus: () => true });
    if (login.headers['set-cookie']) {
      cookies = cookies.concat(login.headers['set-cookie']);
      cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
    }
    
    // Get reseller page for CSRF token
    const usersPage = await client.get('/resellerUsers.php', { headers: { 'Cookie': cookieStr } });
    const pageCsrfMatch = usersPage.data.match(/<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)/i);
    const pageCsrf = pageCsrfMatch ? pageCsrfMatch[1] : csrf;
    console.log(`Page CSRF found: ${Boolean(pageCsrf)}`);
    
    // Test MAC fetch timing
    const t = Date.now();
    const macRes = await client.post('/admingetresellerusers.php', new URLSearchParams({
      draw: '1', start: '0', length: '500',
      'search[value]': '', 'search[regex]': 'false',
      'order[0][column]': '3', 'order[0][dir]': 'asc',
      'columns[3][data]': 'username',
    }).toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-Token': pageCsrf,
        'Origin': baseUrl,
        'Referer': `${baseUrl}/resellerUsers.php`,
        'Cookie': cookieStr
      },
      validateStatus: () => true
    });
    const elapsed = Date.now() - t;
    let rows = 0;
    try { 
      const p = typeof macRes.data === 'string' ? JSON.parse(macRes.data) : macRes.data;
      rows = (p?.data || p?.aaData || []).length;
      const total = p?.recordsTotal || p?.recordsFiltered;
      console.log(`POST /admingetresellerusers.php => ${macRes.status} in ${elapsed}ms, rows=${rows}, recordsTotal=${total}`);
    } catch(e) {
      console.log(`POST /admingetresellerusers.php => ${macRes.status} in ${elapsed}ms, parse failed`);
    }
    
  } catch(e) {
    console.error(`FAILED: ${e.message}`);
  }
}

async function main() {
  await testAccount(
    process.env.MYISP_1_USERNAME.trim(), process.env.MYISP_1_PASSWORD.trim(), '94', 'MyISP Account 1'
  );
  await testAccount(
    process.env.MYISP_2_USERNAME.trim(), process.env.MYISP_2_PASSWORD.trim(), '96', 'MyISP Account 2'
  );
}

main();
