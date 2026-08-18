/**
 * CII Logistics Suite - MySpeedPost External Client Adapter
 */
const https = require('https');

class MySpeedPostClient {
  constructor() {
    this.csrfToken = null;
    this.snapshot = null;
    this.cookies = [];
    this.lastFetched = 0;
    this.sessionPromise = null;
    this.agent = new https.Agent({
      keepAlive: true,
      maxSockets: 20,
      timeout: 15000,
    });
  }

  async initSession(force = false) {
    if (!force && this.csrfToken && this.snapshot && (Date.now() - this.lastFetched < 180000)) {
      return;
    }

    if (this.sessionPromise && !force) {
      return this.sessionPromise;
    }

    this.sessionPromise = (async () => {
      try {
        const pageHtml = await new Promise((resolve, reject) => {
          const req = https.get('https://myspeedpost.com/speed-post-tracking', {
            agent: this.agent,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
            },
            timeout: 10000,
          }, (res) => {
            if (res.headers['set-cookie']) {
              this.cookies = res.headers['set-cookie'].map(c => c.split(';')[0]);
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('Session timeout')); });
        });

        const csrfMatch = pageHtml.match(/<meta name="csrf-token" content="([^"]+)">/);
        this.csrfToken = csrfMatch ? csrfMatch[1] : null;

        const snapshotMatch = pageHtml.match(/wire:snapshot="([^"]+)"/);
        if (snapshotMatch) {
          this.snapshot = snapshotMatch[1].replace(/&quot;/g, '"');
        }
        this.lastFetched = Date.now();
      } finally {
        this.sessionPromise = null;
      }
    })();

    return this.sessionPromise;
  }

  async callLivewire(snapshot, updates, calls) {
    const postData = JSON.stringify({
      _token: this.csrfToken,
      components: [
        {
          snapshot: typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot),
          updates: updates || {},
          calls: calls || []
        }
      ]
    });

    return new Promise((resolve, reject) => {
      const req = https.request('https://myspeedpost.com/livewire/update', {
        method: 'POST',
        agent: this.agent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Content-Type': 'application/json',
          'X-Livewire': 'true',
          'X-CSRF-TOKEN': this.csrfToken,
          'Accept': 'application/json',
          'Cookie': this.cookies.join('; '),
          'Origin': 'https://myspeedpost.com',
          'Referer': 'https://myspeedpost.com/speed-post-tracking',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 12000,
      }, (res) => {
        if (res.headers['set-cookie']) {
          const newCookies = res.headers['set-cookie'].map(c => c.split(';')[0]);
          const cookieMap = {};
          [...this.cookies, ...newCookies].forEach(c => {
            const [k] = c.split('=');
            cookieMap[k] = c;
          });
          this.cookies = Object.values(cookieMap);
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data) });
          } catch (err) {
            resolve({ status: res.statusCode, raw: data });
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Livewire request timeout')); });
      req.write(postData);
      req.end();
    });
  }

  async track(consignmentNumber) {
    const cleanId = (consignmentNumber || '').trim().toUpperCase();
    if (!cleanId) {
      return { success: false, articleId: cleanId, error: 'Empty tracking number' };
    }

    try {
      await this.initSession();

      // Submit tracking request
      let res = await this.callLivewire(
        this.snapshot,
        { consignment_number: cleanId },
        [{ path: '', method: 'submit', params: [] }]
      );

      if (res.status === 419 || !res.data?.components?.[0]) {
        // Session expired, re-init
        await this.initSession(true);
        res = await this.callLivewire(
          this.snapshot,
          { consignment_number: cleanId },
          [{ path: '', method: 'submit', params: [] }]
        );
      }

      if (!res.data?.components?.[0]) {
        return { success: false, articleId: cleanId, error: 'Could not connect to MySpeedPost server' };
      }

      let comp = res.data.components[0];
      let currentSnapshot = comp.snapshot;
      let html = comp.effects?.html || '';

      // Check if tracking events are already present in html
      let parsed = this.parseTrackingHtml(html, cleanId);

      // If pending / fetching, poll fetchStatus
      if (!parsed.hasEvents && !parsed.notFound) {
        for (let poll = 0; poll < 3; poll++) {
          await new Promise(r => setTimeout(r, 1000));
          const pollRes = await this.callLivewire(currentSnapshot, {}, [{ path: '', method: 'fetchStatus', params: [] }]);
          if (pollRes.data?.components?.[0]) {
            comp = pollRes.data.components[0];
            currentSnapshot = comp.snapshot;
            html = comp.effects?.html || html;
            parsed = this.parseTrackingHtml(html, cleanId);
            if (parsed.hasEvents || parsed.notFound) break;
          }
        }
      }

      return parsed;
    } catch (e) {
      return { success: false, articleId: cleanId, error: e.message };
    }
  }

  parseTrackingHtml(html, articleId) {
    if (!html) return { success: false, articleId, notFound: false, hasEvents: false, error: 'Empty response' };

    if (html.includes('Consignment details not found') || html.includes('consignment_not_found')) {
      return {
        success: false,
        articleId,
        notFound: true,
        hasEvents: false,
        api_error: 'Consignment not found'
      };
    }

    // Extract summary chunkedData
    let summaryMap = {};
    const summaryMatch = html.match(/this\.chunk\((\[\{.*?\}\]),\s*cardCount\)/s);
    if (summaryMatch) {
      try {
        const decoded = summaryMatch[1].replace(/&quot;/g, '"').replace(/\\u([0-9a-fA-F]{4})/g, (_, c) => String.fromCharCode(parseInt(c, 16)));
        const summaryArr = JSON.parse(decoded);
        summaryArr.forEach(item => {
          if (item && item.key) summaryMap[item.key] = item.value;
        });
      } catch (e) {}
    }

    // Extract tracking-request json
    let trackingEvents = [];
    const eventsMatch = html.match(/tracking-request="([^"]+)"/);
    if (eventsMatch) {
      try {
        const decoded = eventsMatch[1].replace(/&quot;/g, '"');
        const reqObj = JSON.parse(decoded);
        if (reqObj && Array.isArray(reqObj.tracking_events)) {
          trackingEvents = reqObj.tracking_events;
        }
      } catch (e) {}
    }

    const hasEvents = trackingEvents.length > 0 || (summaryMap.origin_pincode && summaryMap.destination_pincode);
    if (!hasEvents) {
      // If booked only without location data, it's unbooked/empty
      if (summaryMap.current_status && !summaryMap.origin_pincode && !summaryMap.destination_pincode && trackingEvents.length === 0) {
        return {
          success: true,
          articleId,
          source: 'myspeedpost.com',
          http_status: 200,
          message: 'Not Booked (No movement details)',
          delivery_status: 'Not Booked',
          article_number: summaryMap.number || articleId,
          article_type: summaryMap.article_type_text || 'Speed Post',
          booking_date: summaryMap.booked_on || null,
          booking_office_name: summaryMap.booked_at || null,
          booking_pin: summaryMap.origin_pincode || null,
          destination_office_name: summaryMap.delivery_location || null,
          destination_pincode: summaryMap.destination_pincode || null,
          destination_city: null,
          destination_country: summaryMap.destination_country || 'INDIA',
          tariff: summaryMap.tariff || null,
          tracking_details: [],
          booking_details_json: summaryMap,
          raw_data_obj: { summaryMap, trackingEvents }
        };
      }
      return { success: false, articleId, notFound: false, hasEvents: false, error: 'No tracking details available yet' };
    }

    // Normalize events
    const normalizedEvents = trackingEvents.map(ev => {
      let dateStr = '—';
      let timeStr = '—';
      if (ev.tracked_at) {
        try {
          const d = new Date(ev.tracked_at);
          dateStr = d.toLocaleDateString('en-GB'); // DD/MM/YYYY
          timeStr = d.toLocaleTimeString('en-US', { hour12: false });
        } catch (_) {}
      }
      return {
        date: dateStr,
        time: timeStr,
        office: ev.office || (ev.pincode_info?.office_name) || '—',
        event: ev.event || ev.event_type || '—',
        eventcode: ev.event_type || '',
        details: ev.remarks || ev.event || '—',
        pincode: ev.pincode || ev.pincode_info?.pincode || null,
        tracked_at: ev.tracked_at
      };
    });

    // Determine status
    let rawStatus = summaryMap.current_status || '';
    rawStatus = rawStatus.replace(/^[^\w\s]+/, '').trim(); // Remove emojis

    let deliveryStatus = 'Not Booked';
    const statusLower = rawStatus.toLowerCase();
    if (statusLower.includes('delivered')) deliveryStatus = 'Delivered';
    else if (statusLower.includes('out for delivery') || statusLower.includes('invoiced') || statusLower.includes('transit') || statusLower.includes('received')) deliveryStatus = 'In Transit';
    else if (statusLower.includes('dispatched')) deliveryStatus = 'Dispatched';
    else if (statusLower.includes('booked')) deliveryStatus = 'Not Booked';

    if (normalizedEvents.some(e => (e.event || '').toLowerCase().includes('delivered'))) {
      deliveryStatus = 'Delivered';
    }


    return {
      success: true,
      articleId,
      source: 'myspeedpost.com',
      http_status: 200,
      message: 'data retrieved successfully from myspeedpost.com',
      delivery_status: deliveryStatus,
      article_number: summaryMap.number || articleId,
      article_type: summaryMap.article_type_text || 'Speed Post',
      booking_date: summaryMap.booked_on || (normalizedEvents[normalizedEvents.length - 1]?.tracked_at) || null,
      booking_office_name: summaryMap.booked_at || null,
      booking_pin: summaryMap.origin_pincode || null,
      destination_office_name: summaryMap.delivery_location || null,
      destination_pincode: summaryMap.destination_pincode || null,
      destination_city: null,
      destination_country: summaryMap.destination_country || 'INDIA',
      tariff: summaryMap.tariff || null,
      tracking_details: normalizedEvents,
      booking_details_json: summaryMap,
      raw_data_obj: { summaryMap, trackingEvents }
    };
  }
}

const mySpeedPostClient = new MySpeedPostClient();

module.exports = {
  MySpeedPostClient,
  mySpeedPostClient
};
