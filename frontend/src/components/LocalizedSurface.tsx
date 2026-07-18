import { useEffect, useRef } from "react";
import type { AppLanguage } from "../i18n";
import { loadUiCatalogue, translateUiPhrase } from "../uiTranslation";

const TRANSLATED_ATTRIBUTES = ["placeholder", "title", "aria-label", "alt"] as const;
const SKIP_SELECTOR = "script, style, code, pre, textarea, [data-language-fixed]";

function withOriginalSpacing(current: string, translated: string) {
  const leading = current.match(/^\s*/)?.[0] ?? "";
  const trailing = current.match(/\s*$/)?.[0] ?? "";
  return `${leading}${translated}${trailing}`;
}

export function LocalizedSurface({ language }: { language: AppLanguage }) {
  const originalText = useRef(new WeakMap<Text, string>());
  const renderedText = useRef(new WeakMap<Text, string>());
  const originalAttributes = useRef(new WeakMap<Element, Map<string, string>>());
  const renderedAttributes = useRef(new WeakMap<Element, Map<string, string>>());

  useEffect(() => {
    document.documentElement.lang = language;
    let active = true;
    let catalogue: Record<string, string> = {};
    let observer: MutationObserver | null = null;

    function skipped(element: Element | null) {
      return Boolean(element?.closest(SKIP_SELECTOR));
    }

    function translateText(node: Text) {
      if (skipped(node.parentElement)) return;
      const current = node.data;
      const previousRendered = renderedText.current.get(node);
      let source = originalText.current.get(node);
      if (source === undefined || (previousRendered !== undefined && current !== previousRendered)) {
        source = current;
        originalText.current.set(node, source);
      }
      const translated = translateUiPhrase(catalogue, language, source);
      const next = translated === source.trim() ? source : withOriginalSpacing(source, translated);
      renderedText.current.set(node, next);
      if (current !== next) node.data = next;
    }

    function translateAttributes(element: Element) {
      if (skipped(element)) return;
      let originals = originalAttributes.current.get(element);
      let rendered = renderedAttributes.current.get(element);
      if (!originals) {
        originals = new Map();
        originalAttributes.current.set(element, originals);
      }
      if (!rendered) {
        rendered = new Map();
        renderedAttributes.current.set(element, rendered);
      }
      for (const attribute of TRANSLATED_ATTRIBUTES) {
        const current = element.getAttribute(attribute);
        if (current == null) continue;
        const previousRendered = rendered.get(attribute);
        if (!originals.has(attribute) || (previousRendered !== undefined && current !== previousRendered)) {
          originals.set(attribute, current);
        }
        const source = originals.get(attribute) ?? current;
        const next = translateUiPhrase(catalogue, language, source);
        rendered.set(attribute, next);
        if (next !== current) element.setAttribute(attribute, next);
      }
    }

    function translateTree(root: Node) {
      if (root.nodeType === Node.TEXT_NODE) {
        translateText(root as Text);
        return;
      }
      if (!(root instanceof Element) && root !== document.body) return;
      if (root instanceof Element) translateAttributes(root);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        if (node.nodeType === Node.TEXT_NODE) translateText(node as Text);
        else translateAttributes(node as Element);
        node = walker.nextNode();
      }
    }

    void loadUiCatalogue(language).then((loaded) => {
      if (!active) return;
      catalogue = loaded;
      translateTree(document.body);
      observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === "characterData") translateText(mutation.target as Text);
          else if (mutation.type === "attributes") translateAttributes(mutation.target as Element);
          else mutation.addedNodes.forEach(translateTree);
        }
      });
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: [...TRANSLATED_ATTRIBUTES],
      });
    });
    return () => {
      active = false;
      observer?.disconnect();
    };
  }, [language]);

  return null;
}
