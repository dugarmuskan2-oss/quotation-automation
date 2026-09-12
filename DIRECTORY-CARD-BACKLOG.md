# What still has to be done to every card

Two cards have been taken end to end — **Kerala Roadways** and **APL Apollo**. Some of what was
needed is now done automatically for every card; the rest was done **by hand on those two only**
and still has to be done for the other 46 in the queue, and the 2,000-odd behind them.

This is the list. Nothing here is a rule — the rules are in `DIRECTORY-DATA-RULES.md` and
`CONTACT-EXPORT-RULES.md`. This is the work.

---

## How HE checks a card — the method, not the fixes

He works one card at a time and finds mistakes on it. The point is not the mistakes. It is
that **he knows what the data should say and the app does not**, so each thing he catches is a
CLASS of fault, not an instance. Run these on every card before showing it to him.

**1. Is this in the right field?**
A bare "9176660264" sat in notes. It is D. Vijaya's mobile at the Chennai office. Notes are
where things go when nobody worked out where they belong. Ask of every note: is this a person,
a number, a place, a product, or a firm? Only what is none of those is a note.

**2. Is this ALL of it?**
"I also dont see this data." "did you take info from here also." He looks at a card and asks
what is missing, because he remembers what he wrote. Jindal Saw is on ELEVEN pages; seven were
found. A colour-coated page was read for firm names and lost all seven of its people.

**3. Is this one thing or two?**
Three ASHOK rows. Two SANDEEPs spelled differently. D. Vijaya / Madam Vizi / Vigi. Two Jindal
Saw cards, one with 12 people and one with 53. And the reverse — two men on one number who are
genuinely two men.

**4. Where did this come from?**
"colour coating has its own page?" The structure of his phone book IS the structure of the
data. A page heading is a category. A heading inside a page is a branch. A firm on a trade page
belongs to that trade. Losing the page loses the meaning.

**5. Who is this?**
"who are these people" — every name on a card should resolve to a real person at a real firm.
A name with no number and no home is a question, not a record.

**6. Does it match what he already knows?**
He caught Bharat Steel standing where his page says Crayon. He caught a branch header that was
not editable. He caught 25 dealers that were not clickable. **The card is checked against his
memory, which is the only complete copy of this data that exists.** Anything the app cannot
show him, he cannot check — so a thing hidden is worse than a thing wrong.

---

## How this file is kept

**Every correction made to any card gets written here, at the time, with what it means for the
others.** *His instruction.* Not at the end of the card, not from memory later — as it happens.

Three questions for each fix:
1. Was it a CODE bug? Then it is fixed everywhere already — put it in the automatic table.
2. Was it done BY HAND? Then it will recur — put it in the by-hand list with the shape to look
   for, so the next card is quicker.
3. How MANY other cards look like this? Count them. A number makes it a job; a hunch does not.

Remember rule §0! in DIRECTORY-DATA-RULES.md: writing it down here is the ONLY thing that
happens to the other cards. Nothing is applied to them until he asks.

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

## What Jindal Saw taught, in five groups

Twenty-seven faults on ONE card. Grouped, because the groups are what transfer — the
individual faults are listed underneath.

### 1. Whole sources were missing
- **The people he EMAILS were never read.** Google keeps saved contacts and "other contacts";
  the code kept only the domain from the second. 36 people missing from Jindal Saw alone.
- **Only 7 of his 11 pages were used** — chosen by title, missing any page naming the firm in
  its body.
- **The address book was ignored while checking**, so a verify pass deleted five real people.

### 2. Things reached the card as a NAME and nothing else
- All 8 transporters and 4 dealers lost their people, numbers and emails.
- A page could be read for firm names and still lose all seven people on it.

### 3. Things sat in notes that had a proper home
- A bare number that was D. Vijaya's mobile; a branch board number; a postal address; product
  specifications.
- *His rule: the page decides the FIELD, not just the label.*

### 4. Things were quietly wrong
- **The head office was invented** — nothing in his pages names any office as head.
- Sanjiv Dheer held five branch board numbers as personal phones.
- Bharat Steel stood where the page says Crayon, because they share a number.
- A misspelt firm name; a row named after an email address; a branch with nobody in it.

### 5. One man, several spellings — and the reverse
- D. Vijaya / Madam Vizi / Vigi. Rajat Chabra / Chhabra. Swadeep Koche / Khoche.
  K.Thyagarajan / Thayagarajan. "Mr. Madan" / "MR.MADAN".
- But Rakesh, Ramesh and Magesh are three men, and two people can share one number.

**The one above the others: a card is built from ALL his sources — saved contacts, emailed
contacts, and every page whose TEXT names the firm. Nearly half these findings trace back to
reading only part of it.**

---

## Found on JINDAL SAW — to transfer

His complaint: *"you need to be smarter about placing things — not just adding to notes —
think longer and add".* Everything below was sitting in the notes when it had a proper home.

9.  **A bare number left as a note.** "9176660264" alone. It is D. Vijaya's mobile at the
    Chennai office — and the ONLY way to know that is to read his OTHER pages: one lists her
    under 🏢CHENNAI OFFICE🏢, one calls her "MADAM VIZI", one is a contact just for her.
    **A loose number must be chased across every page before it is written off as a note.**
10. **One person under several names across pages** — "D. VIJAYA", "MADAM VIZI", "VIGI", all
    on 9176660264. The automatic merge cannot see it: different names, and each row has a
    number so neither is bare.
11. **A branch in brackets after a name, and it can be WRONG on the card.** "S Karthick
    (Nashik)" was filed under CHENNAI OFFICE. Check the bracket against the branch.
12. **A branch board number as a note** — "NASIK FACTORY (PPC DIVISION) BOARD NO: 02551-227333/
    32/34" belongs on that branch as a firm line.
13. **A postal address as a note** — "NO 3G, CENTURY PLAZA, 560 ANNASALAI TEYNAMPET CHENNAI-18"
    is the Chennai branch's address.
14. **Product specifications as notes** — "PPGL (PREPAINTED GALVALUME)", "AZ 150 MPA 550 (ALSO
    COMES IN AZ 70 & MPA 250)" belong in products.

15. **A FIRM NAME THAT IS NOT IN THE SOURCE.** The card said the two main distributors of JSL
    colour-coated sheet were BHARAT STEEL CHENNAI PVT LTD and SAROJ STEEL. The page says
    **CRAYON ROOTING & STRUCTURE** and Saroj Steel. "Bharat Steel" appears nowhere on it.
    **Every firm name on a card must be findable in the source text.** This is the only
    invention found so far and it survived a checking pass, so check it deliberately.
16. **A page can be read and still lose everybody on it.** The same colour-coated page names
    Gaurabh 9884809549, Yogesh Sharma, C. Hari 9444929292 / 25354333, Taha 9952954110, Satish
    8056106044, and the Tata PPGL dealers Vijay Kumar 9655928636 and Vasanth 9585527041 —
    every one of them dropped, while the firm names were kept. **Count the people on the page
    against the people on the card.**
17. **SOURCE PAGES WERE CHOSEN TOO NARROWLY.** Pages were gathered by the card's recorded
    headings plus a title match, which misses any page that names the firm in its BODY. Jindal
    Saw is named on **eleven** pages; seven were found. The four missed included two of the
    biggest — P(22) STEEL ITEMS (6,390 chars) and P(8) LARGER DIA (5,314), which is where he
    records that Jindal Saw has factories at Kosi Kalan and Kutch.
    **Search every page's TEXT for the firm name, not just its title.**

18. **THE NOTES ARE NOT THE ONLY SOURCE — AND FORGETTING THAT DELETES REAL PEOPLE.**
    The rebuild was given the eleven phone-book PAGES and the card. It was not given the
    ADDRESS BOOK — the 53 Google contacts carrying an @jindalsaw.com address, which is where
    most of the staff on that card came from. So the checker found Akhilesh Jain, Uday Mehta,
    Pravin Misra, Sharad Shardul and chemicallab nowhere in "the source", called them
    fabricated, and the rebuild removed all five — along with five real addresses
    (k.thyagarajan@, girish.nikam@, mangesh.lahamge@, chandra.damle@, psn.shreeram@).

    Every one of them is real and in his Google Contacts. The result was NOT applied.

    **A card has TWO sources: the notes pages, and the address book entries grouped by email
    domain. Any check that sees only one will declare the other invented.** This is the exact
    opposite failure to finding #15, and far more dangerous: #15 added one wrong name, this
    deletes real ones, and it comes wearing the authority of a verification pass.

    Before trusting ANY "invented" verdict, look the name up in the address book.

19. **CORRECTION to #15 — Bharat Steel was NOT invented.** It is on his P(22) page as a JSW
    supplier, with "MR. GAURAV - 9884809549 (OWNER)" — the SAME number as "MR. GAURABH -
    9884809549" at Crayon on the colour-coated page. One man, two firms. The earlier reading
    swapped one firm's name for the other because they share a phone number. *His decision:
    the number goes on BOTH firms.* A shared number linking two FIRMS is a real pattern here,
    and it must not rename either of them.
20. **A firm named after its trade fell off the card.** "SAFE SPEED CARRIERS", "BALAJI
    ROADLINES" — the code decides which half of a note is the relationship by looking for a
    trade word, and their NAMES contain one. Both vanished from "Who they work with". Fixed:
    when both halves name a trade, the LONGER half is the description.
21. **Plurals.** "distributorS" did not match a list holding "distributor", so Crayon and
    Saroj Steel never reached the block at all.

22. **THE BIG ONE: every firm named in a page was reduced to its NAME.** All eight Nasik
    transporters, all four colour-coated dealers and Jindal Quality Tubular reached the card
    as a one-line note and nothing else — every owner, staff name, phone, email and remark
    under them was dropped. Dev Sharma 8983458235, Rajesh Varma who speaks Tamil, Ramesh who
    has worked there 7 years, Tanuj on 9940433346 with two plant locations. **A firm named in
    a page brings its PEOPLE with it, or it is not worth naming.**
23. **A name compared as raw text splits one man in two.** "Mr. Madan" and "MR.MADAN" both
    carrying 9371007041 stayed two rows, because the comparison kept the space and the full
    stop. Same for "Mr. Rajesh Varma" / "MR.RAJESH VARMA". Fixed in code: names are compared
    with punctuation and honorifics removed, so two REAL Kumars with different numbers still
    stay two.
24. **A misspelt firm name.** The card said NAVISH LOGISTIK; his page says NAVISH LOGISTICS.
25. **A branch with nobody in it is a signal.** STAINLESS SHEET FACTORY exists as a branch and
    is empty — because SUNIL TILE: 2551227327, the one person under that heading, was dropped.
    An empty branch means somebody was lost.

26. **A branch board number ends up as one man's personal phone.** Sanjiv Dheer carried SEVEN
    numbers; two are his, and five were the Chennai, Bombay, Delhi and Nasik-PPC BOARD lines
    listed above him on the page. A number under a "(1) BOARD NO:-" line belongs to the
    BRANCH, never to the next person named.
27. **A row named after an email address.** "sanjay.naik@jindalsaw.com" was a person, while
    the real Sanjay Naik sat elsewhere on the card. Same for a nameless row holding
    psn.shreeram@. *His decision: merge them into the real person.*
28. **The address book and the pages spell one man two ways.** "K.THYAGARAJAN" (contacts) and
    "THAYAGARAJAN" (Chennai page) are one man. *His decision: merge.*
29. **A man can belong to TWO branches, and the page shows it.** Chandra Damle is item (8) on
    the Nasik list and saved in contacts as "(Mumbai-MKT)". Vinay Tavare is on that same Nasik
    list AND under Bombay Office — so the Nasik list does include Bombay men. *His decision:
    list Chandra Damle under both.* **Where a page and a name disagree, show him the two lines
    and let him decide — do not pick.**
30. **No evidence means no branch.** Pravin Misra, Uday Mehta and Karthikeyan are in his
    contacts and on none of his eleven pages. *His decision: leave them unfiled* rather than
    assume the head office. An empty branch box is honest; a guessed one is not.

31. **THE HEAD OFFICE WAS ASSERTED ON NO EVIDENCE.** The card said Jindal Saw's head office
    is CHENNAI, carrying the Century Plaza address. Not one of his eleven pages says head
    office, registered office or corporate office about Jindal Saw — the only "head office" on
    any page belongs to Scoda Tubes, on an unrelated page. His pages give FOUR offices as
    equals: Chennai, Bombay, Delhi, Nasik.

    The city came from the contacts scan guessing, and the address was the CHENNAI OFFICE
    branch's, sitting in the head-office box — which is why that branch showed no address.

    *His decision: leave the head office BLANK and put the address on the Chennai branch.*
    **A field nobody filled in is not an invitation to fill it.** Check every card for a head
    office the pages never named — the scan set one on all of them.

32. **THE BIGGEST GAP OF ALL: the people he actually EMAILS were never read.** Google keeps
    two lists — contacts he SAVED, and "other contacts", everyone he has written to. The scan
    read the second list and kept **only the domain**, on the reasoning that the addresses
    were none of the directory's business. That rule threw away the men he corresponds with:
    41 people at jindalsaw.com, of whom 36 were on no card — Mayank Singh Thakur, Megha
    Vatsayan, Umesh Barhate, Deepak Sharma, Thejas Raghav T, and the department mailboxes
    logistics@, quality.nsk@, accounts@, marketing@, payment.advice@.

     in utils/googlePeople.js now reads names and addresses, narrowed to one
    domain so it can be used while working a single card. **Every card in the queue is missing
    these people.**
33. **A phone from his pages and an address from his email are the same man, spelled twice.**
    Rajat Chabra / Rajat Chhabra. Swadeep Koche / Swadeep Khoche. S Karthick / Karthik /
    Karthi. Shreeram / Sreeram. Nothing automatic joins them: one row has a number and no
    address, the other an address and no number, and the spellings differ. *Show him the pairs
    and let him say.* He merged four and refused three — Rakesh, Ramesh and Magesh look
    similar but have different numbers and are different men.
34. **A system login is not a person's address.** sapadmin@jindalsaw.com came through as
    "Swadeep Khoche," — it is the SAP account he logs in with, not his mailbox.
35. **The page decides the FIELD, not just the label.** A line written under his PRODUCT
    heading is a product; one under his DEALER heading is a relation. "( a ). PPGL (
    PREPAINTED GALVALUME) MAKE: JSL /TATA BSL" and its specification were sitting as notes
    when the page plainly files them as products. *His instruction: place the note where it
    belongs, do not just record where it came from.*

The general lesson, and the one worth the most: **a card is built from ALL his pages about that
firm, not one.** Jindal Saw has seven. A detail that looks orphaned on one page is usually
explained on another.

---

## The cap of twelve — what it cost, and what fixing it taught

Saving a card cut its people to TWELVE, silently. Thirteen cards were sitting exactly at it.
**199 people were restored from the waiting list, and 364 more from the people he has emailed.**
Maharashtra Seamless had lost 106; Jindal Saw 71.

- **A firm can carry more than one domain, and matching on ALL of them is a disaster.** The
  first repair matched every domain on each card, including gmail.com, and took Maharashtra
  Seamless to **3,830 people** — everyone he has ever emailed at a free-mail address. Rebuilt
  using each firm's OWN domains only; free mail is never a firm.
- **Some cards genuinely hold several firms' people.** Maharashtra Seamless has mahaseam.com
  (70), jindalpipe.com (17) and unitedseamless.in (15) — three mills on one card. ISMT carries
  kirloskar.com. *His decision: leave them, do not split.*
- **Still open:** Hdfcbank, Yesbank and Irclass are two banks and a classification society,
  sitting in the queue as suppliers. Not asked about yet.

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

## Agreed but NOT YET DONE — he said wait

**Every phone-book page becomes a category, including the 276 headed "(ALL DETAILS)".**
*His words: "all - dont make changes to them yet".* Currently only pages WITHOUT "ALL DETAILS"
give a category, which is his earlier answer and is now superseded.

This reverses the rule in CONTACT-EXPORT-RULES.md §5-and-6 and DIRECTORY-DATA-RULES.md §4a. It
affects 276 pages: 28 that carry a filing code ("SNO 12 APL APOLLO/SG PREMIUM (ALL DETAILS)",
"PD (2) PIPE DEALER (STOCKIST)- KOLKATTA (ALL DETAILS)") and 248 that are just a firm name.

One of those 28 is a plain bug either way: "PD (2) PIPE DEALER (STOCKIST)- KOLKATTA" is a
trade page and was excluded only because it also says ALL DETAILS.

**DO NOT APPLY until he says so.**

---

**A save from a stale browser copy silently guts a card. The guard is agreed, deferred.**
*His words: "BUILD IT WHEN IT COMES TO IT".*

`POST /contacts/pending/preview` (routes/contacts.js) does
`item.preview = sanitizePartner(req.body.preview)` — a **whole-object overwrite**. Any edit in
the browser sends the entire card back, so whatever that tab is holding wins, even when it is
older than what is stored and even when the server it is talking to is running yesterday's
code.

**It has now cost data three times:** `branch` on one card, `gst` on Kerala Roadways, and on
Bombay Hardware **60 headings cut to 12 and both price rules wiped**. All three were put back
by hand, and only because they happened to be looked at.

The approve route is already protected — routes/contacts.js:473 runs
`keepWhatWasAddedSince(before, partner, REVIEWED_FIELDS)`. The preview route is not.

**The fix when it comes to it:** stamp each queue item with a `rev`, have the browser send the
`rev` it loaded, and refuse a save whose `rev` does not match with a 409 that tells the browser
to reload. `keepWhatWasAddedSince` is the wrong tool *here* — restoring anything missing would
break the ✕ buttons that delete a heading or a note on purpose. A threshold ("refuse a save
that drops more than half") has no honest cut-off. Versioning has no false positives.

**Until then:** do not leave a waiting card open in a second tab, and restart the dev server
after any change to `utils/contacts.js` before touching a card in the browser.

---

## Still open from earlier, on Apollo

- **"Tamilnadu & Chennai" and "Chennai" are separate groups**, so Sankara and Trichy AMK appear
  under both. Left as written rather than merged.
- **25 of Apollo's 30 dealers are in the waiting list**, so their names are plain rather than
  links. They become links as they are brought into the queue — *his decision.*

---

## What BOMBAY HARDWARE taught, in six groups

One card, worked end to end with him watching. **Everything below is written out in full
further down** — this is the shape of it, because the shape is what transfers.

| | was | now |
|---|---|---|
| People | 17 (really 8 men) | **26** |
| Notes | 111 | **1 showing** |
| Filed under | 42 headings | **60** |
| Branches shown | 7 | **10** |
| Price rules | none | 2 |
| What they are | blank | pipe dealer (stockist) |

**And 41 new cards came out of this one card, carrying 123 people.** That is the headline: a
card is not just wrong in itself, it is holding other firms prisoner.

### 1. A card is built from ALL his sources, and the head office is not guessable
His saved contacts held 37 people where the card had 17. The head office is **Bangalore** —
every landline on the card is 044, Chennai. *Never read a head office off an area code.*
A number written under a CITY heading belongs to that city's branch.

### 2. What is on the card may belong to somebody else
The address was Chetna Steel's factory. A branch, `CHETNA FACTORY`, was a whole firm. Both
arrived because one man, Rishab Mehta, is on both firms. **When a person is shared, check every
field against the page it really came from.**

### 3. A note is where something goes when nobody worked out where it belongs
61 notes were provenance the Filed-under list already carried. Two price rules were sitting as
notes. A two-word note, `HYD FACTORY`, was a **heading** governing five firms. **Of 111 notes,
one was really a note.**

### 4. A note about ANOTHER firm belongs on that firm's card — so that firm needs a card
*His rule.* 40 firms named on this card had none: the waiting list is keyed by email domain, and
a firm with no email address never enters it. They existed only as pages. **Never delete from
one card until the fact is verified on the other.**

### 5. Direction is not carried by the words
"from them", "purchases from Bombay H/W" are written from ONE side. Reused on the other card
they say the opposite — that fault reached 31 cards before it was caught. A **customer** note
flips; a **transporter** or a **supplier** does not. And "Pipe supplier to them" meant Bombay
Hardware supplying THEM, which is the reverse of how it reads.

### 6. His words go beside the name, whole
*"Add it in brackets next to the name under they sell to."* Not in a note, not cut short — a
quotation is whole or it is not a quotation. **His headings: They sell to · They buy from ·
Transporters · Their factory.**

### What was NOT wrong
**Not one digit was mistyped**, across nine numbers, and `7708106940` (Sampath) and
`7708106949` (the godown) were correctly kept apart. Say so when it is true: the fault is
almost always placement, not transcription.

---

## Found on BOMBAY HARDWARE — the detail behind those six

The card had **17 people and 111 notes**; his saved contacts alone held 37 people for it. Both
numbers were a symptom: things that belong in a field were sitting in notes, and the people who
were missing outnumbered the people who were duplicated.

### 1. The head office is NOT where the phone numbers are

The card said Bangalore. Every landline on it was **044 — Chennai**. The inference was that
Chennai must be home, and it was **wrong**: *his words, "headoffice is bangalore / numbers are
from the chennai branch".*

**Transfers:** never read a head office off an area code. A firm's main office can be in a town
that appears nowhere on the page you are reading. **Ask, or leave it blank.** This is the same
lesson as Jindal Saw, arrived at from the opposite direction — there the answer was "leave it
blank", here the answer was a town the numbers never mention.

A number written under a CITY heading belongs to **that city's branch**, whatever the head
office is.

### 2. A firm's own address can belong to a different firm

The card carried `NO.15,VAANIYAMALLI VILLAGE... GUMMIDIPOONDI` — which is on the **Chetna
Steel** page, not theirs. It got there because one man, Rishab Mehta, is on both firms.

**Transfers:** when one person is shared between two firms, check every field on the card
against the page it really came from. A shared contact drags his other firm's address, branch
and people across with him.

### 3. A branch is not a firm

`CHETNA FACTORY` was filed as a branch of Bombay Hardware. Chetna Steel has its own full page
with its own people (Hanuman, Ashish Vikram, its T.C. man, its transport man Sai Ganesh).
*His decision: its own card, linked both ways.*

**Transfers:** if the "branch" has people of its own on a page of its own, it is a firm.

### 4. Provenance notes are not notes

**61 of the 111 notes** said only *From your phone book, under "X"* — which the Filed-under list
already says. Deleting them lost nothing, once every heading they named was in `categories`.
**Do the union first, then delete.**

### 5. The relation notes were pointing the wrong way

**43 notes** said some other firm *buys from* Bombay Hardware. The app only understood
"dealer / transporter / supplier", so each of the 43 became its own heading. Now grouped under
**"Firms that buy from them"**, and its opposite is **"Firms they buy from"**.

**Transfers:** a stockist's card is mostly about who buys FROM them. Expect this on every
dealer card. His spelling wanders — `PURELASING`, `PURCHASE FORM` — and both are matched now.

### 6. A note that says more than the relationship stays visible

"THEY ARE PURCHASING FROM BOMBAY H/W **BY GIVING PDC UPTO 15 LAC**" carries a payment term.
"used to purchase from them **but now stopped**" carries the ending. Those stay as notes; the
bare ones ("They purchase from them — X") are hidden because the group already says it.

### 7. Branches with nobody in them were invisible

Delhi, Trichy, Coimbatore and Vellore were on the card and not on the screen, because the
screen built its branch list from the PEOPLE. His own written list of their offices was being
thrown away in the display. Every branch on the card now gets a block.

### 8. The head office town appeared twice

Bangalore was the head office AND a branch, so it rendered as two blocks with Pankaj in the
lower one. People filed at the head-office town now sit in the head-office block.

### 9. Caps again — categories at 12, rules at 20, types at 10

Bombay Hardware is filed under **60 headings**. The next save would have thrown 48 away.
Raised to 400 / 200 / 100. *Same lesson as the cap of twelve: a cap is a stop against a
runaway file, never a limit on one firm.*

### 10. "From <email> · read into 1 field" was wrong twice

The strip above the card named `kavitha@chetnasteel.com` as the sender of a card that came out
of his phone book, and said one field for twenty-six people. A card read from his notes now
says what it really is: *From your phone book · filed under 60 headings · 26 people.*

### 11. A trunk group keeps its area code

`044-2522 3308 / 49138888` is one group; the second line shares the 044 he wrote once.
`expandTrunkLine` in utils/contacts.js is the rule — use it, never hand-type the code.

### 12. A note about ANOTHER firm belongs on that firm's card

*His words, on "TOOK REFERNCE FROM MR: SAMPATH– BOMBAY H/W": "it shouldnt appear here but in
Maniams card".* That sentence is on his **Maniam Steels** page and is a fact about Maniam —
it reached Bombay Hardware only because "BOMBAY H/W" appears in it.

*And what it means: "it mean bombay hardware also supplies to Manian".* A reference from
Sampath is not just an introduction — **the firm he referred is one Bombay Hardware supplies.**

**The line to draw:**

| Kind of note | Whose card |
|---|---|
| *"X buys from them"* — a relationship between the two firms | **Both** — it groups under "Who they work with" |
| *"we took the reference for X from Sampath"* — how he came to know X | **X's card only** |

**Never delete it from one card until you have checked it is on the other.** Maniam Steels
carried it three times, so removing it here lost nothing. Where the other firm has no card
yet, the note stays put — losing it is worse than it sitting in the wrong place.

**Parked for that reason:** "HYD FACTORY" (belongs with the *PIPE DEALER (STOCKIST) - JINDAL
STAR ALL INDIA* page; there is no Jindal Star card), "ACCORDING TO MR SAMPATH (BOMBAY H/W) GOOD
PARTY. (about ENGINEERING TOOLS SUPPLY)", and "SIR SPOKE TO BOMBAY HW SAMPATH (21.2.2025)"
(from the Coimbatore Industrial Product page). None of those three firms has a card yet.

### 12a. So the firm the note is about needs a card — and 29 of them did not have one

*His words: "it goes under the card of which the contact belongs".*

Bombay Hardware's notes named **40 firms with no card at all** — not held back, not waiting,
simply never brought in. The waiting list is keyed by **email domain**, and a firm with no
email address never enters it. These exist only as pages in the phone book.

**They were built from those pages: 29 new cards**, each with its people, numbers, town,
address and the heading it is filed under — Seven Star Aircon (6 people), Metech (12), Sobha
(10), Micron Electricals (8), Moglix (5), Sv Tech (5), shree venus (5) and the rest.

The detail moved onto them **in his words**, and Bombay Hardware kept one bare line:

| | |
|---|---|
| Was, on Bombay Hardware | `THEY ARE PURCHASING FROM BOMBAY H/W BY GIVING PDC UPTO 15 LAC — SREE MAZHI` |
| Now, on Sree Mazhi | `BOMBAY HARDWARE — THEY ARE PURCHASING FROM BOMBAY H/W BY GIVING PDC UPTO 15 LAC` |
| Now, on Bombay Hardware | `SREE MAZHI ENTERPRIES — they buy from them` |

**Bombay Hardware's notes box went from 29 showing to 13**, and the customers in "Who they work
with" became clickable instead of plain bold text.

**What is NOT moved, and why:**

- **A supplier or a transporter stays on both.** That is a two-way relationship and it is what
  "Who they work with" is built from. Only a CUSTOMER note moves.
- **A firm with nothing read stays put.** Sree Mazhi, National Fire Armour, Savoy Engineers and
  Kumar Agro have no reading with a number, so there is no card to move to and losing the note
  is worse than it sitting in the wrong place.
- **Two of his wordings hid from the reader** and were moved by hand: "**Supply** one full truck
  load per month" (the rule matches "supplier", not "Supply") and "ACCORDING TO MR SAMPATH
  (BOMBAY H/W) GOOD PARTY. (about ENGINEERING TOOLS SUPPLY)", which names the firm only in a
  bracket at the end.

**The fact now appears on both cards** — once as his page wrote it, once as the moved line. That
duplication is deliberate: the moved line is what makes the link work in both directions.

### 13. A fact should not be a note AND a rule

"They give METAL up to 5,00,000" and "work with LC only" were sitting in both places. They are
**price rules**, and the rule now carries his sentence word for word so the note copy could go.
Notes 51 → 49.

### 14. What was NOT wrong

**Not one digit was mistyped**, across nine numbers. `7708106940` (Sampath) and `7708106949`
(the godown) were correctly kept apart. Say this when it is true — the fault is almost always
placement, not transcription.

---

## One firm, two cards — why it happens and what now catches it

**Maharashtra Seamless had two cards.** Added 5 Sept as "Maharashtra Seamless Limited" and
7 Sept as "MAHARASHTRA SEAMLESS LTD", from two different addresses. They were **identical in
every field** except one carried his three enquiries. The empty copy was removed; the removal
is undoable from Recent changes.

**The cause, confirmed in the code:** the app decides "new card" versus "add to the one you
have" on the **card id** alone (`mergePartner`, utils/contacts.js). That id comes from the
browser, which fills it only when `knownEmail(pi.from)` finds a card holding that **exact
address**. A firm writing from a second address matches nothing, is posted with a blank id, is
given a fresh one, and lands beside its twin. **No code on that path ever compares firm names.**

**What now catches it — both are warnings, neither blocks:**

- `duplicateFirms` (utils/contacts.js) groups the directory by `firmNameKey` and the list shows
  an amber band: *"1 firm looks like it has two cards."* This is the only check that can see
  two **free-mail** firms — it found Airta Logistics, which no address rule ever could.
- `sameNameNoteHtml` (partner-directory.js) warns on the approve row *before* the second card
  is made. It caught NAVISH LOGISTICS and ARC, both already in the directory under a slightly
  different name, sitting in the queue ready to duplicate.

**The rule:** match on the name to WARN, never to merge. `firmNameKey` is loose on purpose
(`sameFirmName` treats a prefix as a match), and two real firms share a name in two towns often
enough in this trade. Exact key equality for the warning; the prefix rule stays out of it. A
silent refusal is the same failure as a silent duplicate.

**Airta Logistics — merged.** *His answer: "same firm".* Both gmail addresses now sit on one
card, with Coimbatore, the SAIL FACTORY → CUDDALORE route and the note. The directory is 25
cards and both warning bands are empty.

**How a merge is done, and the one judgement in it:** the app's own `mergePreviews` does the
folding — it is additive by design, so a blank never replaces a value and nothing on either
card is dropped. It knows nothing about the counters, and those are the only real decision:

- **The same `last` date on both cards means ONE job that went out to two addresses** — asked
  once, not twice. Both Airta cards said *asked 1, last 2026-08-04*, so the merged card says
  asked 1. Different dates are different jobs and do add up.
- Why it matters: "Regular" means asked 5+ times in the last 4 months, so a doubled count would
  mark a firm regular that never was, and the ranking would then prefer it.

The merge refuses to write unless every address, number, note and route from both cards is
still reachable afterwards. The card that goes is an ordinary undoable removal in Recent
changes.

---

## "HYD FACTORY" — a sub-heading the reader had nowhere to put

It sat on Bombay Hardware as a two-word note and read as junk. It is not junk and it is not
another firm's remark: on the page **"PIPE DEALER ( STOCKIST ) - JINDAL STAR ALL INDIA"** it
heads five entries —

```
HYD FACTORY
1. ASHOKA TUBE  SAMARTH BANSAL: 9820073606
2. KARAN - 9950000665
3. BHUSHAN TUBES BOMBAY  MR: VARUN MITTAL - 9869345494
4. BOMBAY H/W  VIREN BHAI -
5. MARUTI COMMER...
```

— and the reading put the words `"HYD FACTORY"` into the **notes of all five firms**, because
there was no field for a heading below the page heading.

**It belongs in Filed under, refining its parent:**
`PIPE DEALER ( STOCKIST ) - JINDAL STAR ALL INDIA — HYD FACTORY`

**What transfers:** a note that is two or three words in capitals, carried identically by
several firms, is almost always a **sub-heading**, not a remark. Check the page before deleting
it — the same words on five cards is the tell. Four other firms on this page carry the same
line and will want the same treatment when their turn comes.

**Also from this page:** it names `BOMBAY H/W VIREN BHAI (9840333333)` at line 41 as well, so
the owner added to the card is confirmed twice in his own book.

---

## A relation sentence cannot be reused from the other side unchanged

*His corrections: "they sell to", "also under , they sell to", "what is to heavy metal?",
"all these also under respective clients : Buy from bombay hardware".*

**1. The headings now say it his way.** "Firms that buy from them" → **They sell to**. "Firms
they buy from" → **They buy from**. Two lines, opposite directions, no thinking required.

**2. The direction words flip meaning when the note moves.** This was a fault I introduced.
Moving "THEY ARE PURCHASING FROM BOMBAY H/W BY GIVING PDC UPTO 15 LAC" onto Sree Mazhi's card
as `BOMBAY HARDWARE — <that sentence>` made it read **They sell to: Bombay Hardware** — saying
the customer sells to Bombay Hardware. Backwards, on 31 cards.

The words "from them", "from Bombay H/W" are written from ONE side. On the other card they must
be replaced, not carried:

| On Bombay Hardware's card | On the customer's card |
|---|---|
| `SEVEN STAR AIRCON — they buy from them` | `BOMBAY HARDWARE — supplier to them` |
| reads **They sell to** | reads **They buy from** |

**His own sentence still goes on the customer's card — as an ordinary note, not as the link.**
Put inside the link it drags its direction words along and overrides the grouping, because
"purchasing from" is tested before "supplier".

**What must NOT be flipped:** a transporter who carries for them, and a supplier like Chetna
Steel. Rewriting those as "supplier to them" would say Bombay Hardware supplies its own
suppliers. Only a note the buying test matches is a customer note.

**3. A product is not a place.** "supplier to them for HEAVY METAL" left "HEAVY METAL" as the
row heading, which reads as a town. A leftover that matches one of the card's own products is
never a place.

**Where it ended:** Bombay Hardware reads **Transporters 4 · They sell to 35 · They buy from 5**,
and its notes box is **9**, from 111 at the start. Four more cards were built for customers with
no reading at all — National Fire Armour, Sree Mazhi, Savoy Engineers, Kumar Agro — from the raw
page, so his sentence has somewhere to live.

**Watch for a stale page.** Two of his corrections were of labels the code had already changed;
his browser was running an older copy of `partner-directory.js`. Bump the `?v=` on every change
to it, and say so.

---

## The bracket: his own words, whole

*His words: "in brackets can add (under xxx says --- purchases from --- ) for context -- exact
words of the notes", and the shape he wrote out:*

```
   on Bombay Hardware's card   SEVEN STAR AIRCON (BOMBAY HARDWARE HE PURCHASE MATERIAL ON CREDIT BASIS)
   on Seven Star's own card    THEY PURCHASE : 1. MST 2. SICAGEN 3. BOMBAY HARDWARE
                               HE PURCHASE MATERIAL ON CREDIT BASIS
```

So the firm is followed by **his own words**, and nothing of the app's in between. The bare
"they buy from them" was filler added to make the line group; his wording already says the
buying in 32 of 36 cases, and the filler is kept only where dropping it would move the firm
out of the list.

**Cutting his sentence at the point Bombay Hardware is named was tried and abandoned.** It
works for Seven Star, where the name begins a clause. It fails on a list: Crescon's line reads
*"REGULAR PURCHASES THE MATERIAL TO VARDHAMAN AGENCY, SUMIT INDUSTRIES, MST, BOMBAY HARDWARE,
SPARSH PIPES, CALCUTTA TUBE"* — cut at the name and the bracket becomes *"BOMBAY HARDWARE,
SPARSH PIPES, CALCUTTA TUBE"*, which reads as though Bombay Hardware sells to Sparsh Pipes.
**A quotation is whole or it is not a quotation.**

**Where the two cards differ:** the customer's own card keeps the **whole page sentence**,
because it is theirs; Bombay Hardware's card carries the shorter note that names it.

**Watch the bracket does not change the heading.** The wording is tested before it is written:
"Pipe supplier to them" alone reads as *They buy from*, so Chakara keeps the filler. Three
others keep it because their wording names no relationship at all.

Bombay Hardware ends at **Transporters 5 · They sell to 36 · Their factory 1 · They buy from 3**.

**And it goes BESIDE THE NAME, not in a note.** *His correction: "Add it in brackets next to the
name under they sell to".* The relation block now carries what he wrote about each firm in
brackets after the link:

```
THEY SELL TO   CRESCON PROJECTS SERVICE (CRESCON regularly purchases material from them
               on a credit basis) · shree venus · PONDY OXIDES AND CHEMICALS LTD (POCL)
               (POCL buys pipe material from them on credit basis) · ...
```

The bracket appears **only when his wording says something the heading does not**. "(transporter
working for them)" under the heading Transporters is noise; "(BOMBAY HARDWARE HE PURCHASE
MATERIAL ON CREDIT BASIS)" is worth reading. That test is `relExtra`, which was already written
to answer the same question for the notes list.

Because everything is now shown up there, a relation note is no longer repeated below.
**Bombay Hardware's Notes box is ONE line** — the 21.2.2025 record of speaking to Sampath,
which is genuinely about them. It began at 111.

---

## Open: is "MOKSHI MOTHILA" one firm or two?

His heavy-metal line reads:

> `BOMBAY H/W - HEAVY METAL , PURCHASE TO SREE VASTA , MOKSHI MOTHILA , TUBES INDIA .`

**No firm called "Mokshi Mothila" exists anywhere in his book.** But the COIMBATORE INDUSTRIAL
PRODUCT page lists, under Mumbai:

```
🏢MUMBAI🏢 (ADVANCE PAYMENT)
1. TUBES INDIA
2. MOTILAL LAXMICHAND
```

Tubes India and **Motilal** Laxmichand, side by side — the same pair that ends his heavy-metal
line. So "MOKSHI MOTHILA" may be **Mokshi and Motilal run together**, making that line four
suppliers rather than three.

*Asked. His answer: "unsure about makshi motilal".* **Left exactly as he wrote it.** Splitting a
name on a guess invents a firm, and joining two invents a merger; neither is recoverable once
the cards are approved.

The same doubt blocks two other moves — his "SREE VASTA" against the existing cards **Sreevatsa
Venkateswara** and **Sreevatsa Tube**, and "MOKSHI" against **Mokshiind**. Until he says which,
those notes stay on Bombay Hardware.

**What transfers:** a name that matches nothing in 1,912 pages is usually **two names with the
comma lost**, not a firm you have never met. Look for the pair somewhere else in his book before
proposing anything — and propose, never decide.

---

## What APL APOLLO taught — and why it was the card that proved the tool

Apollo is a MAKER with dealers all over India, where Bombay Hardware is a stockist with
customers. Running the same rules over the opposite kind of firm is what found these: **most of
them were rules that only ever worked on one card.**

### 1. A test that names one firm works for one firm

The buying test had **"bombay" written into it**. It had been tuned until Bombay Hardware read
correctly, and every other card fell through it. "Enexio purchase from Sreevatsa" and "Wootz
take material from them" each became a heading of its own with one firm under it.

**What transfers:** any test that decides a relationship has to be told **whose card it is on**.
A firm's own distinctive words identify it — never the trade words, because PIPE, STEEL and
TUBES name half his book.

### 2. He writes three parts, not two

`Dealer — Tamilnadu & Chennai — SHRI LAKSHMI STEEL SUPPLIERS` is **the relationship, the place,
and the firm.** Reading everything after the first dash as the firm gave a firm called
"Tamilnadu & Chennai — SHRI LAKSHMI STEEL SUPPLIERS", and thirty questions asking whether that
was one firm or two. Reading it properly took the relations carried across from **25 to 45**.

### 3. "Dealer" is not a firm — a card beats a long name

Both halves of that line carry a trade word: "Dealer" on one side, "SUPPLIERS" inside the firm's
own name on the other. The only tiebreak was length, on the reasoning that a description is
longer than a name — and here **the name is longer**.

**The order now:** a side he has a CARD for is the firm, whatever words are in its name. Failing
that, with three parts the firm is last. Length decides only between two.

### 4. A firm is not a place, any more than a product is

`TATA — SANTOSH STEEL is their dealer` left "SANTOSH STEEL" once the relationship words came
off, and Apollo grew a row headed with one of his own dealers. Third time for this shape, after
"HEAVY METAL" and "Pipe to". **If the leftover names a firm he has a card for, it is not where
anybody is.**

### 5. A list nobody would read is the same as no list

Apollo's first run asked **forty questions, with Swastik in it three times**. Three faults at
once: the same firm asked about once per note; questions about firms with nothing to lose; and
the broken splitter inventing names.

**The rules now:** one question per thing. Only ask when a detail would otherwise be **stranded**
— and quote that detail, so he can see what is at stake. Never ask him to confirm what already
happens.

### 6. A firm with no card anywhere is left alone

*His words: "if a name doesnt have any other contact cards in google contact, let it stay as is
in the card -- most questions in apollo were just that".* Five of Apollo's seven questions were
"Who is X?" about a firm with no card and nothing in the phone book, and his answer to every one
was **"let it stay just here"**. Apollo has 17 of those. The tool reports the number now instead
of asking seventeen times.

### 7. A dealer of theirs is a firm they sell to

*His words: "they are also who they sell to".* Apollo's regional dealers had a heading of their
own as though that were a different kind of dealing. It is the same dealing seen from the
maker's side. **Dealers now read under "They sell to"**, with the places kept as its rows and
his own wording in the brackets — "Dealer for them in Mumbai".

### 8. A person can carry a note of their own

*His words: "can add notes option to contacts and move this note there".* "NOTE: WHO VISITED OUR
OFFICE ON 26.7.2019 (Bhanu Srivastava)" was in the firm's notes box, where nothing connects it
to the man. A person had **no field for a remark at all** — which is why three exhibition notes
on this same card had been folded into a man's NAME to keep them beside him.

### 9. One firm's page can be headed with two names

"SNO 12 APL APOLLO/SG PREMIUM (ALL DETAILS) SNO 12" is Apollo's own page. Matching the whole
heading made it somebody else's, and the tool offered to move Apollo's own factory list off
Apollo. **Split the heading on "/" before deciding whose page it is.**

### What Apollo ended at

**45 relations carried onto the right cards, 22 firms built that had no card at all, 17 left
exactly as he wrote them, and no questions outstanding** — all seven answered in his own words,
kept on the card.
