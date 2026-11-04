# Common Workflows

## 1. Open a project in VS Code

```
1. open_project(project_path="C:/Users/marek/projects/my-app")
2. take_screenshot()  — confirm VS Code opened with correct folder
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

## 4. GUI interaction workflow

```
1. take_screenshot()                             — see current state
2. focus_window(title_contains="Chrome")
3. take_screenshot()                             — confirm window is active
4. click(x=<url_bar_x>, y=<url_bar_y>)
5. press_keys("ctrl+a")                          — select all
6. type_text("https://example.com")
7. press_keys("enter")
8. take_screenshot()                             — confirm navigation
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
