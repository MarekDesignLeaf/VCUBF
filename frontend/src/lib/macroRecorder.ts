/**
 * Recording and replaying what the user did, so a command can be taught by
 * performing it instead of described in words.
 *
 * Steps identify their target by identity, never by position. A recording made
 * on Monday has to still work after the window is resized, the list gains a row
 * or the layout reflows, and a coordinate survives none of that.
 */

export type MacroStepKind = "click" | "type" | "select" | "check" | "navigate" | "submit";

export interface MacroStep {
  kind: MacroStepKind;
  /** How to find the element again. */
  target: string;
  /** What the user would call it, for reading the recording back to them. */
  label?: string;
  /** What was typed or chosen. */
  value?: string;
  /** The page it happened on, so a replay can get there first. */
  path?: string;
}

/** Attributes that are meant to be stable, in the order they should be trusted. */
const STABLE_ATTRIBUTES = ["data-testid", "data-test", "data-action", "data-field", "name"];

function escapeValue(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/** The visible text of an element, trimmed to something loggable. */
function labelFor(element: Element): string | undefined {
  const aria = element.getAttribute("aria-label");
  if (aria?.trim()) return aria.trim().slice(0, 120);
  const text = (element as HTMLElement).innerText ?? element.textContent ?? "";
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed) return trimmed.slice(0, 120);
  const placeholder = element.getAttribute("placeholder");
  return placeholder?.trim() ? placeholder.trim().slice(0, 120) : undefined;
}

/**
 * A description that finds this element again.
 *
 * Deliberately ordered: an id put there for testing is the most reliable thing
 * available, and a structural path is the least — it breaks the moment anything
 * is inserted above the element.
 */
export function describeTarget(element: Element): string {
  for (const attribute of STABLE_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (value?.trim()) return `[${attribute}="${escapeValue(value.trim())}"]`;
  }
  if (element.id) return `#${CSS.escape(element.id)}`;

  // Role plus visible label: how a person would describe it, and stable across
  // re-renders as long as the wording stays.
  const role = element.getAttribute("role") ?? element.tagName.toLowerCase();
  const label = labelFor(element);
  if (label) return `role=${role}|text=${label}`;

  // Last resort: where it sits. Recorded so the step is not lost, but it is the
  // first thing to break.
  const parts: string[] = [];
  let node: Element | null = element;
  while (node && node !== document.body && parts.length < 6) {
    const parent: Element | null = node.parentElement;
    const index = parent ? Array.from(parent.children).indexOf(node) + 1 : 1;
    parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${index})`);
    node = parent;
  }
  return parts.join(" > ");
}

/** Finds the element a recorded step refers to. */
export function findTarget(target: string): HTMLElement | null {
  if (target.startsWith("role=")) {
    const [rolePart, textPart] = target.split("|text=");
    const role = rolePart.slice("role=".length);
    const wanted = (textPart ?? "").trim().toLowerCase();
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(`[role="${escapeValue(role)}"], ${role}`),
    );
    return candidates.find((element) => (labelFor(element) ?? "").toLowerCase() === wanted) ?? null;
  }
  try {
    return document.querySelector<HTMLElement>(target);
  } catch {
    return null;
  }
}

type Listener = { type: string; handler: EventListener };

/**
 * Watches what the user does and collects it as steps.
 *
 * Capture-phase listeners, so a step is recorded even when the application stops
 * the event from propagating.
 */
export class MacroRecorder {
  private readonly steps: MacroStep[] = [];
  private readonly listeners: Listener[] = [];
  private lastPath = "";
  private recording = false;

  start() {
    if (this.recording) return;
    this.recording = true;
    this.steps.length = 0;
    this.lastPath = window.location.pathname;
    this.steps.push({ kind: "navigate", target: this.lastPath, path: this.lastPath });

    this.on("click", (event) => {
      const element = (event.target as Element | null)?.closest(
        "button, a, [role=button], [role=tab], summary, input[type=checkbox], input[type=radio]",
      );
      if (!element) return;
      // A checkbox is recorded as its resulting state, not as a click, so a
      // replay sets it rather than toggling whatever it happens to be.
      if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
        this.push({
          kind: "check",
          target: describeTarget(element),
          label: labelFor(element),
          value: String(element.checked),
        });
        return;
      }
      this.push({ kind: "click", target: describeTarget(element), label: labelFor(element) });
    });

    // change, not keystrokes: a name typed letter by letter is one step.
    this.on("change", (event) => {
      const element = event.target as HTMLElement | null;
      if (element instanceof HTMLSelectElement) {
        this.push({
          kind: "select",
          target: describeTarget(element),
          label: labelFor(element),
          value: element.value,
        });
        return;
      }
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
        if (element.type === "checkbox" || element.type === "radio") return;
        // Never record a secret, whatever the field is called.
        if (element.type === "password") return;
        this.push({
          kind: "type",
          target: describeTarget(element),
          label: labelFor(element) ?? element.getAttribute("name") ?? undefined,
          value: element.value,
        });
      }
    });

    this.on("submit", (event) => {
      const form = event.target as Element | null;
      if (!form) return;
      this.push({ kind: "submit", target: describeTarget(form), label: labelFor(form) });
    });
  }

  /** Call when the route changes, so a replay knows to go there first. */
  notePath(path: string) {
    if (!this.recording || path === this.lastPath) return;
    this.lastPath = path;
    this.push({ kind: "navigate", target: path });
  }

  stop(): MacroStep[] {
    this.recording = false;
    for (const { type, handler } of this.listeners) {
      document.removeEventListener(type, handler, true);
    }
    this.listeners.length = 0;
    return this.collapse();
  }

  get length(): number {
    return this.steps.length;
  }

  get isRecording(): boolean {
    return this.recording;
  }

  private on(type: string, handler: (event: Event) => void) {
    const wrapped: EventListener = (event) => {
      if (!this.recording) return;
      try {
        handler(event);
      } catch { /* Recording must never break the page it is watching. */ }
    };
    document.addEventListener(type, wrapped, true);
    this.listeners.push({ type, handler: wrapped });
  }

  private push(step: MacroStep) {
    this.steps.push({ ...step, path: window.location.pathname });
  }

  /**
   * Tidies the recording: consecutive edits of the same field keep only the
   * final value, and a navigate that goes nowhere is dropped.
   */
  private collapse(): MacroStep[] {
    const out: MacroStep[] = [];
    for (const step of this.steps) {
      const previous = out[out.length - 1];
      if (previous && step.kind === "type" && previous.kind === "type" && previous.target === step.target) {
        out[out.length - 1] = step;
        continue;
      }
      if (previous && step.kind === "navigate" && previous.kind === "navigate" && previous.target === step.target) {
        continue;
      }
      out.push(step);
    }
    return out;
  }
}

export interface ReplayOutcome {
  ok: boolean;
  /** The step that could not be performed, if any. */
  failedAt?: number;
  failedLabel?: string;
}

/** Lets React see a value set from outside, which a plain assignment does not. */
function setFieldValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Performs a recorded command.
 *
 * Each step waits for its target to appear rather than assuming the page has
 * caught up: navigation and re-renders are asynchronous, and a replay that does
 * not wait fails on the first click after a route change.
 */
export async function replayMacro(
  steps: MacroStep[],
  navigate: (path: string) => void,
  onStep?: (index: number, step: MacroStep) => void,
): Promise<ReplayOutcome> {
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    onStep?.(index, step);

    if (step.kind === "navigate") {
      if (window.location.pathname !== step.target) {
        navigate(step.target);
        await settle(400);
      }
      continue;
    }

    // Up to two seconds for the target to appear.
    let element: HTMLElement | null = null;
    for (let attempt = 0; attempt < 20 && !element; attempt += 1) {
      element = findTarget(step.target);
      if (!element) await settle(100);
    }
    if (!element) return { ok: false, failedAt: index, failedLabel: step.label ?? step.target };

    switch (step.kind) {
      case "click":
      case "submit":
        element.click();
        break;
      case "check":
        if (element instanceof HTMLInputElement && element.checked !== (step.value === "true")) {
          element.click();
        }
        break;
      case "type":
      case "select":
        if (
          element instanceof HTMLInputElement
          || element instanceof HTMLTextAreaElement
          || element instanceof HTMLSelectElement
        ) {
          setFieldValue(element, step.value ?? "");
        }
        break;
    }
    await settle(220);
  }
  return { ok: true };
}
