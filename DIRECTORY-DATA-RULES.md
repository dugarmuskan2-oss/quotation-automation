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

---

## 0b. Where a thing goes is a question, not a judgement call

If it is unclear which field a piece of information belongs in, **ask him at the time** — not
in a batch at the end, and never by picking the likelier option quietly. Record the answer in
this file or in `CONTACT-EXPORT-RULES.md` so it is not asked twice.

---

## 0c. A name is left exactly as he typed it

Some rows are named after the mailbox rather than a person — "KRS Chennai - Madhavaram",
"Kerala Roadways (P) Ltd - Chennai Transhipment". That is how he saved them in Google, and
*his decision is to leave them exactly as written.* Tidying a name into what the app thinks it
should be is the same silent editing as fixing a phone number.

The one exception already agreed: a name GUESSED from an email domain gives way to a real name
found in the notes — because the guess was never his writing in the first place.

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
| `categories[]` | The phone-book headings the firm is filed under, WORD FOR WORD. |

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

## 4a. The heading of the page is the best thing on it

His phone book is filed by trade — "P(13) PURCHASE DEP - ERW MFG (SCAFFOLDING TUBE)",
"P(20) PURCHASE DEP. ( SQUAR PIPE)", "PD (1) PIPE DEALER (STOCKIST)-BOMBAY (MUMBAI)". That
heading says what a firm does better than anything in its own entry, and **every firm on that
page shares it**. One firm can be on several: APL Apollo is under ERW MFG and under SQUARE PIPE.

*Owner's decisions:* the category is the heading **word for word** — filing code and city and
all, because that is how he wrote them and how he will look for them. A page headed
"<FIRM> (ALL DETAILS)" is about one firm rather than a trade and gives **no** category.

---

## 4d. A note about ONE person belongs beside their name

Apollo carried the same fact three times — "MET IN EXIBITION ON 7.6.2018 (Sadeep P B S)",
"SANDEEP BPS MET IN CHENNAI EXIBITION", "SANDEEP BPS MET IN CHENNAI EXHIBITION" — three notes
you had to read to learn one thing about one man.

*Owner's decision:* it reads **"Sandeep (met in chennai exhibition 7.6.2018)"**, in brackets
after his name. This is HIS edit of his own name, not the app tidying one — §0c still stands.

Placement is his call each time: he chose the name here rather than the job box or a new
field, and a note naming a person is not automatically moved.

---

## 4e. A card links only to cards that exist

Apollo names 30 dealers; ONE is in the directory and 25 are still in the waiting list. *Owner's
decision: leave them plain until they reach the queue through the normal button.* Clicking a
name must never quietly pull a firm into his queue — what is in front of him to approve is his
to decide.

---

## 4c. What was written under a firm stays on that firm

Apollo's page carries "TATA — SANTOSH STEEL is their dealer" and "SURYA — SANTOSH STEEL is
their dealer" — notes about a THIRD party's dealer, sitting on Apollo's card because that is
the page he wrote them on. *Owner's decision: if it was under Apollo, let it stay.*

The page a thing was written on is part of what it means. Moving a note to where the app
thinks it belongs loses the reason it was written there, and he is the one who filed it.
This is the same rule as §4a from the other side: the heading is information, so is the page.

---

## 4b. One product range, not three copies of it

APL Apollo's range came out three times — the whole thing and both of its halves — because
the same range is written in four different contacts and each reading split it differently.
The label he typed in front of it ("PRODUCT RANGE :") is not part of the product, and a line
wholly contained in another adds nothing. The **longest wording wins**, being the one that
holds every part. A line with a different SPEC is a different product and is kept.

---

## 5. Deletions

**Anything deleted from the DIRECTORY goes to Recent changes and needs approving.**
*Owner's rule.* Removals are matched by value, never by index — a list that shifted under an
index removal would delete the wrong thing.

**On a card still WAITING for approval, ✕ just deletes.** There is nothing to request: the
review copy is the only place that row exists, and the card is not in the directory yet. This
was got wrong — ✕ asked the server to remove from the directory, the server answered "that card
is no longer in the directory", and the row silently stayed put. Pressing it did nothing at all.

The rule generalises: **a control that means two things on two screens must be told which
screen it is on.**

---

## 5a. A field the owner cannot see is a field he does not have

The branch name was an editable input the whole time, styled to read as a heading until
hovered. He reported it as not editable twice, and he was right to: if it does not look like a
field, it is not one. It now carries a visible border.

**Judge an interface by what it looks like it does, not by what the code allows.**

---

## 5b. Things that belong together go together

A branch's town and address lived in a "Where they are" section at one end of the card while
the people who work there sat at the other, and the branch name appeared in both with nothing
to say they were the same thing. *Owner's instruction:* one block per branch — its name, its
address, its people.

A field that exists in two places on one card is a field the owner has to reconcile by hand.

---

## 6. The server must know the field

**A field added to the model is not real until the server runs the new code.** The dev server
was running a build from before `branch` existed, so the moment a card saved it stripped the
field off all thirteen people — the browser showed the right thing and the server threw it
away.

This applies to the live site too. **Push before using a new field**, or every save silently
drops it.

---

## 6a. Check the measurement before reporting it

A count is a claim and it can be wrong. Reported "1,108 phone numbers missing" — the matcher
was reading across newlines and gluing the next list number onto the phone above it, so
`8446241136)\n6` came out as one eleven-digit number. Reported "64 mangled numbers" — 63 were
ordinary Chennai landlines with an STD code, and exactly one was mangled. Reported "441
customers held back" — `gmail.com` had got into the customer list, so every supplier with a
Gmail address was being excluded.

**Before quoting a number, look at a handful of the rows behind it.** Each of those three would
have caused real damage if acted on unchecked.

---

## 6b. Fix one card properly before touching fifty

Taking Kerala Roadways end to end found five bugs that affected all forty-seven: the 8-digit
landline that counted as no match key, people with no number never merging, ✕ doing nothing,
the branch field that did not look like one, and the address split from its people. None of
them were visible from a survey of the whole set — they only appeared when one card had to be
actually correct.

---

## 7. Nothing reaches the directory without approval

Every import writes to the waiting list or the queue. Every tool has a dry run by default.
The owner approves one firm at a time. There is no bulk path into the directory and there
must not be one.
