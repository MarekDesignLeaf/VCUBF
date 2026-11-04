// pc-control structured extraction: data straight from the DOM, in one call,
// with no screenshot and no model in between.
//
// Options:
//   items:  CSS selector of repeated containers (cards, rows, results). When set,
//           every field is read inside each container and a list is returned.
//   fields: { name: "css selector" | "css selector@attribute" | "@attribute" }.
//           Without items, each field is read once from the whole page.
//           "@href", "@src" and other attributes resolve URLs to absolute ones.
//   tables: true to return every visible <table> as { headers, rows }.
//   links:  true to return links (text and absolute URL), optional linkFilter text.
//   limit:  max items / rows / links (default 100).
(options) => {
  const opts = Object.assign({ items: "", fields: {}, tables: false, links: false, linkFilter: "", limit: 100 }, options || {});
  const clean = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
  const absolute = (value) => {
    try { return new URL(value, location.href).href; } catch (_) { return value; }
  };

  function read(scope, spec) {
    const [selector, attribute] = String(spec).split("@");
    const el = selector.trim() ? scope.querySelector(selector.trim()) : scope;
    if (!el) return null;
    if (attribute) {
      const value = el.getAttribute(attribute);
      if (value === null) return null;
      return ["href", "src", "action", "data-src"].includes(attribute) ? absolute(value) : clean(value);
    }
    if ("value" in el && ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) return clean(el.value);
    return clean(el.innerText || el.textContent);
  }

  function readFields(scope) {
    const row = {};
    for (const [name, spec] of Object.entries(opts.fields || {})) {
      try { row[name] = read(scope, spec); } catch (error) { row[name] = null; }
    }
    return row;
  }

  const result = { url: location.href, title: document.title };
  if (opts.items) {
    const containers = [...document.querySelectorAll(opts.items)];
    result.count = containers.length;
    result.items = containers.slice(0, opts.limit).map((container) =>
      Object.keys(opts.fields || {}).length ? readFields(container) : { text: clean(container.innerText).slice(0, 500) });
    result.truncated = containers.length > opts.limit;
  } else if (Object.keys(opts.fields || {}).length) {
    result.fields = readFields(document);
  }

  if (opts.tables) {
    result.tables = [...document.querySelectorAll("table")]
      .filter((table) => table.getBoundingClientRect().height > 0)
      .slice(0, 10)
      .map((table) => {
        const headerCells = table.querySelectorAll("thead th, tr:first-child th");
        const headers = [...headerCells].map((cell) => clean(cell.innerText));
        const rows = [...table.querySelectorAll("tbody tr, tr")]
          .filter((row) => !row.querySelector("th") || !headers.length)
          .slice(0, opts.limit)
          .map((row) => [...row.children].map((cell) => clean(cell.innerText)));
        return { caption: clean(table.caption?.innerText || ""), headers, rows };
      });
  }

  if (opts.links) {
    const filter = clean(opts.linkFilter).toLowerCase();
    const seen = new Set();
    result.links = [...document.querySelectorAll("a[href]")]
      .map((a) => ({ text: clean(a.innerText || a.getAttribute("aria-label") || a.title), url: absolute(a.getAttribute("href")) }))
      .filter((link) => link.url.startsWith("http") && (!filter || (link.text + " " + link.url).toLowerCase().includes(filter)))
      .filter((link) => (seen.has(link.url) ? false : (seen.add(link.url), true)))
      .slice(0, opts.limit);
  }
  return result;
}
