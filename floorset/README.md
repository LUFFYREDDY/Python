# Floorset — trial build

Table and entry booking for clubs, built from a picture of the room. This is
the trial version of the production split described in the developer
handover. The single demo file is replaced by **two separate interfaces**:

| Interface | URL | Who uses it |
|---|---|---|
| **Guest booking page** | `/v/<venue>` e.g. `/v/quarter` | The club's customers. Shows only the club's name, colours and typeface. No demo bar, no platform name, no developer text. |
| **Owner dashboard** | `/owner` | The club owner or floor manager, behind a sign-in. Bookings, door check-in, floor plan, nights, branding and policy. |

Both run from one small Python server that uses only the standard library and
SQLite, so there is nothing to install.

## Run it

```bash
python3 -m floorset.server
# Guest page:      http://localhost:8000/v/quarter
# Owner dashboard: http://localhost:8000/owner
```

On first start the server creates `floorset/floorset.db`, seeds the demo venue
(Quarter Lounge, two floors, the next Friday and Saturday) and prints the
owner's sign-in. Set your own password with:

```bash
FLOORSET_OWNER_PASSWORD='choose-something-long' python3 -m floorset.server
```

| Variable | Default | Meaning |
|---|---|---|
| `FLOORSET_DB` | `floorset/floorset.db` | SQLite file |
| `FLOORSET_PORT` | `8000` | Port |
| `FLOORSET_OWNER_PASSWORD` | random, printed once | Owner password (re-applied on every start when set) |
| `FLOORSET_TRIAL` | `1` | Trial mode: the SMS code is shown on screen and no money is taken |

Tests: `python3 -m pytest floorset`

## What the guest can do

1. Pick a night and see what the night is: headline, line-up, doors, last
   entry, dress code and age.
2. Move between floors. The basket is kept across floors.
3. Tap a table on the plan to see the cover charge, the "entry for N included"
   line, the redeemable policy and the hold-until time. Add it to the basket.
4. Add general entry with a 0–30 stepper. Adding a table folds that many
   entries into the table so nobody pays twice. **Removing the table gives
   those entries back.** That settles open decision #6 in the handover, and the
   guest is told when it happens.
5. Pick an occasion and leave a note.
6. **Continue** puts a 10-minute hold on the tables. A countdown shows how long
   is left. If someone else has just taken a table, the guest is told straight
   away.
7. Enter name, mobile number (6-digit code), arrival time and consent to the
   club keeping their details.
8. See the payment summary with the GST split and the cancellation policy, then
   pay.
9. Get a reference like `QU-7K2XB` and an **Add to calendar** file.
10. Later: **Find or cancel a booking** using the reference and phone number.
    The refund follows the venue's policy.

## What the owner can do

- **Bookings:** pick a night and see revenue, bookings, guests expected,
  checked in, tables sold, occasions, no-shows and refunds. The live floor
  plan shows which tables are booked or checked in. Tap a booked table to
  jump to its booking. Tap free tables to create a **walk-in or comp**
  booking. Each booking can be marked arrived or no-show, or cancelled with a
  chosen refund.
- **Door:** a large, phone-friendly search by reference, name or last 4
  digits, with one-tap check-in. If the network drops, it keeps working from
  the last list it downloaded.
- **Floor plan:** the editor from the handover, §5:
  - select, select many, marquee selection and group drag that stops as a
    group at the wall
  - draw table and draw zone
  - align, even gaps, nudge, and bulk tier, shape, cover and size
  - single table and zone editing
  - "block" a table so it can't be sold online
  - floors: add, rename, delete
  - tables by type with automatic placement, which reports honestly when not
    everything fits
- **Nights:** dates, labels, line-up, doors, last entry, dress code, age and a
  note for guests.
- **Branding & policy:**
  - name, logo mark and shape, colours, surface, typeface and entry price
  - redeemable or not, and the table hold-until time
  - GST rate, and whether prices include GST
  - cancellation window and the late refund percentage
  - a live preview of the result
- **Venue config:** the whole venue as JSON to copy, or paste back and apply.

Changes in the floor, nights and branding tabs stay as **unsaved changes**
until **Save & publish**, so guests never see a half-edited floor. The server
re-checks every rule on save:
- positions snap to 0.5 units
- everything stays inside the 2.5-unit wall margin
- table codes are unique on each floor
- zone kinds come from the fixed list
- colours, times and prices are valid

It refuses to delete a table or night that still has live bookings.

## The rule that matters: no table sold twice

Every held or confirmed table is a row in `booking_tables`. A **unique index
over (venue, night, table) for active rows** means the database itself
refuses a second claim. It does not rely on application code. Holds expire
after 10 minutes and their tables are released. A test races six buyers for
one table and checks that exactly one wins.

## Trial vs production

| Area | Trial build | Needed for launch |
|---|---|---|
| Payments | "Pay" confirms the booking without taking money (`trial-…` payment id) | Payment gateway; confirm only from the gateway's server-side webhook; refunds through the gateway |
| SMS | Code is shown on screen | DLT-registered SMS/WhatsApp provider for codes, confirmations and reminders |
| Hosting | One process and a SQLite file | Postgres, HTTPS, backups, a process manager |
| Owner accounts | One owner per venue, set from the command line | Staff roles (manager or door), password reset, an admin console for onboarding venues |
| Floor plan upload | Not in this pass (draw, place by type or paste JSON instead) | Plan photo upload and reading (§5.3) |
| Fonts | Loaded from Google Fonts | Self-hosted |

Also not in this pass: freehand sketch, and reading a layout from an uploaded
plan photo (see the handover). Table types are templates: once tables are
placed, editing a type changes only future placements. That settles open
decision #5, the "template" option.
