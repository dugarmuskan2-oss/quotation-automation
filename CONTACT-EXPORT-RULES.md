# How the address book becomes cards

Everything learned about reading DSC's Google Contacts into the Partner Directory. Written
down because these rules were paid for — most of them came from something going wrong on real
data, and the cost of relearning them is another wrong card in front of the owner.

**The owner's standing instruction: DO NOT SKIP ANY DATA. If there is any doubt about where a
piece of information goes, ASK — do not choose quietly.**

---

## 1. The shape

A contact's notes box becomes one or more **firms**. A firm becomes one **card**. A card holds:

| Field | What goes in it |
|---|---|
| `company` | The firm's name as written |
| `city`, `address` | Head office only |
| `branches[]` | `{city, area, address}` — every other office, factory, depot, godown |
| `people[]` | `{name, role, branch, phones[], emails[]}` |
| `products[]` | `{p, spec}` — what they make or stock |
| `types[]` | GI / ERW / Seamless / SS / MS / Alloy |
| `notes[]` | `{t, d}` — **only** what fits nowhere above |
| `relations` | Written into `notes` on both cards (see §5) |

`role` is the person's **job**. `branch` is **where they sit**. These were one field until
Sept 2026 and it did not work: Jindal Saw has 53 people across seven places, and the reading
had nowhere to put the place, so it wrote job, product and place into one box —
`"HEAD - DOMESTIC SALES (SEAMLESS DIVISION), for CS pipe (Bombay office)"`.

---

## 2. Reading a notes box

### Headings govern everything below them

```
🏭NASIK FACTORY 🏭
 (1) GIRISH NIKAM ( DESPATCH) -M- 9970053986
(2) MAHESH PERDESH ( DESPATCH) -M- 8600107980
       EMAIL: Mahesh.pardeshi@jindalsaw.com
(3) MANGESH LAHAMGE -M- 8600107980 (tc changing person)
```

Every numbered entry belongs to `NASIK FACTORY` until the next heading. All seventeen of them,
not the four that happen to repeat the word. A heading may be marked by emoji, capitals, or
simply sitting alone on its line.

### Brackets after a name are that person's job

`GIRISH NIKAM ( DESPATCH)` → name `GIRISH NIKAM`, role `DESPATCH`.
`MANGESH LAHAMGE ... (tc changing person)` → role `tc changing person`.

The bracket goes **next to their name**, never left inside the notes text.

### Numbering means nothing

These lists restart, repeat and skip. Use the numbers only to see where one entry ends and the
next begins — never to count, and never to decide something is missing.

---

## 3. Numbers

- **Copy digit for digit.** Do not reformat, do not add or drop a country code.
- **A short number stays short.** `904743223` is nine digits in the notes; it is left at nine.
  Completing it is a guess, and a wrong number is worse than a visibly broken one.
- **Keep an extension with its number, in one entry**: `044-27885491 EXTN: 403`.
- **Non-Indian numbers keep their country code**: `+94 71 0399475`. Only recognising the Indian
  10-digit shape lost Lalan Engineering's Colombo numbers entirely.
- **Trunk groups are expanded, but only under a rule that refuses when unsure**
  (`expandTrunkLine`). `022-24902570 /72 /76 /78` is four lines; the tail must be plain digits,
  shorter than the *line* (not the whole string — `044-49542545 / 26544914` is two whole Chennai
  numbers), and land on a digit. An extension, comma or letter anywhere → left exactly as
  written. An earlier pass invented these expansions with no rule and had to be undone.
- **A number with no owner named belongs to the FIRM**, not to the nearest person above it. It
  keeps the label the owner gave it — `Godown`, `Board`, `Factory`, `Fax`.

---

## 4. People

- **A shared number does NOT mean one person.** Mahesh Perdesh and Mangesh Lahamge are both
  written against 8600107980. *Owner's decision: keep both, both carry the number.*
- **A shared email DOES mean one person.** "Mahesh Pardeshi" and "MAHESH PERDESH" both hold
  `mahesh.pardeshi@jindalsaw.com` — one man, two spellings. Merge, keeping the fuller name.
- **A person covering two branches gets an entry under each.** *Owner's decision.* Vinay Tavare
  appears under Bombay office and under Nasik factory, same number both times.
- **A department heading names the branch, not the job**, when a matching branch exists:
  `PPC-DIV -- D.V SANGLE` sits under `NASIK FACTORY (PPC DIVISION)`. *Owner's decision.*
- **Google's display name is often a label, not a person** — "Purchase | Fire Trix", or the
  firm's own name. A plain name beats a label; length only decides between two of a kind.
- **A nameless line is still a person.** Keying people on name-or-email alone made every
  nameless office line collapse to the empty string, so the second was dropped as a duplicate
  and its numbers went with it. The number identifies it.

---

## 5. A firm named inside another firm's entry

**It is still a firm, and it gets its own card.** A transporter, a coater, a galvaniser, a
testing lab, an agent. A firm buried in someone else's notes never gets a card, is never
ranked, and is never sent an enquiry.

The connection is written onto **both** cards: the transporter's says who it hauls for, the
mill's says who hauls for it. Whichever the owner opens, the connection is on the page. If the
named firm is not in the book at all, the note still goes on the card that is — half a
connection beats none.

2,729 of the 3,568 firms found were named inside another firm's entry.

---

## 5a. A firm with no way to contact it stays a note

**A firm named in passing, with no phone and no email of its own, does NOT get a card.**
*Owner's decision.* It stays where it was — as a note on the card of whoever mentioned it. A
card you cannot ring is a card you cannot use, and 605 of them would bury the firms he can.

This narrows §5: a firm named inside another firm's entry gets its own card **when it carries a
number or an address**. When it carries only a name, the mention itself is the record.

---

## 5b. A firm with no name is named after the person

`RAVI -- 9840012345` with no company beside it becomes a card called **Ravi**, with a note
saying no firm name was given. *Owner's decision.* The number is worth keeping and he needs
something to find it by.

---

## 5c. Broken addresses go in the notes, not the address box

`info@southindiatubes@gmail.com` (two @ signs), `bluebox_ajit@yahoo.co` (cut short),
`EVEREST TRADING CO@YAHOO.COM` (spaces in it). These are **not repaired** — that is a guess —
and they are **not stored as addresses**, or something will try to email them.
*Owner's decision:* keep the text as a remark, so he can move it up when he knows the right one.

---

## 5d. The trade is suggested, never assumed

Every card needs a trade — dealer, manufacturer, transporter, fabricator. The reading proposes
one **only when the notes actually say it** ("PIPE DEALER (STOCKIST)" → dealer, "ROADLINES" →
transporter) and the card shows it pre-filled. *Owner's decisions: suggest it, he confirms; the
card is **approvable as it stands** — a guessed trade does not block Approve; and where the
notes say nothing, **leave it blank** rather than guessing from the firm's name.* A name is
weaker evidence than a remark, and a wrong trade decides who gets sent a freight enquiry.

On the first 48 cards this guessed 13 and left 35 blank.

---

## 6. What must NOT become a card

- **Customers.** The directory is who he buys from and ships with. A customer on it gets ranked
  as a supplier and can be sent a freight enquiry. Matched on the company name of all saved
  quotations **and** on email domain — a firm read from a notes box usually has no address, so
  the domain test alone missed Chemplast Sanmar, which was on the held-back list all along.
- **A WhatsApp group, a website, or a note to self.** Keep as a note on the firm it belongs to.
- **A person named as a referrer.** "Suresh Chordia referred Saroj Steel" is one firm, not two.

---

## 7. Addresses

One canonical spelling, cleaned on write **and** on read, or every duplicate guard in the app
misses (they all compare strings):

- Strip `Name <addr>` wrappers, quotes, a typed `e-mail:` label, `mailto:`, trailing punctuation.
- **Do not repair.** `rohit,jaiswal@stecol.co.in` has a comma where a dot belongs — it is
  rejected so it shows red, never silently "fixed".
- **Free mail and Indian ISP domains are not firms**: gmail, yahoo, rediffmail … and vsnl, bsnl,
  mtnl, sify, airtelmail, dataone, satyam, eth. vsnl.net alone put 47 unrelated people on one
  card called "Vsnl", which reached the directory as a transporter. **One list, in
  `utils/contacts.js`** — there were two, and the short one had no ISPs on it.

---

## 8. Notes

Notes are the **last resort**, not the first. A product range goes to `products`, a branch to
`branches`, a postal address to `address`, a person to `people`.

Genuine remarks do belong there, word for word, never summarised: *"they do not keep Rourkela
material"*, *"his shop is in Satangadu"*, *"only pays after 60 days"*, *"credit limit fixed
5 lac"*.

**Once a notes box has been read, the verbatim copy comes OFF the card.** Leaving it beside the
people extracted from it means reading everything twice with no way to tell which is
authoritative. The reader's own kept remarks are spared by name — they are substrings of the
raw text too, and dropping them would throw away the remark along with the dump.

---

## 8a. The firm's name

The contacts scan has only an address to go on, so it makes a name out of the domain —
`md4.com` becomes "Md4", `abs.co.in` becomes "Abs". Useful as a placeholder, useless on a card:
the owner cannot tell "Md4" from anything, and "Gamail" is not a firm at all — it is someone's
typo of gmail.com.

**A name read from the notes replaces a name guessed from a domain.** *Owner's decision.*
Between two real names the fuller one wins — "BOMBAY HARDWARE PVT LTD" over "Bombayhardware" —
because that is the name he would write on an enquiry.

A name counts as guessed when it is exactly what `companyFromEmail` would produce from one of
the card's own addresses.

---

## 9. Merging into the waiting list

A firm read from a notes box is usually one already on the list **with more detail**. It must
improve that card, not sit beside it.

- Match on the app's own identities (`identitiesOf`): email **domain**, tidied name, any shared
  phone. Not the raw address — Bombay Hardware was queued under `bhplsales@` while its Google
  card carried `accounts@`, and nothing matched.
- **A card already approved is settled — leave it.** One still waiting is not, so a richer card
  folds into it.
- **Never let a thin card block a rich one.** A firm was skipped because *one* of its eight
  addresses was already known, so the owner saw a one-line card while the eight-person version
  was discarded.
- **Blank never beats a stored answer.** The review copy is frozen when queued; approving it
  three days later was overwriting a city and address typed since.

---

## 10. Before trusting a run

- **Count what went in against what came out.** Every phone number and email in the source, vs
  every one on a card. That check found 102 numbers trapped inside trunk-line strings and 36
  genuinely lost.
- **Read line by line, never across newlines.** A matcher that spanned lines glued the next
  list number onto the phone above it — `8446241136)\n6` became one 11-digit number — and
  reported 1,108 false losses.
- **A second pass that re-reads the source catches what the first missed.** On 27 batches it
  recovered 26 dropped items and removed 15 invented phone numbers.
- **Say what was held back and why**, per firm. "441 held back" with no reason is uncheckable —
  and it was wrong: `gmail.com` had got into the customer list and was excluding every supplier
  with a Gmail address.

---

## 11. The standing rule

Nothing reaches the directory without the owner approving it, one firm at a time. Every tool
here writes only to the waiting list or the queue. Every tool has a dry run by default.
