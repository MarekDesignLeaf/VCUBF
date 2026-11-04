// pc-control page snapshot: one pass over the DOM (open shadow roots included)
// that returns the page as compact text for an AI, with no screenshot.
//
// Every interactive element gets a stable reference stored on the element
// itself (data-pcref="e12"); the same element keeps its ref across snapshots,
// so an AI can act on "e12" without re-reading the page. Elements outside the
// viewport are included: Playwright scrolls to them itself when acting, so the
// AI never needs to scroll just to see more.
//
// Called with one options object:
//   mode:  "interactive" (default) | "text" | "both"
//   query: optional words; only elements whose role/name/href/value contain all
//          of them are returned (replaces listing and scrolling)
//   limit: max elements (default 120)
//   maxText: max characters of page text for mode text/both (default 6000)
//   prefix: ref prefix for this frame ("" for the main frame, "f1:" for a child)
(options) => {
  const opts = Object.assign({ mode: "interactive", query: "", limit: 120, maxText: 6000, prefix: "" }, options || {});
  const doc = document;
  const win = window;
  if (!win.__pcrefSeq) win.__pcrefSeq = 0;

  const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "DETAILS", "OPTION"]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option",
    "switch", "combobox", "textbox", "searchbox", "slider", "spinbutton", "treeitem", "gridcell", "listbox",
  ]);
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "HEAD", "META", "LINK"]);

  const clean = (text, max = 80) => {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    return value.length > max ? value.slice(0, max - 1) + "…" : value;
  };

  function visible(el) {
    if (typeof el.checkVisibility === "function") {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    } else {
      const style = win.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function role(el) {
    const explicit = (el.getAttribute("role") || "").split(" ")[0];
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === "A") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "SELECT") return el.multiple ? "listbox" : "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "OPTION") return "option";
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      if (type === "file") return "file";
      if (type === "hidden") return "hidden";
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    if (/^H[1-6]$/.test(tag)) return "heading";
    return "generic";
  }

  function labelFor(el) {
    const root = el.getRootNode();
    const labelled = el.getAttribute("aria-labelledby");
    if (labelled) {
      const text = labelled.split(/\s+/).map((id) => (root.getElementById ? root.getElementById(id) : doc.getElementById(id))?.innerText || "").join(" ");
      if (clean(text)) return text;
    }
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    if (el.id && root.querySelector) {
      try {
        const label = root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label && clean(label.innerText)) return label.innerText;
      } catch (_) { /* invalid id */ }
    }
    const wrapping = el.closest("label");
    if (wrapping && clean(wrapping.innerText)) return wrapping.innerText;
    return "";
  }

  function accessibleName(el) {
    const tag = el.tagName;
    const label = labelFor(el);
    if (label) return label;
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) return el.value || type;
      if (type === "image") return el.alt || "image";
      return el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "";
    }
    if (tag === "TEXTAREA" || tag === "SELECT") return el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "";
    const text = el.innerText || el.textContent || "";
    if (clean(text)) return text;
    const img = el.querySelector && el.querySelector("img[alt]");
    if (img) return img.getAttribute("alt");
    return el.getAttribute("title") || "";
  }

  function interactive(el) {
    if (INTERACTIVE_TAGS.has(el.tagName)) {
      if (el.tagName === "A" && !el.hasAttribute("href") && !el.getAttribute("role")) return false;
      if (el.tagName === "OPTION") return false; // reported inside their select
      if (el.tagName === "DETAILS") return false; // its summary is the control
      if (el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "hidden") return false;
      return true;
    }
    const r = (el.getAttribute("role") || "").split(" ")[0];
    if (INTERACTIVE_ROLES.has(r)) return true;
    if (el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable)) return true;
    if (el.hasAttribute("onclick")) return true;
    const tab = el.getAttribute("tabindex");
    return tab !== null && Number(tab) >= 0 && el.tagName !== "BODY";
  }

  function refOf(el) {
    let ref = el.getAttribute("data-pcref");
    if (!ref) {
      win.__pcrefSeq += 1;
      ref = `e${win.__pcrefSeq}`;
      el.setAttribute("data-pcref", ref);
    }
    return opts.prefix + ref;
  }

  function describe(el) {
    const item = { ref: refOf(el), role: role(el), name: clean(accessibleName(el)) };
    const tag = el.tagName;
    if (tag === "A" && el.getAttribute("href")) {
      const href = el.getAttribute("href");
      item.href = href.startsWith("javascript:") ? "javascript:" : clean(href, 120);
    }
    if (tag === "INPUT" || tag === "TEXTAREA") {
      const type = (el.getAttribute("type") || (tag === "TEXTAREA" ? "textarea" : "text")).toLowerCase();
      if (!["text", "textarea", "button", "submit", "reset", "checkbox", "radio"].includes(type)) item.type = type;
      if (type === "password") item.value = el.value ? "••••" : "";
      else if (!["checkbox", "radio", "button", "submit", "reset", "file"].includes(type)) item.value = clean(el.value, 60);
      if (type === "checkbox" || type === "radio") item.checked = el.checked;
    }
    if (el.isContentEditable) item.value = clean(el.innerText, 60);
    if (tag === "SELECT") {
      const options = [...el.options];
      item.value = clean(options.filter((o) => o.selected).map((o) => o.label).join(", "), 60);
      item.options = options.slice(0, 12).map((o) => clean(o.label, 40));
      if (options.length > 12) item.moreOptions = options.length - 12;
    }
    const ariaChecked = el.getAttribute("aria-checked");
    if (ariaChecked !== null) item.checked = ariaChecked === "true";
    const expanded = el.getAttribute("aria-expanded");
    if (expanded !== null) item.expanded = expanded === "true";
    const selected = el.getAttribute("aria-selected");
    if (selected === "true") item.selected = true;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") item.disabled = true;
    if (el.required || el.getAttribute("aria-required") === "true") item.required = true;
    if (el.getAttribute("aria-invalid") === "true") item.invalid = true;
    return item;
  }

  // Walk the light DOM and every open shadow root, in document order.
  function* walk(root) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      const children = [];
      if (node.shadowRoot) children.push(...node.shadowRoot.children);
      children.push(...(node.children || []));
      for (let i = children.length - 1; i >= 0; i -= 1) {
        const child = children[i];
        if (SKIP_TAGS.has(child.tagName)) continue;
        stack.push(child);
      }
      if (node !== root && node.nodeType === 1) yield node;
    }
  }

  const words = clean(opts.query, 200).toLowerCase().split(" ").filter(Boolean);
  const matches = (item) => {
    if (!words.length) return true;
    const hay = [item.role, item.name, item.href, item.value, item.type, ...(item.options || [])].join(" ").toLowerCase();
    return words.every((word) => hay.includes(word));
  };

  const result = { url: location.href, title: doc.title, elements: [], headings: [], total: 0, truncated: false };
  const wantElements = opts.mode !== "text";
  if (wantElements && doc.body) {
    for (const el of walk(doc.body)) {
      if (/^H[1-3]$/.test(el.tagName) && result.headings.length < 25 && visible(el)) {
        const text = clean(el.innerText, 100);
        if (text) result.headings.push(`${"#".repeat(Number(el.tagName[1]))} ${text}`);
        continue;
      }
      if (!interactive(el) || !visible(el)) continue;
      const item = describe(el);
      if (item.role === "generic" && !item.name) continue;
      if (!matches(item)) continue;
      result.total += 1;
      if (result.elements.length < opts.limit) result.elements.push(item);
      else result.truncated = true;
    }
  }

  if (opts.mode === "text" || opts.mode === "both") {
    result.text = pageText(opts.maxText);
  }

  // Readable page text as light Markdown: headings, paragraphs, list items and
  // table rows of the main content, skipping navigation, hidden and boilerplate.
  function pageText(max) {
    const main = doc.querySelector("main, [role=main], article") || doc.body;
    if (!main) return "";
    const out = [];
    let length = 0;
    const BLOCKS = /^(P|LI|H[1-6]|TR|BLOCKQUOTE|PRE|DT|DD|FIGCAPTION|LABEL|TD|TH)$/;
    const SKIP = /^(NAV|FOOTER|ASIDE|FORM|BUTTON|SELECT)$/;
    function visit(el) {
      if (length >= max || SKIP_TAGS.has(el.tagName)) return;
      if (el !== main && SKIP.test(el.tagName)) return;
      if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return;
      if (el.nodeType === 1 && !visible(el) && el.tagName !== "TR") return;
      if (BLOCKS.test(el.tagName)) {
        let text;
        if (el.tagName === "TR") text = [...el.children].map((cell) => clean(cell.innerText, 80)).join(" | ");
        else if (el.tagName === "TD" || el.tagName === "TH") return;
        else text = clean(el.innerText, 600);
        if (!text) return;
        const prefix = /^H[1-6]$/.test(el.tagName) ? "#".repeat(Number(el.tagName[1])) + " " : el.tagName === "LI" ? "- " : el.tagName === "TR" ? "| " : "";
        out.push(prefix + text);
        length += text.length + 1;
        return;
      }
      for (const child of el.children) visit(child);
      if (!el.children.length) {
        const text = clean(el.innerText || el.textContent, 600);
        if (text) { out.push(text); length += text.length + 1; }
      }
    }
    visit(main);
    let text = out.join("\n");
    if (text.length > max) text = text.slice(0, max) + "\n… [truncated]";
    return text;
  }

  return result;
}
