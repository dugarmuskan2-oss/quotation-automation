/*
    Gmail Pub/Sub push handler: decode notification, fetch new emails with label,
    call get-instructions, generate-quotation, save-quotation.
    Used by POST /api/gmail-push (Vercel or Express).
*/

const FormData = require('form-data');

/**
 * Try fetch; returns null if request failed or response not ok (treat as unreachable).
 */
async function fetchOrNull(url, options = {}) {
    try {
        const res = await fetch(url, options);
        return res;
    } catch (e) {
        return null;
    }
}

/**
 * Get OAuth2 access token from refresh token.
 */
async function getAccessToken(refreshToken, clientId, clientSecret) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token'
        })
    });
    const data = await res.json();
    if (data.error) {
        throw new Error(data.error + (data.error_description ? ': ' + data.error_description : ''));
    }
    return data.access_token;
}

/**
 * Handle Gmail Pub/Sub push payload. Does not throw; logs errors.
 * @param {object} payload - Raw Pub/Sub POST body { message: { data: base64 } }
 */
async function handleGmailPush(payload) {
    if (!payload || !payload.message || !payload.message.data) {
        console.warn('gmail-push: invalid Pub/Sub body');
        return;
    }
    let data;
    try {
        data = JSON.parse(Buffer.from(payload.message.data, 'base64').toString('utf8'));
    } catch (e) {
        console.warn('gmail-push: failed to decode message.data', e.message);
        return;
    }
    const historyId = data.historyId;
    if (!historyId) {
        console.warn('gmail-push: no historyId in message');
        return;
    }

    const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
    const clientId = process.env.GMAIL_CLIENT_ID;
    const clientSecret = process.env.GMAIL_CLIENT_SECRET;
    const labelName = process.env.QUOTATION_LABEL_NAME || 'Quotation Request';
    let mainUrl = (process.env.QUOTATION_APP_URL || '').replace(/\/$/, '');
    if (!mainUrl && process.env.VERCEL_URL) {
        mainUrl = `https://${process.env.VERCEL_URL}`;
    }
    const previewUrl = (process.env.QUOTATION_APP_URL_PREVIEW || '').replace(/\/$/, '');
    const baseUrls = [mainUrl, previewUrl].filter(Boolean);
    const apiKey = process.env.QUOTATION_API_KEY || '';

    if (!refreshToken || !clientId || !clientSecret) {
        console.error('gmail-push: missing GMAIL_REFRESH_TOKEN, GMAIL_CLIENT_ID, or GMAIL_CLIENT_SECRET');
        return;
    }
    if (baseUrls.length === 0) {
        console.error('gmail-push: set QUOTATION_APP_URL or QUOTATION_APP_URL_PREVIEW or deploy on Vercel (VERCEL_URL)');
        return;
    }

    let accessToken;
    try {
        accessToken = await getAccessToken(refreshToken, clientId, clientSecret);
    } catch (e) {
        console.error('gmail-push: token error', e.message);
        return;
    }

    const gmailHeaders = { Authorization: `Bearer ${accessToken}` };

    let listRes;
    try {
        listRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${encodeURIComponent(historyId)}&historyTypes=messageAdded&maxResults=50`,
            { headers: gmailHeaders }
        );
    } catch (e) {
        console.error('gmail-push: history request failed', e.message);
        return;
    }
    if (!listRes.ok) {
        console.error('gmail-push: history not ok', listRes.status, await listRes.text());
        return;
    }

    const historyData = await listRes.json();
    const messageIds = new Set();
    (historyData.history || []).forEach(h => {
        (h.messagesAdded || []).forEach(m => {
            if (m.message && m.message.id) messageIds.add(m.message.id);
        });
    });
    if (messageIds.size === 0) {
        return;
    }

    const labelRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', { headers: gmailHeaders });
    const labelsJson = await labelRes.json();
    const labelEntry = (labelsJson.labels || []).find(l => (l.name || '').toLowerCase() === labelName.toLowerCase());
    const targetLabelId = labelEntry ? labelEntry.id : null;

    for (const id of messageIds) {
        try {
            const msgRes = await fetch(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
                { headers: gmailHeaders }
            );
            if (!msgRes.ok) continue;

            const msg = await msgRes.json();
            const labelIds = msg.labelIds || [];
            if (targetLabelId && !labelIds.includes(targetLabelId)) continue;

            let bodyText = '';
            const parts = msg.payload && msg.payload.parts ? msg.payload.parts : [];
            for (const part of parts) {
                if (part.mimeType === 'text/plain' && part.body && part.body.data) {
                    bodyText += Buffer.from(part.body.data, 'base64').toString('utf8');
                }
            }
            if (msg.payload && msg.payload.body && msg.payload.body.data && parts.length === 0) {
                bodyText = Buffer.from(msg.payload.body.data, 'base64').toString('utf8');
            }

            const attachments = [];
            for (const part of msg.payload && msg.payload.parts ? msg.payload.parts : []) {
                if (part.filename && part.body && part.body.attachmentId) {
                    const attRes = await fetch(
                        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/attachments/${part.body.attachmentId}`,
                        { headers: gmailHeaders }
                    );
                    if (attRes.ok) {
                        const attJson = await attRes.json();
                        attachments.push({ filename: part.filename, data: attJson.data });
                    }
                }
            }

            // Resolve base URL: try main, then preview if main is unreachable
            let baseUrl = null;
            let instructions = '';
            for (const url of baseUrls) {
                const instructionsRes = await fetchOrNull(`${url}/api/get-instructions`, {
                    headers: apiKey ? { 'X-API-Key': apiKey } : {}
                });
                if (instructionsRes && instructionsRes.ok) {
                    const instructionsData = await instructionsRes.json().catch(() => ({}));
                    instructions = (instructionsData.content || '').trim();
                    baseUrl = url;
                    if (url === previewUrl) {
                        console.warn('gmail-push: using preview URL (main unreachable)', url);
                    }
                    break;
                }
            }
            if (!baseUrl) {
                console.error('gmail-push: both QUOTATION_APP_URL and preview unreachable, skipping message', id);
                continue;
            }

            const form = new FormData();
            form.append('emailContent', bodyText);
            form.append('instructions', instructions);
            attachments.forEach((att, i) => {
                form.append('enquiryFiles', Buffer.from(att.data, 'base64'), att.filename || `attachment-${i}`);
            });

            const genHeaders = { ...form.getHeaders() };
            if (apiKey) genHeaders['X-API-Key'] = apiKey;

            const genRes = await fetch(`${baseUrl}/api/generate-quotation`, {
                method: 'POST',
                headers: genHeaders,
                body: form
            });
            if (!genRes.ok) {
                console.error('gmail-push: generate-quotation failed', genRes.status, await genRes.text());
                continue;
            }

            const genJson = await genRes.json();
            const quotation = genJson.quotation;
            if (!quotation) {
                console.warn('gmail-push: no quotation in response');
                continue;
            }

            const saveRes = await fetch(`${baseUrl}/api/save-quotation`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(apiKey ? { 'X-API-Key': apiKey } : {})
                },
                body: JSON.stringify({ quotation })
            });
            if (!saveRes.ok) {
                console.error('gmail-push: save-quotation failed', saveRes.status, await saveRes.text());
            }
        } catch (e) {
            console.error('gmail-push: error processing message', id, e.message);
        }
    }
}

module.exports = { handleGmailPush };
