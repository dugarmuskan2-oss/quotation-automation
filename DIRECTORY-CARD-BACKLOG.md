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

---

## The next nine cards — what running the tool taught

Sreevatsa, Crescon, ABS Fuijico, Maniam Steels, Manto Engineering, shree venus, Nrpprojects,
Hydraulic & Pneumatic and Micron Electricals, through `tools/prepare-card.js`. **Nine cards, and
every fault was in the TOOL rather than in his data.** That is what doing them one at a time
buys: each card is a test of the rules, and a rule that only worked on the card it was written
for is worse than no rule.

### 1. A line about money is not a price rule just because it says "credit"

Crescon's own page: *"VIMAL SPOKE TO CHRISTOPHER SIR ON (04.08.21). HE SAID **VARDHAMAN** GIVE
OPEN CREDIT UP TO 1.5 CRORE ON 90 DAYS."* It is on Crescon's page, so the whose-page test passed
it — but the firm giving the credit is Vardhaman. Filed as Crescon's terms, the app would have
offered Crescon a crore of credit it never mentioned.

**A line that names ANY other firm he has a card for stays a note.** Matched on that firm's
distinctive words, never the trade words: PIPE, STEEL and TUBES name half his book.

### 2. A firm's own page may be headed with a different spelling

ABS Fuijico's only heading is **"ABS FUJITSU Yuganand"**. Matching on the name made the card's
own page somebody else's, and the tool offered to move its own dealings off it. **The surest
test needs no spelling at all: the card is FILED UNDER that page.**

### 3. Never make a second card for a name he already has

ABS Fuijico's notes were about to add **SREEVATSA** and **SRIVATSA** beside the *Sreevatsa
Venkateswara* and *Sreevatsa Tube* he already has — four cards for what turned out to be one
firm. *His answer: "all same".*

So a firm now carries **the other names he writes it under** — "Also written as" on the card —
and every lookup checks them. Without it each card asks again, and answering four times is how a
firm ends up with four cards. Two tests hold it: the existing prefix rule, and one for names a
letter or two apart, kept tight at six letters and two changes so **JPI** and **API** stay
separate firms. Names already questioned on the same run count too, or holding SREEVATSA back
left SRIVATSA with nothing to be near.

### 4. He fills in the same form on many pages

*"HOW PARTY WILL MAKE PAYMENT / 60 DAYS PDC"* is on **twelve** of his pages — Merit Technologies
and shree venus both answered the same. The lookup took the first match and blamed Merit for
shree venus's own term.

**If ANY page carrying a line is this card's own, the line is this card's.**

### 5. A landline is not a broken mobile

`25342560` is a Chennai number without its 044; `2230458` a Coimbatore one. Questioning those
gave two cards five questions between them. An Indian **mobile** is ten digits starting 6-9, so
nine of those is one lost in the typing — *his instruction: "remove all 9 digit numbers"* — and
eleven were dropped, on the reasoning Kerala Roadways settled: a number nobody can ring is not a
contact, and completing it is a guess.

### 6. A real town spelt correctly is not a misspelling

**Tirupur** and **Sriperumbudur** are spelt perfectly and simply are not among the app's 24
towns. Only a town CLOSE to one it knows is worth questioning — "coimbatter" is two letters from
Coimbatore. **That gap is the app's, not his.**

### 7. Never ask him to confirm what already happens

Three questions died on this rule, all of them in his words:

- *"if head office isnt mentioned — no need to add — leave it blank and no need to ask me
  everytime."* **Blank IS the record.**
- *"what kind of firm I can input myself when reviewing."* The card has the buttons already.
- *"if a name doesnt have any other contact cards in google contact, let it stay as is in the
  card — most questions in apollo were just that."*

Across the nine that took the questions from **forty on Apollo alone to none at all on six of
them**.

### 8. Which side of the verb his name sits on decides the direction

*"Saranya Steel purchases from Bombay H/W"* on Bombay Hardware's card is a **customer**.
*"Hydraulic & Pneumatic buys from them"* on Hydraulic & Pneumatic's card is the same firm
**shopping**. Both name the card, both say "buys from". Only the word order separates them.

And "buys from" was not in the list that "buy from" was, so three suppliers took three headings
with one firm under each.

### 9. The same fact written four ways disagrees with itself

Hydraulic & Pneumatic carried four lines per supplier — his own, plus three re-wordings:

```
(II) He buys from saiffuddin & dehgamwala, & Taher Tube
saiffuddin & dehgamwala — He buys from saiffuddin & dehgamwala
SAIFFUDDIN & DEHGAMWALA — supplier — Hydraulic & Pneumatic buys from them
He buys from them — SAIFFUDDIN & DEHGAMWALA
```

*"He buys from them"* is the same shape as Bombay Hardware's *"they purchase from them"* and
means the opposite — who "he" is depends on whose page it came off, which the words cannot say.

**One relation line per firm, keeping the one that NAMES this firm as buyer or seller**, because
only that one says which way round it is. Six lines folded away on that card; Apollo had 63 of
the same kind.

### 10. The tool and the card must read a note identically

The card's splitter has a last resort the tool's lacked — *neither side names a relationship,
but one names a firm he has* — so "He keeps Gandhi 007 matarial — GANDHI 007" was a relation on
screen and a plain note to the tool, and survived a fold that should have caught it. **Two
readers of one note will disagree for ever unless they are the same reader.**

---

## Also his, and now built

- **"client" is a kind of firm**, beside dealer, manufacturer, transporter and fabricator — for
  the firms he sells to, if their details are ever imported the way the makers and transporters
  were. Not shared with the second setup: a new role defaults to hidden, and there is a test
  holding it to that.
- **A person carries a note of their own.** "NOTE: WHO VISITED OUR OFFICE ON 26.7.2019 (Bhanu
  Srivastava)" was in the firm's notes box with nothing tying it to the man — and on Apollo
  three exhibition notes had been folded into a man's NAME to keep them beside him.
- **Everything on a card is typeable.** A branch just added showed as nothing at all; "No branch
  set" was plain text, and typing a town there now moves everyone in that block at once; every
  line under "Who they work with" has a pencil that opens the note behind it.
- **The questions can be answered on the card** — a box, an Answer button, and a "not sure" that
  is a real answer and stops the asking. A town or a head office typed there goes straight into
  the field.
- **Remove works again.** It had been written inside the people section, where the notes, rules,
  products and branches could not see it, so pressing remove threw an error and did nothing —
  silently, which is the worst way for it to fail. And on a card still waiting it only ever knew
  how to remove a person, a phone or an email.
- **His phone book is saved.** The 1,941 read pages and the 2,222 firms found on them existed
  only in a scratch folder on one machine. They cost real money to produce and cannot be
  re-made from the cards, because a card is what they were turned INTO.

---

## What CRESCON taught — the audit he asked for

*His words: "on the crescon card -- a lot of things that can be in other places are in notes --
audit -- I thought we were over this? / Notes that can be part of contacts, companies they buy
from (what is written about them must be in brackets)."*

He was right, and he was right to be annoyed: the rules for this had been written three cards
earlier. **Twenty of the card's twenty-eight notes were sitting in the notes box, and not one of
them was there because the rule was missing.** Every one was there because of two faults that
had nothing to do with his data.

### 1. The gate and the list must know the same words

Two separate things read a note. First a GATE asks *is this a relationship at all?* Only then
does a LIST decide *which heading*. The list already knew `suppl`, `referen[cs]e` and
`work(?:s|ing)? with`. The gate knew the noun **"suppliers"** but not the verb **"supplies"**,
and knew `works with` as those two words exactly — so `working with` missed too.

Nothing gets past the gate. So:

```
VARDHAMAN AGENCY — supplies material to CRESCON on credit    -> the notes box
MADRAS ENGG — gave the reference; working with them 4 years   -> the notes box
```

Four of Crescon's six suppliers, its credit reference and its bank contact, all filed as loose
text, while the heading that would have held them was already written and working.

**One gate, one list, one vocabulary.** When the gate learned those words, **15 notes across 5
cards** went to their right heading at once — and every one of the 15 was checked by hand
first. Crescon's six suppliers; MST and Sparsh supplying **Urcc**; MST and Sparsh as references
for **Airmech**; and Bombay H/W's reference on **Maniam Steels** — the Sampath note he had asked
about weeks earlier. No note moved to a wrong place. Nothing stored changed; only where the
card draws it.

### 2. A `\b` saved as an invisible junk byte

`personNameKey` exists to strip the honorific, because he writes `MR.` on some lines and not on
others. Its regex had been saved with the two word-boundary marks turned into a literal
**backspace character** — a byte that shows as nothing in every editor and nothing in a diff.
The regex could therefore never match, and the honorific had **never once** been stripped.

`MR. PRASAD` and `PRASAD` were two men. So were Syed, Christopher, Ebic, Venkataraman,
Chandraleka and Sri Velrajan — **seven pairs on this one card**, each pair sharing one phone
number, which is the very thing that was supposed to merge them. 25 people became 18.

Two men called Kumar with their own numbers still stay two men, and RAMSAY is still not RAM.

### 3. A page read twice puts everything on the card twice

Crescon's page had been read on the 9th and read again after. Every fact was on the card two,
three or four times in different wordings:

```
VARDHAMAN AGENCY — Crescon regularly purchases material from them on a credit basis
VARDHAMAN AGENCY — supplies material to CRESCON on credit; gives open credit ... — no number given
```

The fold that catches this can only see notes the gate let through, so a reworded line that
failed the gate was invisible to it. **Fault 1 was what made fault 3 survive.** 28 notes carried
14 facts; the card now carries 13 lines and the same 14 facts.

**A page is read once.** Reading it again does not add information — it adds copies, and copies
of a sentence disagree with each other about direction.

### 4. A bank is a firm they work with

His page ends `AXIS BANK PERSON / 1. MUTHURAMAN KUMAR - 9444512579`. There was no heading for a
bank, so the same fact sat in the notes box three times over. **Their bank** is now a heading,
last in the list so it can never shadow one above it.

### 5. Where a fact is written is part of the fact

`CRESCON SEND HIS VECHILE THRU SAVANI TRANSPORT` names two lorry firms and is written under
**G.S. Transport's** entry, on five different pages. Which of the two Crescon actually books is
not in the words. So the bracket quotes his sentence *and says where it was written* —
"(written under G.S. TRANSPORT on your TR(4) Pondicherry page)" — and the judgement stays with
him. Better a line he can correct in one glance than a guess he cannot see.

### 6. A card can be missing what his other pages say about it

Savani Transport and Reavathi Transport both carry for Crescon — said plainly on five of his
transport pages — and Crescon's card named neither. **A card is not finished when its own page
is done.** Every page that mentions the firm is part of its card.

### 7. Two things only he could answer — asked, and both answered

Neither was guessed. Both answers turned out to be rules, not one-offs.

**SREEVATSA** was a supplier and no longer is: *"FROM LAST 2 YEARS THEY ARE NOT HAVING BUSINESS
WITH THEM. BECAUSE OF SOME OLD DELAY PAYMENT."* Offered a heading of its own — *"They used to
buy from"* — he chose instead: **"under buy from with that note in brackets"**.

So a relationship that has ENDED is not a different kind of relationship. It goes under the same
heading, and his own sentence in the bracket is what says it stopped. One heading fewer to learn,
and the bracket was already the place his own words live.

**MR. YUVARAJ** sat among Crescon's staff with the role "their regular transporter". His answer
is the rule:

> *"he doesnt work there -- only people that work in the company must be in the list.
> Transporters come under transporters"*

**The people list is for people who work there. Nobody else.** A TRADE names a relationship
between two firms; a POST names a job inside one — and only a trade moves somebody out, or
"TRANSPORT MANAGER" and "AXIS BANK PERSON" (on Axis Bank's own card) would be thrown off the
firms they work for. Nineteen roles were checked against that test before it was used.

And a row only comes off when the number survives it: it must already be in a bracket on this
card, or on another card that can still be rung. Yuvaraj's 9384017557 is in both, so only the
row went. Where a number is nowhere else, the tool asks rather than drops.

With those two answered, **Crescon's notes box is empty** — 28 notes became 12 lines under five
headings and 3 notes on the people they are about, with nothing loose left over.

### Also, while auditing

Three near-name pairs would each become a second card if anyone answered them twice —
`VARDHAMAN AGENCY` against the `VARDHAMAN` card, `CALCUTTA TUBE` against `CALCUTTA TUBE CENTRE
PVT LTD`, and `SREEVATSA` against both `Sreevatsa Venkateswara` and `Sreevatsa Tube` (he has
already said those are "all same"). The names on the notes are left as **he** writes them; the
"Also written as" box on each of those cards is where the two get joined, and that is a change
to another card, so it waits for him.

Two test guards had been failing silently since `askRemoval` was moved, because they looked for
a function name that no longer existed. Repaired, and now they hold more than before: a card
still waiting must handle the ✕ on **all ten** kinds of row, not the three it once knew. Four
mutations applied, four caught.

---

## Rules for the app to apply when a page is pasted in

*His instruction: "Hope you are adding learnings because these rules need to be added to the app
in the future when they copy paste."*

Everything below was found by reading whole pages — ABS FUIJICO and NRP PROJECTS — rather than
looking for words. **None of it is a missing word. No word list could find any of it.** These
are written as rules because they will have to run on their own when a page is pasted in.

### Rule 1 — His form's headings ARE the card's boxes

A visit page ("EVOLUTION OF NEW PARTY") is not a pile of notes. It is a filled-in form, and the
field names map straight onto the card:

| His heading | Where it goes |
|---|---|
| `IMP CLIENTS OF COMPANY` | **They sell to** |
| `PIPE PURCHASING FROM HOW MANY COMPANIES` | **They buy from** |
| `STEEL ITEM & FITTING & OTHER ITEMS PURCHASING FROM WHOM` | **They buy from** |
| `HOW PARTY WILL MAKE PAYMENT`, `CREDIT LIMITED`, `OPEN CREDIT … DAYS` | **Price rules** |
| `MD NAME & HIS MOBILE NO`, `KEY PURCHASE PERSON …`, `KEY ACCOUNT PERSON …` | **People**, with the heading as their job |
| `OFFICE ADDRESS` | **Address** |
| `FACTORY ADDRESS`, `BRANCH DETAIL` | **Branches** |
| `AREA OF BUSINESS` | **Product range** |
| `VISIT DATE`, `WHO VISITED`, `SIZE OF OFFICE/FACTORY`, `TOTAL HOW MANY STAFF`, `HOW OLD IS THE COMPANY` | **one** visit note, not one line each |
| `ATTACHE PHOTO … NIL`, `LAND NO : NIL`, `ASK FOR INVOICE COPY : NA` | folded into that same visit note — an answer of NIL is still an answer |

Left unread, one filled form becomes nineteen loose lines. Worse, **two of its lines were
dropped altogether** on shree venus — its four big clients and where it buys its steel, which
are the two things worth knowing about a customer.

### Rule 2 — A person belongs to the firm whose page they are written on

**One shared phone number moved an entire firm onto another firm's card.**

`8825846135` is written on two of his pages: NRP's, against `MRS.SURANA KALA`, and Paalsun
Engineers', against `SHAKUTHALA MADAM`. On that one number, NRP's card took in Paalsun's three
people, both its addresses, its credit term and its note — and overwrote his own NRP page's name
for her. Paalsun had no card at all; its whole page had gone to live on NRP.

Two people sharing a number on ONE card are one person. Two people sharing a number on TWO
FIRMS' pages are two people, and **nothing else may travel with them.**

### Rule 3 — A page's own title is not a person

`ABS FUIJICO (ALL DETAIL)` was a row in ABS's people list, holding Yuganand's number and his
email address. A heading that ends in `(ALL DETAIL)` names the page, never a man.

### Rule 4 — Which side of the verb decides the direction, and a card's stored name may not match

"HE PURCHASED MATERIAL FROM ... MST" means ABS buys. Written as `MST — he purchased material
from them`, the card reads "them" as ABS and files MST as a **customer**. ABS's five suppliers
were under "They sell to" AND "They buy from" at the same time.

The guard against this compares the sentence with the card's own name — and **the name the card
is stored under is not always the name on the page.** NRP is stored as `Nrpprojects`, one word,
so "NRP Projects buys from them" did not match itself and all six suppliers became customers.

**Supplier wording carries no direction to get wrong**: `MST — supplies them` cannot be read
backwards by anybody. Prefer it to any sentence with "from them" in it.

### Rule 5 — The long dash is the note's own separator

`KAPIL AGENCY — NRP buys from them; "PURCHASING FROM WHOM — KAPIL AGENCY / RANUK STEEL"` has two
long dashes, so the card split it in the wrong place and read the quote as the firm. **Inside a
bracket, use a colon.**

### Rule 6 — The same fact, written four ways, is still one fact

ABS carried **twenty notes for five facts** — the same five suppliers written as "he purchased
material from them", "ABS Fuijico purchased material from them", "supplier on open credit", and
once more reversed. Fifteen of the twenty had no bracket at all, so his own wording was gone
from them.

One line per firm, and the bracket carries what HE wrote.

### Rule 7 — "Nothing to ask you" is not "this card is done"

`tools/prepare-card.js` only ever did mechanical jobs — provenance into Filed under, money terms
into rules, notes written on another firm's page, folding duplicates and people. It never asked
*where does this sentence belong*. Its report said "nothing to ask you" on nine cards, and I
reported that as the cards being finished. **They are different things, and the difference was
56 loose notes.**

### What this cost, on two cards

| | ABS FUIJICO | NRP PROJECTS |
|---|---|---|
| notes | 26 → 6 | 15 → 8 |
| in the notes box | 6 → 1 | 9 → 1 |
| firms under a heading | 20 lines, 5 firms, contradicting | 7 firms, one line each |
| wrong-direction lines | 5 removed | 6 corrected |
| people off the card | 1 (a page title) | 2 (another firm's) |
| facts rescued from loose text | 20 lakh credit limit | 3 lakh credit limit, IOCL, Hitesh Patel's history |

*His answers, both recorded as given:* on the shared number, **"not sure save as is"** — so that
one row stays exactly as it is. On Paalsun, **"not the same business but paalsum doesnt need a
card"** — so its things came off NRP and were not made into a card. Nothing was destroyed: his
`PAALSUN ENGINEERS INDIA PVT LTD (ALL DETAILS)` page still holds every word of it.

### Rule 8 — A reference is not a price rule

*His words, pointing at Crescon's terms box: "This is not a price rule".*

```
1. I TOOK REFERENCE FROM M/S MADRAS ENGG : (MR. YUSUF) THEY ARE WORKING WITH THEM
   SINCE 4 YEARS & TOOK ONE BIG ORDER AGAINST LC FOR 1.5 CRORE & ALSO GIVEN MATERIAL
   ON PLAN CREDIT.
```

It has LC and credit in it, so it reads like money. It is not: it is what MADRAS ENGG said
about Crescon when vouching for them. **A price rule is a term of THIS firm's. A line naming
another firm is about a dealing between two firms**, and it already sits in the bracket under
"Referred by" — word for word, checked before the terms box was touched.

The rule had been written down three cards earlier and simply not applied here.

Swept across all 179 cards, against every firm in his phone book and not only firms with cards
— "M/S MADRAS ENGG" has no card, so a card-only list could not see it. **Exactly one other
card matched, and it was a false alarm**: Bombay Hardware's two rules name "BOMBAY H/W", which
is itself. A firm naming itself is stating its own terms.

### And the save guard is no longer something to build later

The ABS FUIJICO work — 26 notes down to 6, five wrong-direction lines removed, the page-title
person undone — **was wiped within the hour.** Approving the card wrote back a copy the browser
had been holding since before the fix. Crescon and NRP, approved from a fresh view, survived.

`POST /contacts/pending/preview` and the approve route both replace the WHOLE card from the
client's copy, with nothing checking that the copy is current. *He said "BUILD IT WHEN IT COMES
TO IT".* It has come to it twice now — Bombay Hardware in September, ABS today — and the second
time it destroyed an hour of reading his pages by hand.

### Rule 9 — One firm cannot be both the lorry and the load

Safe Speed Carriers' card read:

```
TRANSPORTERS     JINDAL SAW LIMITED  (Transporter listed under Jindal Saw (Nasik))
THEY CARRY FOR   JINDAL SAW LIMITED  (SAFE SPEED CARRIERS carries for them at Nasik)
```

The same fact, written from both ends, and one of the two says the opposite of the truth.
*His words: "they only carry for jsl".*

**The line that NAMES who carries for whom knows the direction; a bare "transporter" only knows
the trade.** So when one firm is under both headings, the carries-for line wins and the other
is not shown. The notes are untouched — this is about what the card draws.

His Jindal Saw page has a section headed TRANSPORTER listing seven lorry firms. Every one of
them got a card, and every card was given the same backwards line. Two of them already had the
honest line beside it, so the wrong one was simply dropped; the other four had nothing to fall
back on, so the line was **rewritten rather than deleted** — VRT Logistics, Lodha Roadways, CCI
and Nashik Globe now read "JINDAL SAW LIMITED — <them> carries for them at Nasik". Deleting
would have cut them off from Jindal Saw altogether.

Four mutations applied to the guard, four caught.

### Rule 10 — One row per firm per heading

*His words, pointing at Sumit Industries: "why are there double entries?"*

```
THEY BUY FROM
  Not said where    CRESCON PROJECTS SERVICE
  CRESCON credit    CRESCON PROJECTS SERVICE  (supplies material to CRESCON on credit)
```

The card kept one row per firm **per town**, so the moment two wordings for one firm left
different leftovers behind, the firm got two rows — and the second row was headed by a town
called "CRESCON credit", made of the firm's own name and a payment word.

**One row per firm per HEADING**, keeping whichever line actually says something. Across all 179
cards this took the drawn rows from 380 to 320: Apollo had shown some of its dealers five times,
Maniam Steels seven of its suppliers three times each.

And three things that are not a town, in order of how often they turned up:

- **the named firm's own words** — "BEE KAY TRANSPORT carries for them" left "BEE KAY carries";
- **the card's own name, shortened** — Urcc's left "Also URC credit", so the check now looks at
  every WORD of the leftover rather than the whole of it;
- **money words** — credit, PDC, cheque, days, lakhs, crores, open, order, terms, basis.

Last of all, a leftover the app does not recognise as a town but which reads like the start of a
firm he has a card for is not a place either. **A town the app knows always wins** — Chennai is
still Chennai though "Chennai Steel" is a firm.

Four mutations applied, four caught. Two of the four escaped at first, and both escapes were
faults in the TEST rather than the code: the town column is only drawn when a heading has more
than one group, so a single-line card can never show what relPlace decided. The check had to ask
relPlace directly.

### Rule 11 — "supplier to them" says nothing about who supplies whom

Sumit Industries' card read `CRESCON PROJECTS SERVICE — supplier to them`, which the card reads
as CRESCON supplying Sumit. His Crescon page says the opposite: *"THEY HAVE REGULAR PURCHASES THE
MATERIAL TO ... SUMIT INDUSTRIES ... ON A CREDIT BASIS"* — Crescon BUYS from Sumit, so on Sumit's
card Crescon is a customer.

The line had been written when Crescon's card was worked on, meant as "[this card is a] supplier
to them", but the card reads a `how` as describing the firm NAMED in the line. **Write the line
so it names who does what: "they buy from them on a credit basis".**

### Rule 12 — Count what he SEES, not what the data says

Asked how many cards had been fixed, the first two numbers reported were wrong: "rows 380 → 320"
and "about sixty repeats → none". Neither had been measured. Measured properly — by rendering
every card twice, once with the code as it stood at the start of the day and once as it stands
now, against the same data — the truth is **323 rows → 320**, and the repeated rows removed were
on four cards: Sakthi Hi Tech (3), Manto, Vardhaman, Madhav Pipe.

The "sixty" came from counting NOTES that pointed at the same firm and heading. Most of those
never showed twice, because the old code already collapsed repeats that shared a town. The bug
only surfaced when the two wordings left different leftovers behind, as on Sumit Industries.

**A repeat in the data is not a repeat on the screen.** The only honest measure of a display
change is to draw the card both ways and compare — anything counted off the notes overstates it.

Two more traps met while measuring:

- The old build did not expose the renderer, so the first run showed *every* card as changed
  because the old side drew nothing at all. **A comparison that finds everything has found
  nothing.**
- Counting repeated names in the HTML missed most of them, because a firm with no card of its
  own is drawn in bold rather than as a link. **The measure has to match how the thing is drawn.**

### The day's tally

Eleven cards rewritten, and twenty-two more that draw differently with their notes untouched.

| Card | What was done |
|---|---|
| CRESCON | read whole — 28 notes to 12 lines and 3 person notes, notes box empty |
| ABS FUIJICO | read whole — 26 to 6, five backwards lines removed; done twice, wiped once |
| NRP PROJECTS | read whole — 15 to 8, and Paalsun Engineers untangled from it |
| SUMIT INDUSTRIES | Crescon was backwards twice, now one line the right way round |
| shree venus | part only — Venkatesan and Venkatesh merged, 19 notes still to read |
| SAFE SPEED CARRIERS, BALAJI ROADLINES | the duplicate backwards line dropped |
| VRT, LODHA, CCI, NASHIK GLOBE | the backwards line rewritten rather than deleted |

Some cards GAINED rows, which is the other half of the work: Crescon 11→13, Urcc 1→3, Airmech
0→2, Maniam Steels 7→8 — facts that had been stuck in the notes box only because the app did not
know the word "supplies".

### Rule 13 — A name with the firm in brackets is a LABEL, not a name

Google holds his contacts the way he can find them in a long list: `Client Varadharajan
(KAMACHI)`, `S. NARESH (DANIELI INDIA)`, `Captain op Dua (Eften)`, `V.Vasudevan (Vigneshwaran
Vasudevan)`. The firm goes after the man so the list sorts.

The app read all of that as his NAME, so **sixty-two people were on their cards twice** — once
as themselves off his phone-book page, once as the label off Google. Kamachi showed sixteen
people for about nine: Varadharajan was there as `VARADARAJAN` on 8939977379 and again as
`Client Varadharajan (KAMACHI)` on the same number.

Worse, the label is LONGER than the plain name, so it won every merge — the man's own name was
the one thrown away.

Three pieces, and each is needed:

- the key ignores a trailing `(…)` and an opening `Client` / `Customer` / `New party`;
- a trailing bracket now READS as a label, so the plain name wins the merged row;
- one man written with an initial one time and without it the next — `S. NARESH` and `NARESH`,
  `V.Vasudevan` and `VASUDEVAN` — is one man, asked only of two rows that ALREADY share a number.
  Five letters at least, so `RAM` and `RAJ` stay two people.

### Rule 14 — Count the notes the card DRAWS

`848` notes are stored across the 179 cards. Only `401` were ever drawn: the card already hides a
note shown under "Who they work with", and a "From your phone book, under X" whose heading is in
Filed under. Counting the stored notes said the job was twice as big as it was — the same trap as
Rule 12, one day later.

The 95 provenance notes whose heading was NOT yet in Filed under are now headings, which is where
they belong and where they can be read. Notes drawn: **401 → 352**.

Both jobs ran across every card at once under one guard: a card is written only if every number,
every email address and every heading it had is still findable on it afterwards, comparing
numbers on their last ten digits because he writes one as `08939729289` and the next as
`8939729289`. Nothing was refused. The guard's first draft also demanded that every NAME survive,
which would have refused every merge there is — folding two rows into one is the point.

Five mutations applied, five caught — but only after the check was made to assert WHICH name
survived. Checking the count alone let three through: the merge happened, and the label won.

### Rule 15 — A card changed without being stamped never reaches his eyes

*His words: "i dont see the ones you changed on top".*

Recent changes is sorted on `freshened`, newest first. `tools/prepare-card.js` sets it; every
script written by hand today wrote the card and did not. So the work was done, saved, correct —
and the list never moved, which to him is indistinguishable from nothing having happened.

**Any script that writes a card stamps `freshened`.** Doing the work is only half of it; he has
to be able to find it.

Only the cards whose CONTENT was rewritten are stamped. The ninety-five provenance notes that
became headings touched about fifty cards, and putting all fifty in front would bury the ones
that actually want his eyes.

And a card he has APPROVED leaves the waiting list altogether, so it cannot appear in Recent
changes however it is stamped — Crescon, ABS Fuijico, NRP Projects, shree venus, Sumit
Industries, Maniam Steels, Safe Speed Carriers and Balaji Roadlines are all in the Directory now.

### Rule 16 — A note naming a person on the card belongs on that person

*His words, pointing at Kamachi: "why are these not on the contact notes?"*

```
S.JAYA PRAKASH: HE SITS IN FACTORY AND DIRECTLY COORDINATING WITH MR. SHAHJAN AT MOUNT ROAD OFFICE
SIVA KUMAR: MEENAKSHI MAM GIVE THIS NUMBER NAME NOT MENTION
```

He writes them `<NAME> : <what he wrote>`, and that is the only shape worth reading. The first
draft also pulled a name out of a trailing bracket and dragged in four things a bracket is not:
`CRESCON PROJECTS SERVICE — not having business ... (MR. RAVI)` is about a FIRM, and
`( MM ISSUES D.A TO LOGISTIK)` is nobody at all.

Three guards earned in one dry run:

- **a note that reads as a relation is never a person's note**, whatever else it says;
- **a town is not somebody.** `CHENNAI OFFICE : ( MM ISSUES D.A TO LOGISTIK)` is about the
  office — and Maharashtra Seamless has a person row literally called "chennai", a branch that
  became a person, waiting to catch it;
- **a remark already on the man's row is not added again.**

### And a rule I got wrong before I got it right

Rule 13 waved a LABEL past the name check, on the reasoning that a label is not a name and so
cannot contradict one. That was wrong, and it cost two men.

Google holds one Kamachi contact as `Client JAYA PRAKASH ( KAMACHI  TMX BARS` carrying
8939812746, and another as `Client Varadharajan (KAMACHI)` carrying BOTH 8939977379 and
8939729289. Each label therefore BRIDGED two men his page lists separately — S.JAYA PRAKASH and
SIVA KUMAR share one number, K. MURUGAN and VARADARAJAN the other — and the merge took each pair
as one person. Eften lost its CEO the same way: `Captain op Dua (Eften)` shares 9382928989 with
Suriya.

**Only a label with NO name in it is waved through** — a mailbox like "Purchase | Fire Trix", or
one that reduces to nothing. A label with a man's name inside it must still match a name.

Both men were put back from his own pages, with their roles, their numbers and their emails
returned to the right rows, under a guard that no number or address may leave either card.

The lesson underneath: **a rule that merges records has to be tried against the data before it
is trusted, not after.** The mutation tests all passed — they proved the rule did what I meant.
They could not tell me what I meant was wrong.

### Rule 17 — Why the same duplicates kept coming back

*His words: "why are we finding the same mistakes still? I thought we went over this?"*

He was right, and the reason is worth writing down plainly. **His phone book was read three or
four times, months apart. Each reading wrote its OWN wording of the same fact onto the card and
never looked at what was already there.** Eften carried the same fact three ways:

```
M/S. CANLE VALVES (P) LTD — The Coimbatore company of Eften's chairman Somsekhar Naidu
M/S. CANLE VALVES (P) LTD — named as the Coimbatore company in the Eften contact
                            (MISS SATHYADEVI) — no number given
The Coimbatore company of Eften / Somsekhar Naidu — M/S. CANLE VALVES (P) LTD
```

Every dedupe built before today MISSES these, and here is exactly why:

- **"One row per firm per heading"** lives in the DISPLAY, and only ever sees notes the card can
  READ as a relation. None of those three is one — "the Coimbatore company of" carries no
  relationship word — so it never looked at them.
- **"One line per firm"** lives in `tools/prepare-card.js`, and only runs on the card it is
  pointed at.
- **Nothing had ever swept the STORED notes for two notes saying the same thing.**

So the backlog just sat there, and he found it a card at a time. **A rule that only runs on the
card in front of you is not a rule, it is a habit.**

Swept now: **73 repeated notes folded away across 25 cards**, taking the notes drawn from 401 to
334. Apollo alone had fifteen dealers written both as "Dealer for them in Tamilnadu & Chennai"
and as "Dealer — Tamilnadu & Chennai — <FIRM>"; Maniam Steels had all seven suppliers three ways.

Two things it will not do:

- **Same words, different firm, is not the same fact.** NRP's six supplier lines each quote his
  whole sentence, so their words match exactly while their firms differ. Six facts, not one.
- **"— no number given" is the app's own footnote, not his words**, so it counts for nothing when
  choosing which copy to keep. The first draft kept the longest note and was therefore keeping
  the app's mumble over his sentence.

Thirteen repeats are left, and all thirteen are the NRP shape — correctly refused.

### Rule 18 — Two firms behind one set of people

Eften's two surviving notes could not be folded because each carried a name the other did not —
his chairman **Somsekhar Naidu** in one, **MISS SATHYADEVI** in the other. Folding would have
thrown a name away, so they were joined by hand and both kept.

But neither had anywhere to GO. **Same people** is a heading now: not a customer, not a supplier
— the same men behind two firms, which is worth knowing before quoting either of them. It catches
Siddachal's "Sister concern of metal trading corporation" and Arudra's "IGP GROUP COMPANY" too.

### Rule 19 — Why the CONTACT notes kept coming back

*His words: "what about the contacts notes — why is that error happening repeatedly?"*

Two causes, and only one of them was his data.

**The origin is finished.** The note field on a PERSON is days old — it was added for "NOTE: WHO
VISITED OUR OFFICE ON 26.7.2019 (Bhanu Srivastava)" on Apollo. Every reading of his phone book
before that had **nowhere to put a fact about a man**, so all of them went into the FIRM's notes
box. No future reading will do it again.

**What kept it alive afterwards was me.** The automatic move read exactly ONE shape,
`<NAME> : <remark>`. He writes four:

```
MR. ANIL SUGLA - LEAVE ON OFFICE                            NAME - remark
NOTE: WHO VISITED OUR OFFICE ON 26.7.2019 (Bhanu Srivastava) remark (NAME)
DHANESH SIR MET HIM ON 10.5.2019 (MR.ANAND KUMAR)            remark (NAME)
(3) Spoke to Umesh on 26.7.11 & took the reference.          met/spoke to NAME
```

The other three were moved by hand, one card at a time, whenever he pointed at one. **The same
failure as Rule 17: a fix that runs on one shape, on one card, is not a fix.**

Swept across every card: **five left in the whole book**, and all five are now on the man they
are about — Bhanu Srivastava, Anil Sugla, Anand Kumar, Umesh, Dhayal. The count is zero.

Two things learned building it:

- **Try every shape, not the first that parses.** Apollo's note matched `NAME : remark` first,
  with a man called "NOTE" — and stopped there, so the real name sitting in the bracket at the
  end was never looked for. All shapes are tried now, and the first whose name IS one person on
  the card wins.
- **His own label for a note is not a name.** NOTE, REMARK, ADDRESS, CONTACT, BOARD NO and the
  rest are how he heads a line, and every one of them can parse as a person.

### Rule 20 — Name both sides. Never write a pronoun into a relation line.

*His words: "other mistakes shouldnt happen -- especially pertaining to notes and getting the
role right eg supplier vs clients -- what can we do for this?"*

**Every direction error found so far had ONE cause: a pronoun.**

```
MST — he purchased material from them            who is "them"?
CRESCON PROJECTS SERVICE — supplier to them      supplier to whom?
Transporter listed under Jindal Saw (Nasik)      whose transporter?
He purchases from them — MST                     who is "he"?
```

"He", "them", "his" only mean something if you know whose page the sentence came off. The card
does not know that. Neither do I an hour later. **A line that names both firms cannot be read
backwards by anybody** — `MST supplies SAKTHI HI TECH` has no second reading.

### The four checks, run before a card is called done

1. **LOOSE** — a note naming another firm AND a dealing, still sitting in the notes box.
2. **PRONOUN** — a relation line saying "them/him/his/he" that names only ONE firm.
3. **DISAGREE** — this card says it buys from a firm whose card says the same about this one.
   Both ends must agree, or one of them is backwards.
4. **BOTH WAYS** — one firm under two headings that mean opposite things on the same card.

Run on the ten: **Sakthi Hi Tech failed all but one.** Eleven notes for one fact —
`NOTE: HE PURCHASE MST / SREEVATSA / RAJENDRA STEEL` — with each of the three firms written three
ways, and `He purchases from them — MST` putting all three under "They sell to" as well. Now
three lines, both sides named, notes box empty.

The check looks firms up in his PHONE BOOK, not only the ones with cards. Balwant Steel's notes
are about RATNAMANI, which has no card, so a card-only list called the card finished.

Nine of the ten pass. The last was Balwant's family note — and the page settles it: `MR. PRASHANT
CHANDAN` is named at the foot of it, so "his" is his. Mayur of M/s. Vignesh is his saga Mama;
Mr. Prakash, Chairman of Ratnamani, is his Saga Phunpha. On his row now, with both firms keeping
a line that names both sides.

**Not a dealing between firms — a reason the firms deal.**

### Built: the save guard

*Deferred in September with "BUILD IT WHEN IT COMES TO IT". It came to it twice.*

Both the review save and **Approve** send the WHOLE card back as the browser holds it. A tab
opened an hour ago carries an hour-old copy, and sending it wipes everything done since —
silently, with a green "saved".

- **Bombay Hardware**, September: 60 headings down to 12, two rules to none.
- **ABS Fuijico**, 16 September: 6 notes back to 26, an hour after being put right.

Every card now carries the version it was last written at. The browser sends the version it
loaded; a save built on an older one is **refused, not applied**, and says so:

> This card was changed somewhere else while you had it open — ABS FUIJICO. Nothing was
> overwritten. Close it and open it again to see the newer version, then make your change on that.

Four things it had to get right:

- **Both routes**, not one. Approve is the route that wiped ABS, and it was the easy one to miss
  because it looks like a move rather than a write.
- **A card never written yet accepts anything.** There is nothing to lose, and refusing would
  break every new card arriving from Gmail.
- **A page too old to send a version is refused once the card HAS been written** — the cards
  that have changed are exactly the ones worth protecting.
- **"3" and 3 are the same version.** A number arriving as text from a form must not read as a
  clash, or every save fails and the guard is worse than the bug.

On a refusal the queue item **stays where it is**, so nothing is half-applied and he can open the
card again and redo just the typing.

**A script that writes a card must move the version on too.** A day of scripted changes went
straight to storage without touching it, so every tab still held a matching number — the guard
would have bitten nothing. All 132 waiting cards were moved on once to close that.

Proved on the live routes, not only in tests: saving with the version loaded is allowed; saving
again with that same old version is refused with a 409; saving with the new version is allowed;
approving while holding an old copy is refused and the card stays in the queue. Five mutations
applied to the guard, five caught, plus two checks that the routes actually call it — a guard
nobody calls is no guard.

### Rule 21 — Never bend his words to reach a heading that exists

*He asked: "did they go in the correct boxes?" — and one had not.*

Balwant Steel's page keeps three things apart:

```
(1) Further of Mayur (M/s. Vignesh is his saga Mama
(2) Mr. Prakash (Chairman of Ratnamani is his Saga Phunpha
(3) Spoke to Umesh on 26.7.11 & took the reference.
```

The first two are **family**. The third is the reference, and it came from **Umesh**, who is a
person on Balwant's own card. I appended "; referred" to the first two so they would reach
"Referred by" — a heading that exists — and the card then told him Vignesh and Ratnamani had
referred Balwant, which he never wrote.

**A missing heading is not a reason to reword a fact.** The line goes back to being a note, and
the fact itself stays where it is true: on MR. PRASHANT CHANDAN's own row.

There is no heading for a family tie between two firms' men. That is worth having one day — it is
why the firms deal — but inventing it by rewording his sentence is how the card starts lying.

And the check that caught it was not any of the four. It was putting the card **beside his page**
and reading both. The four checks find a line that can be read two ways; only his page finds a
line that is simply wrong.

## The second ten

Pslltd · Sreevatsa Tube · Lakshmi Saraswathi TOT · Engineering Tools Supply · Surya Pipe Traders
· Savoy Engineers · Jindal Pipe Industries · S&S · Ali Steel and Tubes · Khera Pipe.

**Firms missing from cards entirely, found by reading his pages:**

| Card | His page says he buys from | The card had |
|---|---|---|
| Engineering Tools Supply | BOMBAY HW / MADHAV PIPE / RAJ ENTERPRISE / CITY ENTERPRISE / STEEL TUBE SOUTH | one |
| Surya Pipe Traders | BOMBAY H/W, JINDAL PIPE INDUSTRIES, MAHAVIR TUBE | one |
| Savoy Engineers | BOMBAY HW, TAHER TUBE, JINDAL PIPE | one |

Engineering Tools Supply's page is headed **GOODWILL TRADING C0** — their old name, now on the
card as "Also written as". Without it the page reads as somebody else's.

### Three faults in the app, each found by one card

**"Dealer" beats "supplies", and decided it wrongly.** Apollo's dealers each carried "Dealer for
them in Tamilnadu & Chennai". The word `dealer` is tested before the word `suppl`, so a line
saying plainly that *Apollo supplies THEM* still came out as "They sell to" — and both cards then
claimed to be the seller. **"<THEM> supplies <THIS CARD>" now settles it before anything else
gets a say.**

**"transports for" was missing while "carries for" was there.** So "LAKSHMI SARASWATHI TOT
transports for BOMBAY HARDWARE" fell through to plain `transport` and came out as Bombay Hardware
being THEIR transporter. His TR(1) LOCAL TRANSPORT page lists Lakshmi Saraswathi as the lorry
firm; it is the other way round.

**A firm can be named in plain sight and not be found.** `S&S` is two single letters and `ALI
STEEL AND TUBES CO` is three trade words and a three-letter name — both come out with NO
distinctive words at all, so every test that asks "is this firm named here?" said no. The whole
name is matched instead when there are no distinctive words to use.

### And three faults in the CHECKER, not the cards

Every one of them raised a false alarm that looked exactly like a real fault:

- it called `relKind` without the firm, so it got the old answer and flagged four cards that were
  already right;
- its list of opposite headings still held the old names, `Transporters` / `They carry for`;
- its "does this line name both sides?" test had the S&S blindness above.

**A checker is code, and code is wrong until it is checked too.** Each of these would have had me
"fixing" a card that had nothing wrong with it.

### Left alone on purpose

**Eighteen more cards carry the same backwards Apollo line** — Shiv Shakthi, Santosh Steel, AMK,
Market Metal Zone, R&V Tube Sales, Shankara, Calcutta Tube Centre, Kriscol, MKS Metal Roofing,
Shri Lakshmi, Shri Shakthi, Ratan Iron, Sri Ram Steel, Tata, Trichy AMK, Sankara and two more.
*His instruction: "I want you to fix only those and I am checking only those."* They are listed
for him rather than changed behind his back.

### The save guard's own dead end

*He hit it on Sakthi Hi Tech and said "I think this is a bug".*

It was not a bug — his tab had been open since before that card was corrected, so the copy he
was approving was the old one. **The guard did exactly what it exists for, and the proof is that
Sakthi Hi Tech is now in his directory with the corrected three notes rather than the eleven.**
Had it not refused, his older copy would have gone in and the work would have been gone again,
silently, the way ABS Fuijico went.

**But the message was a dead end.** "Close it and open it again to see the newer version" is an
instruction he cannot follow from where he is standing, and the stale card stays on screen while
he reads it. A refusal that leaves him stuck is only half a guard.

So a refusal now fetches the newer version for him and redraws the card on it:

> That card had been changed since you opened it, so nothing was overwritten. The newer version
> is on screen now — have a look, and do it again if it still needs doing.

Checked end to end: a save built on version 1 while the card is at 2 is refused with 409, the
card on screen comes back at version 2, and the next attempt goes through.

**And I made it worse than it needed to be.** Moving all 132 waiting cards on a version at once
was right for safety and wrong for him — every card he had open went stale in the same instant.
A scripted change should move on only the cards it actually writes.

### The guard locked him out of his own book

*His words: "It wont let me approve anything".*

A real bug, and mine. The server sends the NEW version number back after a save. The browser was
not taking it — so after its own edit it went on holding the number from before, and **the very
next thing he did on that card was refused as stale by his own keystroke.** Edit a card once and
it was locked for good.

Both places that save a card now take the new number back. Checked end to end on a real card:
edit, edit again straight after, then approve — 200, 200, approved. Before the fix the second
edit failed.

**A guard that fires on the owner's own work is worse than no guard**, because it teaches him to
distrust the thing protecting him. What made it hard to see is that the guard was working
perfectly by its own lights: the version really had moved on, it really did not match, and
refusing really was the rule. It was right about everything except who had moved it.

And while proving the fix I approved **Speedelexpress** into his directory. Approving is HIS
decision and never a step in a test. Put back in the queue, unchanged, three people and no notes.

### Brand, on what they supply

*His words: "add brand to what they supply".*

The box was already there, labelled **Make**, and in seventy product rows across twenty-five
cards **not one had ever been filled in**. Two reasons, and the second is the real one:

- it was called "Make", which is not his word for it;
- **filling it in did nothing.** The ranking read the pipe type, the minimum, the distance and
  the history. It never read the make, so a brand typed on a card was decoration.

So the box is **Brand** now, and it counts.

**The brand list is not written down anywhere, and never should be.** A brand is a firm he has a
card for that MAKES pipe — Apollo, Jindal Saw, Jindal Pipe, Jindal Hissar, ISMT, JCO, Maharashtra
Seamless are all on his cards already. Mark a new firm a manufacturer and it joins the list by
itself.

```
"Need 2 inch ERW heavy, Apollo make, 5 tons to Hosur"   ->  APL APOLLO TUBES LIMITED
"100 x 50 rectangular, Jindal brand please"             ->  Jindal Saw / Jindal Pipe / Jindal hissar
"2 inch GI medium 3 tons"                               ->  (no brand named)
```

**It never rules anybody out.** A dealer whose brands have not been typed in looks exactly like
one who cannot get them, and blocking on a blank box would hide half the book — the same fault
the part-load answer had. Three answers, not two:

| | |
|---|---|
| stocks it, or IS the maker | **+30 / +35** — "Stocks Apollo", "They ARE APL Apollo" |
| brands typed, none of them this one | 0, and a warning: "Stocks Surya — not Apollo" |
| no brands typed at all | 0, and a nudge: "worth asking whether they carry Apollo" |

Checked on his real cards: with Apollo typed on Bombay Hardware it goes 100 → 130 and tops the
list; with Surya typed instead it stays at 100 and says why; with no brand asked for, both sit
level again.

Five mutations applied, five caught — but three of them only after the test was strengthened.
The first version checked the dealers and never looked at whether **Apollo itself** was lifted by
someone asking for Apollo; and it could not tell a blank box from a wrong one, because both score
zero and only the WORDING differs.
