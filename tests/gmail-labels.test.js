/**
 * @jest-environment node
 *
 * tests/gmail-labels.test.js
 *
 * Tagging threads in Gmail the moment we send into them:
 *   Freight enquiry  -> Quotation Automation/Freight Enquiry
 *   Supplier enquiry -> Quotation Automation/Enquiry Sent by us
 *   Regret reply     -> Quotation Automation/Regret
 *
 * The rule that matters most here: a labelling failure must NEVER be reported as a
 * failed send. The mail has already left; the label is a filing detail. Until the
 * owner re-runs tools/gmail-auth.js for the gmail.modify scope, every one of these
 * calls fails with 403 — and sending has to carry on regardless.
 */

const { GMAIL_SENT_LABELS } = require('../utils/constants');
const { findOrCreateLabelId, _labelIdCache } = require('../utils/gmail')._test;
const { labelSentThread } = require('../routes/gmail')._test;

beforeEach(() => { _labelIdCache.clear(); });

// A stand-in for gmail.users.labels — records what it was asked to do.
function fakeLabels(existing, opts = {}) {
  const calls = { list: 0, create: [] };
  return {
    calls,
    api: {
      list: async () => { calls.list++; return { data: { labels: existing.slice() } }; },
      create: async ({ requestBody }) => {
        calls.create.push(requestBody.name);
        if (opts.conflict) {
          // Gmail's 409 when another send created the same label a moment earlier.
          existing.push({ id: 'RACE_WINNER', name: requestBody.name });
          const err = new Error('Label name exists or conflicts');
          err.code = 409;
          throw err;
        }
        const made = { id: 'NEW_' + calls.create.length, name: requestBody.name };
        existing.push(made);
        return { data: made };
      },
    },
  };
}

describe('the three label names', () => {
  test('all nest under Quotation Automation', () => {
    Object.values(GMAIL_SENT_LABELS).forEach(name => {
      expect(name.startsWith('Quotation Automation/')).toBe(true);
    });
  });

  test('names match what the user asked for, exactly', () => {
    expect(GMAIL_SENT_LABELS.freight).toBe('Quotation Automation/Freight Enquiry');
    expect(GMAIL_SENT_LABELS.supplier).toBe('Quotation Automation/Enquiry Sent by us');
    expect(GMAIL_SENT_LABELS.regret).toBe('Quotation Automation/Regret');
  });
});

describe('findOrCreateLabelId', () => {
  test('reuses a label that already exists instead of making a duplicate', async () => {
    const f = fakeLabels([{ id: 'L_EXISTING', name: 'Quotation Automation/Regret' }]);
    const id = await findOrCreateLabelId({ users: { labels: f.api } }, 'Quotation Automation/Regret');
    expect(id).toBe('L_EXISTING');
    expect(f.calls.create).toEqual([]);
  });

  test('matches case-insensitively — Gmail will not let you create a second Regret', async () => {
    const f = fakeLabels([{ id: 'L1', name: 'quotation automation/regret' }]);
    const id = await findOrCreateLabelId({ users: { labels: f.api } }, 'Quotation Automation/Regret');
    expect(id).toBe('L1');
    expect(f.calls.create).toEqual([]);
  });

  test('creates the label on first use, nested and visible', async () => {
    const existing = [];
    const f = fakeLabels(existing);
    const gmail = { users: { labels: f.api } };
    const id = await findOrCreateLabelId(gmail, 'Quotation Automation/Freight Enquiry');
    expect(id).toBe('NEW_1');
    expect(f.calls.create).toEqual(['Quotation Automation/Freight Enquiry']);
  });

  test('a 409 race is resolved by re-reading, not by failing the send', async () => {
    const f = fakeLabels([], { conflict: true });
    const id = await findOrCreateLabelId({ users: { labels: f.api } }, 'Quotation Automation/Regret');
    expect(id).toBe('RACE_WINNER');
  });

  test('caches the id so a second send does not re-list the mailbox', async () => {
    const f = fakeLabels([{ id: 'L1', name: 'Quotation Automation/Regret' }]);
    const gmail = { users: { labels: f.api } };
    await findOrCreateLabelId(gmail, 'Quotation Automation/Regret');
    await findOrCreateLabelId(gmail, 'Quotation Automation/Regret');
    expect(f.calls.list).toBe(1);
  });

  test('a non-409 failure is surfaced, not silently swallowed here', async () => {
    const boom = {
      list: async () => ({ data: { labels: [] } }),
      create: async () => { const e = new Error('backend error'); e.code = 500; throw e; },
    };
    await expect(findOrCreateLabelId({ users: { labels: boom } }, 'X')).rejects.toThrow('backend error');
  });
});

describe('labelSentThread — the send must survive a labelling problem', () => {
  const quiet = () => jest.spyOn(console, 'error').mockImplementation(() => {});

  test('a missing scope (403) does not throw — it just reports false', async () => {
    const spy = quiet();
    jest.resetModules();
    jest.doMock('../utils/gmail', () => ({
      sendEmail: jest.fn(), lookupMessageThread: jest.fn(),
      fetchThreadMessages: jest.fn(), searchContactSuggestions: jest.fn(),
      applyLabelToThread: async () => { const e = new Error('Insufficient Permission'); e.code = 403; throw e; },
    }));
    const isolated = require('../routes/gmail')._test.labelSentThread;
    await expect(isolated('T1', 'regret')).resolves.toBe(false);
    spy.mockRestore();
    jest.dontMock('../utils/gmail');
    jest.resetModules();
  });

  // These next tests must observe WHAT WAS CALLED, not the return value.
  //
  // In a jest process there are no GMAIL_* env vars, so createGmailClient throws and the
  // fail-soft catch turns every single call into `false` — valid key, unknown key, no thread,
  // all identical. Asserting `resolves.toBe(false)` therefore passed just as happily with the
  // guards deleted. Recording the calls to applyLabelToThread is what gives these teeth.
  function withRecorder() {
    jest.resetModules();
    const calls = [];
    jest.doMock('../utils/gmail', () => ({
      sendEmail: jest.fn(), lookupMessageThread: jest.fn(),
      fetchThreadMessages: jest.fn(), searchContactSuggestions: jest.fn(),
      applyLabelToThread: async (threadId, name) => { calls.push([threadId, name]); return true; },
    }));
    const fn = require('../routes/gmail')._test.labelSentThread;
    return { fn, calls, done: () => { jest.dontMock('../utils/gmail'); jest.resetModules(); } };
  }

  test('a known key really does label the thread, with the right label name', async () => {
    const r = withRecorder();
    await expect(r.fn('T1', 'regret')).resolves.toBe(true);
    expect(r.calls).toEqual([['T1', 'Quotation Automation/Regret']]);
    r.done();
  });

  test('an unknown label key never reaches Gmail — no stray label can be created', async () => {
    const r = withRecorder();
    await r.fn('T1', 'nonsense');
    await r.fn('T1', '');
    await r.fn('T1', undefined);
    expect(r.calls).toEqual([]);
    r.done();
  });

  test('a send with no thread id never reaches Gmail', async () => {
    const r = withRecorder();
    await r.fn('', 'regret');
    await r.fn(null, 'regret');
    expect(r.calls).toEqual([]);
    r.done();
  });

  test('the SHORT key is accepted in any case; a raw label name is not a key', async () => {
    const r = withRecorder();
    await expect(r.fn('T1', 'REGRET')).resolves.toBe(true);
    await r.fn('T2', 'Quotation Automation/Regret');   // a label name is not a key
    expect(r.calls).toEqual([['T1', 'Quotation Automation/Regret']]);
    r.done();
  });

  test('every key in the map is wired to its label', async () => {
    const r = withRecorder();
    await r.fn('A', 'freight');
    await r.fn('B', 'supplier');
    expect(r.calls).toEqual([
      ['A', 'Quotation Automation/Freight Enquiry'],
      ['B', 'Quotation Automation/Enquiry Sent by us'],
    ]);
    r.done();
  });
});

describe('source guards — the send paths ask for their label', () => {
  const fs = require('fs');
  const path = require('path');
  const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

  test('the Regret button sends label: regret', () => {
    const html = read('index.html');
    expect(html).toMatch(/replyToMessageId: q\.gmailMessageId[\s\S]{0,300}label: 'regret'/);
  });

  test('the freight enquiry sends label: freight', () => {
    expect(read('freight-tab-weight-editor.js')).toContain("label: 'freight'");
  });

  test('the supplier enquiry sends label: supplier', () => {
    expect(read('quote-enquiry-tab.js')).toContain("label: 'supplier'");
  });

  test('gmail-auth requests the gmail.modify scope that labelling needs', () => {
    expect(read('tools/gmail-auth.js')).toContain('auth/gmail.modify');
  });

  test('the Apps Script no longer guesses regrets from their wording', () => {
    const gs = read('apps-script/GmailLabelReport.gs');
    expect(gs).toContain('Quotation Automation/Freight Enquiry');
    expect(gs).toContain('Quotation Automation/Enquiry Sent by us');
    // The editable regret wording is not a dependable search key — the app labels those.
    expect(gs).not.toContain('we will not be able to quote for your requirement');
  });
});
