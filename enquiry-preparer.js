(function () {
    'use strict';

    function $(id) {
        return document.getElementById(id);
    }

    function parseNumber(value) {
        const n = parseFloat(String(value == null ? '' : value).replace(/,/g, '').trim());
        return Number.isFinite(n) ? n : NaN;
    }

    function normalizeQuotation(quotation) {
        if (!quotation || typeof quotation !== 'object') {
            return null;
        }
        const header = quotation.header || {};
        const lineItems = Array.isArray(quotation.lineItems) ? quotation.lineItems : [];
        return {
            quoteNumber: quotation.quoteNumber || header.quoteNumber || '',
            customerName: quotation.customerName || header.billTo || header.customerName || '',
            kindAttn: header.kindAttn || '',
            projectName: quotation.projectName || header.projectName || '',
            lineItems: lineItems.map(function (item, idx) {
                const qty = parseNumber(item.quantity || item.qty);
                return {
                    slNo: idx + 1,
                    description: item.originalDescription || item.description || item.identifiedPipeType || '',
                    quantity: Number.isFinite(qty) ? String(qty) : String(item.quantity || item.qty || '').trim(),
                    unit: String(item.unit || item.uom || 'Nos').trim()
                };
            }).filter(function (item) {
                return item.description || item.quantity;
            })
        };
    }

    function renderLineItemsText(lineItems) {
        if (!Array.isArray(lineItems) || !lineItems.length) {
            return 'No line items available.';
        }
        return lineItems.map(function (item, idx) {
            const sl = item.slNo || (idx + 1);
            const desc = item.description || '';
            const qty = item.quantity || '';
            const unit = item.unit || '';
            return sl + '. ' + desc + ' | Qty: ' + qty + (unit ? ' ' + unit : '');
        }).join('\n');
    }

    function applyTemplate(template, data) {
        var output = String(template || '');
        var tokenMap = {
            quoteNumber: data.quoteNumber || '',
            customerName: data.customerName || '',
            kindAttn: data.kindAttn || '',
            projectName: data.projectName || '',
            date: new Date().toLocaleDateString(),
            lineItems: renderLineItemsText(data.lineItems || [])
        };

        Object.keys(tokenMap).forEach(function (token) {
            var re = new RegExp('\\{\\{\\s*' + token + '\\s*\\}\\}', 'gi');
            output = output.replace(re, tokenMap[token]);
        });

        return output.trim();
    }

    function setStatus(id, text, ok) {
        var el = $(id);
        if (!el) return;
        el.textContent = text || '';
        el.style.color = ok ? '#2e7d32' : '#c62828';
    }

    function readTemplate() {
        return ($('enquiryTemplateText') && $('enquiryTemplateText').value) || '';
    }

    function writeOutput(content) {
        var outputEl = $('generatedEnquiryText');
        if (outputEl) {
            outputEl.value = content || '';
        }
    }

    function generateFromQuotationData(rawQuotation) {
        var normalized = normalizeQuotation(rawQuotation);
        if (!normalized) {
            throw new Error('Could not read quotation details.');
        }
        if (!normalized.lineItems.length) {
            throw new Error('Quotation found, but it has no line items.');
        }
        var template = readTemplate();
        if (!template.trim()) {
            throw new Error('Please enter an enquiry template first.');
        }
        var content = applyTemplate(template, normalized);
        writeOutput(content);
        return normalized;
    }

    function findByQuotationNumber(quoteNumber) {
        var all = Array.isArray(window.approvedQuotations) ? window.approvedQuotations : [];
        var target = String(quoteNumber || '').trim().toLowerCase();
        if (!target) return null;
        return all.find(function (q) {
            var header = q.header || {};
            var qn = q.quoteNumber || header.quoteNumber || '';
            return String(qn).trim().toLowerCase() === target;
        }) || null;
    }

    function createEnquiryFromQuotationNumber() {
        setStatus('enquiryFromQuoteStatus', '', false);
        var quoteInput = $('enquiryFromQuoteNumber');
        var quoteNumber = quoteInput ? String(quoteInput.value || '').trim() : '';

        if (!quoteNumber) {
            setStatus('enquiryFromQuoteStatus', 'Please enter a quotation number.', false);
            return;
        }
        if (!Array.isArray(window.approvedQuotations) || !window.approvedQuotations.length) {
            setStatus('enquiryFromQuoteStatus', 'No approved quotations are loaded yet. Open Approval once to load data.', false);
            return;
        }

        var match = findByQuotationNumber(quoteNumber);
        if (!match) {
            setStatus('enquiryFromQuoteStatus', 'Quotation not found in loaded approvals.', false);
            return;
        }

        generateFromQuotationData(match);
        setStatus('enquiryFromQuoteStatus', 'Enquiry draft created from quotation number.', true);
    }

    async function createEnquiryFromAiInput() {
        setStatus('enquiryInputStatus', '', false);
        var text = String(($('enquiryInputText') && $('enquiryInputText').value) || '').trim();
        var fileEl = $('enquiryInputFile');
        var file = fileEl && fileEl.files && fileEl.files.length > 0 ? fileEl.files[0] : null;

        if (!text && !file) {
            setStatus('enquiryInputStatus', 'Please paste content or choose a file first.', false);
            return;
        }
        if (typeof window.extractQuotationWithAIFile !== 'function') {
            setStatus('enquiryInputStatus', 'AI extraction is not available in this build.', false);
            return;
        }

        try {
            setStatus('enquiryInputStatus', 'Calling AI to extract enquiry details...', true);
            var aiData = await window.extractQuotationWithAIFile(text, file);
            generateFromQuotationData(aiData);
            setStatus('enquiryInputStatus', 'Enquiry draft created from pasted/uploaded content.', true);
        } catch (error) {
            console.error('Enquiry preparer failed:', error);
            setStatus('enquiryInputStatus', 'Failed to create enquiry: ' + (error.message || 'Unknown error'), false);
        }
    }

    function copyGeneratedEnquiry() {
        var outputEl = $('generatedEnquiryText');
        var statusEl = $('generatedEnquiryStatus');
        if (!outputEl || !outputEl.value.trim()) {
            if (statusEl) {
                statusEl.textContent = 'Nothing to copy yet.';
                statusEl.style.color = '#c62828';
            }
            return;
        }

        outputEl.select();
        outputEl.setSelectionRange(0, outputEl.value.length);
        document.execCommand('copy');
        if (statusEl) {
            statusEl.textContent = 'Enquiry copied to clipboard.';
            statusEl.style.color = '#2e7d32';
        }
    }

    function resetTemplateToDefault() {
        var templateEl = $('enquiryTemplateText');
        if (!templateEl) return;
        templateEl.value = [
            'Subject: Enquiry for {{quoteNumber}}',
            '',
            'Dear Sir/Madam,',
            '',
            'Please quote your best rate for the following requirement:',
            '',
            'Client: {{customerName}}',
            'Kind Attn: {{kindAttn}}',
            'Project: {{projectName}}',
            'Date: {{date}}',
            '',
            '{{lineItems}}',
            '',
            'Please share price, delivery timeline, taxes, and payment terms.',
            '',
            'Regards,',
            'DSC Pipes and Tubes Pvt Ltd'
        ].join('\n');
    }

    function init() {
        resetTemplateToDefault();

        window.enquiryPreparer = {
            createEnquiryFromQuotationNumber: createEnquiryFromQuotationNumber,
            createEnquiryFromAiInput: createEnquiryFromAiInput,
            copyGeneratedEnquiry: copyGeneratedEnquiry,
            resetTemplateToDefault: resetTemplateToDefault
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
