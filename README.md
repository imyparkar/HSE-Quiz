# Live HSE Quiz

A live, timed, multiplayer quiz on KOC HSSE procedures. The presenter projects the quiz; participants scan a QR code, enter their name and answer on their own phone or laptop.

- 20 questions per quiz, drawn at random from a 200-question bank (24 KOC procedures), with option order shuffled every run
- 40 seconds per question; no answer = no points
- One question at a time, shown on the presenter screen and every participant's device
- Live leaderboard that updates as each answer arrives
- Winners podium (1st, 2nd, 3rd) after the final question, plus full ranking and CSV download

It runs on **Cloudflare Workers + Durable Objects** (free plan is enough). The Durable Object keeps each quiz room's state on the server, so all screens stay in sync and correct answers are never sent to phones before the reveal.

---

## Repository layout

```
public/             Static pages served by Cloudflare
  index.html        Presenter screen (create session, QR code, questions, leaderboard, podium)
  play.html         Participant screen (join with name, answer, see result)
  host.js, play.js, common.js, style.css, qrcode.js
src/
  worker.js         Worker + QuizRoom Durable Object (rooms, timer, scoring)
  questions.json    The question bank used by the quiz
bank/
  QUESTION_BANK.md  Readable bank with keys and clause references
  question_bank.csv Same bank for editing in Excel
scripts/
  csv-to-json.mjs   Rebuilds src/questions.json from the CSV
wrangler.jsonc      Cloudflare configuration
PROJECT_INSTRUCTIONS.md  Instructions for the Claude Project "Live HSE Quiz"
```

## Deploy (GitHub → Cloudflare, no command line needed)

1. Create a new GitHub repository (e.g. `live-hse-quiz`) and upload every file in this folder, keeping the folder structure.
2. Log in to the Cloudflare dashboard → **Workers & Pages** → **Create** → **Import a repository**.
3. Connect GitHub and pick the repository. Leave the defaults (build command empty, deploy command `npx wrangler deploy`). Click **Deploy**.
4. When it finishes you get a URL like `https://live-hse-quiz.<your-subdomain>.workers.dev`. Open it — that is the presenter screen.

Every later commit to the repository redeploys automatically.

> Use **Workers** (not the older "Pages" product): the quiz needs a Durable Object for the live connections, which Workers supports directly.

### Deploy from a computer instead (optional)

```
npm install
npx wrangler login
npx wrangler deploy
```

Run locally with `npx wrangler dev` and open http://localhost:8787.

## Running a quiz

1. Open the site on the projector PC and click **Create quiz session**. Use **Full screen**.
2. Participants scan the QR code (or open `/play.html` and type the 6-character room code), enter their name and tap **Log in & join**. Names appear on the presenter screen; ✕ removes someone.
3. Click **▶ Present**. Question 1 appears on all screens with a 40-second timer.
4. A question closes when the timer ends or when every connected participant has answered. The presenter screen then shows the correct answer, how many chose each option, and the procedure clause. Click **Next question** (or press Space / →).
5. After question 20 the podium appears automatically.
6. **Play again with new questions** keeps the same participants and draws a fresh random set. **Download results (CSV)** saves the ranking.

If a phone drops its connection or the page is refreshed, it reconnects and keeps its score.

### Scoring
- Correct answer: 500–1000 points (faster = more; 1000 for an instant answer, 500 at the last second)
- Wrong answer or no answer: 0 points
- Ties are broken by number of correct answers, then by total answer time

Change the numbers at the top of `src/worker.js` (`SETTINGS`) if you want a different number of questions, time limit or points.

## Editing the question bank

1. Open `bank/question_bank.csv` in Excel, edit or add rows (columns: ID, Procedure, Topic, Question, A, B, C, D, Key, Reference). Save as CSV (UTF-8).
2. Run `node scripts/csv-to-json.mjs` to rebuild `src/questions.json` — or ask Claude in the "Live HSE Quiz" project to produce the new `questions.json`.
3. Commit to GitHub; Cloudflare redeploys.

Each quiz picks one question per procedure (20 of the 24 procedures) so a single quiz covers a wide spread of topics.
