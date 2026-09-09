# Partner Directory — rules for the data itself

**Strict.** These govern what a card may hold and what may be done to it, wherever the data
comes from — a Google import, a tagged email, a brochure, or the owner typing. They are not
about reading the address book; that is `CONTACT-EXPORT-RULES.md`. These are about the
database.

Every rule here exists because it was broken on real data and cost something.

---

## 0. Nothing is ever excluded

**Every piece of information that arrives ends up somewhere on a card.** No threshold, no "not
worth keeping". Where a field for it does not exist, it goes in `notes` word for word, or a
field is added. It is never discarded.

This includes data that fails validation. A malformed address, a nine-digit mobile, a number
with letters in it — **kept, and marked as needing his eye**. Silently dropping it destroys the
only record of what he wrote.

## 0a. Nothing is ever silently changed

A value is stored **as written**. Not reformatted, not completed, not corrected. `904743223` is
nine digits and stays nine digits. The one exception is unwrapping — `<>`, quotes, a typed
`e-mail:` label — because that is removing packaging, not editing content.

Where a correction is genuinely wanted, **the owner says so**. He decided 984093660 was a typo
of 9840939660 and that it should go; nobody inferred that.

## 0c. A name is left exactly as he typed it

Some rows are named after the mailbox rather than a person — "KRS Chennai - Madhavaram",
"Kerala Roadways (P) Ltd - Chennai Transhipment". That is how he saved them in Google, and
*his decision is to leave them exactly as written.* Tidying a name into what the app thinks it
should be is the same silent editing as fixing a phone number.

The one exception already agreed: a name GUESSED from an email domain gives way to a real name
found in the notes — because the guess was never his writing in the first place.

---

## 0b. Where a thing goes is a question, not a judgement call

If it is unclear which field a piece of information belongs in, **ask him at the time** — not
in a batch at the end, and never by picking the likelier option quietly. Record the answer in
this file or in `CONTACT-EXPORT-RULES.md` so it is not asked twice.

---

## 1. The card

| Field | Rules |
|---|---|
| `company` | As written. A name read from source beats one guessed from an email domain. |
| `gst` | The firm's GST number, upper-cased, stored as written, never validated. |
| `city` / `address` | Head office only. |
| `branches[]` | `{city, area, address}` — every other office, factory, depot, godown. |
| `people[]` | `{name, role, branch, phones[], emails[]}`. `role` is the job, `branch` is where they sit. |
| `types[]` | GI / ERW / Seamless / SS / MS / Alloy. |
| `products[]` | `{p, spec}`. |
| `moq` | `0` means *not set*, never "zero tonnes". |
| `partLoad` | **Three states.** `true` / `false` / `null`. `null` is "not answered" and must never be shown as "no". |
| `role` (trade) | Blank means nobody has chosen. `'other'` is a real choice and is not the same thing. |
| `notes[]` | `{t, d}` — the last resort, and the only place free text lives. |

---

## 2. Identity — when two things are one thing

**Firms** are matched on: email **domain**, tidied name, or a shared phone. Never on the raw
address string — Bombay Hardware sat in the queue under `bhplsales@` while its other card
carried `accounts@`, and nothing matched.

**People on one card** are matched on:

- a shared **email** → the same person, whatever the names look like. "Mahesh Pardeshi" and
  "MAHESH PERDESH" both hold `mahesh.pardeshi@jindalsaw.com`.
- a shared **phone** (6+ digits) → the same person **only if the names are compatible**. Two
  people are written against 8600107980 and they are two people. *Owner's decision: keep both,
  both carry the number.*
- the same **name**, when one of them has no number and no address at all. Three empty ASHOK
  rows are one Ashok. Two men called Kumar who each have their own number are two men.
- **A different branch means a different row.** *Owner's decision:* a man covering Bombay and
  Nasik is listed under each, same numbers on both.

Six digits is the threshold for matching people **on one card**; ten is the threshold for
telling **firms** apart. An 8-digit Chennai landline under the ten-digit rule counted as no key
at all, so a nameless office row never matched itself and every re-run added another copy.

---

## 3. Free mail is not a firm

One list, in `utils/contacts.js`, used everywhere. Gmail, Yahoo, Rediffmail and the Indian ISP
domains — vsnl, bsnl, mtnl, sify, airtelmail, dataone, satyam, eth. `vsnl.net` alone put 47
unrelated people on one card called "Vsnl", which reached the directory as a transporter.

There were two such lists and the short one had no ISPs on it. Two lists drift. One list.

---

## 4. Writes

- **Every write is a read-modify-write of ONE partner, scoped to the fields that changed.**
  Never a whole-list overwrite from the client.
- **A blank never replaces a stored answer.** The review copy is frozen when an item is queued;
  approving it three days later was overwriting a city and address typed since.
- **A stale copy never reasserts a server-owned field** — `enq`, `rep`, `last`, `checked`.
- **Approving merges, it does not replace.** Everything on both copies survives.
- **A thin card never blocks a rich one.** A firm was skipped because *one* of its eight
  addresses was already known, so the owner saw a one-line card while the eight-person version
  was thrown away.
- **A card already approved is settled.** A re-read may improve a card still waiting; it may
  never rewrite one he has approved.

---

## 5. Deletions

**Anything deleted goes to Recent changes and needs approving.** *Owner's rule.* Removals are
matched by value, never by index — a list that shifted under an index removal would delete the
wrong thing.

---

## 6. The server must know the field

**A field added to the model is not real until the server runs the new code.** The dev server
was running a build from before `branch` existed, so the moment a card saved it stripped the
field off all thirteen people — the browser showed the right thing and the server threw it
away.

This applies to the live site too. **Push before using a new field**, or every save silently
drops it.

---

## 7. Nothing reaches the directory without approval

Every import writes to the waiting list or the queue. Every tool has a dry run by default.
The owner approves one firm at a time. There is no bulk path into the directory and there
must not be one.
