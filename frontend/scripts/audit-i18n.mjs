import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const sourceRoot = path.resolve("src");
const ignoredAttributes = new Set(["className", "to", "href", "type", "name", "value", "method"]);
const visibleAttributes = new Set(["placeholder", "title", "aria-label", "alt"]);
const entries = new Map();

function add(file, line, value) {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || !/[A-Za-zÀ-ž]/.test(text)) return;
  const locations = entries.get(text) ?? [];
  locations.push(`${path.relative(sourceRoot, file)}:${line}`);
  entries.set(text, locations);
}

function walk(file) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function visibleJsxExpression(node) {
    let current = node.parent;
    while (current) {
      if (ts.isJsxExpression(current)) {
        const parent = current.parent;
        if (ts.isJsxAttribute(parent)) return !ignoredAttributes.has(parent.name.text);
        return true;
      }
      if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) return false;
      current = current.parent;
    }
    return false;
  }
  function visit(node) {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    if (ts.isJsxText(node)) add(file, line, node.text);
    if (ts.isJsxAttribute(node) && visibleAttributes.has(node.name.text) && node.initializer && ts.isStringLiteral(node.initializer)) {
      add(file, line, node.initializer.text);
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && visibleJsxExpression(node)) {
      add(file, line, node.text);
    }
    if (ts.isTemplateExpression(node) && visibleJsxExpression(node)) {
      const template = node.templateSpans.reduce(
        (value, span, index) => `${value}{{${index}}}${span.literal.text}`,
        node.head.text,
      );
      add(file, line, template);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["setError", "confirm", "alert"].includes(node.expression.text)) {
      const first = node.arguments[0];
      if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) add(file, line, first.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

function walkLabelCatalogues(file) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  function visit(node, insideLabels = false) {
    const entersLabels = ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /LABELS$/.test(node.name.text);
    const active = insideLabels || entersLabels;
    if (active && ts.isStringLiteral(node)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      add(file, line, node.text);
    }
    ts.forEachChild(node, (child) => visit(child, active));
  }
  visit(source);
}

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? files(full) : entry.name.endsWith(".tsx") ? [full] : [];
  });
}

export function extractVisiblePhrases() {
  entries.clear();
  for (const file of files(sourceRoot)) walk(file);
  walkLabelCatalogues(path.join(sourceRoot, "api", "client.ts"));
  return [...entries].sort(([a], [b]) => a.localeCompare(b));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sorted = extractVisiblePhrases();
  for (const [text, locations] of sorted) console.log(`${JSON.stringify(text)}\t${locations.join(",")}`);
  console.error(`Visible static phrases: ${sorted.length}`);
}
