# What still has to be done to every card

Two cards have been taken end to end — **Kerala Roadways** and **APL Apollo**. Some of what was
needed is now done automatically for every card; the rest was done **by hand on those two only**
and still has to be done for the other 46 in the queue, and the 2,000-odd behind them.

This is the list. Nothing here is a rule — the rules are in `DIRECTORY-DATA-RULES.md` and
`CONTACT-EXPORT-RULES.md`. This is the work.

---

## Already automatic — nothing to repeat

These were bugs, and fixing them fixed every card at once:

| Fix | What it did |
|---|---|
| 8-digit landline counts as a match key | folded 37 duplicate rows |
| A bare person merges on their name | the three empty ASHOK rows |
| ✕ deletes on a card not yet approved | delete works |
| Branch lifted out of a job title | 260 people, 58 cards |
| Branch taken from a row's own name | 18 rows |
| A firm's real name beats a domain guess | "Md4" → "Hydraulic & Pneumatic" |
| Product range de-duplicated | 9 lines |
| Categories from the phone-book heading | 98 tags on 31 cards |
| Relation notes gathered by kind and place | Apollo: 63 notes → one block |
| Heading notes hidden once shown as a category | — |
| Customers held back | 66 firms |
| Trunk lines split into ringable numbers | 102 numbers |

---

## Done BY HAND on Kerala Roadways — repeat for every card

1. **GST pulled out of the notes into its own box.** `GST NO : 32AAACK1383P1ZE` was sitting in
   the notes text. The field exists now, but nothing populates it from the notes.
2. **Two Stalin rows folded into one**, and the 9-digit `984093660` dropped as a typo of
   `9840939660`. *His call — never inferred.* Other cards will have the same shape.
3. **Ashok given `mdsmv@krs.in`**, which had gone to the firm instead of to him. The rule is
   written down (an address beside a name is that person's) but the existing cards were read
   before it.
4. **`25297907` relabelled Fax**, because another contact says `FAX NO`. Nothing cross-checks
   contacts for this yet — one card was found still mentioning FAX with nothing labelled.
5. **A duplicated `9840872540` removed** from the office row.

## Done BY HAND on APL Apollo — repeat for every card

6. **Sandeep's two rows folded into one** — "SANDEEP BPS" (no number) and "SADEEP P B S" (two
   numbers). Different spellings and neither row was bare, so the automatic merge does not
   catch it.
7. **"MR. MUDI" twice, folded.**
8. **Three exhibition notes moved into his name** as
   `SADEEP P B S (met in chennai exhibition 7.6.2018)`. *Placement is his call each time.*

---

## Measured across the 46 cards in the queue

Counted, not guessed. These are what the two cards above predict for the rest:

| | Count |
|---|---|
| Cards with branches but people not filed under any | **24** |
| The same number twice on one card | **29** |
| Two rows sharing a name | 2 |
| Rows with no number and no address | 38 |
| A card mentioning FAX with nothing labelled Fax | 1 |
| Numbers glued together (`044` + an existing local number) | 1 |

Two of these the owner was asked about and **has not yet decided**, so nothing was done:

- **The 29 repeated numbers.** Two people CAN share a number — that is his rule — so a repeat
  is only a duplicate when one of the rows has no name. He has not confirmed that reading.
- **The 24 cards with unfiled people.** Leave them under "No branch set", assume the head
  office, or re-read those cards from the notes.

---

## Not automatable, and probably should not be

These need his eye, one card at a time:

- **A number with a digit missing.** `904743223` is nine digits. Completing it is a guess.
- **A typo that is only a typo in context.** `984093660` vs `9840939660` — same man, one
  number, and only he knows which is right.
- **A broken address.** `info@southindiatubes@gmail.com`, `bluebox_ajit@yahoo.co`. Kept as
  remarks, never repaired.
- **Which person a loose note is about**, and whether it belongs beside their name.
- **Whether a firm is a customer** when it is not on any quotation.

---

## Still open from earlier, on Apollo

- **"Tamilnadu & Chennai" and "Chennai" are separate groups**, so Sankara and Trichy AMK appear
  under both. Left as written rather than merged.
- **25 of Apollo's 30 dealers are in the waiting list**, so their names are plain rather than
  links. They become links as they are brought into the queue — *his decision.*
