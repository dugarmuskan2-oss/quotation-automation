/**
 * tests/enquiry-walls-and-sender.test.js
 *
 * DSC-2930 (Enexio, 9 Oct 2026). One email, three of Enexio's projects, one PDF each, walls given
 * in mm. The quote was billed to an end client ("Max Cement Limited"), left one project out, and
 * turned walls into the wrong schedules (18" × 6.35 mm → "STD 9.53 mm"; 40 NB × 5.08 → Sch 40).
 *
 *   utils/wallThickness.js  — a seamless line's schedule comes from the live list's Thickness
 *                             column; a wall no row has stays as mm (no price, blank and red).
 *   utils/enquiryReading.js — the AI is shown who sent the email, and told the customer is the
 *                             sender's company and that every file is part of the enquiry.
 */

jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn() }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
    DynamoDBDocumentClient: { from: jest.fn(() => ({})) },
    ScanCommand: jest.fn(), GetCommand: jest.fn(), PutCommand: jest.fn(), QueryCommand: jest.fn(), UpdateCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-s3', () => ({ S3Client: jest.fn() }));
jest.mock('@google-cloud/storage', () => ({ Storage: jest.fn(() => ({ bucket: jest.fn(() => ({})) })) }));
jest.mock('openai', () => jest.fn(() => ({ files: {}, responses: {}, chat: { completions: {} } })));

const fs = require('fs');
const path = require('path');
const W = require('../utils/wallThickness');
const { ENQUIRY_READING_RULES, senderHeader } = require('../utils/enquiryReading');
const { processOneEmail } = require('../gmail-ingest/ingestLogic');
const { _test: PL } = require('../utils/priceList');

// Rows as the live seamless list has them (Size, Inch, NB, OD, SCH, Thickness …), trimmed.
const SEAMLESS = [
    ['Size', 'Inch', 'NB', 'OD (mm)', 'SCH', 'Thickness (mm)', 'Cost/Meter', 'Price per Meter'],
    ['11/2X40', '1 1/2', '40', '48.3', '40', '3.68', '404', '464'],
    ['11/2X80', '1 1/2', '40', '48.3', '80', '5.08', '535', '615'],
    ['2X40', '2', '50', '60.3', '40', '3.91', '521', '552'],
    ['2X80', '2', '50', '60.3', '80', '5.54', '716', '759'],
    ['8" X 20', '8', '200', '219.1', '20', '6.35', '3310', '3641'],
    ['8" X 30', '8', '200', '219.1', '30', '7.04', '3547', '3901'],
    ['10 " X 140 / XXS', '10', '250', '273.1', '140 / XXS', '25.4', '', ''],
    ["18'' X STD (9.53 MM)", '18', '450', '457.2', 'STD', '9.53', '11222', '12905'],
];
const byWall = W.buildScheduleByWall(SEAMLESS);
const seamless = (d) => ({ originalDescription: d, identifiedPipeType: 'CS Seamless Pipe as per ASTM 106 Gr. B' });

describe('schedule from the customer\'s wall', () => {
    test('40 NB × 5.08 mm is Sch 80 (the AI said Sch 40)', () => {
        const li = [seamless('11/2X40')];
        W.applyEnquiryWalls(li, ['5.08'], byWall);
        expect(li[0].originalDescription).toBe('11/2X80');
        expect(li[0].enquiryWallMm).toBe(5.08);
    });
    test('a wall printed 5.5 matches the list\'s 5.54 (within tolerance) → Sch 80', () => {
        expect(W.scheduleForWall(byWall, '2', 5.5)).toBe('80');
    });
    test('a wall nearer another schedule is NOT pulled to the wrong one', () => {
        expect(W.scheduleForWall(byWall, '2', 4.5)).toBeNull();   // between 3.91 and 5.54
    });
    test('18" × 6.35 mm is not a listed schedule → stays as mm, so it finds no price', () => {
        const li = [seamless('18XSTD')];
        const r = W.applyEnquiryWalls(li, [6.35], byWall);
        expect(li[0].originalDescription).toBe('18X6.35MM');
        expect(r).toEqual({ matched: 0, unmatched: 1 });
        const book = { seamless: { '18|std': 12905 }, versions: {} };
        expect(PL.checkLinePrice(book, li[0]).outcome).toBe('size-not-in-list');
    });
    test('the wall is read from the description when the AI put it there', () => {
        const li = [seamless('8X6.35'), seamless('2" NB X 5.5mm')];
        W.applyEnquiryWalls(li, [], byWall);
        expect(li.map(l => l.originalDescription)).toEqual(['8X20', '2X80']);
    });
    test('a bare whole number is a schedule, not a wall ("8X10" is left alone)', () => {
        expect(W.wallFromDescription('8X10')).toBeNull();
        expect(W.wallFromDescription('8X6.35')).toBe(6.35);
    });
    test('ERW lines are left alone — their walls are priced as walls', () => {
        const li = [{ originalDescription: '8X6.35', identifiedPipeType: 'ERW' }];
        W.applyEnquiryWalls(li, [6.35], byWall);
        expect(li[0].originalDescription).toBe('8X6.35');
    });
    test('"140 / XXS" in the SCH column reads as 140', () => {
        expect(W.scheduleForWall(byWall, '10', 25.4)).toBe('140');
    });
    test('when two rows are within tolerance, the closer wall wins (not the first row)', () => {
        const two = W.buildScheduleByWall([SEAMLESS[0],
            ['a', '8', '200', '219.1', '20', '6.35', '1', '1'],
            ['b', '8', '200', '219.1', 'X', '6.40', '1', '1']]);
        expect(W.scheduleForWall(two, '8', 6.39)).toBe('X');
        expect(W.scheduleForWall(two, '8', 6.36)).toBe('20');
    });
    test('sizes match however they are written ("1-1/2", "11/2", "1 1/2")', () => {
        expect(W.scheduleForWall(byWall, '1-1/2', 5.08)).toBe('80');
    });
});

describe('the AI sees who sent the email', () => {
    test('senderHeader gives From and Subject lines', () => {
        expect(senderHeader({ from: 'H.Henith <Henith@enexioindia.com>', subject: 'Enquiry regarding pipes' }))
            .toBe('From: H.Henith <Henith@enexioindia.com>\nSubject: Enquiry regarding pipes\n\n');
        expect(senderHeader({})).toBe('');
    });
    test('ingest sends the sender to the AI, but saves the email text unchanged', async () => {
        let sentToAi, saved;
        const ctx = {
            getInstructionsContent: async () => 'I', getDefaultTermsContent: async () => '',
            generateQuotationData: async (o) => { sentToAi = o.emailContent; return { lineItems: [] }; },
            getNextQuoteNumber: async () => 1, saveQuotation: async (q) => { saved = q; },
        };
        await processOneEmail(ctx, { id: 'm1', from: 'Henith@enexioindia.com', subject: 'S', body: 'Dear Sir' });
        expect(sentToAi.startsWith('From: Henith@enexioindia.com\n')).toBe(true);
        expect(saved.emailContent).toBe('Dear Sir');
    });
    test('the line item format names "unit" and "wallThicknessMm" (the saved format leaves both out)', () => {
        const shape = /"lineItems" must have ALL of these keys: (\{[^}]*\})/.exec(ENQUIRY_READING_RULES);
        expect(shape).not.toBeNull();
        const keys = Object.keys(JSON.parse(shape[1]));
        expect(keys).toEqual(expect.arrayContaining(['originalDescription', 'identifiedPipeType', 'quantity', 'unit', 'wallThicknessMm', 'kgPerMeter', 'unitRate']));
    });
    test('the rules say the customer is the sender, never a project, and every file counts', () => {
        expect(ENQUIRY_READING_RULES).toMatch(/company that SENT this enquiry/);
        expect(ENQUIRY_READING_RULES).toMatch(/NEVER use the name of an end client, project/);
        expect(ENQUIRY_READING_RULES).toMatch(/Extract the items of EVERY file/);
    });
    test('server.js adds the rules to the prompt and sets schedules before pricing', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
        expect(src).toMatch(/\$\{UNIT_AND_ITEM_RULES\}\$\{ENQUIRY_READING_RULES\}/);
        const iWall = src.indexOf('await setSchedulesFromEnquiryWalls(quotationData.lineItems');
        const iPrice = src.indexOf('await priceLinesFromPriceList(quotationData.lineItems)');
        expect(iWall).toBeGreaterThan(-1);
        expect(iPrice).toBeGreaterThan(iWall);
    });
});

describe('sizes written in NB (mm) match the inch-keyed lists', () => {
    const { parseDescription } = require('../utils/pipeWeights');
    test.each([
        ['25NBXH', '1'], ['50 NB X Heavy', '2'], ['150NBXSCH40', '6'], ['20NBX80', '3/4'], ['40 mm NB X Medium', '11/2'],
    ])('%s is %s inch', (d, inch) => expect(parseDescription(d).size).toBe(inch));
    test.each([
        ['2" NB X Sch 40', '2'], ['20" NB X Sch 20', '20'], ['2NBXM', '2'], ['11/2X80', '11/2'],
    ])('%s stays %s inch (inch mark, or not a bore in mm)', (d, inch) => expect(parseDescription(d).size).toBe(inch));
});

describe('pipe type rule (owner, 16 Oct 2026)', () => {
    test('standards → seamless; bare "seamless" with ERW grades → ERW; else ERW; overrides the saved rules', () => {
        expect(ENQUIRY_READING_RULES).toMatch(/PIPE TYPE — this OVERRIDES every pipe-type rule/);
        expect(ENQUIRY_READING_RULES).toMatch(/API 5L Gr\. B[\s\S]*ASTM A106 Gr\. B[\s\S]*ASTM A53[^\n]*→ "Seamless"|→ "Seamless": API 5L Gr\. B[^\n]*ASTM A106 Gr\. B[^\n]*ASTM A53/);
        expect(ENQUIRY_READING_RULES).toMatch(/says "seamless" \(with no standard above\) AND gives ERW grades[^\n]*→ "ERW"/);
        expect(ENQUIRY_READING_RULES).toMatch(/Everything else → "ERW"/);
        expect(ENQUIRY_READING_RULES).toMatch(/"Seamless pipe 2" Medium" → ERW/);
    });
});
