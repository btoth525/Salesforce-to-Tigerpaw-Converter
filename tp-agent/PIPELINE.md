# Salesforce → TigerPaw pipeline (Papi's playbook)

Brandon's standing ask (2026-10-21): "take my tigerpaw quote and import it from
salesforce into tigerpaw — creating the account if it's not there, adding all
the contacts, then creating the quote and importing the quote."
This is the proven procedure, built on the TechTrans run (account 12871,
Salesforce quote Q-02168). Everything below is verified live unless marked OPEN.

## Transport (tp-agent)
- Agent on ASAP-RDP2 (Brandon's session, user Btoth), binds 127.0.0.1:8799 ONLY.
  No inbound ports on the network, ever. Outbound Cloudflare tunnel
  "tp-agent" → https://tp-x7q4.plexserver525.com/rpc, header X-TP-Token.
- Runs hidden via scheduled tasks tp-agent / tp-tunnel (wscript VBS launchers);
  desktop shortcut "TP Agent" starts both. Code + installer in this repo
  (tp-agent/, agent v0.3.1, installer v5).
- Local helper: ~/workspace/tp-agent/bin/rpc.sh '<payload-file>' (curl; urllib
  truncates big responses). /tmp wipes between turns — keep files in workspace.
- run_ps command ceiling ~32KB: send file payloads as base64 in ≤20KB chunks.

## Ground rules (learned the hard way)
- NEVER write to a VB6 ListView with raw LVM_INSERTITEM/LVM_SETITEMTEXT —
  it crashed TigerPaw and lost an unsaved form. List READS (list_info/
  list_items) are safe. All writes go through the app's own dialogs.
- Combos: CB_GETLBTEXT returns zeros cross-process. To read a combo's items,
  iterate combo_select(index) + get_text. To SET a combo, write its Edit
  child (WM_SETTEXT) — every TigerPaw combo here is editable.
- Checkboxes: BM_SETCHECK times out on VB6; use click_ctl (mouse-post) and
  verify with check_state (BM_GETCHECK works).
- Command buttons in dialogs answer BM_CLICK via click_ctl.
- Dialogs (Add Phone, Add Email, etc.) are separate top-level windows —
  win_tree them by title_contains.
- Real-mouse clicks: ground targets on a CURRENT full screenshot
  (visual_grounding); window positions drift, so stale coordinates miss.
  Screenshot→click in image space is the reliable pattern.

## Step 0 — gather from Salesforce (reads are free)
- Account: billing street/city/state/zip, Billing_Email__c, Billing_Phone__c.
- Opportunity: its OWN billing fields (they do NOT auto-fill from the account),
  Billing_Special_Instructions__c, opp name (quote description source).
- Contacts on the opp (roles): name, email, phone, mobile, title.
  Note Christina's email existed in Salesforce (cgebhart@tti-corp.com) even
  though summaries may omit it — always re-read the contact records.

## Step 1 — the quote CSV (established flow, do not improvise)
- Pull the quote's lines in TP-IMPORT report format (report 00ORm000001MqsDMAS:
  Cost: Cost #, Product Code, Description, Quantity 1.00, $ amounts, Quote
  Number, Quote Line Created By, Opportunity Name; strip HTML).
- Run Brandon's converter (Salesforce-to-Tigerpaw-Converter, converter.py,
  keep_extras=False) → 13-column CSV. Hand-built/modified CSVs FAIL
  TigerPaw's import — converter output only, unmodified.
- Known artifact: a line whose Salesforce net carries a sub-cent fraction
  (usually a plugin-quantity labor line) imports a penny short (Q-02168:
  $46,056.17 in TigerPaw vs $46,056.18 in Salesforce). Fix it in TigerPaw
  after the import — see the penny-fix step in Step 5. Brandon wants the
  totals to match exactly.
- Stage the file on the server: C:\Users\btoth\tp-agent\<QuoteNo>_tigerpaw.csv
  via run_ps base64 write; verify byte length matches.

## Step 2 — TigerPaw account (create if missing; dedupe first)
Dedupe like Salesforce: search TigerPaw accounts by name/company before
creating (Ben's rule: no duplicate accounts).
New/existing account form fields (HWND set_text / combo Edit writes, then
READ BACK every field):
- Name, Address 1, Address 2 (Suite), City, State combo, Zip, Country combo
  (United States of America), Primary Rep = Brandon Toth, Status = Active,
  Type (Prospect unless Brandon says Customer), Vendor UNCHECKED for customers.
- Marketing Source is REQUIRED to save a new account ("Cold Call" was used
  for TechTrans — confirm with Brandon if a deal has a real source).
Phones — double-click the empty PHONE NUMBERS list → "Add Phone for <acct>"
dialog (number box, type combo, Primary Phone Number checkbox, OK /
Add Another / Cancel — all BM_CLICK-able). Add Another for extra numbers;
the app formats numbers itself: (281) 335-8000.

## Step 3 — contacts (per contact)
- Account page → Contacts tab → add-contact toolbar icon → "New Contact" page.
- First/Last name textboxes (find by geometry in a fresh win_tree — handles
  change every form instance). Title via the Title combo's Edit child.
- Phones: double-click the contact's PHONE NUMBERS list → Add Phone dialog;
  the type combo ACCEPTS typed values ("Mobile" landed for a cell number).
- Email: double-click EMAIL ADDRESSES list → "Add Email Address for <name>"
  dialog: email textbox (the wide top field, id=4), Primary Email Address
  checkbox ON, NEVER check "Create customer portal login".
- Save with focus_window + Ctrl+S — contact pages DO commit on Ctrl+S; the
  tab retitles from "New Contact" to the person's name. DB contact ids
  confirm the save (Christina/Mark/Wendy = 13545/13546/13547).

## Step 4 — special instructions + account save
- Account → Special Instructions tab → the UPPER memo is the general
  Special Instructions (the lower one is Service Order Special Instructions —
  billing text goes in the UPPER). Text from the opp: e.g.
  "Pays by EFT or Check. Send invoices to <billing email> (<name>, Accounting)."
- SAVE VIA THE TOOLBAR SAVE BUTTON (ground it). Ctrl+S on the account page
  is NOT reliable. Saving a customer with Vendor unchecked fires
  "delete the vendor information saved for this account?" → YES.
  Saving then runs a SPELL CHECK over the notes (acctspay, tti, Royer…) →
  Ignore All for each word; never Change/Add (would alter the text).
- Verify: account header "Updated by Brandon Toth <today> <time>", Vendor
  state 0, phones list rows, SI text — all re-read AFTER the save.

## Step 5 — create the TigerPaw quote + import the CSV
(Proven 2026-10-21: Brandon performed it once under the teach recorder —
see "Teach mode" below — and Papi verified every step + fixed the penny.)
- ImportWizard.exe is MASTER DATA ONLY (Accounts, Price Book, Vendor…) —
  NOT the quote path. The quote import lives inside the quote form.
- Create: account ribbon → Quotes → "Quotes and Opportunities for <acct>"
  → New Quote → "Quote Templates" picker opens (the list can look empty —
  proceed; Brandon clicked through its toolbar/OK area) → the account's
  Special Instructions popup may appear (dismiss it) → the
  opportunity/quote form opens with the description pre-filled with the
  Salesforce opp name.
- Description: prefix it "SF Q-<quote number> " (Brandon typed the prefix
  and pasted the number; final form: "SF Q- 02168TechTrans International,
  Inc.- Houston - Access Control,Cameras - Rhombus"). For automation,
  set_text the description combo's Edit child to
  "SF Q-<num> <opp name>" directly.
- A Yes/No dialog can appear during creation — Brandon answered **No**.
- "Specify Opportunity Source" dialog: pick the source in the combo → OK.
  (Which value Brandon picked wasn't captured by the recorder — confirm
  once, then always use it.)
- Import: in the quote form, the menu/popup command **"Import Quote from
  Generic Text File"** → dialog → browse (…) → file picker titled
  "Generic quote text file" → select C:\Users\btoth\tp-agent\<QuoteNo>_tigerpaw.csv
  → Open → then set: ✓ "First line contains column names (do not import)",
  ◉ "Add the imported items to the current quote", ✓ "Import the selling
  prices", ✓ "Import the costs" → OK. Lines land in CSV order.
- Save: toolbar floppy **Save** (main toolbar, ~5th icon; Brandon's own
  final click). Expect the informational notice "This quote cannot be
  printed until it is approved." → OK. Do NOT approve in TigerPaw unless
  Brandon says so.
- Verify: header total textbox == Salesforce net_total, line count == CSV
  rows. Capture the TigerPaw quote number from the Quotes grid.

## Penny fix (after import, when totals differ by $0.01)
- Brandon's rule (2026-10-21): the adjustment goes on a PART, never on a
  labor line — labor rates stay exactly as quoted. Diff Salesforce line
  nets (cpq_read_quote) against CSV qty × price to find the total gap
  (Q-02168: Trim Out Devices 47 × $145.00 = $6,815.00 vs SF $6,815.01 —
  leave that labor line untouched).
- Pick a qty-1 PART line (Q-02168: AL - AL600ULACM power supply) and move
  its unit price by the gap: $539.97 → $539.98 for +$0.01.
- In the quote grid (CSV order; rows ~19px pitch — the Permit row, #11,
  double-clicked at ~(1357,724) in the 3412×931 session), double-click the
  part's row → "Quote Item Detail" dialog → set the unit-price textbox
  (dialog-relative ~(1550,553)) via set_text → read back → OK.
- Header total must now equal the Salesforce total exactly. Save (floppy)
  → OK the print notice. Verified on Q-02168: $46,056.17 → $46,056.18
  with Trim Out back at exactly $145.00 and the penny on the power supply.

## Teach mode (how Step 5 was learned)
- teach_logger.py (in this folder): POLLING recorder — foreground window,
  clicks (with the control under the point), keystrokes → teach-log.jsonl
  on the server; 20-min auto-stop; stop-file teach.stop.
- NEVER use low-level hooks (WH_KEYBOARD_LL / WH_MOUSE_LL) again: v1
  hooked the input path and froze Brandon's clicks mid-session
  (2026-10-21). Polling (GetAsyncKeyState + GetForegroundWindow) can miss
  an event but can never block one.
- After distilling a recorded run into this playbook, DELETE the raw log
  (it contains everything Brandon typed during the session).

## Acceptance check (every run)
Account fields read back ✓ · phones on account + contacts ✓ · contacts
saved (ids) ✓ · SI text ✓ · Vendor correct ✓ · quote lines + total
verified against Salesforce (penny rule) ✓ · report to Brandon with the
TigerPaw quote number.
