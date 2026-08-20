/**
 * CII Logistics Suite - SpeedPostLive External Client Adapter
 */
const https = require('https');

class SpeedPostLiveClient {
  constructor() {
    this.agent = new https.Agent({
      keepAlive: true,
      maxSockets: 10,
      rejectUnauthorized: false
    });
  }

  async track(articleId) {
    const consignmentNumber = articleId.trim().toUpperCase();
    const postData = JSON.stringify({ consignment_number: consignmentNumber });

    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'speedpostlive.com',
        path: '/include/server/t_api',
        method: 'POST',
        agent: this.agent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          'Origin': 'https://speedpostlive.com',
          'Referer': 'https://speedpostlive.com/bulk-tracking',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 15000
      }, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            if (data.status === 200 || (data.data && data.data.consignment)) {
              return resolve(this.formatResult(consignmentNumber, data.data));
            } else if (data.message || data.error) {
              return resolve({
                success: false,
                articleId: consignmentNumber,
                source: 'speedpostlive.com',
                api_error: data.message || data.error || 'Tracking details not available'
              });
            }
          } catch (e) {
            // Not valid JSON (e.g. 404 or HTML)
          }

          resolve({
            success: false,
            articleId: consignmentNumber,
            source: 'speedpostlive.com',
            api_error: `Server responded with HTTP ${res.statusCode} (SpeedPostLive unavailable)`
          });
        });
      });

      req.on('error', (err) => {
        resolve({
          success: false,
          articleId: consignmentNumber,
          source: 'speedpostlive.com',
          api_error: `Connection error: ${err.message}`
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          success: false,
          articleId: consignmentNumber,
          source: 'speedpostlive.com',
          api_error: 'Request timed out'
        });
      });

      req.write(postData);
      req.end();
    });
  }

  formatResult(articleId, data) {
    const consignment = data?.consignment || {};
    const events = (data?.tracking_events || []).slice().sort(
      (a, b) => new Date(b.tracked_at || 0) - new Date(a.tracked_at || 0)
    );

    const latestEvent = events[0] || {};
    let currentStatus = consignment.current_status || latestEvent.event || 'Not Booked';
    if (currentStatus === 'Booked') currentStatus = 'Not Booked';

    // Map events
    const trackingDetails = events.map(e => {
      let date = '';
      let time = '';
      if (e.tracked_at) {
        try {
          const d = new Date(e.tracked_at);
          date = d.toLocaleDateString('en-GB');
          time = d.toLocaleTimeString('en-GB');
        } catch {}
      }

      return {
        date: date || '',
        time: time || '',
        office: e.office || '',
        event: e.event || '',
        eventcode: e.event || '',
        details: e.remarks || e.event || '',
        pincode: e.pincode || '',
        tracked_at: e.tracked_at
      };
    });

    let bookingDate = consignment.booked_on || '';
    if (bookingDate) {
      try {
        bookingDate = new Date(bookingDate).toLocaleDateString('en-GB');
      } catch {}
    }

    return {
      success: true,
      articleId,
      article_number: articleId,
      article_type: consignment.article_type || 'Speed Post',
      booking_date: bookingDate,
      booking_office_name: consignment.booked_at || consignment.origin_office || '',
      booking_pin: consignment.origin_pincode || '',
      destination_office_name: consignment.delivery_location || '',
      destination_pincode: consignment.destination_pincode || '',
      weight_value: consignment.weight || consignment.weight_value || consignment.article_weight || null,
      delivery_status: currentStatus,
      delivery_confirmed_on: currentStatus.toLowerCase().includes('deliver') ? (latestEvent.tracked_at || '') : '',
      tariff: consignment.tariff || '',
      source: 'speedpostlive.com',
      tracking_details: trackingDetails,
      raw_data_obj: data
    };
  }
}

const speedPostLiveClient = new SpeedPostLiveClient();
module.exports = { SpeedPostLiveClient, speedPostLiveClient };
