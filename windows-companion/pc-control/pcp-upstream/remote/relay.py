"""Authenticated outbound relay for a paired Windows agent."""
import asyncio
import hashlib
import inspect
import json
from pathlib import Path
import base64
import io
import os
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from fastapi import FastAPI, Form, Header, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp.server.auth.settings import AuthSettings, ClientRegistrationOptions
from pydantic import BaseModel, Field
from mcp.types import ToolAnnotations
from oauth import LOGIN_PAGE, OwnerProvider
import pc_engine

CLIENT_TOKEN = os.environ.get('PCP_CLIENT_TOKEN', '')
AGENT_TOKEN = os.environ.get('PCP_AGENT_TOKEN', '')
if min(len(CLIENT_TOKEN), len(AGENT_TOKEN)) < 32 or secrets.compare_digest(CLIENT_TOKEN, AGENT_TOKEN):
    raise RuntimeError('Configure distinct random PCP_CLIENT_TOKEN and PCP_AGENT_TOKEN (at least 32 characters)')

_default_hosts = 'pc-control-plus-relay-production.up.railway.app'
ALLOWED_HOSTS = [h.strip() for h in os.environ.get('PCP_ALLOWED_HOSTS', _default_hosts).split(',') if h.strip()]
_security = TransportSecuritySettings(
    enable_dns_rebinding_protection=True,
    allowed_hosts=ALLOWED_HOSTS + [h + ':*' for h in ALLOWED_HOSTS],
    allowed_origins=['https://' + h for h in ALLOWED_HOSTS],
)

ISSUER_URL = os.environ.get('PCP_ISSUER_URL', 'https://' + _default_hosts).rstrip('/')
LOGIN_PASSWORD = os.environ.get('PCP_LOGIN_PASSWORD', '')
if len(LOGIN_PASSWORD) < 8:
    raise RuntimeError('Set PCP_LOGIN_PASSWORD (owner sign-in, at least 8 characters)')
SCOPES = ['pc']
LOGIN_PATH = '/login'
oauth_provider = OwnerProvider(ISSUER_URL, LOGIN_PATH, SCOPES)

@asynccontextmanager
async def lifespan(app):
    async with mcp.session_manager.run():
        yield

app = FastAPI(title='PC Control Plus Relay', docs_url=None, redoc_url=None,
              openapi_url=None, lifespan=lifespan)
queue = asyncio.Queue(maxsize=32)
pending = {}
last_seen = 0.0
last_heartbeat = 0.0
in_flight_jobs = {}  # Jobs delivered to Windows, awaiting results.
AGENT_GRACE_SECONDS = 90
IN_FLIGHT_GRACE_SECONDS = 180


def agent_presence():
    now = time.monotonic()
    # Expire abandoned jobs, but do not make a working agent appear offline
    # merely because it is executing a long command or a login dialog.
    for jid, started in tuple(in_flight_jobs.items()):
        if now - started >= IN_FLIGHT_GRACE_SECONDS:
            in_flight_jobs.pop(jid, None)
    busy = bool(in_flight_jobs)
    online = (last_seen > 0 and now - last_seen < AGENT_GRACE_SECONDS) or busy
    return online, busy


def agent_diagnostics():
    online, busy = agent_presence()
    return {
        'agent_online': online,
        'agent_busy': busy,
        'heartbeat_age_seconds': round(time.monotonic() - last_heartbeat, 1) if last_heartbeat else None,
        'last_contact_age_seconds': round(time.monotonic() - last_seen, 1) if last_seen else None,
        'pending_commands': len(in_flight_jobs),
    }

ALLOWED = frozenset({'system_info', 'list_directory', 'read_text', 'search_files', 'screenshot', 'write_workspace_text', 'delete_workspace_file', 'open_url', 'desktop_click', 'desktop_type', 'desktop_hotkey', 'desktop_scroll', 'desktop_drag', 'desktop_focus_window', 'desktop_batch', 'run_approved_script', 'audit_tail', 'write_file', 'delete_file', 'make_directory', 'move_file', 'run_command', 'camera_list', 'camera_photo', 'camera_video', 'web_open', 'web_attach_existing', 'web_tabs_list', 'web_tab_select', 'web_list_fields', 'web_fill', 'web_click', 'web_screenshot', 'web_close', 'web_type', 'web_press', 'approvals_list', 'approvals_reset', 'permission_status', 'permission_set', 'monitors_list', 'web_goal_start', 'web_goal_status', 'web_goal_cancel', 'web_dom', 'web_batch', 'ui_windows', 'ui_tree', 'ui_batch', 'ui_wait', 'ui_goal_start', 'ui_goal_status', 'ui_goal_cancel'})
# PCP_V2_TOOLS
# The shared engine's tools (pc_engine.TOOLS, the same catalogue the Claude
# plugin exposes) reach the agent as "engine_<name>".
ENGINE_TOOL_IDS = frozenset('engine_' + name for name in pc_engine.TOOLS)
ALLOWED = ALLOWED | ENGINE_TOOL_IDS | {'browser_connection_status'}

class Job(BaseModel):
    tool: str
    args: dict = Field(default_factory=dict)

class Result(BaseModel):
    id: str
    ok: bool
    data: object = None
    error: str | None = None

def authenticate(header, token):
    if not secrets.compare_digest(header or '', 'Bearer ' + token):
        raise HTTPException(401, 'Unauthorized')

UPDATE_NAMES = ('agent.py', 'web_goal.py', 'browser_dom.py', 'windows_uia.py', 'desktop_goal.py', 'pc_engine.py')


@app.get('/v1/agent/update-manifest')
def agent_update_manifest(authorization: str | None = Header(None)):
    """Only the active Railway deployment defines which agent files are released."""
    authenticate(authorization, AGENT_TOKEN)
    # The relay is a distribution point, NOT the signer. Only a release
    # artifact signed outside Railway is eligible to be served as an update.
    source = Path(__file__).with_name('release-manifest.json')
    if not source.is_file():
        raise HTTPException(503, 'Signed release artifact is not published')
    try:
        manifest = json.loads(source.read_text(encoding='utf-8'))
        if manifest.get('schema') != 'pcp.release.v2' or not manifest.get('signature_ed25519'):
            raise ValueError('Missing release signature')
        hashes = manifest['files']
        if set(hashes) != set(UPDATE_NAMES):
            raise ValueError('Unexpected files in signed release')
        for name in UPDATE_NAMES:
            actual = hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
            if hashes[name] != actual:
                raise ValueError('Published agent files do not match release manifest')
        actual_runner = hashlib.sha256(Path(__file__).with_name('runner.py').read_bytes()).hexdigest()
        if manifest['bootstrap_runner_sha256'] != actual_runner:
            raise ValueError('Published runner differs from signed manifest')
        return manifest
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise HTTPException(503, 'Signed release artifact verification failed') from exc


@app.get('/v1/agent/update-file/{filename}')
def agent_update_file(filename: str, authorization: str | None = Header(None)):
    authenticate(authorization, AGENT_TOKEN)
    if filename not in UPDATE_NAMES:
        raise HTTPException(404, 'Unknown agent update file')
    source = Path(__file__).with_name(filename)
    return Response(content=source.read_bytes(), media_type='text/x-python',
                    headers={'Cache-Control': 'no-store'})


@app.get('/v1/agent/bootstrap-runner')
def agent_bootstrap_runner(authorization: str | None = Header(None)):
    authenticate(authorization, AGENT_TOKEN)
    return Response(content=Path(__file__).with_name('runner.py').read_bytes(),
                    media_type='text/x-python', headers={'Cache-Control':'no-store'})


@app.get('/bootstrap.ps1')
def download_bootstrap():
    # Contains no credentials; the local script reads existing Windows settings.
    return Response(content=Path(__file__).with_name('bootstrap.ps1').read_bytes(),
                    media_type='text/plain', headers={'Cache-Control':'no-store'})


@app.get('/health')
def health():
    online, busy = agent_presence()
    return {'ok': True, **agent_diagnostics()}

@app.post('/v1/call')
async def call(job: Job, authorization: str | None = Header(None)):
    authenticate(authorization, CLIENT_TOKEN)
    if job.tool not in ALLOWED:
        raise HTTPException(403, 'Tool not enabled')
    online, busy = agent_presence()
    if not online:
        raise HTTPException(503, 'Agent offline')
    if busy:
        raise HTTPException(409, 'Windows agent busy processing a previous command')
    jid = str(uuid.uuid4())
    future = asyncio.get_running_loop().create_future()
    pending[jid] = future
    try:
        queue.put_nowait({'id': jid, 'tool': job.tool, 'args': job.args})
        return await asyncio.wait_for(future, timeout=75)
    except asyncio.QueueFull:
        raise HTTPException(429, 'Queue full')
    except asyncio.TimeoutError:
        raise HTTPException(504, 'Agent timeout')
    finally:
        pending.pop(jid, None)

@app.get('/v1/agent/next')
async def next_job(authorization: str | None = Header(None)):
    global last_seen
    authenticate(authorization, AGENT_TOKEN)
    last_seen = time.monotonic()
    try:
        job = await asyncio.wait_for(queue.get(), timeout=15)
        if job.get('id'):
            in_flight_jobs[job['id']] = time.monotonic()
        return job
    except asyncio.TimeoutError:
        return {'id': None}

@app.post('/v1/agent/heartbeat')
async def heartbeat(authorization: str | None = Header(None)):
    """Keep the authenticated Windows agent online while it processes a job."""
    global last_seen, last_heartbeat
    authenticate(authorization, AGENT_TOKEN)
    last_seen = time.monotonic()
    last_heartbeat = last_seen
    return {'ok': True}

@app.post('/v1/agent/result')
async def result(value: Result, authorization: str | None = Header(None)):
    global last_seen
    authenticate(authorization, AGENT_TOKEN)
    last_seen = time.monotonic()
    in_flight_jobs.pop(value.id, None)
    future = pending.get(value.id)
    if future is not None and not future.done():
        future.set_result(value.model_dump())
    return {'received': future is not None}

mcp = FastMCP('PC Control Plus', stateless_http=True, json_response=True,
              streamable_http_path='/mcp', transport_security=_security,
              auth_server_provider=oauth_provider,
              auth=AuthSettings(
                  issuer_url=ISSUER_URL,
                  resource_server_url=ISSUER_URL,
                  required_scopes=SCOPES,
                  client_registration_options=ClientRegistrationOptions(
                      enabled=True, valid_scopes=SCOPES, default_scopes=SCOPES)))

async def remote_call(tool: str, args: dict):
    if tool not in ALLOWED:
        raise ValueError('Unsupported tool')
    online, busy = agent_presence()
    if not online:
        raise RuntimeError('Windows agent offline')
    if busy:
        raise RuntimeError('Windows agent busy processing a previous command')
    jid = str(uuid.uuid4())
    future = asyncio.get_running_loop().create_future()
    pending[jid] = future
    try:
        queue.put_nowait({'id': jid, 'tool': tool, 'args': args})
        result = await asyncio.wait_for(future, timeout=75)
        if not result['ok']:
            raise RuntimeError(result.get('error') or 'Agent error')
        return result['data']
    finally:
        pending.pop(jid, None)

@mcp.tool()
async def pc_status() -> dict:
    return agent_diagnostics()

@mcp.tool()
async def pc_system_info() -> dict:
    return await remote_call('system_info', {})

@mcp.tool()
async def pc_list_directory(path: str, limit: int = 100) -> list:
    return await remote_call('list_directory', {'path': path, 'limit': limit})

@mcp.tool()
async def pc_read_text(path: str, max_bytes: int = 50000) -> str:
    return await remote_call('read_text', {'path': path, 'max_bytes': max_bytes})

@mcp.tool()
async def pc_search_files(path: str, pattern: str, limit: int = 100) -> list[str]:
    return await remote_call('search_files', {'path': path, 'pattern': pattern, 'limit': limit})

def compact_screenshot(result: dict) -> dict:
    """Bound screenshot size before returning it over the MCP transport."""
    from PIL import Image
    raw = base64.b64decode(result['base64'], validate=True)
    with Image.open(io.BytesIO(raw)) as source:
        image = source.convert('RGB')
    image.thumbnail((3200, 2000), Image.Resampling.LANCZOS)
    payload = io.BytesIO()
    for _ in range(9):
        payload.seek(0)
        payload.truncate()
        image.save(payload, format='PNG', compress_level=6, optimize=True)
        if payload.tell() <= 2_000_000:
            break
        image.thumbnail((max(320, int(image.width * 0.75)),
                         max(200, int(image.height * 0.75))), Image.Resampling.LANCZOS)
    if payload.tell() > 2_000_000:
        raise ValueError('Screenshot could not be compressed for transport')
    return {**result, 'base64': base64.b64encode(payload.getvalue()).decode('ascii'),
            'width': image.width, 'height': image.height}


@mcp.tool()
async def pc_screenshot(monitor: int = 1) -> dict:
    """Capture one monitor as PNG (default: first screen). Pass monitor=0 for all screens together. Only for a picture the user explicitly asked for: never to find, click, read or check anything, never as a fallback when a text read cannot see something, and nothing acts on what it shows."""
    result = await remote_call('screenshot', {'monitor': monitor})
    return await asyncio.to_thread(compact_screenshot, result)

@mcp.tool()
async def pc_monitors_list() -> list:
    """List connected monitors (index, position and size); index 0 is the combined virtual screen of all monitors."""
    return await remote_call('monitors_list', {})

@mcp.tool()
async def pc_write_workspace_text(path: str, text: str) -> dict:
    """Write a small UTF-8 text file within PCP_WRITE_ROOT after local approval; back up existing file."""
    return await remote_call('write_workspace_text', {'path':path,'text':text})

@mcp.tool()
async def pc_delete_workspace_file(path: str) -> dict:
    """Delete a regular file in PCP_WRITE_ROOT after local approval, preserving a backup."""
    return await remote_call('delete_workspace_file', {'path':path})

@mcp.tool()
async def pc_open_url(url: str) -> dict:
    """Open an HTTP(S) URL in the Windows default browser after local approval."""
    return await remote_call('open_url', {'url':url})

@mcp.tool()
async def pc_desktop_click(x: int, y: int, button: str = 'left', clicks: int = 1) -> dict:
    """Click the Windows desktop, including right/double click, after local approval. Only at coordinates the user gave, for a control UI Automation cannot reach; never at coordinates read from a screenshot."""
    return await remote_call('desktop_click',
                             {'x': x, 'y': y, 'button': button, 'clicks': clicks})


@mcp.tool()
async def pc_desktop_scroll(steps: int, x: int | None = None, y: int | None = None) -> dict:
    """Scroll the mouse wheel; positive steps up, negative down. Optional cursor position. Only at coordinates the user gave, for a control UI Automation cannot reach; never at coordinates read from a screenshot."""
    return await remote_call('desktop_scroll', {'steps': steps, 'x': x, 'y': y})


@mcp.tool()
async def pc_desktop_drag(x1: int, y1: int, x2: int, y2: int,
                          duration_seconds: float = 0.5) -> dict:
    """Drag with the left mouse button between physical screen coordinates. Only at coordinates the user gave, for a control UI Automation cannot reach; never at coordinates read from a screenshot."""
    return await remote_call('desktop_drag', {'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2,
                                              'duration_seconds': duration_seconds})

@mcp.tool()
async def pc_desktop_focus_window(handle: int) -> dict:
    """Activate a visible top-level Windows application before keyboard operations."""
    return await remote_call('desktop_focus_window', {'handle': handle})


@mcp.tool()
async def pc_desktop_batch(actions: list[dict]) -> dict:
    """Run 1-16 keyboard/mouse actions in a single network trip and one owner approval.

    Each entry is {tool: desktop_click|desktop_type|desktop_hotkey|desktop_scroll|desktop_drag,
                   args: {...}}. Not transactional; do not replay on partial failure. Clicks, scrolls and drags only at coordinates the user gave, for a control UI Automation cannot reach; never at coordinates read from a screenshot.
    """
    return await remote_call('desktop_batch', {'actions': actions})

@mcp.tool()
async def pc_desktop_type(text: str, method: str = 'auto', delay_ms: int = 20) -> dict:
    """Enter Unicode text (diacritics, symbols, emoji; newline = Enter) into the focused Windows app.

    method 'auto' types short text key by key (20 ms per character, the minimum modern WinUI apps
    such as Windows 11 Notepad accept) and pastes longer text through the clipboard, restoring the
    previous clipboard afterwards. 'keys' always types (use where paste is blocked, e.g. password
    fields); 'paste' always pastes. Up to 10000 characters.
    """
    return await remote_call('desktop_type', {'text': text, 'method': method, 'delay_ms': delay_ms})

@mcp.tool()
async def pc_desktop_hotkey(keys: list[str]) -> dict:
    """Press an allowlisted keyboard shortcut after local approval."""
    return await remote_call('desktop_hotkey', {'keys':keys})

@mcp.tool()
async def pc_run_approved_script(name: str) -> dict:
    """Run a preinstalled script by name from PCP_SCRIPTS_ROOT after local approval."""
    return await remote_call('run_approved_script', {'name':name})

@mcp.tool()
async def pc_audit_tail(limit: int = 30) -> list:
    """Read recent PC Control Plus action audit events."""
    return await remote_call('audit_tail', {'limit':limit})

@mcp.tool()
async def pc_write_file(path: str, text: str = '', content_base64: str = '', create_dirs: bool = False) -> dict:
    """Create or overwrite a file anywhere in the allowed roots after local approval; backs up any existing file. Pass text or content_base64 (binary), up to 2 MB."""
    args = {'path': path, 'create_dirs': create_dirs}
    if content_base64:
        args['content_base64'] = content_base64
    else:
        args['text'] = text
    return await remote_call('write_file', args)

@mcp.tool()
async def pc_delete_file(path: str) -> dict:
    """Delete a regular file anywhere in the allowed roots after local approval, preserving a backup."""
    return await remote_call('delete_file', {'path': path})

@mcp.tool()
async def pc_make_directory(path: str) -> dict:
    """Create a directory (with parents) anywhere in the allowed roots after local approval."""
    return await remote_call('make_directory', {'path': path})

@mcp.tool()
async def pc_move_file(src: str, dst: str) -> dict:
    """Move or rename a file within the allowed roots after local approval; backs up an existing destination."""
    return await remote_call('move_file', {'src': src, 'dst': dst})

@mcp.tool()
async def pc_run_command(command: str = '', argv: list[str] | None = None, cwd: str = '', wait: bool = True, timeout: int = 20) -> dict:
    """Run a program or shell command on the PC after local approval; audited. Pass argv for a direct program launch or command for a shell line. wait=False launches without waiting."""
    args = {'wait': wait, 'timeout': timeout}
    if cwd:
        args['cwd'] = cwd
    if argv:
        args['argv'] = argv
    else:
        args['command'] = command
    return await remote_call('run_command', args)

@mcp.tool()
async def pc_camera_list() -> list:
    """List the PC's available camera (video input) device names."""
    return await remote_call('camera_list', {})

@mcp.tool()
async def pc_camera_photo(device: str = '') -> dict:
    """Capture one photo from the PC camera after local approval; returns PNG base64 and the saved path. Optional device name from pc_camera_list. Only for a picture the user explicitly asked for: never to find, click, read or check anything, never as a fallback when a text read cannot see something, and nothing acts on what it shows."""
    return await remote_call('camera_photo', {'device': device} if device else {})

@mcp.tool()
async def pc_camera_video(seconds: int = 5, device: str = '') -> dict:
    """Record a short video (1 to 60 s) from the PC camera after local approval; saves it locally and returns the path and size. Optional device name from pc_camera_list. Only for a recording the user explicitly asked for: never to find, click, read or check anything, and nothing acts on what it shows."""
    args = {'seconds': seconds}
    if device:
        args['device'] = device
    return await remote_call('camera_video', args)

@mcp.tool()
async def pc_web_open(url: str) -> dict:
    """Open a URL in a controlled browser on the PC after local approval; returns the page title and URL."""
    return await remote_call('web_open', {'url': url})

@mcp.tool()
async def pc_web_attach_existing() -> dict:
    """Attach to an owner-approved local CDP Chrome/Edge session, without navigating any tab."""
    return await remote_call('web_attach_existing', {})


@mcp.tool()
async def pc_web_tabs_list() -> dict:
    """Enumerate tabs in the controlled browser session, without query strings."""
    return await remote_call('web_tabs_list', {})


@mcp.tool()
async def pc_web_tab_select(index: int) -> dict:
    """Select an existing controlled browser tab after local owner approval."""
    return await remote_call('web_tab_select', {'index': index})


@mcp.tool()
async def pc_web_list_fields() -> list:
    """List the form fields and buttons on the current browser page (name, id, type, label)."""
    return await remote_call('web_list_fields', {})

@mcp.tool()
async def pc_web_fill(fields: list) -> dict:
    """Fill form fields on the current page after local approval. Each item is {selector or name, value}."""
    return await remote_call('web_fill', {'fields': fields})

@mcp.tool()
async def pc_web_click(selector: str = '', text: str = '') -> dict:
    """Click an element on the current page after local approval. Give a CSS selector, or the visible button/link text."""
    a = {}
    if text:
        a['text'] = text
    if selector:
        a['selector'] = selector
    return await remote_call('web_click', a)

@mcp.tool()
async def pc_web_type(text: str, selector: str = '', submit: bool = False) -> dict:
    """Type text on the current page after local approval. With a selector it types into that field, otherwise into the focused element; submit=True presses Enter after."""
    a = {'text': text, 'submit': submit}
    if selector:
        a['selector'] = selector
    return await remote_call('web_type', a)

@mcp.tool()
async def pc_web_press(key: str) -> dict:
    """Press a keyboard key in the browser (for example Enter, Tab, Escape) after local approval."""
    return await remote_call('web_press', {'key': key})

@mcp.tool()
async def pc_web_screenshot() -> dict:
    """Capture a PNG of the current browser page. Only for a picture the user explicitly asked for: never to find, click, read or check anything, never as a fallback when a text read cannot see something, and nothing acts on what it shows."""
    return await remote_call('web_screenshot', {})

@mcp.tool()
async def pc_web_dom() -> dict:
    """Read rendered DOM, stripped HTML and visible controls, without screenshots."""
    return await remote_call('web_dom', {})

@mcp.tool()
async def pc_web_batch(actions: list[dict], allow_changes: bool = False) -> dict:
    """Execute up to six structured DOM actions in one relay roundtrip. Writes require local approval."""
    return await remote_call('web_batch', {'actions': actions, 'allow_changes': allow_changes})

@mcp.tool()
async def pc_ui_windows() -> list:
    """Enumerate top-level Windows applications by title, PID and handle without screenshots."""
    return await remote_call('ui_windows', {})

@mcp.tool()
async def pc_ui_tree(handle: int, depth: int = 4, limit: int = 140) -> dict:
    """Inspect a native Windows window using its accessibility/UIA tree."""
    return await remote_call('ui_tree', {'handle': handle, 'depth': depth, 'limit': limit})

@mcp.tool()
async def pc_ui_wait(handle: int, name: str = '', control_type: str = '', timeout: float = 10) -> dict:
    """Wait locally for a named UIA control or control type; do not poll screenshots."""
    return await remote_call('ui_wait', {'handle': handle, 'name': name,
                                        'control_type': control_type, 'timeout': timeout})

@mcp.tool()
async def pc_ui_batch(handle: int, actions: list[dict]) -> dict:
    """Execute 1-8 native UIA pattern actions in a batch after owner approval."""
    return await remote_call('ui_batch', {'handle': handle, 'actions': actions})

@mcp.tool()
async def pc_ui_goal_start(goal: str) -> dict:
    """Start autonomous Windows application work after one approval for the whole goal. Each step is decided from UI Automation text, never from screenshots."""
    return await remote_call('ui_goal_start', {'goal': goal})

@mcp.tool()
async def pc_ui_goal_status(job_id: str) -> dict:
    """Read progress of an autonomous native Windows goal."""
    return await remote_call('ui_goal_status', {'job_id': job_id})

@mcp.tool()
async def pc_ui_goal_cancel(job_id: str) -> dict:
    """Cancel an autonomous native Windows goal."""
    return await remote_call('ui_goal_cancel', {'job_id': job_id})

@mcp.tool()
async def pc_web_goal_start(url: str, goal: str, allow_changes: bool = True,
                            browser_mode: str = 'existing') -> dict:
    """DOM-only automation: each step is decided from the page's DOM text, never from screenshots. Default: attach to an existing CDP-enabled Edge/Chrome
    tab without opening, focusing or closing windows. Explicit 'isolated' mode
    starts a dedicated browser. One owner approval covers the named task.
    """
    return await remote_call('web_goal_start', {
        'url': url, 'goal': goal, 'allow_changes': allow_changes,
        'browser_mode': browser_mode,
    })

@mcp.tool()
async def pc_web_goal_status(job_id: str) -> dict:
    """Retrieve a browser goal's step trace and structured result. Poll until completed or failed."""
    return await remote_call('web_goal_status', {'job_id': job_id})

@mcp.tool()
async def pc_web_goal_cancel(job_id: str) -> dict:
    """Request cancellation of a browser goal running on Windows."""
    return await remote_call('web_goal_cancel', {'job_id': job_id})

@mcp.tool()
async def pc_web_close() -> dict:
    """Close the controlled browser on the PC."""
    return await remote_call('web_close', {})

@mcp.tool()
async def pc_permission_status() -> dict:
    """Read the device owner's locally configured computer-control permission profile."""
    return await remote_call('permission_status', {})


@mcp.tool()
async def pc_permission_set(profile: str) -> dict:
    """Request a permission-profile change; ALWAYS requires direct Windows owner approval.

    Profiles: read_only, standard, advanced, administrator. Administrator
    additionally requires actual Windows process elevation; UAC is never bypassed.
    """
    return await remote_call('permission_set', {'profile': profile})


@mcp.tool()
async def pc_approvals_list() -> list:
    """List action types the owner has chosen to stop being prompted for (remembered local approvals)."""
    return await remote_call('approvals_list', {})

@mcp.tool()
async def pc_approvals_reset() -> dict:
    """Clear all remembered approvals so every sensitive action prompts again on the PC."""
    return await remote_call('approvals_reset', {})

# ─── Shared engine tools: generated from pc_engine.TOOLS, nothing written twice ───

# Engine tools already served by an equivalent PC Control Plus tool of the same name.
ENGINE_EQUIVALENTS = {
    'ui_windows': 'pc_ui_windows lists the same windows (title, PID, handle); the handle works as window= in pc_ui_snapshot and pc_ui_act.',
}
_ENGINE_KINDS = {'str': str, 'int': int, 'bool': bool, 'list': list[dict], 'dict': dict}


def _engine_relay_tool(spec):
    async def tool(**kwargs):
        return await remote_call('engine_' + spec.name, kwargs)

    parameters = []
    for param in spec.params:
        kind = _ENGINE_KINDS[param.kind]
        if param.required:
            parameters.append(inspect.Parameter(param.name, inspect.Parameter.KEYWORD_ONLY, annotation=kind))
        else:
            annotation = kind | None if param.default is None else kind
            parameters.append(inspect.Parameter(param.name, inspect.Parameter.KEYWORD_ONLY,
                                                default=param.default, annotation=annotation))
    tool.__name__ = tool.__qualname__ = 'pc_' + spec.name
    tool.__signature__ = inspect.Signature(parameters, return_annotation=dict)
    tool.__annotations__ = {param.name: param.annotation for param in parameters} | {'return': dict}
    # The catalogue states the real effects: anything that can navigate, submit
    # or delete is not read-only and is declared destructive.
    mcp.tool(name='pc_' + spec.name, description=spec.description('pc_'),
             annotations=ToolAnnotations(readOnlyHint=spec.read_only, destructiveHint=spec.destructive,
                                         openWorldHint=spec.group in ('browser', 'web')))(tool)


for _spec in pc_engine.TOOLS.values():
    if _spec.name not in ENGINE_EQUIVALENTS:
        _engine_relay_tool(_spec)


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False))
async def pc_browser_connection_status() -> dict:
    """Read-only: whether the Chrome or Edge already open on the PC allows remote debugging for PC Control Plus, and how to switch it on (chrome://inspect or edge://inspect, #remote-debugging). Starts, restarts or closes nothing; never returns the browser's debugging identifier."""
    return await remote_call('browser_connection_status', {})


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False))
async def pc_capabilities() -> dict:
    """Describe every PC Control Plus tool (name, purpose, parameters) and the shared engine's tools with their safety level and when to use them. Reads nothing on the PC."""
    listed = await mcp.list_tools()
    return {
        'engine_version': pc_engine.ENGINE_VERSION,
        'engine_tools': [spec.as_dict('pc_') for spec in pc_engine.TOOLS.values()],
        'equivalents': {'pc_' + name: note for name, note in ENGINE_EQUIVALENTS.items()},
        'tools': [{'name': tool.name, 'description': (tool.description or '').split('\n\n')[0]} for tool in listed],
        'browser_step_reference': pc_engine.BROWSER_STEP_REFERENCE,
        'instructions': mcp.instructions,
    }


def _instructions():
    names = sorted(tool for tool in mcp._tool_manager._tools)
    return (
        'PC Control Plus: audited control of the owner\'s Windows PC and browser. Sensitive actions ask the owner '
        'on the PC itself; tell the user what you are about to do.\n\n'
        + pc_engine.fast_path('pc_')
        + '\n\nThe browser tools attach to the Chrome or Edge the owner already has open (remote debugging switched on '
        'at chrome://inspect or edge://inspect, #remote-debugging; check with pc_browser_connection_status) without '
        'opening, closing or clearing its tabs. They reach only public HTTPS addresses: every navigation and redirect '
        'is checked before it is sent. pc_browser_open navigates the current tab and asks the owner first. '
        'For whole tasks with one approval use '
        'pc_web_goal_start / pc_ui_goal_start.\n\n'
        'Control works only from text state (page DOM, UI Automation). Never take a screenshot to find, click, read '
        'or check anything, never fall back to one when a text read cannot see something, and never act at '
        'coordinates read from an image. pc_screenshot, pc_web_screenshot and the camera tools only capture a picture '
        'the user explicitly asked for.\n\n'
        'If something fails, call pc_status. Call pc_capabilities for every tool, its level and when to use it.\n\n'
        'Tools: ' + ', '.join(names) + '.'
    )


mcp._mcp_server.instructions = _instructions()


@app.get('/login', response_class=HTMLResponse)
def login_form(rid: str, error: str = ''):
    msg = '<p class="err">Incorrect password.</p>' if error else ''
    return LOGIN_PAGE.format(rid=rid, error=msg, login_path=LOGIN_PATH)

@app.post('/login')
def login_submit(rid: str = Form(...), password: str = Form('')):
    if not secrets.compare_digest(password, LOGIN_PASSWORD):
        return RedirectResponse(LOGIN_PATH + '?rid=' + rid + '&error=1', status_code=303)
    target = oauth_provider.complete_login(rid)
    if not target:
        return JSONResponse({'error': 'invalid_request', 'detail': 'expired or unknown login'}, status_code=400)
    return RedirectResponse(target, status_code=303)

app.mount('/', mcp.streamable_http_app())
