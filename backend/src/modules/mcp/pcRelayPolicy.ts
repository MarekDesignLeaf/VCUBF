/**
 * Secretary's trust decision for each PC Control Plus relay tool.
 *
 * The tools themselves (names, descriptions, parameters, relay job ids) come
 * from the relay (pcpRelayCatalogue.generated.ts, imported by
 * windows-companion/pc-control/server/import_pcp_catalogue.py). This file
 * only decides, per relay job, how Secretary offers it:
 *
 * - "read": runs at once under read_pc; it returns what the PC reports and
 *   leaves nothing running or queued behind on the PC. One read job is the
 *   exception, stated in its limitation: read-only research
 *   (web_research_start) starts a read-only task in a new tab of the owner's
 *   Chrome. It changes nothing anywhere: the PC refuses every booking,
 *   payment, sending, sign-in, personal data or deletion step, and the task
 *   runs under the owner's one standing, revocable read-only research
 *   permission granted on the PC itself (issue #81).
 * - "reviewed": a change on the PC, or a command that keeps running or waits
 *   in a queue on the PC (goals). It is never read-only: preview, the user's
 *   explicit yes through confirm_action, then one call. The PC shows its
 *   owner ONE dialog with three choices (this operation only, all future
 *   operations, deny); a type the owner allowed for all future operations
 *   is not asked again, except irreversible or sensitive types (delete, run
 *   command or script, sensitive reads, camera, send, publish, pay, website
 *   changes, autonomous tasks), which the PC always asks one by one.
 *
 * Consent layers, stated once. (1) Secretary: who in the company may operate
 * the PC (permission, audit, and the user's yes for a reviewed step). (2) The
 * PC owner's dialog on the PC itself; it cannot be answered remotely.
 * (3) Platform consents that nothing here can or should answer: Windows UAC,
 * Chrome's Allow remote debugging, a website's sign in, 2FA and payment pages.
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
  | { kind: "read"; limitation?: string }
  | {
    kind: "reviewed"; reviewReason: "destructive" | "irreversible"; effect: string; protections?: string;
    /**
     * A read-only request of this job is not previewed as a change: it is sent
     * to this read tool instead (pc_web_goal_start with allow_changes false in
     * the existing Chrome is pc_web_research_start, as on the PC itself).
     */
    readOnlyRoute?: { tool: string; when: (args: Record<string, unknown>) => boolean };
  }
  | { kind: "not_offered"; reason: string };

const SHELL = "Owner-local, pending review: runs an arbitrary command line on the PC. Secretary offers no unreviewed shell; named scripts the owner approved run with pc_run_approved_script.";
const PC_SAFETY = "Owner-local, pending review: changes the PC's own safety settings (profile, remembered approvals), which guard every other PC step. The owner changes them on the PC itself.";
const BACKUP_PROFILE = "The PC first saves a backup copy of an existing file in its backups folder, refuses paths outside its profile, and asks its owner on the PC.";
const BACKUP_WORKSPACE = "The PC first saves a backup copy in its backups folder, works only inside the PC Control Plus workspace, and asks its owner on the PC.";
const IMAGES = "Captures an image of the screen or a camera. Secretary never controls the PC from images and does not take pictures of the owner's PC or room; read the screen as text with pc_browser_snapshot or pc_ui_snapshot.";
const KEYS = "Sends keyboard input to the window in front on the PC; read it first with pc_ui_snapshot.";
const RESEARCH = "Read-only: opens one new tab in the Google Chrome already open on the PC and reads public HTTPS pages from their DOM text; it fills search forms but the PC refuses any booking, payment, purchase, sending, sign-in, personal or card data and deletion. The first task shows the owner one dialog on the PC (this task only, all future read-only research on this PC, or deny; the standing permission is revocable with pc_web_research_trust_revoke); later tasks need no approval once the owner allowed all future research. Chrome's own Allow remote debugging prompt is Chrome's and is never answered for the owner. Poll pc_web_goal_status with the job_id. The step planner runs on the PC; if it fails (for example no API credits), the research tab stays open at the address given and pc_browser_read or pc_browser_extract read its results from the DOM, using no API credits: for flights pass a Google Flights address such as https://www.google.com/travel/flights?q=Flights%20from%20London%20to%20Prague%20on%202026-12-10.";
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
  web_research_trust_status: { kind: "read" },
  web_research_start: { kind: "read", limitation: RESEARCH },

  // Changes, and commands that keep running or wait in the PC's queue.
  open_url: { kind: "reviewed", reviewReason: "irreversible", effect: "Opens the address in the PC's default browser." },
  write_workspace_text: { kind: "reviewed", reviewReason: "destructive", effect: "Writes (or overwrites) a text file in the PC Control Plus workspace." },
  write_file: {
    kind: "reviewed", reviewReason: "irreversible", protections: BACKUP_PROFILE,
    effect: "Writes (or overwrites) a file on the PC where its profile allows it, from text or base64 content (at most 2 MB).",
  },
  delete_file: { kind: "reviewed", reviewReason: "irreversible", protections: BACKUP_PROFILE, effect: "Deletes one regular file on the PC where its profile allows it." },
  delete_workspace_file: { kind: "reviewed", reviewReason: "irreversible", protections: BACKUP_WORKSPACE, effect: "Deletes one file in the PC Control Plus workspace." },
  run_approved_script: {
    kind: "reviewed", reviewReason: "irreversible",
    protections: "Only a script the owner placed in the PC's approved-scripts folder, named like name.ps1 or name.py; it runs without a shell, for at most 12 seconds, after the owner's approval on the PC.",
    effect: "Runs one of the owner's approved scripts on the PC and returns its exit code and output.",
  },
  make_directory: { kind: "reviewed", reviewReason: "destructive", effect: "Creates a folder on the PC." },
  move_file: { kind: "reviewed", reviewReason: "irreversible", effect: "Moves or renames a file or folder on the PC." },
  desktop_type: { kind: "reviewed", reviewReason: "irreversible", effect: KEYS },
  desktop_hotkey: { kind: "reviewed", reviewReason: "irreversible", effect: KEYS },
  web_open: { kind: "reviewed", reviewReason: "irreversible", effect: "Navigates the PC Control Plus browser to the address." },
  web_fill: { kind: "reviewed", reviewReason: "irreversible", effect: "Fills fields of the open web page." },
  web_click: { kind: "reviewed", reviewReason: "irreversible", effect: "Clicks in the open web page; it can submit forms." },
  web_type: { kind: "reviewed", reviewReason: "irreversible", effect: "Types into the open web page; it can submit forms." },
  web_press: { kind: "reviewed", reviewReason: "irreversible", effect: "Presses a key in the open web page; it can submit forms." },
  web_batch: { kind: "reviewed", reviewReason: "irreversible", effect: "Runs several steps in the open web page; with allow_changes it can submit forms." },
  ui_batch: { kind: "reviewed", reviewReason: "irreversible", effect: "Acts on controls of a Windows app window." },
  web_goal_start: {
    kind: "reviewed", reviewReason: "irreversible", effect: "Starts a web task that keeps running on the PC until it finishes or is cancelled.",
    // The PC runs a read-only goal in the existing Chrome as read-only research; Secretary does the same.
    readOnlyRoute: {
      tool: "pc_web_research_start",
      when: (args) => args.allow_changes === false && (args.browser_mode === undefined || args.browser_mode === null || args.browser_mode === "existing"),
    },
  },
  ui_goal_start: { kind: "reviewed", reviewReason: "irreversible", effect: "Starts a desktop task that keeps running on the PC until it finishes or is cancelled." },

  // Steps that only move focus, stop work or reduce access. They stay previewed: running them without Secretary's
  // yes needs an execution path that is not a database transaction (see docs/PHONE_PC_INTEGRATION.md, consent layers).
  web_attach_existing: { kind: "reviewed", reviewReason: "destructive", effect: "Attaches PC Control Plus to the Chrome or Edge already open on the PC (Chrome's own Allow remote debugging prompt stays Chrome's)." },
  web_tab_select: { kind: "reviewed", reviewReason: "destructive", effect: "Switches the browser tab PC Control Plus works in." },
  web_goal_cancel: { kind: "reviewed", reviewReason: "destructive", effect: "Cancels a running web task on the PC; it only stops work." },
  ui_goal_cancel: { kind: "reviewed", reviewReason: "destructive", effect: "Cancels a running desktop task on the PC; it only stops work." },
  web_research_trust_revoke: { kind: "reviewed", reviewReason: "destructive", effect: "Revokes the owner's standing read-only research permission on the PC; it only reduces access." },
  approvals_revoke: { kind: "reviewed", reviewReason: "destructive", effect: "Withdraws one remembered approval on the PC (named by pc_approvals_list); it only reduces access, and granting stays on the PC." },

  // Never through Secretary.
  run_command: { kind: "not_offered", reason: SHELL },
  permission_set: { kind: "not_offered", reason: PC_SAFETY },
  approvals_reset: { kind: "not_offered", reason: PC_SAFETY },
  desktop_click: { kind: "not_offered", reason: COORDINATES },
  desktop_focus_window: { kind: "not_offered", reason: "The PC refuses this step by the owner's policy against blind desktop input, so offering it would only fail. Windows are listed by pc_ui_windows and operated by pc_ui_snapshot and pc_ui_act." },
  desktop_drag: { kind: "not_offered", reason: COORDINATES },
  desktop_scroll: { kind: "not_offered", reason: COORDINATES },
  desktop_batch: { kind: "not_offered", reason: COORDINATES },
  screenshot: { kind: "not_offered", reason: IMAGES },
  web_screenshot: { kind: "not_offered", reason: IMAGES },
  camera_list: { kind: "not_offered", reason: IMAGES },
  camera_photo: { kind: "not_offered", reason: IMAGES },
  camera_video: { kind: "not_offered", reason: IMAGES },
  ui_windows: { kind: "not_offered", reason: "The same windows are listed by pc_ui_windows (the shared engine's tool), whose handles work in pc_ui_snapshot and pc_ui_act." },
  download_file: { kind: "not_offered", reason: "Copies a file's original bytes off the PC as a binary MCP resource. Secretary's PC bridge carries text results only, and a copy of a PC file in Secretary would have no CRM record, permission or retention rule yet. Text files are read with pc_read_text." },
  export_whatsapp_chat: { kind: "not_offered", reason: "Exports a private chat of the owner's personal WhatsApp Web, including messages of third parties, outside the CRM and the official WhatsApp Business connector. Secretary handles customer messages only through the connector, with their record and consent." },
  web_close: { kind: "not_offered", reason: "Ends the PC's own browser session; a matter for the PC itself, not offered through Secretary." },
};
