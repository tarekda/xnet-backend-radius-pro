const axios = require('axios');
const https = require('https');

async function test() {
  const c = axios.create({
    baseURL: 'https://pi.myisp.live',
    httpsAgent: new https.Agent({ keepAlive: false })
  });

  try {
    const r = await c.get('/login.php');
    const csrfMatch = r.data.match(/name=.csrf_token.[^>]*value=.([^"']+)/i);
    const csrf = csrfMatch ? csrfMatch[1] : '';
    
    let cookies = r.headers['set-cookie'] || [];
    let cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
    
    const form = new URLSearchParams();
    form.append('login_username', 'tarek');
    form.append('login_password', '123456');
    form.append('captcha', '');
    form.append('csrf_token', csrf);
    
    const h = { 
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieStr,
      'X-Requested-With': 'XMLHttpRequest'
    };
    
    const p = await c.post('/checklogin.php', form.toString(), { headers: h });
    const p2 = await c.post('/login.php', form.toString(), { headers: { ...h, 'X-Requested-With': undefined }, maxRedirects: 0, validateStatus: () => true });
    
    if (p2.headers['set-cookie']) {
      cookies = cookies.concat(p2.headers['set-cookie']);
      cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
      h['Cookie'] = cookieStr;
    }
    
    // WITHOUT X-REQUESTED-WITH
    const u = await c.get('/resellerUsers.php', { headers: { 'Cookie': cookieStr }, maxRedirects: 5 });
    console.log("WITHOUT X-REQUESTED-WITH:", u.data.includes('export-users.php'));
    
  } catch(e) {
    console.error(e.message);
  }
}
test();
