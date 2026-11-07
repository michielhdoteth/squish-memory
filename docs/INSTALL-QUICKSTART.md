# Squish Install Quickstart

> **Release status (2026-10-20): Squish 2.2.0 is an unpublished source candidate.** The npm
> package currently resolves to 1.9.0 and has not been validated against this checkout. Do not
> install the published package or follow these setup notes until a release announcement confirms
> the package version and host compatibility. The sections below describe target-version reference
> details, not a currently supported install path. Hosted sync, hosted API, managed AI, and checkout
> are unavailable.

## Installation status

There is no supported package-install command for this source candidate. Installation instructions
will be restored after a matching release and update path have been verified.

## Run local MCP

```bash
squish-mcp
```

Configure the MCP client to launch `squish-mcp` using its supported stdio configuration. See
[MCP Server](MCP-SERVER.md) for transport and tool details.

## Check the local runtime

```bash
squish context --json
squish health --json
squish stats --json
squish status --pretty
```

Inspect a stored memory by ID:

```bash
squish inspect <memory-id> --json
```

For transcript search across supported local agent stores and project roots, use the MCP tool
`squish_sessions` with `action: "search"`. The CLI `squish sessions` commands only operate on
sessions already stored in the Squish database. See [CLI sessions](CLI.md#sessions).
