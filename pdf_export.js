/**
 * CII Document Engine - PDF Export Module
 */
const PDFDocument = require('pdfkit');

/**
 * Generate PDF buffer from tracking results
 * @param {Array} results - List of consignment tracking objects
 * @param {string} format - 'list' (numbered list) or 'table' (compact table)
 * @returns {Promise<Buffer>}
 */
function generateTrackingPdf(results, format = 'list') {
  return new Promise((resolve, reject) => {
    const isTable = format === 'table';
    const doc = new PDFDocument({
      margin: 36,
      size: 'A4',
      layout: isTable ? 'landscape' : 'portrait',
      bufferPages: true,
      info: {
        Title: 'India Post Consignment Tracking Report',
        Author: 'India Post Bulk Tracker',
        Subject: 'Consignment Tracking Details',
      }
    });

    const buffers = [];
    doc.on('data', (chunk) => buffers.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', (err) => reject(err));

    const total = results.length;
    const deliveredCount = results.filter(r => r && r.delivery_status === 'Delivered').length;
    const transitCount = results.filter(r => r && (r.delivery_status === 'In Transit' || r.delivery_status === 'Out for Delivery')).length;
    const bookedCount = results.filter(r => r && (r.delivery_status === 'Not Booked' || r.delivery_status === 'Booked' || (!r.delivery_status && r.success))).length;
    const failedCount = results.filter(r => !r || !r.success).length;

    if (isTable) {
      renderTableLayout(doc, results, { total, deliveredCount, transitCount, bookedCount, failedCount });
    } else {
      renderListLayout(doc, results, { total, deliveredCount, transitCount, bookedCount, failedCount });
    }


    // Add page numbers on all buffered pages
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;

      // Subtle footer line
      doc.moveTo(36, pageHeight - 28)
        .lineTo(pageWidth - 36, pageHeight - 28)
        .strokeColor('#e2e8f0')
        .lineWidth(0.5)
        .stroke();

      // Footer text
      doc.font('Helvetica')
        .fontSize(8)
        .fillColor('#94a3b8')
        .text('India Post Bulk Tracker Report', 36, pageHeight - 22, { align: 'left' });

      doc.text(`Page ${i + 1} of ${range.count}`, 36, pageHeight - 22, {
        align: 'right',
        width: pageWidth - 72
      });
    }

    doc.end();
  });
}

function getStatusColor(status) {
  if (!status) return '#ef4444';
  const s = status.toLowerCase();
  if (s.includes('deliver')) return '#16a34a';
  if (s.includes('transit') || s.includes('out for')) return '#2563eb';
  if (s.includes('dispatch')) return '#9333ea';
  if (s.includes('booked')) return '#d97706';
  return '#ef4444';
}

function formatDate(d) {
  if (!d) return '—';
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return String(d);
    return dt.toLocaleDateString('en-IN');
  } catch {
    return String(d);
  }
}

/**
 * Numbered List Format
 * 1. ED1175... origin pincode, origin post office name, destination pincode, destination post office name
 */
function renderListLayout(doc, results, stats) {
  const pageWidth = doc.page.width;
  const contentWidth = pageWidth - 72;

  // Header Banner
  doc.rect(36, 36, contentWidth, 54).fill('#0f172a');

  doc.font('Helvetica-Bold').fontSize(14).fillColor('#ffffff')
    .text('INDIA POST CONSIGNMENT TRACKING REPORT', 48, 48);

  doc.font('Helvetica').fontSize(8.5).fillColor('#94a3b8')
    .text(`Generated on: ${new Date().toLocaleString('en-IN')} | Total Consignments: ${stats.total}`, 48, 68);

  // Stats bar
  const statsY = 96;
  doc.rect(36, statsY, contentWidth, 22).fill('#f1f5f9');
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#334155');
  doc.text(`SUMMARY:  Delivered: ${stats.deliveredCount}   |   In Transit: ${stats.transitCount}   |   Not Booked: ${stats.bookedCount}   |   Failed: ${stats.failedCount}`, 44, statsY + 6);

  let currentY = 126;
  const bottomLimit = doc.page.height - 45;

  results.forEach((r, idx) => {
    const itemNum = idx + 1;
    const articleId = (r && (r.articleId || r.article_number)) || 'Unknown';
    const status = (r && r.delivery_status) || (r && r.success ? 'Not Booked' : 'Failed / No Data');

    const originPin = (r && r.booking_pin) || '—';
    const originOffice = (r && r.booking_office_name) || '—';
    const destPin = (r && r.destination_pincode) || '—';
    const destOffice = (r && r.destination_office_name) || '—';
    const bookingDate = r && r.booking_date ? formatDate(r.booking_date) : '—';
    const deliveredOn = r && r.delivery_confirmed_on ? formatDate(r.delivery_confirmed_on) : null;
    const statusColor = getStatusColor(status);

    const cardHeight = 52;

    // Check if new page needed
    if (currentY + cardHeight > bottomLimit) {
      doc.addPage();
      currentY = 36;
    }

    // Card background
    doc.rect(36, currentY, contentWidth, cardHeight)
      .fillAndStroke(idx % 2 === 0 ? '#ffffff' : '#f8fafc', '#e2e8f0');

    // Left accent bar
    doc.rect(36, currentY, 4, cardHeight).fill(statusColor);

    // Number & Consignment ID
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a');
    doc.text(`${itemNum}. ${articleId}`, 48, currentY + 7);

    // Status Badge
    const statusText = status.toUpperCase();
    const badgeWidth = doc.widthOfString(statusText, { font: 'Helvetica-Bold', size: 7.5 }) + 10;
    const badgeX = contentWidth + 36 - badgeWidth - 8;
    
    doc.roundedRect(badgeX, currentY + 6, badgeWidth, 14, 3).fill(statusColor);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#ffffff')
      .text(statusText, badgeX, currentY + 9, { width: badgeWidth, align: 'center' });

    // Details Line 1: Origin & Destination
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#475569');
    doc.text('Origin:', 48, currentY + 23);
    doc.font('Helvetica').fontSize(8.5).fillColor('#1e293b');
    doc.text(`${originPin} (${originOffice})`, 82, currentY + 23, { width: 200, lineBreak: false });

    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#475569');
    doc.text('Destination:', 290, currentY + 23);
    doc.font('Helvetica').fontSize(8.5).fillColor('#1e293b');
    doc.text(`${destPin} (${destOffice})`, 345, currentY + 23, { width: 200, lineBreak: false });

    // Details Line 2: Booking Date & Delivery Date
    doc.font('Helvetica').fontSize(7.5).fillColor('#64748b');
    let metaText = `Booking Date: ${bookingDate}`;
    if (deliveredOn) {
      metaText += `  |  Delivered On: ${deliveredOn}`;
    }
    const w = r && (r.weight_value || r.booking_details_json?.weight_value || r.raw_data_obj?.booking_details?.weight_value);
    if (w) {
      metaText += `  |  Weight: ${w}g`;
    }
    if (r && r.article_type) {
      metaText += `  |  Type: ${r.article_type}`;
    }
    doc.text(metaText, 48, currentY + 38);

    currentY += cardHeight + 4;
  });
}

/**
 * Tabular Layout (Landscape)
 */
function renderTableLayout(doc, results, stats) {
  const pageWidth = doc.page.width;
  const contentWidth = pageWidth - 72;

  // Header Banner
  doc.rect(36, 36, contentWidth, 40).fill('#0f172a');
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff')
    .text('INDIA POST CONSIGNMENT TRACKING REPORT (TABLE VIEW)', 48, 45);
  doc.font('Helvetica').fontSize(8).fillColor('#94a3b8')
    .text(`Generated: ${new Date().toLocaleString('en-IN')}  |  Total: ${stats.total}  |  Delivered: ${stats.deliveredCount}  |  In Transit: ${stats.transitCount}  |  Not Booked: ${stats.bookedCount}  |  Failed: ${stats.failedCount}`, 48, 60);

  // Column definitions
  const columns = [
    { label: '#', x: 36, width: 24, align: 'center' },
    { label: 'Consignment No.', x: 60, width: 105, align: 'left' },
    { label: 'Status', x: 165, width: 75, align: 'center' },
    { label: 'Origin PIN', x: 240, width: 60, align: 'center' },
    { label: 'Origin Post Office', x: 300, width: 130, align: 'left' },
    { label: 'Dest PIN', x: 430, width: 60, align: 'center' },
    { label: 'Destination Office', x: 490, width: 135, align: 'left' },
    { label: 'Weight (g)', x: 625, width: 50, align: 'center' },
    { label: 'Booked On', x: 675, width: 65, align: 'center' },
    { label: 'Delivered On', x: 740, width: 66, align: 'center' },
  ];

  function drawTableHeader(y) {
    doc.rect(36, y, contentWidth, 20).fill('#1e293b');
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#ffffff');
    columns.forEach(col => {
      doc.text(col.label, col.x + 2, y + 6, { width: col.width - 4, align: col.align });
    });
    return y + 20;
  }

  let currentY = drawTableHeader(84);
  const rowHeight = 18;
  const bottomLimit = doc.page.height - 40;

  results.forEach((r, idx) => {
    if (currentY + rowHeight > bottomLimit) {
      doc.addPage();
      currentY = drawTableHeader(36);
    }

    const itemNum = idx + 1;
    const articleId = (r && (r.articleId || r.article_number)) || '—';
    const status = (r && r.delivery_status) || (r && r.success ? 'Not Booked' : 'Failed');

    const originPin = (r && r.booking_pin) || '—';
    const originOffice = (r && r.booking_office_name) || '—';
    const destPin = (r && r.destination_pincode) || '—';
    const destOffice = (r && r.destination_office_name) || '—';
    const rawW = r && (r.weight_value || r.booking_details_json?.weight_value || r.raw_data_obj?.booking_details?.weight_value);
    const weightVal = rawW ? `${rawW}` : '—';
    const bookingDate = r && r.booking_date ? formatDate(r.booking_date) : '—';
    const deliveredOn = r && r.delivery_confirmed_on ? formatDate(r.delivery_confirmed_on) : '—';
    const statusColor = getStatusColor(status);

    // Row background
    doc.rect(36, currentY, contentWidth, rowHeight)
      .fillAndStroke(idx % 2 === 0 ? '#ffffff' : '#f8fafc', '#f1f5f9');

    // Values
    doc.font('Helvetica').fontSize(7.5).fillColor('#334155');
    doc.text(String(itemNum), columns[0].x, currentY + 5, { width: columns[0].width, align: 'center' });

    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#0f172a');
    doc.text(articleId, columns[1].x + 4, currentY + 5, { width: columns[1].width - 4, align: 'left' });

    doc.font('Helvetica-Bold').fontSize(7).fillColor(statusColor);
    doc.text(status, columns[2].x, currentY + 5, { width: columns[2].width, align: 'center' });

    doc.font('Helvetica').fontSize(7.5).fillColor('#1e293b');
    doc.text(originPin, columns[3].x, currentY + 5, { width: columns[3].width, align: 'center' });
    doc.text(originOffice.length > 22 ? originOffice.substring(0, 22) + '…' : originOffice, columns[4].x + 4, currentY + 5, { width: columns[4].width - 4, align: 'left' });

    doc.text(destPin, columns[5].x, currentY + 5, { width: columns[5].width, align: 'center' });
    doc.text(destOffice.length > 22 ? destOffice.substring(0, 22) + '…' : destOffice, columns[6].x + 4, currentY + 5, { width: columns[6].width - 4, align: 'left' });

    doc.text(weightVal, columns[7].x, currentY + 5, { width: columns[7].width, align: 'center' });
    doc.text(bookingDate, columns[8].x, currentY + 5, { width: columns[8].width, align: 'center' });
    doc.text(deliveredOn, columns[9].x, currentY + 5, { width: columns[9].width, align: 'center' });

    currentY += rowHeight;
  });
}

module.exports = {
  generateTrackingPdf
};
