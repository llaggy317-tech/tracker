/**
 * CII Logistics Platform - Backend Core Server & Tracking Engine
 */
const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { spawn } = require('child_process');
const { generateTrackingPdf } = require('./pdf_export');
const { mySpeedPostClient } = require('./myspeedpost_client');
const { speedPostLiveClient } = require('./speedpostlive_client');

const app = express();
const PORT = process.env.PORT || 3001;
const OCR_PORT = 3002;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));


// ─── Launch Local Python OCR Solver ─────────────────────────────────────────
let ocrProcess = null;
function startOcrServer() {
  const ocrScript = path.join(__dirname, 'ocr_server.py');
  const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
  try {
    ocrProcess = spawn(pyCmd, [ocrScript], { stdio: 'inherit' });
    ocrProcess.on('error', (err) => {
      try {
        const fallbackCmd = pyCmd === 'python3' ? 'python' : 'python3';
        ocrProcess = spawn(fallbackCmd, [ocrScript], { stdio: 'inherit' });
      } catch (e) {
        console.warn('⚠️ Could not launch Python OCR server:', err.message);
      }
    });
  } catch (err) {
    console.warn('⚠️ Could not launch Python OCR server:', err.message);
  }
}
startOcrServer();

process.on('exit', () => { if (ocrProcess) ocrProcess.kill(); });
process.on('SIGINT', () => { if (ocrProcess) ocrProcess.kill(); process.exit(); });

// ─── India Post Next.js Server Action hashes ────────────────────────────────
const TOKEN_ACTION = process.env.TOKEN_ACTION || '00b4f44fd7cd8e5a9d969100904e4880581555ea21';
const TRACK_ACTION = process.env.TRACK_ACTION || '70bc3136e27b6f2d8159c7da34c65ac761901c1b12';
const CAPTCHA_GEN_ACTION = process.env.CAPTCHA_GEN_ACTION || '7f3ab4e2b026889d6719afd3e6916cf5224dcf9fe1';
const CAPTCHA_AUDIO_ACTION = process.env.CAPTCHA_AUDIO_ACTION || '7f3b58085d563af7aec60a32f403a47c1b2160a8ed';
const INDIA_POST_HOST = 'www.indiapost.gov.in';

// ─── CII Access Control & Session Management (5 Exclusive User Keys) ────────
const crypto = require('crypto');
const AUTH_FILE = path.join(__dirname, 'history', 'auth_sessions.json');
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Default pool of 5 exclusive passwords (can also be customized via AUTH_KEYS env var)
const ALLOWED_PASSWORDS = (process.env.AUTH_KEYS
  ? process.env.AUTH_KEYS.split(',').map(s => s.trim()).filter(Boolean)
  : [
      'CII-ALPHA-7821',
      'CII-BRAVO-9430',
      'CII-CHARLIE-5164',
      'CII-DELTA-8295',
      'CII-ECHO-3902'
    ]
);

function loadAuthSessions() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    }
  } catch (_) {}
  return {};
}

function saveAuthSessions(sessions) {
  try {
    const dir = path.dirname(AUTH_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(AUTH_FILE, JSON.stringify(sessions, null, 2), 'utf8');
  } catch (err) {
    console.warn('⚠️ Could not save auth sessions:', err.message);
  }
}

function cleanExpiredSessions(sessions) {
  const now = Date.now();
  let changed = false;
  for (const [token, info] of Object.entries(sessions)) {
    if (!info.expiresAt || info.expiresAt < now) {
      delete sessions[token];
      changed = true;
    }
  }
  if (changed) saveAuthSessions(sessions);
  return sessions;
}

// ─── Helper: raw HTTPS POST ──────────────────────────────────────────────────
function postReq(hostname, path, headers, body, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    let resolved = false;

    const req = https.request(
      {
        hostname,
        port: 443,
        path,
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Content-Type': 'text/plain;charset=UTF-8',
          'Accept': 'text/x-component',
          'next-url': '/',
          'Origin': 'https://www.indiapost.gov.in',
          'Referer': 'https://www.indiapost.gov.in/',
          'Content-Length': Buffer.byteLength(bodyStr),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (!resolved) {
            resolved = true;
            resolve({ status: res.statusCode, body: data });
          }
        });
      }
    );

    req.on('error', (e) => {
      if (!resolved) {
        resolved = true;
        resolve({ status: 0, body: '', error: e.message });
      }
    });

    req.on('timeout', () => {
      req.destroy();
      if (!resolved) {
        resolved = true;
        resolve({ status: 0, body: '', error: 'Request timeout' });
      }
    });

    req.write(bodyStr);
    req.end();
  });
}

// ─── Helper: Solve CAPTCHA via local OCR microservice ───────────────────────
function solveCaptchaLocal(imageBase64) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({ image: imageBase64 });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: OCR_PORT,
        path: '/solve',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout: 4000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json.success ? json.text : null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(postData);
    req.end();
  });
}

// ─── Helper: Auto-fetch and solve a fresh CAPTCHA ───────────────────────────
async function getAutoSolvedCaptcha(maxTries = 4, articleId = '') {
  const prefix = articleId ? `[Track ${articleId}] ` : '[CAPTCHA] ';
  for (let tryNum = 0; tryNum < maxTries; tryNum++) {
    if (tryNum > 0) await new Promise((r) => setTimeout(r, 300));
    const result = await postReq(
      INDIA_POST_HOST,
      '/',
      { 'next-action': CAPTCHA_GEN_ACTION },
      JSON.stringify(["BASE_URL_BACKEND_CAPTCHA", "GET", null, "/captcha_generator?captcha_type=image"]),
      15000
    );

    if (!result || result.status !== 200 || !result.body) {
      console.log(`${prefix}Auto-captcha failed on attempt ${tryNum + 1}`);
      continue;
    }

    const idMatch = result.body.match(/"captcha_id1":"([^"]+)"/);
    let image = null;
    const rscTextMatch = result.body.match(/[0-9a-f]+:T([0-9a-f]+),(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)/);
    if (rscTextMatch) {
      const len = parseInt(rscTextMatch[1], 16);
      image = rscTextMatch[2].slice(0, len);
    } else {
      const imgMatch = result.body.match(/(data:image\/(?:png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+?)(?=[0-9a-f]+:|\n|$)/);
      if (imgMatch) image = imgMatch[1];
    }

    if (!idMatch || !image) {
      console.log(`${prefix}Auto-captcha failed on attempt ${tryNum + 1}`);
      continue;
    }

    const answer = await solveCaptchaLocal(image);
    if (!answer) {
      console.log(`${prefix}Auto-captcha failed on attempt ${tryNum + 1}`);
      continue;
    }

    console.log(`${prefix}Auto-captcha solved: ${answer} (attempt ${tryNum + 1})`);
    return { captchaId: idMatch[1], answer };
  }
  return null;
}

// ─── Parse Next.js RSC response lines ───────────────────────────────────────
function parseRscLine(body) {
  if (!body) return null;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('1:')) {
      try {
        return JSON.parse(trimmed.substring(2));
      } catch (_) { }
    }
  }
  const match = body.match(/1:(\{.*?\})(?:\n|$|[0-9a-f]+:)/s);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch (_) { }
  }
  const dataMatch = body.match(/(\{"data":.*?,"success":.*?,"error":.*?\})/);
  if (dataMatch) {
    try {
      return JSON.parse(dataMatch[1]);
    } catch (_) { }
  }
  return null;
}


// ─── CII Engine: India Post Official API Tracking Pipeline ────────────────────
async function trackViaIndiaPost(articleId, token, captchaId, answer) {
  let curCaptchaId = captchaId;
  let curAnswer = answer;
  let parsed = null;
  let lastResult = null;
  let attempts = 0;
  const maxAttempts = (captchaId && answer) ? 1 : 3;

  while (attempts < maxAttempts) {
    attempts++;
    if (!curCaptchaId || !curAnswer) {
      const auto = await getAutoSolvedCaptcha(4, articleId);
      if (!auto) {
        if (attempts < maxAttempts) {
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }
        break;
      }
      curCaptchaId = auto.captchaId;
      curAnswer = auto.answer;
    }

    console.log(`[Track ${articleId}] Posting track request...`);
    const payload = [token, articleId, { captchaId: curCaptchaId, answer: curAnswer }];
    const result = await postReq(
      INDIA_POST_HOST,
      '/',
      { 'next-action': TRACK_ACTION },
      JSON.stringify(payload),
      18000
    );

    lastResult = result;
    if (!result || result.status !== 200) {
      console.log(`[Track ${articleId}] Track request HTTP ${result?.status || 0} / error: ${result?.error || 'timeout/network'}`);
      curCaptchaId = null;
      curAnswer = null;
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }

    parsed = parseRscLine(result.body);

    // Detect session expired
    if (!parsed) {
      if (result.body && (result.body.includes('session_expired') || result.body.includes('SESSION_EXPIRED'))) {
        console.log(`[Track ${articleId}] Session expired`);
        return {
          success: false,
          articleId,
          http_status: 200,
          api_error: 'session_expired',
          session_expired: true,
        };
      }
      curCaptchaId = null;
      curAnswer = null;
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }

    if (parsed && parsed.success) {
      break;
    }

    if (parsed && (parsed.error === 'captcha_failed' || parsed.error === 'backend_error' || parsed.error === 'captcha_required')) {
      console.log(`[Track ${articleId}] Captcha verification failed (${parsed.error}), retrying...`);
      curCaptchaId = null;
      curAnswer = null;
      await new Promise((r) => setTimeout(r, 350));
      continue;
    }

    break;
  }


  if (!parsed) {
    return {
      success: false,
      articleId,
      http_status: lastResult?.status || 0,
      api_error: 'Could not track article after retries',
    };
  }

  if (typeof parsed === 'string' && parsed.includes('session_expired')) {
    return {
      success: false,
      articleId,
      http_status: 200,
      api_error: 'session_expired',
      session_expired: true,
    };
  }

  if (parsed && typeof parsed === 'object' && parsed.error) {
    return {
      success: false,
      articleId,
      http_status: 200,
      api_error: parsed.error,
      session_expired: JSON.stringify(parsed.error).includes('session_expired'),
    };
  }

  const dataObj = parsed?.data || {};
  const booking = dataObj.booking_details || {};
  const trackingList = dataObj.tracking_details || [];
  const deliveryStatus = dataObj.del_status?.del_status || dataObj.delivery_status || null;

  const STATUS_PRIORITY = {
    'Delivered': 5,
    'Out for Delivery': 4,
    'In Transit': 3,
    'Dispatched': 2,
    'Not Booked': 1,
  };

  function statusFromEventCode(code, eventText) {
    const c = (code || '').toUpperCase();
    const t = (eventText || '').toUpperCase();
    if (c === 'ITEM_DELIVERY' || t.includes('ITEM DELIVERED') || t.includes('DELIVERED(ADDRESSEE)') || t.includes('DELIVERED(AGENT)')) return 'Delivered';
    if (c === 'ITEM_OUT_FOR_DELIVERY' || t.includes('OUT FOR DELIVERY') || t.includes('OUT FOR')) return 'Out for Delivery';
    if (c === 'ITEM_DISPATCH' || t.includes('ITEM DISPATCH') || t.includes('DISPATCHED')) return 'Dispatched';
    if (c === 'ITEM_RECEIVE' || c === 'ITEM_REDIRECTION' || t.includes('ITEM RECEIVED') || t.includes('IN TRANSIT') || t.includes('REACHED')) return 'In Transit';
    if (c === 'ITEM_BOOK' || t.includes('ITEM BOOKED') || t.includes('BOOKED')) return 'Not Booked';
    return null;
  }

  let resolvedStatus = null;
  let maxPriority = 0;

  if (deliveryStatus) {
    const s = deliveryStatus.trim();
    if (STATUS_PRIORITY[s]) {
      resolvedStatus = s;
      maxPriority = STATUS_PRIORITY[s];
    }
  }

  if (Array.isArray(trackingList)) {
    for (const ev of trackingList) {
      const code = ev.event_code || ev.code || '';
      const text = ev.event_description || ev.event_desc || ev.event || ev.description || '';
      const s = statusFromEventCode(code, text);
      if (s && STATUS_PRIORITY[s] > maxPriority) {
        maxPriority = STATUS_PRIORITY[s];
        resolvedStatus = s;
      }
    }
  }

  if (!resolvedStatus) {
    resolvedStatus = 'Not Booked';
  }

  const booking_office_name =
    booking.booking_office_name || dataObj.booking_office_name || dataObj.booking_office || null;
  const booking_pin =
    booking.booking_pin || dataObj.booking_pin || dataObj.booking_pincode || null;
  const destination_office_name =
    booking.destination_office_name || dataObj.destination_office_name || dataObj.destination_office || null;
  const destination_pincode =
    booking.destination_pincode || dataObj.destination_pincode || dataObj.destination_pin || null;

  return {
    success: true,
    articleId,
    http_status: 200,
    delivery_status: resolvedStatus,
    delivery_location: destination_office_name || destination_pincode ? `${destination_office_name || ''} (${destination_pincode || ''})`.trim() : null,
    delivery_date: trackingList.find(t => (t.event_code || '').toUpperCase() === 'ITEM_DELIVERY')?.event_date || null,
    delivery_time: trackingList.find(t => (t.event_code || '').toUpperCase() === 'ITEM_DELIVERY')?.event_time || null,
    article_number: booking.article_number || dataObj.article_number || null,
    article_type: booking.article_type || dataObj.article_type || null,
    booking_date: booking.booking_date || dataObj.booking_date || null,
    booking_office_name,
    booking_pin,
    destination_office_name,
    destination_pincode,
    tariff: booking.tariff || dataObj.tariff || null,
    event_count: trackingList.length,
    delivery_confirmed_to: booking.delivery_confirmed_to || dataObj.delivery_confirmed_to || null,
    delivery_confirmed_on: booking.delivery_confirmed_on || dataObj.delivery_confirmed_on || null,
    tariff_mask_status: booking.tariff_mask_status ?? dataObj.tariff_mask_status ?? false,
    tracking_details: trackingList,
    booking_details_json: booking,
    raw_data_obj: dataObj,
  };
}

// ─── GET /api/token — fetch a fresh session token ───────────────────────────
app.get('/api/token', async (req, res) => {
  try {
    for (let t = 0; t < 3; t++) {
      if (t > 0) await new Promise((r) => setTimeout(r, 500));
      const result = await postReq(
        INDIA_POST_HOST,
        '/',
        { 'next-action': TOKEN_ACTION },
        '[]',
        18000
      );

      if (!result || result.status !== 200) continue;

      const token = parseRscLine(result.body);
      if (token) {
        return res.json({ success: true, token, provider: 'indiapost' });
      }
    }
    return res.json({ success: false, error: 'Could not fetch token from India Post official server' });
  } catch (e) {
    return res.json({ success: false, error: e.message });
  }
});

// ─── GET /api/captcha — fetch a fresh captcha image and audio ───────────────
app.get('/api/captcha', async (req, res) => {
  try {
    const result = await postReq(
      INDIA_POST_HOST,
      '/',
      { 'next-action': CAPTCHA_GEN_ACTION },
      JSON.stringify(["BASE_URL_BACKEND_CAPTCHA", "GET", null, "/captcha_generator?captcha_type=image"]),
      18000
    );

    if (!result || result.status !== 200) {
      return res.json({
        success: false,
        error: `Captcha service error: HTTP ${result?.status || 0}`
      });
    }

    const idMatch = result.body.match(/"captcha_id1":"([^"]+)"/);
    let image = null;
    const rscTextMatch = result.body.match(/[0-9a-f]+:T([0-9a-f]+),(data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)/);
    if (rscTextMatch) {
      const len = parseInt(rscTextMatch[1], 16);
      image = rscTextMatch[2].slice(0, len);
    } else {
      const imgMatch = result.body.match(/(data:image\/(?:png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+?)(?=[0-9a-f]+:|\n|$)/);
      if (imgMatch) image = imgMatch[1];
    }

    if (!idMatch || !image) {
      return res.json({ success: false, error: 'Could not parse captcha from response' });
    }

    return res.json({
      success: true,
      captchaId: idMatch[1],
      image: image.startsWith('data:') ? image : `data:image/png;base64,${image}`,
      audio: null
    });
  } catch (e) {
    return res.json({ success: false, error: e.message });
  }
});

// ─── POST /api/track — track a single consignment ───────────────────────────
app.post('/api/track', async (req, res) => {
  const { token, articleId, captchaId, answer, source = 'indiapost' } = req.body;

  if (!articleId) {
    return res.json({ success: false, error: 'Missing articleId' });
  }

  const cleanId = articleId.trim().toUpperCase();

  // 1. Direct MySpeedPost tracking
  if (source === 'myspeedpost') {
    try {
      const result = await mySpeedPostClient.track(cleanId);
      return res.json(result);
    } catch (e) {
      return res.json({ success: false, articleId: cleanId, error: e.message, source: 'myspeedpost.com' });
    }
  }

  // 2. Direct SpeedPostLive tracking
  if (source === 'speedpostlive') {
    try {
      const result = await speedPostLiveClient.track(cleanId);
      return res.json(result);
    } catch (e) {
      return res.json({ success: false, articleId: cleanId, error: e.message, source: 'speedpostlive.com' });
    }
  }

  // 3. Direct India Post tracking
  if (source === 'indiapost') {
    if (!token) {
      return res.json({ success: false, articleId: cleanId, error: 'Missing India Post session token' });
    }
    try {
      const result = await trackViaIndiaPost(cleanId, token, captchaId, answer);
      return res.json(result);
    } catch (e) {
      return res.json({ success: false, articleId: cleanId, error: e.message, source: 'indiapost.gov.in' });
    }
  }

  // 4. Auto Mode: Try MySpeedPost -> SpeedPostLive -> India Post
  try {
    const result = await mySpeedPostClient.track(cleanId);
    if (result && (result.success || result.notFound)) {
      console.log(`[TRACK] (Auto:MySpeedPost) ${cleanId} → ${result.delivery_status || 'OK'}`);
      return res.json(result);
    }
  } catch (err) { }

  try {
    const spResult = await speedPostLiveClient.track(cleanId);
    if (spResult && spResult.success) {
      return res.json(spResult);
    }
  } catch (err) { }

  if (token && token !== 'myspeedpost_active') {
    try {
      const ipResult = await trackViaIndiaPost(cleanId, token, captchaId, answer);
      return res.json(ipResult);
    } catch (e) {
      return res.json({ success: false, articleId: cleanId, error: e.message });
    }
  }

  return res.json({ success: false, articleId: cleanId, error: 'Could not track consignment via available providers' });
});



// ─── POST /api/export — export results to Excel ──────────────────────────────
app.post('/api/export', (req, res) => {
  const { results } = req.body;
  if (!results || !Array.isArray(results)) {
    return res.status(400).json({ error: 'No results provided' });
  }

  const rows = results.map((r) => ({
    requested_article_number: r.articleId,
    article_number: r.article_number || null,
    article_type: r.article_type || null,
    booking_date: r.booking_date || null,
    booking_office_name: r.booking_office_name || null,
    booking_pin: r.booking_pin || null,
    destination_office_name: r.destination_office_name || null,
    destination_pincode: r.destination_pincode || null,
    destination_city: r.destination_city || null,
    weight_value: r.weight_value || null,
    tariff: r.tariff || null,
    cod_amount: r.cod_amount || null,
    source_country: r.source_country || null,
    destination_country: r.destination_country || null,
    delivery_confirmed_on: r.delivery_confirmed_on || null,
    tariff_mask_status: r.tariff_mask_status || false,
    delivery_status: r.delivery_status || null,
    tracking_details: JSON.stringify(r.tracking_details || []),
    booking_details_json: JSON.stringify(r.booking_details_json || {}),
    success: r.success || false,
    message: r.message || null,
    api_error: r.api_error ? JSON.stringify(r.api_error) : null,
    http_status: r.http_status || null,
    request_error: r.request_error || null,
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Tracking');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Disposition', `attachment; filename="indiapost_tracking_${timestamp}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ─── POST /api/export-clean — export selected columns only ───────────────────
app.post('/api/export-clean', (req, res) => {
  const { rows } = req.body;
  if (!rows || !Array.isArray(rows)) {
    return res.status(400).json({ error: 'No rows provided' });
  }

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Tracking');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Disposition', `attachment; filename="indiapost_tracking_clean_${timestamp}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ─── POST /api/export-pdf — export results to PDF ───────────────────────────
app.post('/api/export-pdf', async (req, res) => {
  const { results, format } = req.body;
  if (!results || !Array.isArray(results)) {
    return res.status(400).json({ error: 'No results provided' });
  }

  try {
    const pdfBuf = await generateTrackingPdf(results, format || 'list');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `indiapost_tracking_${format === 'table' ? 'table_' : ''}${timestamp}.pdf`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(pdfBuf);
  } catch (err) {
    console.error('PDF export error:', err);
    res.status(500).json({ error: 'Failed to generate PDF: ' + err.message });
  }
});

// ─── HISTORY STORAGE API ───────────────────────────────────────────────────
const HISTORY_DIR = path.join(__dirname, 'history');
if (!fs.existsSync(HISTORY_DIR)) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

// GET /api/history — list all saved tracking sessions (metadata only)
app.get('/api/history', (req, res) => {
  try {
    const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'));
    const sessions = [];

    for (const f of files) {
      try {
        const filePath = path.join(HISTORY_DIR, f);
        const raw = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        sessions.push({
          id: data.id || f.replace('.json', ''),
          name: data.name,
          trackType: data.trackType || 'range',
          rangeDetails: data.rangeDetails || '',
          timestamp: data.timestamp || new Date().toISOString(),
          formattedDate: data.formattedDate || '',
          total: data.total || (data.results ? data.results.length : 0),
          stats: data.stats || {},
          file: f
        });
      } catch (err) {
        console.warn(`Error reading history file ${f}:`, err.message);
      }
    }

    // Sort newest first
    sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json({ success: true, sessions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/history/:id — get full session data
app.get('/api/history/:id', (req, res) => {
  try {
    const { id } = req.params;
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '');
    const filePath = path.join(HISTORY_DIR, `${safeId}.json`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    res.json({ success: true, session: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/history — save a new tracking session
app.post('/api/history', (req, res) => {
  try {
    const { id, name, trackType, rangeDetails, allIds, results, stats } = req.body;
    if (!results || !Array.isArray(results) || results.length === 0) {
      return res.status(400).json({ success: false, error: 'No results to save' });
    }

    const now = new Date();
    const sessionId = id || `session_${now.getTime()}_${Math.random().toString(36).substring(2, 7)}`;
    const formattedDate = now.toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true
    });

    const totalCount = results.length;
    const computedStats = stats || {
      delivered: results.filter(r => r && r.delivery_status === 'Delivered').length,
      transit: results.filter(r => r && (r.delivery_status === 'In Transit' || r.delivery_status === 'Out for Delivery')).length,
      dispatched: results.filter(r => r && r.delivery_status === 'Dispatched').length,
      booked: results.filter(r => r && (r.delivery_status === 'Not Booked' || r.delivery_status === 'Booked' || (!r.delivery_status && r.success))).length,
      failed: results.filter(r => !r || !r.success).length,
    };

    let sessionName = name;
    if (!sessionName) {
      if (trackType === 'batch') {
        const first = allIds && allIds.length > 0 ? allIds[0] : (results[0]?.articleId || 'Batch');
        sessionName = `Batch: ${totalCount} items (${first}${totalCount > 1 ? '...' : ''}) • ${formattedDate}`;
      } else {
        const details = rangeDetails || (allIds && allIds.length > 1 ? `${allIds[0]} → ${allIds[allIds.length - 1]}` : (allIds ? allIds[0] : 'Range'));
        sessionName = `Range: ${details} (${totalCount} items) • ${formattedDate}`;
      }
    }

    const sessionData = {
      id: sessionId,
      name: sessionName,
      trackType: trackType || 'range',
      rangeDetails: rangeDetails || '',
      timestamp: now.toISOString(),
      formattedDate,
      total: totalCount,
      stats: computedStats,
      allIds: allIds || results.map(r => r.articleId || r.article_number),
      results
    };

    const filePath = path.join(HISTORY_DIR, `${sessionId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(sessionData, null, 2), 'utf8');

    res.json({ success: true, session: sessionData });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/history/:id — delete a specific session
app.delete('/api/history/:id', (req, res) => {
  try {
    const { id } = req.params;
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '');
    const filePath = path.join(HISTORY_DIR, `${safeId}.json`);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/history — clear all history
app.delete('/api/history', (req, res) => {
  try {
    const files = fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
      fs.unlinkSync(path.join(HISTORY_DIR, f));
    }
    res.json({ success: true, count: files.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── CII Auth API Endpoints (5-User Exclusive Session Controller) ───────────

// GET /api/auth/status — get available user slots
app.get('/api/auth/status', (req, res) => {
  const sessions = cleanExpiredSessions(loadAuthSessions());
  const activeKeys = new Set(Object.values(sessions).map(s => s.password));
  const totalSlots = ALLOWED_PASSWORDS.length;
  res.json({
    success: true,
    totalSlots,
    activeUsersCount: activeKeys.size,
    availableSlots: Math.max(0, totalSlots - activeKeys.size),
  });
});

// POST /api/auth/login — authenticate with one of the 5 keys
app.post('/api/auth/login', (req, res) => {
  const { password, clientToken } = req.body || {};
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ success: false, error: 'Password is required' });
  }

  const cleanPass = password.trim();
  if (!ALLOWED_PASSWORDS.includes(cleanPass)) {
    return res.status(401).json({ success: false, error: 'Invalid access key.' });
  }

  const sessions = cleanExpiredSessions(loadAuthSessions());
  const now = Date.now();

  // Check if this password is held by another active clientToken
  let existingHolderToken = null;
  for (const [tok, info] of Object.entries(sessions)) {
    if (info.password === cleanPass && info.expiresAt > now) {
      existingHolderToken = tok;
      break;
    }
  }

  // If clientToken matches existing holder, refresh lease
  if (existingHolderToken && clientToken && existingHolderToken === clientToken) {
    sessions[clientToken].expiresAt = now + SESSION_DURATION_MS;
    saveAuthSessions(sessions);
    return res.json({
      success: true,
      token: clientToken,
      expiresAt: sessions[clientToken].expiresAt,
      message: 'Session resumed (7 days).'
    });
  }

  // If password is already in use by a different active user
  if (existingHolderToken && existingHolderToken !== clientToken) {
    return res.status(403).json({
      success: false,
      error: 'This access key is currently in use by another active user. Please use an unused access key.'
    });
  }

  // Claim the password for a new token
  const token = crypto.randomBytes(24).toString('hex');
  sessions[token] = {
    password: cleanPass,
    claimedAt: now,
    expiresAt: now + SESSION_DURATION_MS
  };
  saveAuthSessions(sessions);

  const activeKeys = new Set(Object.values(sessions).map(s => s.password));
  return res.json({
    success: true,
    token,
    expiresAt: sessions[token].expiresAt,
    remainingSlots: Math.max(0, ALLOWED_PASSWORDS.length - activeKeys.size),
    message: 'Access granted (valid for 7 days).'
  });
});

// POST /api/auth/verify — check if stored token is active
app.post('/api/auth/verify', (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.json({ valid: false });
  const sessions = cleanExpiredSessions(loadAuthSessions());
  const info = sessions[token];
  if (info && info.expiresAt > Date.now()) {
    return res.json({ valid: true, expiresAt: info.expiresAt });
  }
  return res.json({ valid: false });
});

// POST /api/auth/logout — release the access key
app.post('/api/auth/logout', (req, res) => {
  const { token } = req.body || {};
  if (token) {
    const sessions = loadAuthSessions();
    if (sessions[token]) {
      delete sessions[token];
      saveAuthSessions(sessions);
    }
  }
  return res.json({ success: true });
});

// ─── Serve the frontend ───────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   📦  India Post Bulk Tracker — Server Running      ║');
  console.log(`║   🌐  Open: http://localhost:${PORT}                   ║`);
  console.log('║   🛑  Press Ctrl+C to stop                          ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error('╔══════════════════════════════════════════════════════╗');
    console.error(`║  ❌  Port ${PORT} is already in use!                  ║`);
    console.error('║                                                      ║');
    console.error('║  Fix: Open Task Manager → find "node.exe" → End it  ║');
    console.error('║  OR run this in PowerShell:                          ║');
    console.error(`║    Stop-Process -Id (Get-NetTCPConnection -LocalPort  ║`);
    console.error(`║    ${PORT}).OwningProcess -Force                       ║`);
    console.error('╚══════════════════════════════════════════════════════╝');
    console.error('');
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});
