# Cash Clinic — Abundance Quiz setup guide

A complete system: quiz → result → Tap payment → the digital book is emailed automatically.

```
index.html          ← the quiz (GitHub Pages)
success.html        ← post-payment page
logo-wordmark.png   ← logo used in the header / emails
favicon.png         ← browser tab icon
firestore.rules     ← database security rules
storage.rules       ← book security rules (private)
firebase.json       ← ties the config together
functions/
  index.js          ← server: create charge + verify + email the book
  package.json
  .env              ← already filled with your values (edit SUCCESS_URL)
```

**Security in one line:** the Tap secret key and the email password never touch the browser — they live only on the server (Cloud Functions). The price is enforced server-side (not in the page), and the book is private and delivered through a signed link that expires after 7 days.

---

## What you need first
- A Firebase project on the **Blaze** plan (Functions + outbound calls to Tap need Blaze; it stays near-free for light usage).
- A **Tap Payments** account (secret key `sk_test_...` for testing, `sk_live_...` for live).
- The sending email (Google Workspace — `abdullah.a@cashclinic.net`).
- The book PDF file.

---

## 1) Prepare the files
1. Download the whole folder to your computer.
2. In **`index.html`** and **`success.html`**, replace the `CONFIG.firebase` values with your project's
   (Firebase Console → Project settings → Your apps → Web app → config).
3. In `functions/.env`, it's already filled — just set **`SUCCESS_URL`** to your GitHub Pages link
   (the one that ends with `/success.html`).

---

## 2) Upload the book (private)
```
firebase storage:objects:upload ./dalil-alwafra.pdf gs://cash-quiz-906a6.firebasestorage.app/books/dalil-alwafra.pdf
```
Or from Firebase Console → Storage → create a `books` folder and upload the file there.
Keep it at the same path set in `BOOK_STORAGE_PATH` inside `.env`.

---

## 3) Set the secrets (one time)
From the terminal, inside the project folder:
```
firebase functions:secrets:set TAP_SECRET_KEY     # paste sk_test_... then Enter
firebase functions:secrets:set SMTP_PASS          # the email App Password
```
> **Google Workspace email:** turn on 2-Step Verification for `abdullah.a@cashclinic.net`, then create an
> **App Password** (myaccount.google.com → Security → App passwords) and use that 16-character code here —
> not the normal login password. If App Passwords don't show up, your Workspace admin needs to allow them.

---

## 4) Deploy
```
cd functions && npm install && cd ..
firebase deploy --only functions,firestore:rules,storage
```
After deploying, the function URLs are printed. **Copy the `tapWebhook` URL**, it looks like:
`https://us-central1-PROJECT.cloudfunctions.net/tapWebhook`

---

## 5) Connect Tap to the webhook
In the Tap dashboard → **Developers / Webhooks** → paste the `tapWebhook` URL.
This is what makes the book go out automatically after a successful payment (even if the buyer closes the page).
Make sure the secret key from step 3 is from the same Tap environment (test or live).

---

## 6) Publish the front-end on GitHub Pages
1. Upload **`index.html`**, **`success.html`**, **`logo-wordmark.png`**, and **`favicon.png`** to the repo,
   all in the same folder (same drag-and-drop method as your other sites).
2. Settings → Pages → enable publishing from `main`.
3. Take the site URL and make sure **`SUCCESS_URL`** in `.env` points to `…/success.html`
   (if you change it, re-run `firebase deploy --only functions`).

---

## 7) Test it
- Open the quiz link, answer the 11 questions, click "شوف نتيجتي" (See my result).
- Click "احصل على دليل الوفرة المالية" → fill in the details → pay with a Tap test card.
- Expected: the success page confirms the order and the book lands in the email within minutes.

**Tap test card:** `5123 4500 0000 0008` — any future expiry — CVV `100`.

---

## Going live
1. Switch the secret key to `sk_live_...`:
   ```
   firebase functions:secrets:set TAP_SECRET_KEY
   firebase deploy --only functions
   ```
2. Update the webhook URL in the Tap dashboard if it differs between environments.

---

## Where do I see the numbers?
- **`leads`** in Firestore = everyone who finished the quiz (with their scores and answers) — even if they didn't buy.
- **`orders`** = orders and purchases (`status: paid` means paid and the book was delivered).

## Key security notes
- The price is computed on the server; changing it in the browser does nothing, and the server rejects any mismatched amount.
- The book is only delivered after the server confirms with Tap that the status is `CAPTURED`.
- The book is never sent twice for the same order (`emailSent`).
- If you also want Tap's own receipt emailed to the buyer, set `receipt.email` to `true` in `functions/index.js`.

Need me to adjust anything (price, email copy, result design)? Just tell me.
