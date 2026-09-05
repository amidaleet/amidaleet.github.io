#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const htmlPath = path.resolve(__dirname, "..", "index.html");
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const SKIP_TAGS = new Set(["script", "style"]);

function usage() {
  return `Sync inlined HTML i18n values with translations.en in index.html.

Usage:
  node scripts/sync-i18n.js [review|check|apply] [--to html|en] [--all] [--ru]

Commands:
  review   Show diffs without writing (default)
  check    Same as review, but exit 1 if anything is out of sync
  apply    Write changes. Requires --to:

           --to html   Copy translations.en into inlined HTML
           --to en     Copy inlined HTML into translations.en

Options:
  --all    Also list keys that are already in sync
  --ru     Also check that translations.ru has the same keys as en,
           and that ru values are non-empty. Does not compare wording.
`;
}

function parseArgs(argv) {
  const args = argv.filter((arg) => arg !== "--");
  if (args.includes("-h") || args.includes("--help")) {
    return { command: "help" };
  }

  let command = "review";
  let to = null;
  let all = false;
  let ru = false;
  const positional = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--to") {
      to = args[i + 1];
      i += 1;
    } else if (arg.startsWith("--to=")) {
      to = arg.slice("--to=".length);
    } else if (arg === "--all") {
      all = true;
    } else if (arg === "--ru") {
      ru = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional[0]) command = positional[0];
  if (command === "apply" && !to && ["html", "en"].includes(positional[1])) {
    to = positional[1];
  }

  if (!["help", "review", "check", "apply"].includes(command)) {
    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
  if (to != null && !["html", "en"].includes(to)) {
    throw new Error(`--to must be html or en, got: ${to}\n\n${usage()}`);
  }
  if (command === "apply" && !to) {
    throw new Error(`apply requires --to html or --to en\n\n${usage()}`);
  }
  if (command === "apply" && ru) {
    throw new Error(`--ru cannot be used with apply\n\n${usage()}`);
  }

  return { command, to, all, ru };
}

function parseAttributes(attrStr) {
  const attrs = {};
  const re = /([^\s=]+)(?:="([^"]*)")?/g;
  let match;
  while ((match = re.exec(attrStr))) {
    attrs[match[1]] = match[2] === undefined ? true : match[2];
  }
  return attrs;
}

function findMatchingClose(html, openEnd, tagName) {
  const lower = tagName.toLowerCase();
  const openRe = new RegExp(`<${tagName}\\b`, "gi");
  const closeRe = new RegExp(`</${tagName}\\s*>`, "gi");
  openRe.lastIndex = openEnd;
  closeRe.lastIndex = openEnd;

  let depth = 1;
  let closeMatch = closeRe.exec(html);
  let openMatch = openRe.exec(html);

  while (closeMatch) {
    if (openMatch && openMatch.index < closeMatch.index) {
      depth += 1;
      openMatch = openRe.exec(html);
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return { innerEnd: closeMatch.index, closeEnd: closeMatch.index + closeMatch[0].length };
    }
    closeMatch = closeRe.exec(html);
  }

  throw new Error(`No closing </${lower}> found`);
}

function extractObjectLiteral(source, braceStart) {
  if (source[braceStart] !== "{") {
    throw new Error("Expected {");
  }

  let depth = 0;
  let inString = false;
  let quote = null;
  let escape = false;

  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === quote) {
        inString = false;
        quote = null;
      }
      continue;
    }
    if (ch === "\"" || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const literal = source.slice(braceStart, i + 1);
        return { literal, start: braceStart, end: i + 1 };
      }
    }
  }

  throw new Error("Unbalanced object literal");
}

function extractTranslations(html) {
  const marker = "const translations = ";
  const markerAt = html.indexOf(marker);
  if (markerAt === -1) {
    throw new Error("Could not find `const translations =` in index.html");
  }

  const translations = extractObjectLiteral(html, html.indexOf("{", markerAt));
  const enKeyAt = translations.literal.indexOf("en:");
  if (enKeyAt === -1) {
    throw new Error("Could not find `en:` in translations object");
  }
  const en = extractObjectLiteral(translations.literal, translations.literal.indexOf("{", enKeyAt));

  return {
    value: Function(`"use strict"; return (${translations.literal});`)(),
    enStart: translations.start + en.start,
    enEnd: translations.start + en.end
  };
}

function collectSites(html) {
  const sites = [];
  const tagRe = /<([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g;
  let match;

  while ((match = tagRe.exec(html))) {
    const tagName = match[1];
    const lower = tagName.toLowerCase();
    const openStart = match.index;
    const openEnd = match.index + match[0].length;

    if (SKIP_TAGS.has(lower)) {
      const close = html.toLowerCase().indexOf(`</${lower}`, openEnd);
      tagRe.lastIndex = close === -1 ? html.length : html.indexOf(">", close) + 1;
      continue;
    }

    const attrs = parseAttributes(match[2]);
    const selfClosing = match[3] === "/" || VOID_TAGS.has(lower);
    let inner = "";
    let innerStart = openEnd;
    let innerEnd = openEnd;

    if (!selfClosing && (attrs["data-i18n"] || attrs["data-i18n-html"])) {
      const close = findMatchingClose(html, openEnd, tagName);
      inner = html.slice(openEnd, close.innerEnd);
      innerStart = openEnd;
      innerEnd = close.innerEnd;
    }

    if (attrs["data-i18n"]) {
      sites.push({
        kind: "text",
        key: attrs["data-i18n"],
        value: inner.trim(),
        innerStart,
        innerEnd,
        inner
      });
    }
    if (attrs["data-i18n-html"]) {
      sites.push({
        kind: "html",
        key: attrs["data-i18n-html"],
        value: inner.trim(),
        innerStart,
        innerEnd,
        inner
      });
    }
    if (attrs["data-i18n-aria"]) {
      sites.push(attributeSite("aria", attrs["data-i18n-aria"], "aria-label", match[0], openStart));
    }
    if (attrs["data-i18n-alt"]) {
      sites.push(attributeSite("alt", attrs["data-i18n-alt"], "alt", match[0], openStart));
    }
  }

  return sites;
}

function attributeSite(kind, key, attrName, openTag, openStart) {
  const attrRe = new RegExp(`${attrName}="([^"]*)"`);
  const attrMatch = openTag.match(attrRe);
  if (!attrMatch) {
    return {
      kind,
      key,
      value: "",
      attrName,
      attrStart: openStart + openTag.length - 1,
      attrEnd: openStart + openTag.length - 1,
      missingAttr: true
    };
  }

  const rel = openTag.indexOf(attrMatch[0]);
  return {
    kind,
    key,
    value: attrMatch[1],
    attrName,
    attrStart: openStart + rel,
    attrEnd: openStart + rel + attrMatch[0].length,
    missingAttr: false
  };
}

function groupSites(sites) {
  const groups = new Map();
  for (const site of sites) {
    if (!groups.has(site.key)) groups.set(site.key, []);
    groups.get(site.key).push(site);
  }
  return groups;
}

function compare(en, sites) {
  const groups = groupSites(sites);
  const keys = new Set([...Object.keys(en), ...groups.keys()]);
  const rows = [];

  for (const key of [...keys].sort()) {
    const htmlSites = groups.get(key) || [];
    const htmlValues = [...new Set(htmlSites.map((site) => site.value))];
    const enValue = Object.prototype.hasOwnProperty.call(en, key) ? en[key] : undefined;
    const conflict = htmlValues.length > 1;
    let status;

    if (!htmlSites.length) status = "not-inlined";
    else if (enValue === undefined) status = "html-only";
    else if (conflict) status = "conflict";
    else if (htmlValues[0] === enValue) status = "ok";
    else status = "diff";

    rows.push({ key, status, htmlSites, htmlValues, enValue });
  }

  return rows;
}

function color(enabled, code, text) {
  return enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function preview(value) {
  if (value === undefined) return "(missing)";
  return JSON.stringify(value);
}

function printReview(rows, { all = false } = {}) {
  const tty = Boolean(process.stdout.isTTY);
  const labels = {
    ok: color(tty, "32", "OK"),
    diff: color(tty, "33", "DIFF"),
    conflict: color(tty, "31", "CONFLICT"),
    "html-only": color(tty, "31", "HTML-ONLY"),
    "not-inlined": color(tty, "36", "NOT-INLINED")
  };

  for (const row of rows) {
    if ((row.status === "ok" || row.status === "not-inlined") && !all) continue;
    const kinds = row.htmlSites.length
      ? row.htmlSites.map((site) => site.kind).join(",")
      : "not in HTML";
    console.log(`${labels[row.status].padEnd(tty ? 19 : 9)}  ${row.key}  [${kinds}]`);
    if (row.status === "ok" || row.status === "not-inlined") continue;
    if (row.htmlValues.length) {
      for (const value of row.htmlValues) {
        console.log(`  html: ${preview(value)}`);
      }
    }
    console.log(`  en:   ${preview(row.enValue)}`);
  }

  const counts = rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});
  const problems = rows.filter((row) => !["ok", "not-inlined"].includes(row.status));

  console.log("");
  console.log(
    `${counts.ok || 0} inlined values in sync, ${problems.length} need review, ${counts["not-inlined"] || 0} key${(counts["not-inlined"] || 0) === 1 ? "" : "s"} not inlined in HTML.`
  );

  return problems.length;
}

function isEmptyValue(value) {
  return value == null || String(value).trim() === "";
}

function compareRu(en, ru) {
  const enKeys = Object.keys(en || {});
  const ruTable = ru || {};
  const ruKeys = Object.keys(ruTable);
  const enSet = new Set(enKeys);
  const ruSet = new Set(ruKeys);
  const rows = [];

  for (const key of [...new Set([...enKeys, ...ruKeys])].sort()) {
    const inEn = enSet.has(key);
    const inRu = ruSet.has(key);
    const ruValue = inRu ? ruTable[key] : undefined;
    let status;
    if (!inRu) status = "missing";
    else if (!inEn) status = "extra";
    else if (isEmptyValue(ruValue)) status = "empty";
    else status = "ok";
    rows.push({ key, status, ruValue });
  }

  return rows;
}

function printRuReview(rows, { all = false } = {}) {
  const tty = Boolean(process.stdout.isTTY);
  const labels = {
    ok: color(tty, "32", "OK"),
    missing: color(tty, "31", "MISSING"),
    extra: color(tty, "33", "EXTRA"),
    empty: color(tty, "31", "EMPTY")
  };

  console.log("translations.ru");
  for (const row of rows) {
    if (row.status === "ok" && !all) continue;
    console.log(`${labels[row.status].padEnd(tty ? 19 : 9)}  ${row.key}`);
    if (row.status === "empty") {
      console.log(`  ru: ${preview(row.ruValue)}`);
    }
  }

  const counts = rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});
  const problems = rows.filter((row) => row.status !== "ok");

  console.log("");
  console.log(
    `${counts.ok || 0} ru keys in sync, ${problems.length} need review (${counts.missing || 0} missing, ${counts.extra || 0} extra, ${counts.empty || 0} empty).`
  );

  return problems.length;
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function escapeText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function paddedInner(originalInner, nextValue) {
  if (!originalInner) return nextValue;
  const lead = originalInner.match(/^\s*/)[0];
  const trail = originalInner.match(/\s*$/)[0];
  if (!originalInner.trim()) return nextValue;
  return `${lead}${nextValue}${trail}`;
}

function applyToHtml(html, en, rows) {
  const replacements = [];

  for (const row of rows) {
    if (!row.htmlSites.length) continue;
    if (row.enValue === undefined) {
      throw new Error(`Cannot write HTML for "${row.key}": missing translations.en.${row.key}`);
    }
    if (row.status === "ok") continue;

    for (const site of row.htmlSites) {
      if (site.kind === "text") {
        replacements.push({
          start: site.innerStart,
          end: site.innerEnd,
          value: paddedInner(site.inner, escapeText(row.enValue))
        });
      } else if (site.kind === "html") {
        replacements.push({
          start: site.innerStart,
          end: site.innerEnd,
          value: paddedInner(site.inner, row.enValue)
        });
      } else {
        const attr = `${site.attrName}="${escapeAttr(row.enValue)}"`;
        replacements.push({
          start: site.missingAttr ? site.attrStart : site.attrStart,
          end: site.missingAttr ? site.attrEnd : site.attrEnd,
          value: site.missingAttr ? ` ${attr}` : attr
        });
      }
    }
  }

  replacements.sort((a, b) => b.start - a.start);
  let next = html;
  for (const replacement of replacements) {
    next = next.slice(0, replacement.start) + replacement.value + next.slice(replacement.end);
  }
  return { html: next, changes: replacements.length };
}

function formatEnObject(en) {
  const lines = Object.entries(en).map(([key, value]) => `        ${key}: ${JSON.stringify(value)}`);
  return `{\n${lines.join(",\n")}\n      }`;
}

function applyToEn(html, extracted, rows) {
  const nextEn = { ...extracted.value.en };

  for (const row of rows) {
    if (!row.htmlSites.length) continue;
    if (row.status === "conflict") {
      throw new Error(`Key "${row.key}" has conflicting HTML values; fix those first`);
    }
    if (row.status === "ok") continue;
    nextEn[row.key] = row.htmlValues[0];
  }

  const formatted = formatEnObject(nextEn);
  const nextHtml = html.slice(0, extracted.enStart) + formatted + html.slice(extracted.enEnd);
  return { html: nextHtml, changes: rows.filter((row) => row.htmlSites.length && row.status !== "ok").length };
}

function main() {
  const { command, to, all, ru } = parseArgs(process.argv.slice(2));
  if (command === "help") {
    process.stdout.write(usage());
    return;
  }

  const html = fs.readFileSync(htmlPath, "utf8");
  const extracted = extractTranslations(html);
  const sites = collectSites(html);
  const rows = compare(extracted.value.en, sites);
  let problemCount = printReview(rows, { all });

  if (ru) {
    console.log("");
    problemCount += printRuReview(compareRu(extracted.value.en, extracted.value.ru), { all });
  }

  if (command === "review") return;
  if (command === "check") {
    if (problemCount) process.exitCode = 1;
    return;
  }

  const result = to === "html"
    ? applyToHtml(html, extracted.value.en, rows)
    : applyToEn(html, extracted, rows);

  if (result.html === html) {
    console.log(`No file changes written (--to ${to}).`);
    return;
  }

  fs.writeFileSync(htmlPath, result.html);
  console.log(`Wrote ${result.changes} change(s) to ${path.relative(process.cwd(), htmlPath)} (--to ${to}).`);
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}
