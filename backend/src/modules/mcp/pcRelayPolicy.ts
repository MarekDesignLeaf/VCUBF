/**
 * Secretary's trust decision for each PC Control Plus relay tool.
 *
 * The tools themselves (names, descriptions, parameters, relay job ids) come
 * from the relay (pcpRelayCatalogue.generated.ts, imported by
 * windows-companion/pc-control/server/import_pcp_catalogue.py). This file
 * only decides, per relay job, how Secretary offers it:
 *
 * - "read": runs at once under read_pc; it returns what the PC reports and
 *   leaves nothing running or queued behind on the PC.
 * - "reviewed": a change on the PC, or a command that keeps running or waits
 *   in a queue on the PC (goals). It is never read-only: preview, the user's
 *   explicit yes through confirm_action, then one call; the PC asks its owner
 *   again for every sensitive step.
 * - "not_offered": visible in describe_capabilities with the reason, never
 *   callable through Secretary.
 *
 * Text state only (owner's rule): PC control works from DOM snapshots and
 * UI Automation, never from screenshots. No image, camera or screen-coordinate
 * tool is offered, and a control loop (a goal) is offered only while the
 * importer attests from its source that the loop is screenshot-free
 * (pcpRelayCatalogue.control_loops); otherwise it is not offered.
 *
 * tests/mcpDevices.test.ts fails when a relay tool has no decision here or a
 * decision names no relay tool.
 */

export type PcRelayDecision =
  | { kind: "read" }
  | { kind: "reviewed"; reviewReason: "destructive" | "irreversible"; effect: string; omitParams?: string[] }
  | { kind: "not_offered"; reason: string };

const SHELL = "Runs a program or command line on the PC. Secretary offers no shell or command execution; it stays a local tool of PC Control Plus.";
const PC_SAFETY = "Changes the PC's own safety settings. Only the owner changes them, on the PC itself.";
const IMAGES = "Captures an image of the screen or a camera. Secretary never controls the PC from images and does not take pictures of the owner's PC or room; read the screen as text with pc_browser_snapshot or pc_ui_snapshot.";
const NO_DELETION = "Deletes a file on the PC. The Secretary MCP gateway offers no deletion other than the guarded contact deletion (issue #74); delete files on the PC itself.";
const KEYS = "Sends keyboard input to the window in front on the PC; read it first with pc_ui_snapshot.";
const COORDINATES = "Acts at screen coordinates, the way screenshot-driven control does. PC control through Secretary works only from text state: use pc_ui_act (UI Automation refs) or pc_browser_act (page refs).";

export const PC_RELAY_POLICY: Record<string, PcRelayDecision> = {
  // Reads: the answer is the whole effect.
  system_info: { kind: "read" },
  monitors_list: { kind: "read" },
  list_directory: { kind: "read" },
  read_text: { kind: "read" },
  search_files: { kind: "read" },
  audit_tail: { kind: "read" },
  approvals_list: { kind: "read" },
  permission_status: { kind: "read" },
  web_tabs_list: { kind: "read" },
  web_list_fields: { kind: "read" },
  web_dom: { kind: "read" },
  ui_tree: { kind: "read" },
  ui_wait: { kind: "read" },
  web_goal_status: { kind: "read" },
  ui_goal_status: { kind: "read" },

  // Changes, and commands that keep running or wait in the PC's queue.
  open_url: { kind: "reviewed", reviewReason: "irreversible", effect: "Opens the address in the PC's default browser." },
  write_workspace_text: { kind: "reviewed", reviewReason: "destructive", effect: "Writes (or overwrites) a text file in the PC Control Plus workspace." },
  write_file: {
    kind: "reviewed", reviewReason: "irreversible", omitParams: ["content_base64"],
    effect: "Writes (or overwrites) a text file on the PC where its profile allows it. Binary content is not offered through Secretary.",
  },
  make_directory: { kind: "reviewed", reviewReason: "destructive", effect: "Creates a folder on the PC." },
  move_file: { kind: "reviewed", reviewReason: "irreversible", effect: "Moves or renames a file or folder on the PC." },
  desktop_type: { kind: "reviewed", reviewReason: "irreversible", effect: KEYS },
  desktop_hotkey: { kind: "reviewed", reviewReason: "irreversible", effect: KEYS },
  desktop_focus_window: { kind: "reviewed", reviewReason: "destructive", effect: "Brings a window to the front on the PC." },
  web_open: { kind: "reviewed", reviewReason: "irreversible", effect: "Navigates the PC Control Plus browser to the address." },
  web_attach_existing: { kind: "reviewed", reviewReason: "destructive", effect: "Attaches PC Control Plus to the Chrome or Edge already open on the PC." },
  web_tab_select: { kind: "reviewed", reviewReason: "destructive", effect: "Switches the browser tab PC Control Plus works in." },
  web_fill: { kind: "reviewed", reviewReason: "irreversible", effect: "Fills fields of the open web page." },
  web_click: { kind: "reviewed", reviewReason: "irreversible", effect: "Clicks in the open web page; it can submit forms." },
  web_type: { kind: "reviewed", reviewReason: "irreversible", effect: "Types into the open web page; it can submit forms." },
  web_press: { kind: "reviewed", reviewReason: "irreversible", effect: "Presses a key in the open web page; it can submit forms." },
  web_batch: { kind: "reviewed", reviewReason: "irreversible", effect: "Runs several steps in the open web page; with allow_changes it can submit forms." },
  ui_batch: { kind: "reviewed", reviewReason: "irreversible", effect: "Acts on controls of a Windows app window." },
  web_goal_start: { kind: "reviewed", reviewReason: "irreversible", effect: "Starts a web task that keeps running on the PC until it finishes or is cancelled." },
  ui_goal_start: { kind: "reviewed", reviewReason: "irreversible", effect: "Starts a desktop task that keeps running on the PC until it finishes or is cancelled." },
  web_goal_cancel: { kind: "reviewed", reviewReason: "destructive", effect: "Cancels a running web task on the PC." },
  ui_goal_cancel: { kind: "reviewed", reviewReason: "destructive", effect: "Cancels a running desktop task on the PC." },

  // Never through Secretary.
  run_command: { kind: "not_offered", reason: SHELL },
  desktop_click: { kind: "not_offered", reason: COORDINATES },
  desktop_drag: { kind: "not_offered", reason: COORDINATES },
  desktop_scroll: { kind: "not_offered", reason: COORDINATES },
  desktop_batch: { kind: "not_offered", reason: COORDINATES },
  run_approved_script: { kind: "not_offered", reason: SHELL },
  delete_file: { kind: "not_offered", reason: NO_DELETION },
  delete_workspace_file: { kind: "not_offered", reason: NO_DELETION },
  permission_set: { kind: "not_offered", reason: PC_SAFETY },
  approvals_reset: { kind: "not_offered", reason: PC_SAFETY },
  screenshot: { kind: "not_offered", reason: IMAGES },
  web_screenshot: { kind: "not_offered", reason: IMAGES },
  camera_list: { kind: "not_offered", reason: IMAGES },
  camera_photo: { kind: "not_offered", reason: IMAGES },
  camera_video: { kind: "not_offered", reason: IMAGES },
  ui_windows: { kind: "not_offered", reason: "The same windows are listed by pc_ui_windows (the shared engine's tool), whose handles work in pc_ui_snapshot and pc_ui_act." },
  web_close: { kind: "not_offered", reason: "Ends the PC's own browser session; a matter for the PC itself, not offered through Secretary." },
};
