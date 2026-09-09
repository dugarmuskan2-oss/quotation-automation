/**
 * Gmail Ingest – Description and pipe-type formatting
 * Mirrors the rules used in the Creation/Approval UI so report-created quotes match manual quotes.
 * (See index.html: normalizeFractionText, isNumericLikeToken, formatItemDescriptionByPipeType, getPipeHeaderLabel)
 *
 * This is a manual mirror, not a shared module, and it had drifted: this copy was missing the
 * NB mm->inch conversion, the A/B/C class-letter fallback, and Light-class matching entirely —
 * three features index.html had gained one at a time with nothing to notice this one falling
 * behind. tests/description-format.test.js now asserts the two agree (see "convergence:
 * frontend and Gmail-ingest formatter must produce the same output") specifically so the next
 * feature added to one side cannot go quietly missing from the other again.
 *
 * Wrapped in an IIFE — required now that this file is ALSO loaded as a plain browser <script>
 * (index.html, so the Freight tab's enquiry table can reuse it). Un-wrapped, every const and
 * function here would land in the page's global scope alongside index.html's own ~12,000 lines,
 * and it already collided once: this file's own NB_MM_TO_INCH is the exact same name index.html
 * declares for the exact same table, and two top-level `const NB_MM_TO_INCH` on one page is a
 * SyntaxError that broke every inline script on the page, not just this feature.
 */
(function () {
'use strict';

/**
 * Normalize fraction characters and spacing for parsing (e.g. ¼ -> 1/4, "1 1/2" -> "1-1/2").
 * @param {string} text
 * @returns {string}
 */
function normalizeFractionText(text) {
    if (!text) return text;
    const fractionMap = {
        '¼': '1/4', '½': '1/2', '¾': '3/4',
        '⅛': '1/8', '⅜': '3/8', '⅝': '5/8', '⅞': '7/8',
        '⅓': '1/3', '⅔': '2/3'
    };
    let normalized = String(text)
        .replace(/ /g, ' ')
        .replace(/⁄/g, '/');
    normalized = normalized.replace(/(\d)([¼½¾⅛⅜⅝⅞⅓⅔])/g, '$1 $2');
    normalized = normalized.replace(/[¼½¾⅛⅜⅝⅞⅓⅔]/g, m => fractionMap[m] || m);
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

// NB (nominal bore, mm) -> inch string. Customers often write "125 NB", "65 NB", and GPT passes
// the bare mm number through (e.g. "125XC"); this converts it to inches, matching index.html's
// copy of the same table exactly (see the comment there for why 6, 8 and 10 are deliberately
// left out: they are also completely ordinary bare-inch sizes, and this business quotes 6", 8"
// and 10" pipe constantly, so converting them down to 1/8", 1/4" and 3/8" would be wrong far
// more often than right). This table did not exist here before, so a manufacturer's email
// naming a size in mm-NB (e.g. "125 NB Heavy") ingested from Gmail rendered as a 125-inch pipe.
const NB_MM_TO_INCH = {
    '15':'1/2','20':'3/4',
    '25':'1','32':'1-1/4','40':'1-1/2','50':'2','65':'2-1/2',
    '80':'3','90':'3-1/2','100':'4','125':'5','150':'6',
    '200':'8','250':'10','300':'12','350':'14','400':'16',
    '450':'18','500':'20','600':'24'
};

/**
 * Format item description using pipe-type rules (e.g. "1XH" + ERW -> "1\" NB X Heavy -- ERW").
 * @param {{ originalDescription?: string, identifiedPipeType?: string }} item
 * @returns {string}
 */
function formatItemDescriptionByPipeType(item) {
    const raw = (item.originalDescription || '').trim();
    if (!raw) return raw;

    const pipeType = (item.identifiedPipeType || '').toLowerCase();
    let normalized = normalizeFractionText(raw.replace(/["]/g, '').trim());
    // Garbled AI codes double the separator "X" (e.g. "2XXH", "1XXHY"); collapse it so the
    // size↔class split still parses. Skip seamless — its "XXS" schedule legitimately has "XX".
    if (!pipeType.includes('seamless')) {
        normalized = normalized.replace(/x{2,}/gi, 'X');
    }
    const numberToken = '\\d+(?:\\.\\d+)?|\\d+-\\d+\\/\\d+|\\d+\\/\\d+';
    const nxhMatch = normalized.match(new RegExp(`^(${numberToken})\\s*[xX]\\s*(h|hy|hv|hvy|heavy|hevy)$`, 'i'));
    const nxmMatch = normalized.match(new RegExp(`^(${numberToken})\\s*[xX]\\s*(m|med|medium)$`, 'i'));
    // Light class, and its own case: "2XL" had no match here at all (no nxlMatch, no lightTokens
    // below), so a genuinely Light-class pipe fell all the way through to `return normalized`
    // and reached a customer as the raw code "2XL" rather than '2" NB X Light -- ERW'.
    const nxlMatch = normalized.match(new RegExp(`^(${numberToken})\\s*[xX]\\s*(l|lgt|light)$`, 'i'));
    const xMatch = normalized.match(new RegExp(`(${numberToken})\\s*[xX]\\s*([A-Za-z0-9.\\/-]+)`));
    const hMatch = normalized.match(new RegExp(`^(${numberToken})\\s*(h|hy|hv|hvy|heavy|hevy)$`, 'i'));
    const mMatch = normalized.match(new RegExp(`^(${numberToken})\\s*(m|med|medium)$`, 'i'));
    const schMatch = normalized.match(new RegExp(`^(${numberToken})\\s*(?:sch|schedule)\\s*(\\d+(?:\\.\\d+)?)$`, 'i'));

    let first = '';
    let secondDisplay = '';
    let secondClean = '';
    let isHeavy = false;
    let isMedium = false;
    let isLight = false;
    let isSch = false;

    if (nxhMatch) {
        first = nxhMatch[1];
        secondDisplay = nxhMatch[2];
        secondClean = nxhMatch[2].toLowerCase();
        isHeavy = true;
    } else if (nxmMatch) {
        first = nxmMatch[1];
        secondDisplay = nxmMatch[2];
        secondClean = nxmMatch[2].toLowerCase();
        isMedium = true;
    } else if (nxlMatch) {
        first = nxlMatch[1];
        secondDisplay = nxlMatch[2];
        secondClean = nxlMatch[2].toLowerCase();
        isLight = true;
    } else if (xMatch) {
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

    // Convert NB mm -> inch if `first` is a known NB value (e.g. 25 -> 1, 50 -> 2). Computed
    // before the seamless branch so every pipe type uses it, matching index.html.
    const displayFirst = NB_MM_TO_INCH[String(Math.round(parseFloat(first)))] || first;

    if (pipeType.includes('seamless')) {
        // Named ANSI schedules (XS, XXS, STD, etc.) format like numeric ones. Missing here
        // before, so a genuine "2XXS" (extra-extra-strong) or "4XSTD" fell through unformatted.
        const namedSchedules = ['xs', 'xxs', 'std', 'sxs', 's'];
        if (isSch || isNumericLikeToken(secondClean)) {
            return `${displayFirst}" NB X Sch ${secondDisplay || secondClean}`;
        }
        if (namedSchedules.includes(secondClean)) {
            return `${displayFirst}" NB X Sch ${(secondDisplay || secondClean).toUpperCase()}`;
        }
        return normalized;
    }

    const isGi = pipeType.includes('gi') || pipeType.includes('galvanized');
    const isErw = pipeType.includes('erw');
    if (!isGi && !isErw) return raw;

    const pipeLabel = isGi ? 'GI' : 'ERW';
    // Class letters: C Class = Heavy, B Class = Medium, A Class = Light. Missing here before —
    // an un-normalized code like "125XC" (a real, reported case on the frontend side) had no
    // heavy/medium/light match at all server-side and returned raw.
    const heavyTokens = ['h', 'hy', 'hv', 'hvy', 'heavy', 'hevy', 'c', 'cclass'];
    const mediumTokens = ['m', 'med', 'medium', 'b', 'bclass'];
    const lightTokens = ['l', 'lgt', 'light', 'a', 'aclass'];

    if (isHeavy || heavyTokens.includes(secondClean)) {
        return `${displayFirst}" NB X Heavy -- ${pipeLabel}`;
    }
    if (isMedium || mediumTokens.includes(secondClean)) {
        return `${displayFirst}" NB X Medium -- ${pipeLabel}`;
    }
    if (isLight || lightTokens.includes(secondClean)) {
        return `${displayFirst}" NB X Light -- ${pipeLabel}`;
    }
    if (isNumericLikeToken(secondClean)) {
        return `${displayFirst}" NB X ${secondDisplay || secondClean}mm thk -- ${pipeLabel}`;
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

const api = {
    normalizeFractionText,
    isNumericLikeToken,
    formatItemDescriptionByPipeType,
    getPipeHeaderLabel
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;

// The Freight tab's own enquiry table needs the SAME formatting index.html's approval table
// uses — it had none at all, and sent transporters the AI's raw compact code ("8X6.35") instead
// of a readable size. Loading this one file in the browser, rather than writing a third copy,
// is exactly what keeps this function from drifting between callers the way it already had
// between index.html and this file (see the header comment above).
//
// `module` does not exist in a plain browser <script> tag, so it cannot be referenced at all
// here — even inside a typeof-guarded branch, evaluating `module.exports` throws before the
// guard is reached, because the property access on `module` happens first. `api`, a local
// const, is what both exports actually use.
if (typeof window !== 'undefined') window.descriptionFormatter = api;

})();
