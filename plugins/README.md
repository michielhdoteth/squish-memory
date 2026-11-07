# Squish Plugin System

This directory contains executable hook scripts for IDE integration with Claude Code, OpenCode, Cursor, and Windsurf.

## Hook Scripts

Scripts in the `scripts/` directory are executed by IDE extensions to capture user context and memories in real-time.

### Execution Pattern

The plugin uses a bounded asynchronous capture pattern:
- **Fast Enqueue**: Hook scripts receive stdin JSON, validate, and enqueue to a worker queue immediately
- **Async Processing**: Worker processes the queue asynchronously without blocking the IDE
- **Zero Latency**: IDE response times remain unaffected by memory capture operations

### Input/Output Format

Each script receives JSON input via stdin and outputs results to stdout:

**Input (stdin):**
```json
{
  "event": "onChat",
  "content": "user message or assistant response",
  "timestamp": "2025-04-25T12:00:00Z",
  "metadata": {
    "conversation_id": "uuid",
    "workspace": "/path/to/project"
  }
}
```

**Output (stdout):**
```json
{
  "status": "enqueued",
  "memory_id": "optional-uuid",
  "timestamp": "2025-04-25T12:00:01Z"
}
```

### Available Hooks

| Hook | Description |
|------|-------------|
| `onChat` | Triggered on user message or assistant response |
| `onComplete` | Triggered when a task or command completes |
| `onTerminal` | Triggered on terminal command execution |

### Integration

IDE extensions should call these scripts with appropriate event metadata. The scripts handle validation, deduplication, and queueing automatically.
