'use strict';

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const BRAND = '#3b3f79';
const SOFT = '#303030';
const MARGIN = 30;
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const CONTENT_W = PAGE_W - MARGIN * 2;

function fmtIndian(rawValue) {
    const num = Math.round(parseFloat(String(rawValue || '0').replace(/,/g, '')) || 0);
    if (!isFinite(num)) return '0';
    const str = String(Math.abs(num));
    if (str.length <= 3) return str;
    let result = str.slice(-3);
    let rem = str.slice(0, str.length - 3);
    while (rem.length > 2) { result = rem.slice(-2) + ',' + result; rem = rem.slice(0, rem.length - 2); }
    return rem ? rem + ',' + result : result;
}

function roundWhole(v) {
    return Math.round(parseFloat(String(v || '0').replace(/,/g, '')) || 0);
}

function isFreight(item) {
    return (item.description || '').toLowerCase().includes('freight');
}

function safe(str) {
    return String(str || '').replace(/₹/g, 'Rs.').trim();
}

async function generateQuotationPdf(quotation) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true });
            const chunks = [];
            doc.on('data', c => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            let y = MARGIN;

            // ── Logo ─────────────────────────────────────────────────────────────
            const logoPath = path.join(__dirname, '..', 'logo.png');
            let logoW = 0;
            if (fs.existsSync(logoPath)) {
                try { doc.image(logoPath, MARGIN, y, { height: 52, fit: [58, 52] }); logoW = 68; } catch (_) {}
            }

            // ── Company header ────────────────────────────────────────────────────
            const hX = MARGIN + logoW;
            doc.font('Helvetica-Bold').fontSize(11).fillColor(SOFT)
               .text('DSC PIPES AND TUBES PVT LTD', hX, y + 4);
            doc.font('Helvetica').fontSize(8).fillColor(SOFT)
               .text('REGD OFFICE: 7C, 7TH FLOOR, DOSHI TOWERS, NO:156', hX, y + 18)
               .text('P.H ROAD, KILAPUK, CHENNAI - 600 010', hX, y + 28)
               .text('EMAIL ID: info@dscpipes.com', hX, y + 38);
            doc.font('Helvetica-Bold').fontSize(16).fillColor(SOFT)
               .text('QUOTATION', MARGIN, y + 14, { width: CONTENT_W, align: 'right', lineBreak: false });

            y += 62;
            doc.strokeColor(BRAND).lineWidth(1).moveTo(MARGIN, y).lineTo(PAGE_W - MARGIN, y).stroke();
            y += 10;

            // ── Meta grid ────────────────────────────────────────────────────────
            const lX = MARGIN;
            const rX = MARGIN + CONTENT_W / 2 + 8;
            const lblW = 105;
            const valW = CONTENT_W / 2 - lblW - 14;
            const metaH = 11;

            const metaLeft = [
                ['QUOTATION DATE', quotation.quotationDate || ''],
                ['KIND ATTN', quotation.customerName || ''],
                ['PHONE NUMBER', quotation.phoneNumber || ''],
                ['MOBILE NUMBER', quotation.mobileNumber || ''],
            ];
            const metaRight = [
                ['PREPARED BY', quotation.preparedBy || ''],
                ['ASSIGNED TO', quotation.assignedTo || ''],
                ['CHECKED BY', quotation.checkedBy || ''],
                ['QUOTE NUMBER', quotation.quoteNumber || ''],
            ];

            for (let i = 0; i < Math.max(metaLeft.length, metaRight.length); i++) {
                const [ll, lv] = metaLeft[i] || ['', ''];
                const [rl, rv] = metaRight[i] || ['', ''];
                if (ll) {
                    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#333')
                       .text(ll, lX, y, { width: lblW, lineBreak: false });
                    doc.font('Helvetica').fontSize(7.5).fillColor('#000')
                       .text(safe(lv), lX + lblW, y, { width: valW, lineBreak: false });
                }
                if (rl) {
                    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#333')
                       .text(rl, rX, y, { width: lblW, lineBreak: false });
                    doc.font('Helvetica').fontSize(7.5).fillColor('#000')
                       .text(safe(rv), rX + lblW, y, { width: valW, lineBreak: false });
                }
                y += metaH;
            }
            y += 8;

            // ── Bill To / Ship To ─────────────────────────────────────────────────
            doc.strokeColor('#ccc').lineWidth(0.5).moveTo(MARGIN, y).lineTo(PAGE_W - MARGIN, y).stroke();
            y += 8;

            const halfW = CONTENT_W / 2 - 10;
            doc.font('Helvetica-Bold').fontSize(9).fillColor('#000')
               .text('Bill To', lX, y, { width: halfW, lineBreak: false });
            doc.font('Helvetica-Bold').fontSize(9).fillColor('#000')
               .text('Ship To', rX, y, { width: halfW, lineBreak: false });
            y += 12;

            const billTo = [quotation.companyName, quotation.billTo, quotation.projectName].filter(Boolean).join('\n');
            const shipTo = safe(quotation.shipTo || '');
            doc.font('Helvetica').fontSize(8.5);
            const btH = doc.heightOfString(billTo || ' ', { width: halfW });
            const stH = doc.heightOfString(shipTo || ' ', { width: halfW });
            doc.fillColor('#000').text(billTo || '', lX, y, { width: halfW });
            doc.font('Helvetica').fontSize(8.5).fillColor('#000').text(shipTo || '', rX, y, { width: halfW });
            y += Math.max(btH, stH, 10) + 10;

            // ── Table ─────────────────────────────────────────────────────────────
            const colW = [30, 230, 70, 95, 110];
            const colX = [MARGIN];
            colW.slice(0, -1).forEach((w, i) => colX.push(colX[i] + w));
            const colLabels = ['SNo', 'Description', 'Quantity', 'Rate (Rs.)', 'Amount (Rs.)'];

            function drawHeader() {
                doc.rect(MARGIN, y, CONTENT_W, 20).fill(BRAND);
                doc.fillColor('#fff').font('Helvetica-Bold').fontSize(7.5);
                colLabels.forEach((lbl, i) => {
                    doc.text(lbl, colX[i] + 2, y + 6, { width: colW[i] - 4, align: 'center', lineBreak: false });
                });
                y += 22;
            }

            function ensureSpace(h) {
                if (y + h > PAGE_H - MARGIN - 20) {
                    doc.addPage();
                    y = MARGIN;
                    drawHeader();
                }
            }

            drawHeader();

            const lineItems = quotation.lineItems || [];
            const skipFreight = !!quotation.freightDistributedIntoMargin;
            let slNo = 0;

            lineItems.forEach(item => {
                if (skipFreight && isFreight(item)) return;

                const desc = safe(item.description || '');
                const qty = item.quantity;
                const rate = item.finalRate;

                // Pipe-type section header: has description but no quantity/rate
                if (!qty && !rate && desc) {
                    ensureSpace(22);
                    doc.rect(MARGIN, y, CONTENT_W, 18).fill('#e0e0ec');
                    doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(8.5)
                       .text(desc, MARGIN + 6, y + 5, { width: CONTENT_W - 12, lineBreak: false });
                    y += 20;
                    return;
                }

                doc.font('Helvetica').fontSize(8.5);
                const descH = Math.max(doc.heightOfString(desc || '', { width: colW[1] - 8 }), 11);
                const rowH = descH + 9;
                ensureSpace(rowH);

                // Alternating row background
                doc.rect(MARGIN, y, CONTENT_W, rowH).fill(slNo % 2 === 0 ? '#fafafa' : '#fff');
                doc.rect(MARGIN, y, CONTENT_W, rowH).stroke('#ddd');

                slNo++;
                doc.font('Helvetica').fontSize(8.5).fillColor('#000');
                doc.text(String(slNo), colX[0] + 3, y + 5, { width: colW[0] - 6, align: 'center', lineBreak: false });
                doc.text(desc, colX[1] + 4, y + 5, { width: colW[1] - 8 });
                doc.text(String(qty || ''), colX[2], y + 5, { width: colW[2] - 4, align: 'right', lineBreak: false });
                doc.text(fmtIndian(Math.round(parseFloat(rate || 0))), colX[3], y + 5, { width: colW[3] - 4, align: 'right', lineBreak: false });
                doc.text(fmtIndian(roundWhole(item.total)), colX[4], y + 5, { width: colW[4] - 4, align: 'right', lineBreak: false });
                y += rowH;
            });

            // Freight row (if not distributed into margin)
            if (!skipFreight) {
                const freightTotal = lineItems.filter(isFreight).reduce((s, fi) => s + roundWhole(fi.total), 0);
                if (freightTotal > 0) {
                    ensureSpace(22);
                    doc.rect(MARGIN, y, CONTENT_W, 20).fill('#f0f0f0');
                    doc.fillColor('#000').font('Helvetica-Bold').fontSize(8.5)
                       .text('Freight', colX[1] + 4, y + 6, { width: colW[1] - 8, lineBreak: false });
                    doc.text(fmtIndian(freightTotal), colX[4], y + 6, { width: colW[4] - 4, align: 'right', lineBreak: false });
                    y += 22;
                }
            }

            // ── Grand Total ───────────────────────────────────────────────────────
            ensureSpace(36);
            doc.rect(MARGIN, y, CONTENT_W, 32).fill('#eeeef8');
            doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(12)
               .text(`Total: Rs. ${fmtIndian(roundWhole(quotation.grandTotal || 0))}`, MARGIN, y + 9, {
                   width: CONTENT_W - 8, align: 'right', lineBreak: false,
               });
            y += 38;

            // ── Terms ─────────────────────────────────────────────────────────────
            const terms = (quotation.termsText || '').trim();
            if (terms) {
                ensureSpace(28);
                doc.strokeColor('#ddd').lineWidth(0.5).moveTo(MARGIN, y).lineTo(PAGE_W - MARGIN, y).stroke();
                y += 10;
                doc.fillColor(SOFT).font('Helvetica-Bold').fontSize(7.5)
                   .text('TERMS AND CONDITIONS', MARGIN, y);
                y += 12;
                doc.fillColor('#000').font('Helvetica').fontSize(8);
                terms.split('\n').forEach(line => {
                    ensureSpace(12);
                    doc.text(safe(line), MARGIN, y, { width: CONTENT_W, lineBreak: false });
                    y += 12;
                });
            }

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = { generateQuotationPdf };
