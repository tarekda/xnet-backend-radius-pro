const axios = require('axios');
const https = require('https');

async function test() {
  const c = axios.create({
    baseURL: 'https://pi.myisp.live',
    httpsAgent: new https.Agent({ keepAlive: false })
  });

  try {
    console.log("Getting login.php...");
    const r = await c.get('/login.php');
    const csrfMatch = r.data.match(/name=.csrf_token.[^>]*value=.([^"']+)/i);
    const csrf = csrfMatch ? csrfMatch[1] : '';
    console.log("CSRF:", csrf);
    
    let cookies = r.headers['set-cookie'] || [];
    let cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
    console.log("Cookies:", cookieStr);
    
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
    
    console.log("Posting to checklogin.php...");
    const p = await c.post('/checklogin.php', form.toString(), { headers: h });
    console.log("CHECKLOGIN RESPONSE:", p.data);
    
    console.log("Posting to login.php...");
    const p2 = await c.post('/login.php', form.toString(), { headers: { ...h, 'X-Requested-With': undefined }, maxRedirects: 0, validateStatus: () => true });
    console.log("LOGIN RESPONSE STATUS:", p2.status);
    console.log("LOGIN LOCATION:", p2.headers.location);
    
    if (p2.headers['set-cookie']) {
      cookies = cookies.concat(p2.headers['set-cookie']);
      cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
      h['Cookie'] = cookieStr;
    }
    
    console.log("Getting resellerUsers.php...");
    const u = await c.get('/resellerUsers.php', { headers: h, maxRedirects: 5 });
    console.log("USERS PAGE CONTAINS export-users.php?", u.data.includes('export-users.php'));
    if (!u.data.includes('export-users.php')) {
        console.log(u.data.substring(0, 1000));
    }
  } catch(e) {
    console.error(e.message);
  }
}
test();
