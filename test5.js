const axios = require('axios');
const https = require('https');

function dataTableForm(start, length) {
  const form = new URLSearchParams({
    draw: String(Math.floor(start / length) + 1),
    start: String(start),
    length: String(length),
    "search[value]": "",
    "search[regex]": "false",
    "order[0][column]": "3",
    "order[0][dir]": "asc",
  });
  for (let index = 0; index < 35; index += 1) {
    form.set(`columns[${index}][data]`, String(index));
    form.set(`columns[${index}][name]`, "");
    form.set(`columns[${index}][searchable]`, "true");
    form.set(`columns[${index}][orderable]`, "true");
    form.set(`columns[${index}][search][value]`, "");
    form.set(`columns[${index}][search][regex]`, "false");
  }
  form.set("columns[3][data]", "username");
  return form;
}

async function debug() {
  try {
    const username = process.env.MYISP_1_USERNAME.trim();
    const password = process.env.MYISP_1_PASSWORD.trim();
    const baseUrl = 'https://pi.myisp.live';
    const client = axios.create({ baseURL: baseUrl, httpsAgent: new https.Agent({ keepAlive: false }) });
    
    // Login manually
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
    
    await client.post('/checklogin.php', form.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookieStr, 'X-Requested-With': 'XMLHttpRequest' } });
    const p2 = await client.post('/login.php', form.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookieStr }, maxRedirects: 0, validateStatus: () => true });
    
    if (p2.headers['set-cookie']) {
      cookies = cookies.concat(p2.headers['set-cookie']);
      cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
    }
    
    const usersPage = await client.get('/resellerUsers.php', { headers: { 'Cookie': cookieStr } });
    const pageCsrfMatch = usersPage.data.match(/<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)/i);
    const pageCsrf = pageCsrfMatch ? pageCsrfMatch[1] : csrf;
    
    // FETCH PROVIDER MAC MAP (simulated)
    const macRes = await client.post('/admingetresellerusers.php', dataTableForm(0, 500).toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "X-CSRF-Token": pageCsrf,
        "Origin": baseUrl,
        "Referer": `${baseUrl}/resellerUsers.php`,
        "Cookie": cookieStr
      }
    });
    console.log("MAC fetch status:", macRes.status);
    if (macRes.headers['set-cookie']) {
      console.log("MAC fetch returned cookies:", macRes.headers['set-cookie']);
      cookies = cookies.concat(macRes.headers['set-cookie']);
      cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
    }
    
    // Extract resellerId (copied from myispInvoiceService)
    function extractResellerId(html) {
      const normalized = html.replace(/&amp;/gi, '&');
      const match = /export-users\.php\?[^"'<>]*\bresellerId=([^&"'<>]+)/i.exec(normalized);
      if (!match?.[1]) return null;
      try { return decodeURIComponent(match[1]).trim() || null; } catch { return match[1].trim() || null; }
    }
    const resellerId = extractResellerId(usersPage.data);
    
    // Test export
    const exportResponse = await client.get('/export-users.php', {
      params: { resellerId },
      headers: { 'Cookie': cookieStr },
      maxRedirects: 0,
      validateStatus: () => true
    });
    
    console.log("Export status:", exportResponse.status);
    console.log("Export content-type:", exportResponse.headers['content-type']);
    if (exportResponse.status >= 300) {
      console.log("Export location:", exportResponse.headers.location);
    }
    
  } catch(e) {
    console.error("ERR", e.message);
  }
}
debug();
