// Rebuild src/questions.json from bank/question_bank.csv after editing the bank in Excel.
// Usage:  node scripts/csv-to-json.mjs
import { readFileSync, writeFileSync } from "node:fs";

function parseCSV(text) {
  const rows = []; let row = [], field = "", q = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const rows = parseCSV(readFileSync("bank/question_bank.csv", "utf8"));
const head = rows.shift().map((h) => h.trim());
const col = (n) => head.indexOf(n);
const out = [], errors = [];
rows.forEach((r, i) => {
  const key = (r[col("Key")] || "").trim().toUpperCase();
  const q = {
    id: r[col("ID")].trim() || `Q${String(i + 1).padStart(3, "0")}`,
    ref: r[col("Procedure")].trim(),
    topic: r[col("Topic")].trim(),
    q: r[col("Question")].trim(),
    options: ["A", "B", "C", "D"].map((L) => (r[col(L)] || "").trim()),
    answer: "ABCD".indexOf(key),
    source: (r[col("Reference")] || "").trim(),
  };
  if (!q.q || q.options.some((o) => !o) || q.answer < 0) errors.push(`Row ${i + 2} (${q.id}): missing question, option or key`);
  out.push(q);
});
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
writeFileSync("src/questions.json", JSON.stringify(out, null, 1));
console.log(`Wrote ${out.length} questions to src/questions.json`);
