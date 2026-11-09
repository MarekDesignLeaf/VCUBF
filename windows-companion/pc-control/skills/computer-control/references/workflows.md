# Common Workflows

## 1. Open a project in VS Code

```
1. open_project(project_path="C:/Users/marek/projects/my-app")
2. ui_snapshot(window="Visual Studio Code") — confirm the folder opened
```

## 2. Edit a source file

```
1. create_backup(path="C:/path/to/file.py")
2. read_file(path="C:/path/to/file.py")          — read current content
3. write_file(path="C:/path/to/file.py", content=<modified>)
4. read_file(path="C:/path/to/file.py")          — verify changes
```

## 3. Run a build and check errors

```
1. run_command(command="cd C:/project && npm run build", dry_run=True)
   → preview output, confirm with user
2. run_command(command="cd C:/project && npm run build")
3. analyse_build_error(output=<stdout from step 2>)
   → review structured errors
```

## 4. Fill a web form (browser)

```
1. browser_open(url="https://portal.example/order")       — controls as [eN] lines
2. browser_act(steps=[
     {"fill": "e3", "value": "<name the user gave>"},
     {"select": "e5", "label": "<option the user chose>"},
     {"check": "e6"}
   ], snapshot="auto")                                      — filled, fresh snapshot back
3. Tell the user what will be submitted; wait for an explicit yes.
4. browser_act(steps=[{"click": "e7"}, {"wait_for": {"text": "<confirmation text>"}}])
```

## 5. Save a document from a Windows app (UI Automation)

```
1. ui_act(window="exe:notepad.exe", steps=[{"keys": "ctrl+s"}], snapshot="none")
2. ui_snapshot(window="Uložit jako")                        — [uN] Edit "Název souboru:" …
3. ui_act(window="Uložit jako", steps=[
     {"set_value": {"name": "Název souboru"}, "value": "nabidka.txt"},
     {"click": {"name": "Uložit", "role": "Button", "exact": true}}
   ])
```

## 6. Collect data from a website

```
1. web_fetch(url)                                           — enough for static pages
2. Otherwise: browser_open(url), then
   browser_extract(items=".result", fields={"title": "h3", "url": "a@href"})
```
## 5. Kill a stuck process

```
1. get_processes(name_filter="node")             — find the process
2. [tell user what you found, ask confirmation]
3. close_app(pid=<pid>, force=True)              — DESTRUCTIVE: confirm first
```

## 6. Batch file cleanup

```
1. search_files(root="C:/temp", pattern="*.tmp")  — list candidates
2. [show user the list, ask confirmation]
3. For each file:
   a. delete_file(path=<file>, permanent=False)   — soft delete to _deleted_/
```

## 7. Check system health

```
1. get_system_status()      — CPU, RAM, disk
2. get_processes()          — top memory consumers
3. list_windows()           — active windows
```

## 8. Safe terminal workflow

```
1. run_command(command=<cmd>, dry_run=True)   — preview
2. [show user the output, confirm]
3. run_command(command=<cmd>)                  — execute
4. read_terminal_output or check stdout
```
