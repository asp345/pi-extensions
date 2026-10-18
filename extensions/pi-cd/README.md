# pi-cd

Move the current Pi session to another working directory with `/cd`.

## Command

```
/cd
/cd <dir>
```

Without an argument, `/cd` shows the current working directory. With an argument, it resolves `<dir>` against the current working directory (`~` expands to the home directory), waits for the agent to become idle, writes the session with the header `cwd` set to the target, and resumes it. The session ID, file name, and entries are kept.

If the session is stored in the default session directory (`<agent dir>/sessions/--<encoded cwd>--/`), the file moves to the target's default session directory and the original file is deleted. If the session directory is set with `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, or `sessionDir`, the file stays in place and only its header `cwd` changes.
