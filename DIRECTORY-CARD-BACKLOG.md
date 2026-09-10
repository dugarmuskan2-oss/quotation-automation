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

## Still open from earlier, on Apollo

- **"Tamilnadu & Chennai" and "Chennai" are separate groups**, so Sankara and Trichy AMK appear
  under both. Left as written rather than merged.
- **25 of Apollo's 30 dealers are in the waiting list**, so their names are plain rather than
  links. They become links as they are brought into the queue — *his decision.*
