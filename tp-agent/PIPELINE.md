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
- Known artifact: sub-cent unit rates round down (Q-02168 lands at
  $46,056.17 in TigerPaw vs $46,056.18 in Salesforce). Flag it, don't fix it.
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

## Step 5 — create the TigerPaw quote + import the CSV  [OPEN]
- ImportWizard.exe is MASTER DATA ONLY (templates: Accounts, Price Book,
  Vendor…) — not the quote path.
- In-app: account ribbon → Quotes → "Quotes and Opportunities for <acct>"
  window → New Quote → "Quote Templates" picker — the list was EMPTY on
  2026-10-21. OPEN QUESTION for Brandon: how he starts a quote (template
  name? different entry point? does an import flow create the quote?).
- Once a quote shell exists: find its import (expected: quote editor's
  import using the converter CSV), run it, then verify line count = CSV
  rows and Net Sale = CSV total (expect the known penny rounding).
- Fill this section in with the proven clicks the first time it succeeds.

## Acceptance check (every run)
Account fields read back ✓ · phones on account + contacts ✓ · contacts
saved (ids) ✓ · SI text ✓ · Vendor correct ✓ · quote lines + total
verified against Salesforce (penny rule) ✓ · report to Brandon with the
TigerPaw quote number.
