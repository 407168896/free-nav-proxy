// 免费净值代理 —— 零依赖 Node 函数（Vercel / Netlify 免费版均可部署）
// 完整复用原 CloudBase getNav 的银行官方净值抓取逻辑；
// psbc-wm.com(中邮) 等接口需要老版 TLS 重协商(SSL_OP_LEGACY_SERVER_CONNECT)，已挂上。
// 部署：把本目录推到 Vercel/Netlify 即可，无需 npm install（零依赖）。
// 调用：GET/POST ?bank=中邮理财&code=2101UL0001&date=2026-09-18  或 POST body 同参。
const https = require('https');
const crypto = require('crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/* ---------- 通用 HTTP（带重试） ---------- */
function request(hostname, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers: { 'User-Agent': UA, ...headers } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers || {} }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}
async function requestRetry(hostname, path, method, headers, body, times) {
  let lastErr = null;
  for (let i = 0; i < (times || 3); i++) {
    try {
      const r = await request(hostname, path, method, headers, body);
      if (r.status === 200) return r;
      lastErr = new Error('HTTP ' + r.status);
    } catch (e) { lastErr = e; }
    if (i < (times || 3) - 1) await new Promise(r => setTimeout(r, 400 * (i + 1)));
  }
  throw lastErr || new Error('request failed');
}
function parseJson(txt) { try { return JSON.parse(txt); } catch (e) { return null; } }
function normNav(v) { const n = parseFloat(v); return (n === n) ? String(n) : String(v); }
function fmtDate(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const m2 = String(s).match(/^(\d{4})[-\/](\d{2})[-\/](\d{2})/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  return String(s).slice(0, 10);
}

/* ---------- 中银理财（含历史净值） ---------- */
async function bocNav(code, date) {
  const q = `?productCode=${encodeURIComponent(code)}&pageNo=1&pageSize=200`;
  const r = await requestRetry('www.bocwm.cn', '/webApi/cms/productNetWorth/getNetWorthByCode' + q, 'GET', {
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://www.bocwm.cn/'
  }, null, 3);
  const j = parseJson(r.body);
  if (!j || j.code !== 200) return { ok: false, bank: '中银', error: '中银接口无数据', raw: (r.body || '').slice(0, 200) };
  const list = (j.data || []).filter(x => x.releaseDate).sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
  if (!list.length) return { ok: false, bank: '中银', error: '未找到产品代码 ' + code };
  const latest = list[list.length - 1];
  let pick = latest;
  if (date) {
    const cands = list.filter(x => x.releaseDate <= date);
    if (!cands.length) return { ok: false, bank: '中银', error: `无 ${date} 及之前的净值（最早 ${list[0].releaseDate}）` };
    pick = cands[cands.length - 1];
  }
  const nav = pick.shareNetWorth || pick.netWorth || pick.cumulativeNetWorth;
  if (!nav) return { ok: false, bank: '中银', error: '该产品暂无单位净值', name: pick.productName };
  const nameRec = [...list].reverse().find(x => x.productName) || pick;
  return {
    ok: true, bank: '中银', source: 'bocwm.cn',
    code, name: nameRec.productName, productType: pick.productType || nameRec.productType,
    nav: normNav(nav), cumNav: pick.cumulativeNetWorth ? normNav(pick.cumulativeNetWorth) : '',
    navDate: fmtDate(pick.releaseDate),
    latestNav: normNav(latest.shareNetWorth || nav), latestNavDate: fmtDate(latest.releaseDate),
    isHistory: pick.releaseDate !== latest.releaseDate,
    historyFrom: fmtDate(list[0].releaseDate), historyTo: fmtDate(latest.releaseDate)
  };
}

/* ---------- 交银理财（仅最新净值） ---------- */
async function commNavCall(fundcode) {
  const msg = JSON.stringify({
    REQ_HEAD: { TRAN_PROCESS: '', TRAN_ID: '' },
    REQ_BODY: { c_fundcode: fundcode || '', c_productcode: '' }
  });
  const body = encodeURI('REQ_MESSAGE=' + msg);
  const r = await requestRetry('www.bocommwm.com', '/SITE/queryJylcProductDetail.do', 'POST', {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': 'https://www.bocommwm.com/BankCommSite/jylc/cn/ProductDetails.html'
  }, body, 2);
  const j = parseJson(r.body);
  return (j && j.RSP_BODY && j.RSP_BODY.result && j.RSP_BODY.result.jylcProductBo) ? j.RSP_BODY.result.jylcProductBo : null;
}
async function commNav(code, date) {
  if (!/^\d{6,10}$/.test(code)) {
    return { ok: false, bank: '交银', error: '交银接口仅支持 6–10 位数字 fundcode，请核对产品代码（非 fundcode 请改用对应银行或手动录入）' };
  }
  const bo = await commNavCall(code);
  if (!bo) return { ok: false, bank: '交银', error: '交银接口无数据（该数字未匹配到产品）。交银接口仅认 fundcode（5811 开头的 6–10 位数字），你填的可能是产品代码/登记编码；请在交银 APP/官网产品页复制 fundcode 后重试。' };
  if (!bo.f_netvalue) return { ok: false, bank: '交银', error: '该产品暂无单位净值', name: bo.c_fundname };
  const navDate = fmtDate(bo.d_cdate || bo.d_date);
  const res = {
    ok: true, bank: '交银', source: 'bocommwm.com',
    code, name: bo.c_fundname, regCode: bo.c_productcode || '',
    nav: normNav(bo.f_netvalue), navDate,
    level: bo.c_level || '', investType: bo.investtype || ''
  };
  if (date && navDate > date) { res.approx = true; res.warn = '交银官网不提供历史净值，已返回最新净值，请核对买入净值'; }
  return res;
}

/* ================= 银行官方手机银行 APP 接口（T-1 最新，优先于官网） ================= */
const BOC_APP_HOST = 'ebsnew.boc.cn';
const COMM_APP_HOST = 'mbank.95559.com.cn';
const COMM_APP_SERV = 'MOBS.MOBS-PRODUCTSRV.V-1.0';

function httpsReq(hostname, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const r = https.request({ hostname, path, method: method || 'GET', headers: headers || {}, timeout: 20000,
      agent: new https.Agent({ secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT }) }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout')));
    if (body) r.write(body);
    r.end();
  });
}

/* ---------- 中国银行手机银行 APP ---------- */
async function bocAppNav(productId, date) {
  const payload = {
    header: { agent: 'WEB15', version: '3.1.9', device: 'WEB15', platform: 'WEB15', plugins: '5', page: '6',
      local: 'zh_CN', uuid: String(Date.now()) + String(Math.floor(Math.random() * 100000)), ext: '8', cipherType: '0', appSequence: '' },
    method: 'PsnxWmpHistoryNavQueryOutlay',
    params: { productId, subChannelId: '31', circle: '3Y' }
  };
  const rnd = Math.floor(Math.random() * 90000) + 1000;
  const r = await httpsReq(BOC_APP_HOST, `/BMPS/_bfwajax.do?rnd=${rnd}&_locale=zh_CN`, 'POST', {
    'Accept': 'application/json', 'Accept-Language': 'zh-CN,zh;q=0.9',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Referer': 'https://ebsnew.boc.cn/bocphone/VueLocalCli4/bocFinanceDetail/index.html',
    'User-Agent': UA, 'bfw-ctrl': 'json'
  }, 'json=' + encodeURIComponent(JSON.stringify(payload)));
  const j = parseJson(r.body);
  const list = (j && j.result && j.result.list) || [];
  if (!list.length) return { ok: false, bank: '中行APP', error: '中国银行手机银行无该产品净值' };
  const norm = list.map(x => ({ d: String(x.updateDate || '').replace(/\//g, '-'), nav: x.nav, cum: x.accumulativeNav }))
    .filter(x => x.d && x.nav).sort((a, b) => a.d.localeCompare(b.d));
  if (!norm.length) return { ok: false, bank: '中行APP', error: '中行APP 净值格式异常' };
  const latest = norm[norm.length - 1];
  const { pick, earlyWarn } = pickFromHistory(norm, date);
  const res = {
    ok: true, bank: '中行APP', source: 'ebsnew.boc.cn(中国银行手机银行)', code: productId,
    nav: normNav(pick.nav), cumNav: pick.cum ? normNav(pick.cum) : '', navDate: pick.d,
    latestNav: normNav(latest.nav), latestNavDate: latest.d,
    isHistory: pick.d !== latest.d, historyFrom: norm[0].d, historyTo: latest.d
  };
  if (earlyWarn) res.warn = earlyWarn;
  return res;
}

/* ---------- 交通银行手机银行 APP ---------- */
async function commAppCall(processCode, productNo, registerCode) {
  const qs = `?productNo=${encodeURIComponent(productNo)}&registerCode=${encodeURIComponent(registerCode || '')}` +
    `&category=01&isNewJump=true&processCode=${processCode}&servNm=${encodeURIComponent(COMM_APP_SERV)}`;
  const r = await httpsReq(COMM_APP_HOST, `/mobs6/MobileBank//${COMM_APP_SERV}/${processCode}.ajax${qs}`, 'GET', {
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Service-Owner': 'MOBS8',
    'Referer': 'https://mbank.95559.com.cn/mobs6/wm/WM1/NWM1001.html',
    'User-Agent': UA
  });
  return parseJson(r.body);
}
async function commAppNav(productNo, registerCode, date) {
  let rc = registerCode;
  if (!rc) {
    if (/^EW/i.test(productNo)) rc = 'EW';
    else if (/^\d{10}$/.test(productNo)) rc = (/^(5811|5813|0891)/.test(productNo) ? 'JY' : '66');
    else rc = 'JY';
  }
  const j4 = await commAppCall('PRDAFD0004', productNo, rc);
  const cl = (j4 && j4.RSP_BODY && j4.RSP_BODY.chartList) || [];
  const navChart = cl.find(c => c && /单位净值/.test(c.name || '')) || cl[0];
  const data = (navChart && navChart.data) || [];
  if (!data.length) return { ok: false, bank: '交行APP', error: '交通银行手机银行无该产品净值' };
  const norm = data.map(x => ({ d: String(x.time || '').replace(/\//g, '-'), nav: x.value }))
    .filter(x => x.d && x.nav).sort((a, b) => a.d.localeCompare(b.d));
  if (!norm.length) return { ok: false, bank: '交行APP', error: '交行APP 净值格式异常' };
  const latest = norm[norm.length - 1];
  const { pick, earlyWarn } = pickFromHistory(norm, date);
  let name = '';
  try { const j7 = await commAppCall('PRDAFD0007', productNo, rc); name = (j7 && j7.RSP_BODY && j7.RSP_BODY.baseInfo && j7.RSP_BODY.baseInfo.prdName) || ''; } catch (e) {}
  const res = {
    ok: true, bank: '交行APP', source: 'mbank.95559.com.cn(交通银行手机银行)', code: productNo,
    name, registerCode: rc,
    nav: normNav(pick.nav), navDate: pick.d,
    latestNav: normNav(latest.nav), latestNavDate: latest.d,
    isHistory: pick.d !== latest.d, historyFrom: norm[0].d, historyTo: latest.d
  };
  if (earlyWarn) res.warn = earlyWarn;
  return res;
}

// 多个来源取「净值日期最新」的那个
function pickFreshest(list) {
  const ok = list.filter(r => r && r.ok);
  if (!ok.length) return list[list.length - 1];
  return ok.sort((a, b) => String(b.navDate || '').localeCompare(String(a.navDate || '')))[0];
}

// 在历史序列里取 ≤date 的最近一期
function pickFromHistory(norm, date) {
  const latest = norm[norm.length - 1];
  if (!date) return { pick: latest, earlyWarn: '' };
  const c = norm.filter(x => x.d <= date);
  if (c.length) return { pick: c[c.length - 1], earlyWarn: '' };
  return { pick: norm[0], earlyWarn: `查询日期 ${date} 早于该渠道最早净值 ${norm[0].d}（手机银行曲线一般仅保留约3个月），已返回最早一期；精确买入净值请按购买确认单手动填写。` };
}

/* ---------- 北银理财官网 bylc-api ---------- */
async function bylcNav(prodCode, date) {
  const H = {
    'Accept': 'application/json,*/*', 'Accept-Encoding': 'identity',
    'Referer': 'https://www.beijingbobwealth.com.cn/products_index/index.html'
  };
  const r = await httpsReq('www.beijingbobwealth.com.cn',
    `/bylc-api/product/info?PROD_CODE=${encodeURIComponent(prodCode)}&noCache=` + Date.now(), 'GET', H);
  const p = (parseJson(r.body) || {}).data || {};
  const nl = await httpsReq('www.beijingbobwealth.com.cn',
    `/bylc-api/product/navlist?PROD_CODE=${encodeURIComponent(prodCode)}&pageSize=2000&pageNumber=1&noCache=` + Date.now(), 'GET', H);
  const nj = parseJson(nl.body) || {};
  const raw = ((nj.data || {}).list) || [];
  const norm = raw.map(x => ({ d: fmtDate(x.NAV_DATE), nav: x.NAV, cum: x.ACCUMULATIVE_NAV }))
    .filter(x => x.d && x.nav !== null && x.nav !== undefined).sort((a, b) => a.d.localeCompare(b.d));
  if (!norm.length && !p.NAV) return { ok: false, bank: '北银理财', error: '北银理财官网无该产品代码的净值' };
  const latest = norm.length ? norm[norm.length - 1]
    : { d: fmtDate(p.NAV_DATE), nav: p.NAV, cum: p.ACCUMULATIVE_NAV };
  let pick = latest, earlyWarn = '';
  if (date && norm.length) { const ph = pickFromHistory(norm, date); pick = ph.pick; earlyWarn = ph.earlyWarn; }
  const res = {
    ok: true, bank: '北银理财', source: 'beijingbobwealth.com.cn(北银理财官网)', code: prodCode,
    name: p.PROD_NAME || '', nav: normNav(pick.nav), cumNav: pick.cum ? normNav(pick.cum) : '', navDate: pick.d,
    latestNav: normNav(latest.nav), latestNavDate: latest.d,
    isHistory: pick.d !== latest.d, historyFrom: norm.length ? norm[0].d : '', historyTo: latest.d
  };
  if (earlyWarn) res.warn = earlyWarn;
  return res;
}

/* ---------- 中银：按产品名称搜索 ---------- */
async function bocSearch(keyword, pageNo, pageSize) {
  const body = JSON.stringify({ productKeyword: keyword, pageNo: pageNo || 1, pageSize: pageSize || 20 });
  const r = await requestRetry('www.bocwm.cn', '/webApi/cms/product/queryStaticProducts', 'POST', {
    'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://www.bocwm.cn', 'Referer': 'https://www.bocwm.cn/'
  }, body, 3);
  const j = parseJson(r.body);
  if (!j || j.code !== 200 || !j.data) return { ok: false, bank: '中银', error: '中银产品搜索失败', raw: (r.body || '').slice(0, 200) };
  const rows = j.data.rows || j.data.list || j.data.records || [];
  const top = rows.slice(0, 10);
  const navRes = await Promise.all(top.map(async x => {
    try { const n = await bocNav(x.productCode, ''); return n && n.ok ? { nav: n.nav, navDate: n.navDate } : null; }
    catch (e) { return null; }
  }));
  const head = top.map((x, i) => ({
    code: x.productCode, name: x.productName,
    nav: navRes[i] ? navRes[i].nav : '', navDate: navRes[i] ? navRes[i].navDate : '',
    hasNav: !!navRes[i], riskLevel: x.riskLevel || '', productType: x.productTypeName || x.style || ''
  }));
  const tail = rows.slice(10).map(x => ({
    code: x.productCode, name: x.productName, nav: '', navDate: '', hasNav: false,
    riskLevel: x.riskLevel || '', productType: x.productTypeName || x.style || ''
  }));
  const list = head.concat(tail).sort((a, b) => (b.hasNav ? 1 : 0) - (a.hasNav ? 1 : 0));
  return { ok: true, bank: '中银', source: 'bocwm.cn', keyword, total: j.data.total || rows.length, list };
}

/* ---------- 交银理财：本地名称索引 ---------- */
let _commIndex = null;
function commIndex() {
  if (_commIndex) return _commIndex;
  try { _commIndex = require('./comm_index.json'); } catch (e) { _commIndex = []; }
  return _commIndex;
}
async function commSearch(keyword) {
  const kw = (keyword || '').trim();
  const idx = commIndex();
  const list = idx
    .filter(x => x.name && x.name.includes(kw))
    .map(x => ({
      code: x.code, name: x.name, nav: x.nav || '', navDate: x.navDate || '',
      hasNav: !!(x.nav && x.nav !== '0'), riskLevel: '', productType: ''
    }));
  return { ok: true, bank: '交银', source: 'bocommwm.com(本地索引)', keyword: kw, total: list.length, list };
}

/* ---------- 宁银理财 / 宁波银行 ---------- */
async function nbNav(code) {
  return { ok: false, bank: '宁波银行', needManual: true, error: '宁银理财官网拒绝服务端请求(403)，请手动填写净值' };
}

/* ---------- 光大理财 / 宁波银行：官方披露页被反爬墙拦截 ---------- */
const CEB_DISCLOSE_URL = 'https://www.cebwm.com/';

/* ---------- 上海银行理财官网（服务端渲染净值表格） ---------- */
async function shBankNav(code, date) {
  if (date) {
    return { ok: false, bank: '上银理财', needManual: true, historyUnsupported: true, code,
      error: '上海银行官网仅公布最新净值，无法按买入日取历史净值；已按 1.0000 计份额，请手动填写买入净值，之后每日最新净值会自动更新。' };
  }
  const shGet = (hostname, p) => new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path: p, method: 'GET', rejectUnauthorized: false,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Referer': 'https://www.bosc.cn/zh/dtjr/grlc/jzx' }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers || {} })); });
    req.on('error', reject); req.setTimeout(20000, () => req.destroy(new Error('timeout'))); req.end();
  });
  let host = 'www.bosc.cn', path = '/zh/dtjr/grlc/jzx', r = null;
  for (let hop = 0; hop < 4; hop++) {
    r = await shGet(host, path).catch(e => ({ error: e.message }));
    if (r.error) break;
    if (r.status >= 300 && r.status < 400 && r.headers && r.headers.location) {
      const u = new URL(r.headers.location, 'https://' + host);
      host = u.hostname; path = u.pathname + u.search; continue;
    }
    break;
  }
  if (r.error || !r.body) return { ok: false, bank: '上银理财', needManual: true, code, error: '上海银行官网无法访问：' + ((r && r.error) || '空响应') };
  const html = r.body;
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const codeUp = String(code).toUpperCase();
  let hit = null;
  for (const tr of rows) { if (tr.toUpperCase().includes(codeUp)) { hit = tr; break; } }
  if (!hit) return { ok: false, bank: '上银理财', needManual: true, code, error: '上海银行净值表中未找到产品代码 ' + code + '（html长度=' + html.length + '，含WPXK=' + html.includes('WPXK') + '，tr行数=' + rows.length + '）' };
  const cells = (hit.match(/<t[dh][\s\S]*?>([\s\S]*?)<\/t[dh]>/gi) || [])
    .map(td => td.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
  const texts = cells.length ? cells : [hit.replace(/<[^>]+>/g, ' ')];
  const navs = [];
  for (const t of texts) { const m = t.match(/(\d+\.\d{2,})/g); if (m) for (const x of m) navs.push(x); }
  const nav = navs[0]; const cum = navs[1] || '';
  let navDate = '';
  for (const t of texts) {
    const dm = t.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/) || t.match(/(\d{4})(\d{2})(\d{2})/);
    if (dm) {
      if (dm[1].length === 4) navDate = `${dm[1]}-${String(dm[2]).padStart(2, '0')}-${String(dm[3]).padStart(2, '0')}`;
      else navDate = dm[0];
      break;
    }
  }
  let name = '';
  for (const t of texts) { if (/[一-龥]/.test(t) && !/^\d/.test(t)) { name = t; break; } }
  if (!nav) return { ok: false, bank: '上银理财', needManual: true, code, error: '上海银行净值表解析单位净值失败（页面结构可能已变更）' };
  return {
    ok: true, bank: '上银理财', source: 'bankofshanghai.sh.cn', code,
    name, nav: normNav(nav), cumNav: cum ? normNav(cum) : '', navDate: fmtDate(navDate),
    latestNav: normNav(nav), latestNavDate: fmtDate(navDate)
  };
}

/* ---------- 中国理财网（监管统一信披平台）登记编码兜底 ----------
   2026-09-01 上线新平台已启用反爬 + 验证码 + 会话令牌，服务端无法直连自动取净值，
   统一降级为「手动录入」。 */
async function cwSolrNav(regCode, date) {
  if (date) {
    return { ok: false, bank: '中国理财网', needManual: true, historyUnsupported: true, regCode,
      error: '中国理财网仅披露最新净值（无历史序列），无法按买入日取历史净值；请手动填写买入净值，之后每日最新净值会自动更新。' };
  }
  return { ok: false, bank: '中国理财网', needManual: true, regCode,
    error: '中国理财网（信息披露平台）已启用反爬/验证码，服务端无法自动取净值。请到产品页查看最新单位净值后，用「手动录入」按钮填写；已为您记录登记编码 ' + (regCode || '') + ' 备用。' };
}

/* ---------- 中邮理财 / 邮储（官网公开 JSON 接口，脱离 WAF） ----------
   GET /pswm-api/product/nvlist?wp_code=<产品代码>&pageSize=N&pageNum=1
   返回 {state:"ok", data:{list:[{update_date, nav, accumulative_nav, wp_name, wp_code}]}}
   注意：nginx 要求旧版 TLS 重协商，httpsReq 已挂 SSL_OP_LEGACY_SERVER_CONNECT。 */
async function psbcNav(wpCode, date) {
  if (!wpCode) return { ok: false, bank: '中邮理财', needManual: true, error: '缺少产品代码(wp_code)，无法查询中邮理财净值' };
  const H = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Referer': 'https://www.psbc-wm.com/',
    'User-Agent': UA
  };
  const r = await httpsReq('www.psbc-wm.com',
    `/pswm-api/product/nvlist?wp_code=${encodeURIComponent(wpCode)}&pageSize=30&pageNum=1`, 'GET', H);
  const j = parseJson(r.body);
  if (!j || j.state !== 'ok') return { ok: false, bank: '中邮理财', needManual: true, code: wpCode,
    error: '中邮理财接口返回异常(state=' + ((j && j.state) || '空') + ')，请稍后重试或到产品页查看后手动录入。' };
  const raw = (j.data && j.data.list) || [];
  const norm = raw.map(x => ({ d: fmtDate(x.update_date), nav: x.nav, cum: x.accumulative_nav }))
    .filter(x => x.d && x.nav !== null && x.nav !== undefined)
    .sort((a, b) => a.d.localeCompare(b.d));
  if (!norm.length) return { ok: false, bank: '中邮理财', needManual: true, code: wpCode,
    error: '中邮理财接口未返回产品代码 ' + wpCode + ' 的净值，请确认产品代码正确（应为 wp_code，如 2101UL0001）。' };
  const latest = norm[norm.length - 1];
  const { pick, earlyWarn } = pickFromHistory(norm, date);
  const res = {
    ok: true, bank: '中邮理财', source: 'psbc-wm.com(中邮理财官网)', code: wpCode,
    name: (raw[0] && raw[0].wp_name) || '',
    nav: normNav(pick.nav), cumNav: pick.cum ? normNav(pick.cum) : '', navDate: pick.d,
    latestNav: normNav(latest.nav), latestNavDate: latest.d,
    isHistory: pick.d !== latest.d, historyFrom: norm[0].d, historyTo: latest.d
  };
  if (earlyWarn) res.warn = earlyWarn;
  return res;
}

/* ---------- event 解析 ---------- */
function parseEvent(event) {
  let e = event;
  if (typeof e === 'string') { const t = e.trim(); try { e = JSON.parse(t); } catch (_) { e = { _raw: t }; } }
  if (!e || typeof e !== 'object') e = {};
  const isHttp = !!(e.httpMethod || e.queryStringParameters || e.requestContext || e.path || (e.headers && e.body !== undefined));
  let data = {};
  if (isHttp) {
    let body = e.body;
    if (body) {
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
      if (body && typeof body === 'object') data = Object.assign(data, body);
    }
    if (e.queryStringParameters && typeof e.queryStringParameters === 'object') data = Object.assign(data, e.queryStringParameters);
    data.__httpMethod = e.httpMethod || 'POST';
  } else {
    data = e;
  }
  return { data, isHttp };
}

async function handle(data) {
  const bank = (data.bank || '').trim();
  const code = (data.code || '').trim();
  const date = (data.date || '').trim();
  const regCode = (data.regCode || '').trim();
  const registerCode = (data.registerCode || '').trim();
  const keyword = (data.keyword || data.prodName || '').trim();

  if (keyword && !code) {
    if (/中银|中国银行/.test(bank)) return await bocSearch(keyword, Number(data.pageNo) || 1, Number(data.pageSize) || 20);
    if (/交银|交通银行/.test(bank)) return await commSearch(keyword);
    if (/宁波|宁银/.test(bank)) return { ok: false, bank: '宁波银行', error: '宁波银行官网拒绝程序访问，请填写产品代码或手动录入净值' };
    const [boc, comm] = await Promise.all([
      bocSearch(keyword, 1, 20).catch(() => ({ ok: true, list: [] })),
      commSearch(keyword).catch(() => ({ ok: true, list: [] }))
    ]);
    const list = (boc.list || []).concat(comm.list || []);
    if (!list.length) return { ok: false, error: '中银/交银均未找到匹配，请确认产品名称或所属银行' };
    return { ok: true, bank: '全部', source: '合并搜索', keyword, total: list.length, list };
  }
  if (regCode && !code) {
    return await cwSolrNav(regCode, date);
  }
  if (!code) return { ok: false, error: 'missing code or keyword' };

  if (/中银|中国银行/.test(bank)) {
    const app = await bocAppNav(code, date).catch(e => ({ ok: false, error: e.message }));
    if (app && app.ok) return addLagNote(app);
    return addLagNote(await bocNav(code, date));
  }
  if (/交银|交通银行/.test(bank)) {
    const app = await commAppNav(code, registerCode || 'JY', date).catch(e => ({ ok: false, error: e.message }));
    if (app && app.ok) return addLagNote(app);
    return addLagNote(await commNav(code, date));
  }
  if (/光大|光银|阳光/.test(bank)) {
    const [a, b] = await Promise.all([
      bocAppNav(code, date).catch(() => ({ ok: false })),
      commAppNav(code, registerCode, date).catch(() => ({ ok: false }))
    ]);
    const best = pickFreshest([a, b]);
    if (best && best.ok) return addLagNote(best);
    return { ok: false, bank: '光大理财', needManual: true, code, discloseUrl: CEB_DISCLOSE_URL,
      error: '中行/交行手机银行均未查到该产品净值，请确认产品号与代销行；或到光大官网「信息披露>净值公告」查看后手动录入。' };
  }
  if (/浦银|浦发/.test(bank)) {
    const r = await commAppNav(code, registerCode || '66', date).catch(e => ({ ok: false, error: e.message }));
    if (r && r.ok) return addLagNote(r);
    return { ok: false, bank: '浦银理财', needManual: true, code,
      discloseUrl: 'https://www.spdb-wm.com/',
      error: '交行手机银行未查到该浦银产品净值，请确认产品号（销售代码）；或提供 APP 分享链接中的 registerCode。' };
  }
  if (/宁波|宁银/.test(bank)) {
    const [a, b] = await Promise.all([
      bocAppNav(code, date).catch(() => ({ ok: false })),
      commAppNav(code, registerCode, date).catch(() => ({ ok: false }))
    ]);
    const best = pickFreshest([a, b]);
    if (best && best.ok) return addLagNote(best);
    return { ok: false, bank: '宁波银行', needManual: true, code,
      discloseUrl: 'https://aapw.nbcb.com.cn/mobilebank/page/vueArea/financeNew/vVueFinanceNew/finance.html',
      error: '宁波银行手机银行接口请求体为密文，服务端无法直调。请用本地浏览器 relay 抓取，或在宁波银行APP产品页查看后手动录入。' };
  }
  if (/北银|北京银行/.test(bank)) {
    const cands = [code];
    if (/[0-9]$/.test(code)) cands.push(code + 'A');
    for (const c of cands) {
      const r = await bylcNav(c, date).catch(() => ({ ok: false }));
      if (r.ok) return addLagNote(r);
    }
    return { ok: false, bank: '北银理财', needManual: true, code,
      discloseUrl: 'https://www.beijingbobwealth.com.cn/',
      error: '北银理财官网无该产品代码的净值。产品代码形如 YJ01251204A（可带份额后缀 A/B）。' };
  }
  if (/微众|webank/i.test(bank)) {
    const cands = [code];
    if (/[0-9]$/.test(code)) cands.push(code + 'A');
    for (const c of cands) {
      const r = await bylcNav(c, date).catch(() => ({ ok: false }));
      if (r.ok) return addLagNote(r);
    }
    const [a, b] = await Promise.all([
      commAppNav(code, registerCode || '66', date).catch(() => ({ ok: false })),
      bocAppNav(code, date).catch(() => ({ ok: false }))
    ]);
    const best = pickFreshest([a, b]);
    if (best && best.ok) return addLagNote(best);
    return { ok: false, bank: '微众银行', needManual: true, code,
      error: '微众为代销平台，已试北银官网(含A份额)/交行APP/中行APP 均无此代码。请提供底层发行机构与真实产品代码。' };
  }
  if (/上银|上海银行/.test(bank)) {
    return { ok: false, bank: '上银理财', needManual: true, code,
      error: '上海银行官网为单页应用（净值由前端加载），服务端无法直连抓取。请到银行APP/官网产品详情页查看最新单位净值，用「手动录入」按钮填写。', discloseUrl: 'https://www.bosc.cn/zh/dtjr/grlc/jzx' };
  }
  if (/中邮|邮政|邮储/.test(bank)) {
    const r = await psbcNav(code, date).catch(e => ({ ok: false, needManual: true, error: e.message }));
    if (r && r.ok) return addLagNote(r);
    return { ok: false, bank: '中邮理财', needManual: true, code, regCode,
      error: (r && r.error) || '中邮理财接口未返回净值，请确认产品代码(wp_code)正确，或到产品页查看后手动录入。' };
  }
  const tries = [];
  if (/^[A-Za-z]/.test(code)) tries.push(bocAppNav(code, date).catch(() => ({ ok: false })));
  if (/^EW/i.test(code) || /^\d{6,12}$/.test(code)) tries.push(commAppNav(code, registerCode, date).catch(() => ({ ok: false })));
  if (/^\d{6,10}$/.test(code)) tries.push(commNav(code, date).catch(() => ({ ok: false })));
  if (/^[A-Za-z]/.test(code)) tries.push(bocNav(code, date).catch(() => ({ ok: false })));
  if (tries.length) {
    const rs = await Promise.all(tries);
    const best = pickFreshest(rs);
    if (best && best.ok) return addLagNote(best);
  }
  if (regCode) {
    const r = await cwSolrNav(regCode, date).catch(() => ({ ok: false }));
    if (r && r.ok) return addLagNote(r);
  }
  return { ok: false, error: '无法识别银行或该产品在各官方渠道均无数据，请填写所属银行。交银需 6–10 位数字 fundcode；光大/浦银可用 APP 分享链接里的产品号；上银/中邮/邮储等小银行请到产品页查看最新净值后用「手动录入」填写。' };
}

function addLagNote(res) {
  if (!res || !res.ok) return res;
  const d = res.navDate || res.latestNavDate || '';
  const dm = (d || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dm) return res;
  const navT = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3])).getTime();
  const days = Math.floor((Date.now() - navT) / 86400000);
  if (days > 2) {
    res.dataLagNote = `该银行官方披露页最新净值仅更新至 ${d}（距今约 ${days} 天），属银行披露滞后，非数据错误；银行更新后下次查询会自动取到更新值。`;
  }
  return res;
}

/* ---------- 运行入口（Vercel / Netlify 双兼容） ---------- */
async function run(data, method) {
  try {
    if (/OPTIONS/i.test(method || '')) return { _cors: true };
    return await handle(data);
  } catch (e) {
    return { ok: false, error: e.message, stack: (e.stack || '').slice(0, 300) };
  }
}
function jsonResponse(result) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    },
    body: JSON.stringify(result)
  };
}

/* ---------- Vercel 入口：module.exports(req, res) ---------- */
async function vercelHandler(req, res) {
  const method = (req.method || 'POST').toUpperCase();
  let body = '';
  await new Promise(r => { req.on('data', c => body += c); req.on('end', r); });
  const data = {};
  if (body) { try { const bb = JSON.parse(body); if (bb && typeof bb === 'object') Object.assign(data, bb); } catch (_) {} }
  try { const u = new URL(req.url, 'http://localhost'); for (const [k, v] of u.searchParams) data[k] = v; } catch (_) {}
  const result = await run(data, method);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.statusCode = 200;
  res.end(JSON.stringify(result));
}

/* ---------- Netlify 入口：module.exports.handler(event, context) ---------- */
async function netlifyHandler(event, context) {
  const method = (event.httpMethod || 'POST').toUpperCase();
  const data = {};
  if (event.body) { try { const bb = JSON.parse(event.body); if (bb && typeof bb === 'object') Object.assign(data, bb); } catch (_) {} }
  if (event.queryStringParameters && typeof event.queryStringParameters === 'object') Object.assign(data, event.queryStringParameters);
  return jsonResponse(await run(data, method));
}

module.exports = vercelHandler;           // Vercel Functions 调用点
module.exports.handler = netlifyHandler; // Netlify Functions 调用点
module.exports.handle = handle;          // 本地测试用

/* ---------- 本地直接运行：起一个 HTTP 服务方便自测 ---------- */
if (require.main === module) {
  const port = process.env.PORT || 3000;
  require('http').createServer((req, res) => { module.exports(req, res); })
    .listen(port, () => console.log('[nav-proxy] local server on http://localhost:' + port));
}
