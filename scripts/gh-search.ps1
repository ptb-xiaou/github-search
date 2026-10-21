#!/usr/bin/env pwsh
# Thin Windows wrapper for gh-search.mjs — forwards all arguments to Node.
# Credential handling lives in gh-search.mjs (see README.md).
[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $Args)

$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'gh-search.mjs'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error 'Node.js 18+ is required (node not found on PATH).'
    exit 127
}

& $node.Source $script @Args
exit $LASTEXITCODE
