/**
 * Gmail Ingest – Description and pipe-type formatting
 * Mirrors the rules used in the Creation/Approval UI so report-created quotes match manual quotes.
 * (See index.html: normalizeFractionText, isNumericLikeToken, formatItemDescriptionByPipeType, getPipeHeaderLabel)
 */

/**
 * Normalize fraction characters and spacing for parsing (e.g. ¼ -> 1/4, "1 1/2" -> "1-1/2").
 * @param {string} text
 * @returns {string}
 */
function normalizeFractionText(text) {
    if (!text) return text;
    const fractionMap = {
        '\u00BC': '1/4', '\u00BD': '1/2', '\u00BE': '3/4',
        '\u215B': '1/8', '\u215C': '3/8', '\u215D': '5/8', '\u215E': '7/8',
        '\u2153': '1/3', '\u2154': '2/3'
    };
    let normalized = String(text)
        .replace(/\u00A0/g, ' ')
        .replace(/\u2044/g, '/');
    normalized = normalized.replace(/(\d)([\u00BC\u00BD\u00BE\u215B\u215C\u215D\u215E\u2153\u2154])/g, '$1 $2');
    normalized = normalized.replace(/[\u00BC\u00BD\u00BE\u215B\u215C\u215D\u215E\u2153\u2154]/g, m => fractionMap[m] || m);
    normalized = normalized.replace(/\s+/g, ' ').trim();
    normalized = normalized.replace(/(\d+)\s+(\d+\/\d+)/g, '$1-$2');
    normalized = normalized.replace(/(\d)(\d)\/(\d)(?=\D|$)/g, '$1-$2/$3');
    return normalized;
}

/**
 * @param {string} token
 * @returns {boolean}
 */
function isNumericLikeToken(token) {
    if (!token) return false;
    return /^\d+(\.\d+)?$/.test(token) || /^\d+\/\d+$/.test(token) || /^\d+-\d+\/\d+$/.test(token);
}

/**
 * Format item description using pipe-type rules (e.g. "1XH" + ERW -> "1\" NB X Heavy -- ERW").
 * @param {{ originalDescription?: string, identifiedPipeType?: string }} item
 * @returns {string}
 */
function formatItemDescriptionByPipeType(item) {
    const raw = (item.originalDescription || '').trim();
    if (!raw) return raw;

    const pipeType = (item.identifiedPipeType || '').toLowerCase();
    const normalized = normalizeFractionText(raw.replace(/["]/g, '').trim());
    const numberToken = '\\d+(?:\\.\\d+)?|\\d+-\\d+\\/\\d+|\\d+\\/\\d+';
    const xMatch = normalized.match(new RegExp(`(${numberToken})\\s*[xX]\\s*([A-Za-z0-9.\\/-]+)`));
    const hMatch = normalized.match(new RegExp(`^(${numberToken})\\s*(h|hv|hvy|heavy|hevy)$`, 'i'));
    const mMatch = normalized.match(new RegExp(`^(${numberToken})\\s*(m|med|medium)$`, 'i'));
    const schMatch = normalized.match(new RegExp(`^(${numberToken})\\s*(?:sch|schedule)\\s*(\\d+(?:\\.\\d+)?)$`, 'i'));

    let first = '';
    let secondDisplay = '';
    let secondClean = '';
    let isHeavy = false;
    let isMedium = false;
    let isSch = false;

    if (xMatch) {
        first = xMatch[1];
        secondDisplay = normalizeFractionText((xMatch[2] || '').trim());
        secondClean = secondDisplay.toLowerCase().replace(/[^a-z0-9]/g, '');
    } else if (hMatch) {
        first = hMatch[1];
        secondDisplay = hMatch[2];
        secondClean = secondDisplay.toLowerCase();
        isHeavy = true;
    } else if (mMatch) {
        first = mMatch[1];
        secondDisplay = mMatch[2];
        secondClean = secondDisplay.toLowerCase();
        isMedium = true;
    } else if (schMatch) {
        first = schMatch[1];
        secondDisplay = schMatch[2];
        secondClean = secondDisplay.toLowerCase();
        isSch = true;
    } else {
        return normalized;
    }

    if (pipeType.includes('seamless')) {
        if (isSch || isNumericLikeToken(secondClean)) {
            return `${first}" NB X Sch ${secondDisplay || secondClean}`;
        }
        return normalized;
    }

    const isGi = pipeType.includes('gi') || pipeType.includes('galvanized');
    const isErw = pipeType.includes('erw');
    if (!isGi && !isErw) return raw;

    const pipeLabel = isGi ? 'GI' : 'ERW';
    const heavyTokens = ['h', 'hv', 'hvy', 'heavy', 'hevy'];
    const mediumTokens = ['m', 'med', 'medium'];

    if (isHeavy || heavyTokens.includes(secondClean)) {
        return `${first}" NB X Heavy -- ${pipeLabel}`;
    }
    if (isMedium || mediumTokens.includes(secondClean)) {
        return `${first}" NB X Medium -- ${pipeLabel}`;
    }
    if (isNumericLikeToken(secondClean)) {
        return `${first}" NB X ${secondDisplay || secondClean}mm thk -- ${pipeLabel}`;
    }
    return normalized;
}

/**
 * Standardized pipe-type header label (matches frontend getPipeHeaderLabel).
 * @param {string} pipeType
 * @returns {string}
 */
function getPipeHeaderLabel(pipeType) {
    const value = (pipeType || '').toLowerCase();
    if (value.includes('seamless')) return 'CS Seamless Pipe as per ASTM 106 Gr. B';
    if (value.includes('gi') || value.includes('galvanized')) return 'MS GI Pipe as per IS 1239/ 3589';
    if (value.includes('erw')) return 'MS ERW Pipe as per IS 1239/ 3589';
    return pipeType || 'Items';
}

module.exports = {
    normalizeFractionText,
    isNumericLikeToken,
    formatItemDescriptionByPipeType,
    getPipeHeaderLabel
};
