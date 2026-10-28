Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-ChatGPTAppTarget {
    $proc = Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'ChatGPT.exe' -and $_.CommandLine -notmatch '--type='
    } | Select-Object -First 1
    if (-not $proc) { throw 'ChatGPT Windows App is not running.' }
    if ($proc.CommandLine -notmatch '--remote-debugging-port=(\d+)') {
        throw 'ChatGPT Windows App remote debugging port was not found.'
    }
    $port = [int]$Matches[1]
    $targets = (Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:$port/json") -TimeoutSec 5).Content | ConvertFrom-Json
    $page = $targets | Where-Object { $_.type -eq 'page' -and $_.url -eq 'app://-/index.html' } | Select-Object -First 1
    if (-not $page) { throw 'ChatGPT Windows App page target was not found.' }
    [pscustomobject]@{ Port = $port; WebSocketUrl = [string]$page.webSocketDebuggerUrl }
}

function New-CdpSocket([string]$WebSocketUrl, [int]$TimeoutSeconds = 45) {
    $socket = [Net.WebSockets.ClientWebSocket]::new()
    $cts = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($TimeoutSeconds))
    $socket.ConnectAsync([Uri]$WebSocketUrl, $cts.Token).GetAwaiter().GetResult() | Out-Null
    [pscustomobject]@{ Socket = $socket; Cts = $cts; Token = $cts.Token; NextId = 1 }
}

function Close-CdpSocket($Connection) {
    if ($null -eq $Connection) { return }
    try { $Connection.Socket.Dispose() } catch {}
    try { $Connection.Cts.Dispose() } catch {}
}

function Invoke-CdpExpression($Connection, [string]$Expression, [switch]$AwaitPromise) {
    $id = $Connection.NextId
    $Connection.NextId++
    $params = @{ expression = $Expression; returnByValue = $true }
    if ($AwaitPromise) { $params.awaitPromise = $true }
    $request = @{ id = $id; method = 'Runtime.evaluate'; params = $params } | ConvertTo-Json -Compress -Depth 8
    $bytes = [Text.Encoding]::UTF8.GetBytes($request)
    $Connection.Socket.SendAsync([ArraySegment[byte]]::new($bytes), [Net.WebSockets.WebSocketMessageType]::Text, $true, $Connection.Token).GetAwaiter().GetResult() | Out-Null

    while ($true) {
        $buffer = New-Object byte[] 1048576
        $ms = [IO.MemoryStream]::new()
        do {
            $result = $Connection.Socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), $Connection.Token).GetAwaiter().GetResult()
            if ($result.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { throw 'ChatGPT CDP connection closed unexpectedly.' }
            $ms.Write($buffer, 0, $result.Count)
        } while (-not $result.EndOfMessage)
        $message = [Text.Encoding]::UTF8.GetString($ms.ToArray()) | ConvertFrom-Json
        $idProperty = $message.PSObject.Properties['id']
        if ($idProperty -and [int]$idProperty.Value -eq $id) {
            $exceptionProperty = $message.PSObject.Properties['exceptionDetails']
            if ($exceptionProperty -and $null -ne $exceptionProperty.Value) {
                $details = $exceptionProperty.Value
                $textProperty = $details.PSObject.Properties['text']
                $description = if ($textProperty) { [string]$textProperty.Value } else { 'Unknown Runtime.evaluate error.' }
                throw ('ChatGPT CDP evaluation failed: ' + $description)
            }

            $resultProperty = $message.PSObject.Properties['result']
            if (-not $resultProperty -or $null -eq $resultProperty.Value) {
                throw 'ChatGPT CDP response did not contain a result object.'
            }
            $runtimeResult = $resultProperty.Value
            $innerResultProperty = $runtimeResult.PSObject.Properties['result']
            if (-not $innerResultProperty -or $null -eq $innerResultProperty.Value) {
                throw 'ChatGPT Runtime.evaluate response did not contain a runtime result.'
            }
            return $innerResultProperty.Value
        }
    }
}

function ConvertTo-JsString([string]$Value) {
    return ($Value | ConvertTo-Json -Compress)
}

function Normalize-ChatTitleForIdentity([string]$Value) {
    if ($null -eq $Value) { return '' }
    return ([string]$Value).TrimEnd([char[]]"`r`n")
}

function Test-ChatTitleIdentity([string]$Actual, [string]$Expected) {
    return (Normalize-ChatTitleForIdentity $Actual) -ceq (Normalize-ChatTitleForIdentity $Expected)
}

function Resolve-ChatGPTSidebarItem($Connection, [string]$Title) {
    $titleJson = ConvertTo-JsString $Title
    $expr = @"
(() => {
  const target = $titleJson;
  const rows = [...document.querySelectorAll('[role="button"][aria-label]')]
    .filter(x => x.getAttribute('aria-label') === target);

  // ChatGPT renders the same logical thread twice while a sidebar update is
  // optimistic. Discard only its known duplicate DOM row. Different real
  // threads with the same title must still fail closed.
  const stableRows = rows.filter(row => {
    if (row.getAttribute('data-app-action-sidebar-thread-kind') === 'optimistic') return false;
    const key = Object.keys(row).find(k => k.startsWith('__reactFiber$'));
    let fiber = key ? row[key] : null;
    for (let i = 0; fiber && i < 50; i++, fiber = fiber.return) {
      if (fiber.memoizedProps?.item?.kind === 'optimistic') return false;
    }
    return true;
  });
  const candidates = stableRows.length ? stableRows : rows;
  if (candidates.length !== 1) {
    return JSON.stringify({
      ok: false,
      count: candidates.length,
      error: candidates.length === 0
        ? 'Sidebar item was not found.'
        : 'Multiple distinct sidebar items have the same title.'
    });
  }

  const row = candidates[0];
  const rowThreadKey = row.getAttribute('data-app-action-sidebar-thread-id');
  let kind = row.getAttribute('data-app-action-sidebar-thread-kind');
  let id = null;
  let projectId = null;

  const fiberKey = Object.keys(row).find(k => k.startsWith('__reactFiber$'));
  let fiber = fiberKey ? row[fiberKey] : null;
  for (let i = 0; fiber && i < 50; i++, fiber = fiber.return) {
    const props = fiber.memoizedProps || {};
    if (!id) {
      id = props.conversationId
        || props.conversation?.id
        || props.conversation?.conversation_id
        || props.item?.conversation?.id
        || props.thread?.id
        || props.thread?.conversationId
        || null;
    }
    if (!kind) {
      kind = props.item?.kind
        || (props.hostId === 'local' ? 'local' : null)
        || null;
    }
    if (!projectId) {
      projectId = props.projectId
        || props.hoverCardProjectId
        || null;
    }
  }

  if (!id && rowThreadKey) {
    id = rowThreadKey.includes(':')
      ? rowThreadKey.slice(rowThreadKey.indexOf(':') + 1)
      : rowThreadKey;
  }
  if (!kind) {
    kind = rowThreadKey?.startsWith('local:') ? 'local' : 'server';
  }

  return JSON.stringify({
    ok: !!id,
    title: target,
    kind,
    id,
    threadKey: rowThreadKey,
    projectId,
    error: id ? null : 'Sidebar item did not expose an ID.'
  });
})()
"@

    $result = Invoke-CdpExpression $Connection $expr
    $text = [string]$result.value
    if ([string]::IsNullOrWhiteSpace($text)) { throw 'Sidebar item lookup returned no result.' }
    $item = $text | ConvertFrom-Json
    if (-not $item.ok) { throw ("Sidebar item lookup failed for '$Title': " + $item.error) }
    return $item
}

function Get-SharedFileSha256([string]$Path) {
    $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
    try {
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        } finally {
            $sha.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
}

function Copy-SharedFileVerified([string]$Source, [string]$Destination) {
    $before = Get-SharedFileSha256 $Source
    $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
    $input = [IO.File]::Open($Source, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
    try {
        $output = [IO.File]::Open($Destination, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $input.CopyTo($output)
            $output.Flush($true)
        } finally {
            $output.Dispose()
        }
    } finally {
        $input.Dispose()
    }

    $after = Get-SharedFileSha256 $Source
    $copied = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($before -ne $after -or $after -ne $copied) {
        throw "Source changed while copying or copied hash mismatched: $Source"
    }
    return $copied
}

function Find-CodexWorkSessionFile([string]$ThreadId, [switch]$Archived) {
    $base = if ($Archived) {
        Join-Path $env:USERPROFILE '.codex\archived_sessions'
    } else {
        Join-Path $env:USERPROFILE '.codex\sessions'
    }
    if (-not (Test-Path -LiteralPath $base -PathType Container)) {
        if ($Archived) { return $null }
        throw "Codex sessions directory was not found: $base"
    }

    $hits = @(Get-ChildItem -LiteralPath $base -Recurse -File -Force -Filter "*$ThreadId.jsonl" -ErrorAction SilentlyContinue)
    if ($hits.Count -eq 0) {
        if ($Archived) { return $null }
        throw "Local Work source JSONL was not found for thread: $ThreadId"
    }
    if ($hits.Count -ne 1) {
        throw "Multiple local Work JSONL files were found for thread: $ThreadId"
    }
    return $hits[0].FullName
}

function Test-CodexWorkJsonl([string]$Path, [string]$ExpectedThreadId) {
    $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
    $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $true, 65536, $false)
    $lineCount = 0
    $sessionId = $null
    try {
        while (($line = $reader.ReadLine()) -ne $null) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            $lineCount++
            try {
                $record = $line | ConvertFrom-Json
            } catch {
                throw "Invalid JSONL record at line $lineCount in '$Path'."
            }
            if ($lineCount -eq 1) {
                if ([string]$record.type -ne 'session_meta') {
                    throw "Local Work JSONL first record is not session_meta: $Path"
                }
                $payloadId = $record.payload.PSObject.Properties['id']
                $payloadSessionId = $record.payload.PSObject.Properties['session_id']
                if ($payloadId) { $sessionId = [string]$payloadId.Value }
                elseif ($payloadSessionId) { $sessionId = [string]$payloadSessionId.Value }
                if ($sessionId -ne $ExpectedThreadId) {
                    throw "Local Work JSONL thread ID mismatch. Expected '$ExpectedThreadId', got '$sessionId'."
                }
            }
        }
    } finally {
        $reader.Dispose()
    }
    if ($lineCount -lt 1) { throw "Local Work JSONL is empty: $Path" }
    return [pscustomobject]@{
        ThreadId = $sessionId
        LineCount = $lineCount
    }
}

function Wait-CodexWorkArchivedFile([string]$ThreadId, [string]$OriginalPath, [string]$ExpectedSha256, [int]$TimeoutSeconds = 20) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $archived = Find-CodexWorkSessionFile $ThreadId -Archived
        if ($archived -and -not (Test-Path -LiteralPath $OriginalPath)) {
            $hash = Get-SharedFileSha256 $archived
            if ($hash -ne $ExpectedSha256) {
                throw "Archived Work JSONL hash mismatch for thread: $ThreadId"
            }
            return $archived
        }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)

    throw "Local Work archive did not move the source JSONL into archived_sessions within $TimeoutSeconds seconds."
}

function Resolve-ChatGPTConversationId($Connection, [string]$Title) {
    $titleJson = ConvertTo-JsString $Title
    $expr = @"
(() => {
  const target = $titleJson;
  const found = new Map();
  const add = c => {
    if (!c || c.title !== target) return;
    const id = c.id || c.conversation_id || c.conversationId;
    if (typeof id === 'string' && id) found.set(id, { id, title: c.title });
  };
  const root = window.__codexRoot?._internalRoot?.current;
  if (root) {
    const stack = [root], seen = new Set();
    while (stack.length) {
      const f = stack.pop();
      if (!f || seen.has(f)) continue;
      seen.add(f);
      const p = f.memoizedProps || {};
      add(p.conversation);
      add(p.item?.conversation);
      add(p.thread);
      if (f.child) stack.push(f.child);
      if (f.sibling) stack.push(f.sibling);
    }
  }
  const el = [...document.querySelectorAll('[role=button][aria-label]')].find(x => x.getAttribute('aria-label') === target)
    || [...document.querySelectorAll('*')].find(x => x.children.length === 0 && x.textContent.trim() === target);
  if (el) {
    const fk = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    let f = fk ? el[fk] : null;
    for (let i = 0; f && i < 50; i++, f = f.return) {
      const p = f.memoizedProps || {};
      add(p.conversation);
      add(p.item?.conversation);
      add(p.thread);
    }
  }
  return JSON.stringify([...found.values()]);
})()
"@
    $result = Invoke-CdpExpression $Connection $expr
    $json = [string]$result.value
    if ([string]::IsNullOrWhiteSpace($json)) { throw 'No conversation lookup result was returned.' }
    $parsedMatches = $json | ConvertFrom-Json
    $matches = @($parsedMatches | ForEach-Object { $_ })
    if ($matches.Count -eq 0) { throw "Chat title was not found in the ChatGPT App sidebar: $Title" }
    $ids = @($matches | ForEach-Object {
        $idProperty = $_.PSObject.Properties['id']
        if ($idProperty -and -not [string]::IsNullOrWhiteSpace([string]$idProperty.Value)) {
            [string]$idProperty.Value
        }
    } | Sort-Object -Unique)
    if ($ids.Count -eq 0) { throw "Chat title lookup returned no valid conversation ID: $Title" }
    if ($ids.Count -ne 1) { throw "Multiple conversations have the exact same title. Rename the target chat temporarily or use a unique title: $Title" }
    return $ids[0]
}

function Get-RawChatGPTConversation($Connection, [string]$ConversationId, [string]$ExpectedTitle) {
    $idJson = ConvertTo-JsString $ConversationId
    $expr = @"
import((() => {
  const urls = [
    ...performance.getEntriesByType('resource').map(x => x.name),
    ...[...document.querySelectorAll('script[src],link[href]')].map(x => x.src || x.href)
  ];
  return [...new Set(urls)].find(u => /\/assets\/app-shared-[^/]+\.js(?:$|\?)/.test(u));
})()).then(async m => {
  const api = Object.values(m).find(v => {
    if (!v || typeof v.safeGet !== 'function' || typeof v.getRequestTarget !== 'function') return false;
    const proto = Object.getPrototypeOf(v);
    if (!proto) return false;
    const methods = Object.getOwnPropertyNames(proto);
    return methods.includes('safeGet') && methods.includes('getRequestTarget') && methods.includes('getResponse');
  });
  if (!api) throw new Error('ChatGPT internal API client was not found.');
  try {
    const r = await api.safeGet('/conversation/{conversation_id}', { parameters: { path: { conversation_id: $idJson } }, signal: void 0 });
    window.__chatJsonlBackupRaw = JSON.stringify(r);
    return JSON.stringify({ ok: true, len: window.__chatJsonlBackupRaw.length, id: r.conversation_id || r.id, title: r.title, mappingCount: r.mapping ? Object.keys(r.mapping).length : 0 });
  } catch (e) {
    return JSON.stringify({ ok: false, status: e?.responseStatus || e?.status || null, error: String(e), diagnostic: String(e?.diagnosticError || '') });
  }
})
"@

    $delays = @(0, 20, 60)
    $summary = $null
    for ($attempt = 0; $attempt -lt $delays.Count; $attempt++) {
        if ($delays[$attempt] -gt 0) { Start-Sleep -Seconds $delays[$attempt] }
        $result = Invoke-CdpExpression $Connection $expr -AwaitPromise
        $text = [string]$result.value
        if ([string]::IsNullOrWhiteSpace($text)) { throw 'ChatGPT conversation fetch returned no result.' }
        $summary = $text | ConvertFrom-Json
        if ($summary.ok) { break }
        if ([int]$summary.status -ne 429) { throw ('ChatGPT conversation fetch failed: ' + $summary.error) }
    }
    if (-not $summary.ok) { throw 'ChatGPT rate limit remained active after retries. Wait a minute and retry.' }
    if ([string]$summary.id -ne $ConversationId) { throw 'Conversation ID mismatch returned by ChatGPT.' }
    if (-not (Test-ChatTitleIdentity ([string]$summary.title) $ExpectedTitle)) { throw "Conversation title mismatch. Expected '$ExpectedTitle', got '$($summary.title)'." }
    if ([int]$summary.mappingCount -lt 1) { throw 'Conversation mapping is empty.' }

    $total = [int]$summary.len
    $chunkSize = 350000
    $builder = [Text.StringBuilder]::new($total)
    for ($offset = 0; $offset -lt $total; $offset += $chunkSize) {
        $end = [Math]::Min($offset + $chunkSize, $total)
        $chunkResult = Invoke-CdpExpression $Connection ("window.__chatJsonlBackupRaw.slice($offset,$end)")
        $chunk = [string]$chunkResult.value
        if ($chunk.Length -ne ($end - $offset)) { throw "Conversation chunk length mismatch at offset $offset." }
        [void]$builder.Append($chunk)
    }
    $raw = $builder.ToString()
    $null = Invoke-CdpExpression $Connection 'delete window.__chatJsonlBackupRaw; true'
    if ($raw.Length -ne $total) { throw 'Conversation payload assembly failed.' }
    return $raw
}

function Invoke-ChatGPTNativeServerArchive($Connection, [string]$ConversationId) {
    $idJson = ConvertTo-JsString $ConversationId
    $expr = @"
(async () => {
  const targetId = $idJson;
  try {
    const resourceUrls = [
      ...performance.getEntriesByType('resource').map(x => x.name),
      ...[...document.querySelectorAll('script[src],link[href]')].map(x => x.src || x.href)
    ];
    const uniqueUrls = [...new Set(resourceUrls)];
    const sharedUrl = uniqueUrls.find(u => /\/assets\/app-shared-[^/]+\.js(?:$|\?)/.test(u));
    const initialUrl = uniqueUrls.find(u => /\/assets\/app-initial-[^/]+\.js(?:$|\?)/.test(u));

    if (!sharedUrl) throw new Error('ChatGPT app-shared asset was not found.');
    if (!initialUrl) throw new Error('ChatGPT app-initial asset was not found.');

    const shared = await import(sharedUrl);
    const app = await import(initialUrl);
    const api = shared.hvt || Object.values(shared).find(v => {
      if (!v || typeof v.safeGet !== 'function' || typeof v.safePatch !== 'function') return false;
      const proto = Object.getPrototypeOf(v);
      return proto && Object.getOwnPropertyNames(proto).includes('getResponse');
    });
    if (!api) throw new Error('ChatGPT internal API client was not found.');

    const archiveWrapper = app.Zj || Object.values(app).find(v => {
      if (typeof v !== 'function') return false;
      let source = '';
      try { source = v.toString(); } catch {}
      return source.includes('onArchiveSuccess') &&
             source.includes('onArchiveUndoSuccess') &&
             source.includes('archive-chatgpt-conversation');
    });
    if (typeof archiveWrapper !== 'function') {
      throw new Error('ChatGPT native archive wrapper was not found.');
    }

    let archiveSource = '';
    try { archiveSource = archiveWrapper.toString(); } catch {}
    if (!archiveSource.includes('onArchiveSuccess') ||
        !archiveSource.includes('archive-chatgpt-conversation')) {
      throw new Error('ChatGPT native archive wrapper identity verification failed.');
    }

    const root = window.__codexRoot?._internalRoot?.current;
    if (!root) throw new Error('ChatGPT React root was not found.');

    let stateScope = null;
    const seenObjects = new WeakSet();
    const inspectObject = (value, depth) => {
      if (stateScope || !value || typeof value !== 'object' || seenObjects.has(value) || depth > 4) return;
      seenObjects.add(value);
      try {
        if (typeof value.get === 'function' &&
            typeof value.set === 'function' &&
            value.queryClient) {
          stateScope = value;
          return;
        }
      } catch {}

      let keys = [];
      try { keys = Object.keys(value).slice(0, 40); } catch {}
      for (const key of keys) {
        let child;
        try { child = value[key]; } catch { continue; }
        if (child && typeof child === 'object') inspectObject(child, depth + 1);
        if (stateScope) return;
      }
    };

    const stack = [root];
    const seenFibers = new Set();
    while (stack.length && !stateScope && seenFibers.size < 2500) {
      const fiber = stack.pop();
      if (!fiber || seenFibers.has(fiber)) continue;
      seenFibers.add(fiber);
      inspectObject(fiber.memoizedState, 0);
      inspectObject(fiber.memoizedProps, 0);
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
    }
    if (!stateScope) throw new Error('ChatGPT application state scope was not found.');

    const before = await api.safeGet('/conversation/{conversation_id}', {
      parameters: { path: { conversation_id: targetId } },
      signal: void 0
    });
    if (before?.is_archived === true) {
      throw new Error('Conversation is already archived before the native archive transition.');
    }

    let callbackState = 'pending';
    let callbackError = null;

    try {
      await new Promise(resolve => {
        let settled = false;
        archiveWrapper(stateScope, targetId, {
          onArchiveSuccess: () => {
            if (!settled) {
              settled = true;
              callbackState = 'success';
              resolve();
            }
          },
          onArchiveUndoSuccess: () => {}
        });
        setTimeout(() => {
          if (!settled) {
            settled = true;
            callbackState = 'timeout';
            resolve();
          }
        }, 12000);
      });
    } catch (e) {
      callbackState = 'throw';
      callbackError = String(e);
    }

    const after = await api.safeGet('/conversation/{conversation_id}', {
      parameters: { path: { conversation_id: targetId } },
      signal: void 0
    });
    const archived = after?.is_archived === true;

    return JSON.stringify({
      ok: callbackState === 'success' && archived,
      callbackState,
      callbackError,
      archived,
      changed: archived,
      id: after?.conversation_id || after?.id || targetId,
      title: after?.title || null,
      projectId: after?.gizmo_id || before?.gizmo_id || null
    });
  } catch (e) {
    return JSON.stringify({
      ok: false,
      status: e?.responseStatus || e?.status || null,
      errorCode: e?.errorCode || null,
      error: String(e)
    });
  }
})()
"@

    $result = Invoke-CdpExpression $Connection $expr -AwaitPromise
    $text = [string]$result.value
    if ([string]::IsNullOrWhiteSpace($text)) {
        throw 'ChatGPT native archive operation returned no result.'
    }
    $state = $text | ConvertFrom-Json
    if (-not $state.ok) {
        throw ('ChatGPT native archive operation failed: ' + $state.error)
    }
    if (-not [bool]$state.archived) {
        throw 'ChatGPT native archive verification returned archived=false.'
    }
    return $state
}

function Wait-ChatGPTSidebarItemRemoved($Connection, [string]$Title, [int]$TimeoutSeconds = 15) {
    $titleJson = ConvertTo-JsString $Title
    $timeoutMs = [Math]::Max(1000, $TimeoutSeconds * 1000)
    $expr = @"
(async () => {
  const target = $titleJson;
  const timeoutMs = $timeoutMs;
  const findRow = () => [...document.querySelectorAll('[role="button"][aria-label]')]
    .find(x => x.getAttribute('aria-label') === target);

  const visibleBefore = !!findRow();
  if (!visibleBefore) {
    return JSON.stringify({ ok: true, removed: true, visibleBefore: false, waitMs: 0 });
  }

  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (!findRow()) {
      return JSON.stringify({
        ok: true,
        removed: true,
        visibleBefore: true,
        waitMs: Math.round(performance.now() - started)
      });
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  window.dispatchEvent(new Event('focus'));
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('online'));

  for (let i = 0; i < 30; i++) {
    if (!findRow()) {
      return JSON.stringify({
        ok: true,
        removed: true,
        visibleBefore: true,
        usedRevalidationEvents: true,
        waitMs: Math.round(performance.now() - started)
      });
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return JSON.stringify({
    ok: false,
    removed: false,
    visibleBefore: true,
    waitMs: Math.round(performance.now() - started),
    error: 'Archived conversation is still visible in the regular ChatGPT sidebar.'
  });
})()
"@

    $result = Invoke-CdpExpression $Connection $expr -AwaitPromise
    $text = [string]$result.value
    if ([string]::IsNullOrWhiteSpace($text)) {
        throw 'ChatGPT sidebar-removal verification returned no result.'
    }
    $state = $text | ConvertFrom-Json
    if (-not $state.ok -or -not $state.removed) {
        throw ('ChatGPT sidebar-removal verification failed: ' + $state.error)
    }
    return $state
}

function Get-ChatGPTArchivedListMembershipSnapshot(
    $Connection,
    [string]$ConversationId
) {
    $idJson = ConvertTo-JsString $ConversationId
    $expr = @"
import((() => {
  const urls = [
    ...performance.getEntriesByType('resource').map(x => x.name),
    ...[...document.querySelectorAll('script[src],link[href]')].map(x => x.src || x.href)
  ];
  return [...new Set(urls)].find(u => /\/assets\/app-shared-[^/]+\.js(?:$|\?)/.test(u));
})()).then(async m => {
  const api = m.hvt || Object.values(m).find(v => {
    if (!v || typeof v.safeGet !== 'function') return false;
    const proto = Object.getPrototypeOf(v);
    return proto && Object.getOwnPropertyNames(proto).includes('getResponse');
  });
  if (!api) throw new Error('ChatGPT internal API client was not found.');

  try {
    const targetId = $idJson;
    const seenIds = new Set();
    let exact = null;
    let pages = 0;
    let lastTotal = null;

    for (let offset = 0; offset < 500; offset += 100) {
      const r = await api.safeGet('/conversations', {
        parameters: {
          query: {
            hide_snorlax: false,
            is_archived: true,
            limit: 100,
            offset,
            order: 'updated'
          }
        },
        signal: void 0
      });

      pages++;
      lastTotal = Number.isFinite(r?.total) ? r.total : lastTotal;
      const items = Array.isArray(r?.items) ? r.items : [];

      for (const item of items) {
        const id = item?.id || item?.conversation_id || null;
        if (id) seenIds.add(id);
        if (id === targetId && item?.is_archived === true) {
          exact = item;
          break;
        }
      }

      if (exact) break;
      if (items.length === 0 || items.length < 100) break;
      if (Number.isFinite(lastTotal) && offset + items.length >= lastTotal) break;
    }

    return JSON.stringify({
      ok: true,
      present: !!exact,
      pages,
      scanned: seenIds.size,
      total: lastTotal,
      item: exact ? {
        id: exact.id || exact.conversation_id,
        title: exact.title || null,
        is_archived: exact.is_archived === true,
        gizmo_id: exact.gizmo_id || null,
        workspace_id: exact.workspace_id || null,
        update_time: exact.update_time ?? null
      } : null
    });
  } catch (e) {
    return JSON.stringify({
      ok: false,
      status: e?.responseStatus || e?.status || null,
      errorCode: e?.errorCode || null,
      error: String(e)
    });
  }
})
"@

    $result = Invoke-CdpExpression $Connection $expr -AwaitPromise
    $text = [string]$result.value
    if ([string]::IsNullOrWhiteSpace($text)) {
        throw 'Archived-list snapshot returned no result.'
    }

    return ($text | ConvertFrom-Json)
}

function Restore-ChatGPTServerConversationActive(
    $Connection,
    [string]$ConversationId,
    [string]$ProjectId
) {
    $idJson = ConvertTo-JsString $ConversationId
    $projectJson = ConvertTo-JsString $ProjectId

    $expr = @"
(async () => {
  const targetId = $idJson;
  const expectedProjectId = $projectJson || null;

  const urls = [
    ...performance.getEntriesByType('resource').map(x => x.name),
    ...[...document.querySelectorAll('script[src],link[href]')].map(x => x.src || x.href)
  ];
  const sharedUrl = [...new Set(urls)].find(u => /\/assets\/app-shared-[^/]+\.js(?:$|\?)/.test(u));
  if (!sharedUrl) throw new Error('ChatGPT shared App module was not found.');

  const shared = await import(sharedUrl);
  const api = shared.hvt || Object.values(shared).find(v => {
    if (!v || typeof v.safeGet !== 'function' || typeof v.safePatch !== 'function') return false;
    const proto = Object.getPrototypeOf(v);
    return proto && Object.getOwnPropertyNames(proto).includes('getResponse');
  });
  if (!api) throw new Error('ChatGPT internal API client was not found.');

  try {
    await api.safePatch('/conversation/{conversation_id}', {
      parameters: { path: { conversation_id: targetId } },
      requestBody: { is_archived: false },
      signal: void 0
    });

    if (expectedProjectId) {
      await api.safePatch('/conversation/{conversation_id}', {
        parameters: { path: { conversation_id: targetId } },
        requestBody: { gizmo_id: expectedProjectId },
        signal: void 0
      });
    }

    const detail = await api.safeGet('/conversation/{conversation_id}', {
      parameters: { path: { conversation_id: targetId } },
      signal: void 0
    });
    if (detail?.is_archived === true) {
      throw new Error('Rollback verification returned archived=true.');
    }

    let projectFound = expectedProjectId == null;
    let projectPages = 0;

    if (expectedProjectId) {
      const verifyProject = async () => {
        let cursor = null;
        let pages = 0;
        do {
          const page = await api.safeGet('/gizmos/{gizmo_id}/conversations', {
            parameters: {
              path: { gizmo_id: expectedProjectId },
              query: { cursor, limit: 50, owned_only: false }
            },
            signal: void 0
          });
          const items = Array.isArray(page?.items) ? page.items : [];
          pages++;
          if (items.some(x => x?.id === targetId)) {
            return { found: true, pages };
          }
          cursor = page?.cursor ?? null;
        } while (cursor && pages < 20);
        return { found: false, pages };
      };

      let projectState = await verifyProject();
      projectPages += projectState.pages;
      projectFound = projectState.found;

      if (!projectFound) {
        await api.safePatch('/conversation/{conversation_id}', {
          parameters: { path: { conversation_id: targetId } },
          requestBody: { gizmo_id: expectedProjectId },
          signal: void 0
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
        projectState = await verifyProject();
        projectPages += projectState.pages;
        projectFound = projectState.found;
      }

      if (!projectFound) {
        throw new Error('Rollback did not restore Project collection membership.');
      }
    }

    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));

    return JSON.stringify({
      ok: true,
      archived: false,
      projectId: detail?.gizmo_id || null,
      projectFound,
      projectPages,
      id: detail?.conversation_id || detail?.id || targetId,
      title: detail?.title || null
    });
  } catch (e) {
    return JSON.stringify({
      ok: false,
      status: e?.responseStatus || e?.status || null,
      errorCode: e?.errorCode || null,
      error: String(e)
    });
  }
})()
"@

    $result = Invoke-CdpExpression $Connection $expr -AwaitPromise
    $text = [string]$result.value
    if ([string]::IsNullOrWhiteSpace($text)) {
        throw 'Server Chat rollback returned no result.'
    }

    $state = $text | ConvertFrom-Json
    if (-not $state.ok -or [bool]$state.archived) {
        throw ('Server Chat rollback failed: ' + $state.error)
    }

    return $state
}

function Sync-ChatGPTSidebarAfterArchive($Connection, [string]$Title) {
    $titleJson = ConvertTo-JsString $Title
    $expr = @"
(async () => {
  const target = $titleJson;
  const findRow = () => [...document.querySelectorAll('[role="button"][aria-label]')]
    .find(x => x.getAttribute('aria-label') === target);

  const row = findRow();
  if (!row) {
    return JSON.stringify({ ok: true, removed: true, visibleBefore: false, waitMs: 0 });
  }

  const fiberKey = Object.keys(row).find(k => k.startsWith('__reactFiber$'));
  let fiber = fiberKey ? row[fiberKey] : null;
  let onArchive = null;
  for (let i = 0; fiber && i < 30; i++, fiber = fiber.return) {
    const props = fiber.memoizedProps || {};
    if (typeof props.onArchive === 'function') {
      onArchive = props.onArchive;
      break;
    }
  }

  if (onArchive) {
    onArchive();
  }

  let waitMs = 0;
  for (let i = 0; i < 200; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    waitMs = (i + 1) * 100;
    if (!findRow()) {
      return JSON.stringify({
        ok: true,
        removed: true,
        visibleBefore: true,
        usedNativeArchiveHandler: !!onArchive,
        waitMs
      });
    }
  }

  // Ask the App's client-side data layer to revalidate without a full page reload.
  window.dispatchEvent(new Event('focus'));
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('online'));

  for (let i = 0; i < 50; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    waitMs += 100;
    if (!findRow()) {
      return JSON.stringify({
        ok: true,
        removed: true,
        visibleBefore: true,
        usedNativeArchiveHandler: !!onArchive,
        usedRevalidationEvents: true,
        waitMs
      });
    }
  }

  return JSON.stringify({
    ok: false,
    removed: false,
    visibleBefore: true,
    usedNativeArchiveHandler: !!onArchive,
    waitMs,
    error: 'Archived conversation is still visible in the ChatGPT sidebar.'
  });
})()
"@

    $result = Invoke-CdpExpression $Connection $expr -AwaitPromise
    $text = [string]$result.value
    if ([string]::IsNullOrWhiteSpace($text)) { throw 'ChatGPT sidebar synchronization returned no result.' }
    $state = $text | ConvertFrom-Json
    if (-not $state.ok -or -not $state.removed) {
        throw ('ChatGPT sidebar synchronization failed: ' + $state.error)
    }
    return $state
}

function ConvertTo-SafeWindowsFileName([string]$Name) {
    $safe = $Name
    foreach ($ch in [IO.Path]::GetInvalidFileNameChars()) { $safe = $safe.Replace([string]$ch, '_') }
    $safe = $safe.Trim().TrimEnd('.')
    if ([string]::IsNullOrWhiteSpace($safe)) { throw 'Chat title cannot be converted to a valid file name.' }
    return $safe
}

function Get-Sha256([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-ChatGPTSnapshotState($Conversation) {
    # Follow only the active server branch. JSON validity and rendering are
    # not proof that the newest user turn has received a completed final.
    $mapping = $Conversation.mapping
    $nodeId = [string]$Conversation.current_node
    if (-not $nodeId -or -not $mapping) {
        return [pscustomobject]@{ Status = 'unknown'; LatestUserTurnCompleted = $false }
    }
    $visited = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $sawLatestUser = $false
    $completedFinalAfterUser = $false
    $count = 0
    while ($nodeId -and $count -lt 100000 -and $visited.Add($nodeId)) {
        $record = $mapping.PSObject.Properties[$nodeId]
        if (-not $record) { break }
        $node = $record.Value
        $message = $node.message
        if ($message -and $message.author) {
            $role = [string]$message.author.role
            if ($role -eq 'user') {
                $sawLatestUser = $true
                break
            }
            if ($role -eq 'assistant' -and $message.channel -eq 'final' -and $message.status -eq 'finished_successfully' -and (-not $message.recipient -or $message.recipient -eq 'all')) {
                $completedFinalAfterUser = $true
            }
        }
        $nodeId = [string]$node.parent
        $count++
    }
    $status = if (-not $sawLatestUser) { 'unknown' }
              elseif ($completedFinalAfterUser) { 'complete-through-latest-user' }
              else { 'latest-user-turn-not-finished' }
    return [pscustomobject]@{
        Status = $status
        LatestUserTurnCompleted = ($sawLatestUser -and $completedFinalAfterUser)
    }
}

function Backup-ChatGPTConversation {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Title,
        [Parameter(Mandatory)][string]$OutputDirectory,
        [switch]$ArchiveAfterBackup
    )

    $Title = $Title.Trim()
    if (-not $Title) { throw 'Chat / Work title is required.' }
    if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) {
        throw "Output directory does not exist: $OutputDirectory"
    }

    # Chat/Work archives are durable private data, never disposable SPARK log output.
    $projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
    $disposableRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'log')).TrimEnd('\','/')
    $resolvedOutput = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\','/')
    if ($resolvedOutput -ieq $disposableRoot -or
        $resolvedOutput.StartsWith(($disposableRoot + '\'), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'A Chat/Work backup cannot be stored in disposable SPARK log/. Choose the SPARK per-user application data directory (LOCALAPPDATA/SPARK/chatlog) or another permanent approved directory.'
    }
    $outputAttributes = [IO.File]::GetAttributes($OutputDirectory)
    if (($outputAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Backup OutputDirectory must not be a filesystem junction or symlink.'
    }

    $target = Join-Path $OutputDirectory ((ConvertTo-SafeWindowsFileName $Title) + '.jsonl')
    $backup = $null
    $backupVerified = $false

    if (Test-Path -LiteralPath $target) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $backup = "$target.bak.$stamp"
        Copy-Item -LiteralPath $target -Destination $backup -ErrorAction Stop
        if ((Get-Sha256 $target) -ne (Get-Sha256 $backup)) {
            Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
            throw 'Pre-overwrite backup verification failed.'
        }
    }

    $connection = $null
    try {
        $app = Get-ChatGPTAppTarget
        $connection = New-CdpSocket $app.WebSocketUrl 300
        $item = Resolve-ChatGPTSidebarItem $connection $Title
        $itemKind = [string]$item.kind

        if ($itemKind -eq 'local') {
            $threadId = [string]$item.id
            $sourcePath = Find-CodexWorkSessionFile $threadId
            $sourceCheck = Test-CodexWorkJsonl $sourcePath $threadId

            $tmp = "$target.tmp.$([guid]::NewGuid().ToString('N'))"
            try {
                $sourceHash = Copy-SharedFileVerified $sourcePath $tmp
                $tmpCheck = Test-CodexWorkJsonl $tmp $threadId
                if ($tmpCheck.ThreadId -ne $threadId -or $tmpCheck.LineCount -ne $sourceCheck.LineCount) {
                    throw 'Temporary Work backup verification failed.'
                }

                if (Test-Path -LiteralPath $target) {
                    Remove-Item -LiteralPath $target -Force
                }
                Move-Item -LiteralPath $tmp -Destination $target

                $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
                if ($hash -ne $sourceHash) { throw 'Final Work backup SHA-256 verification failed.' }

                $verify = Test-CodexWorkJsonl $target $threadId
                if ($verify.ThreadId -ne $threadId -or $verify.LineCount -ne $sourceCheck.LineCount) {
                    throw 'Final Work backup JSONL verification failed.'
                }
                $backupVerified = $true
            } finally {
                if (Test-Path -LiteralPath $tmp) {
                    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
                }
            }

            $archivedAfterBackup = $false
            $archiveChanged = $false
            $sidebarRemovedAfterBackup = $false
            $sidebarSyncWaitMs = 0
            $archivedSourcePath = $null

            if ($ArchiveAfterBackup) {
                try {
                    $sidebarState = Sync-ChatGPTSidebarAfterArchive $connection $Title
                    $sidebarRemovedAfterBackup = [bool]$sidebarState.removed
                    if ($sidebarState.PSObject.Properties['waitMs']) {
                        $sidebarSyncWaitMs = [int]$sidebarState.waitMs
                    }

                    $archivedSourcePath = Wait-CodexWorkArchivedFile $threadId $sourcePath $hash 20
                    $archivedAfterBackup = $true
                    $archiveChanged = $true
                } catch {
                    $archiveError = $_.Exception.Message
                    throw "Work backup is safely stored at '$target', but Work archive verification failed. The original raw Work backup is preserved. Error: $archiveError"
                }
            }

            return [pscustomobject]@{
                Path = $target
                BackupOfPrevious = $backup
                Title = $Title
                ItemKind = 'local'
                ConversationId = $threadId
                MappingCount = $null
                SnapshotStatus = 'work-source-file-copied'
                LatestUserTurnCompleted = $null
                RecordCount = $verify.LineCount
                Bytes = (Get-Item -LiteralPath $target).Length
                Sha256 = $hash
                SourcePath = $sourcePath
                ArchivedSourcePath = $archivedSourcePath
                ArchiveRequested = [bool]$ArchiveAfterBackup
                ArchivedAfterBackup = $archivedAfterBackup
                ArchiveChanged = $archiveChanged
                SidebarRemovedAfterBackup = $sidebarRemovedAfterBackup
                SidebarSyncWaitMs = $sidebarSyncWaitMs
            }
        }

        $conversationId = [string]$item.id
        if ([string]::IsNullOrWhiteSpace($conversationId)) {
            $conversationId = Resolve-ChatGPTConversationId $connection $Title
        }

        $raw = Get-RawChatGPTConversation $connection $conversationId $Title
        $obj = $raw | ConvertFrom-Json
        if (-not (Test-ChatTitleIdentity ([string]$obj.title) $Title)) { throw 'Raw conversation validation failed before writing.' }
        $mapCount = @($obj.mapping.PSObject.Properties).Count
        if ($mapCount -lt 1) { throw 'Raw conversation mapping is empty.' }

        $tmp = "$target.tmp.$([guid]::NewGuid().ToString('N'))"
        $utf8 = [Text.UTF8Encoding]::new($false)
        [IO.File]::WriteAllText($tmp, $raw, $utf8)
        $check = [IO.File]::ReadAllText($tmp, [Text.Encoding]::UTF8) | ConvertFrom-Json
        if (-not (Test-ChatTitleIdentity ([string]$check.title) $Title) -or [string]$check.conversation_id -ne $conversationId) {
            Remove-Item -LiteralPath $tmp -Force
            throw 'Temporary backup file verification failed.'
        }

        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
        Move-Item -LiteralPath $tmp -Destination $target
        $hash = Get-Sha256 $target
        $verify = [IO.File]::ReadAllText($target, [Text.Encoding]::UTF8) | ConvertFrom-Json
        if (-not (Test-ChatTitleIdentity ([string]$verify.title) $Title) -or [string]$verify.conversation_id -ne $conversationId) {
            throw 'Final backup verification failed.'
        }
        if ((Get-Sha256 $target) -ne $hash) { throw 'Final backup SHA-256 verification failed.' }
        $backupVerified = $true
        $snapshot = Get-ChatGPTSnapshotState $verify

        $archivedAfterBackup = $false
        $archiveChanged = $false
        $sidebarRemovedAfterBackup = $false
        $sidebarSyncWaitMs = 0
        $archivedListVerified = $false
        $archiveVerificationDeferred = $false
        $archivedListVerificationStatus = 'not-requested'
        $archivedListVerificationError = $null
        $projectId = [string]$verify.gizmo_id

        if ($ArchiveAfterBackup) {
            try {
                $archiveState = Invoke-ChatGPTNativeServerArchive $connection $conversationId
                $archivedAfterBackup = [bool]$archiveState.archived
                $archiveChanged = [bool]$archiveState.changed
            } catch {
                $archiveError = $_.Exception.Message
                try {
                    $rollbackState = Restore-ChatGPTServerConversationActive $connection $conversationId $projectId
                    if ([bool]$rollbackState.archived) {
                        throw 'Server Chat rollback verification returned archived=true.'
                    }
                } catch {
                    throw "Backup is safely stored at '$target', but native Archive failed and rollback could not be verified. Archive error: $archiveError; rollback error: $($_.Exception.Message)"
                }
                throw "Backup is safely stored at '$target'. Native Archive failed, and the conversation was restored to the active state. Error: $archiveError"
            }

            try {
                $sidebarState = Wait-ChatGPTSidebarItemRemoved $connection $Title 15
                $sidebarRemovedAfterBackup = [bool]$sidebarState.removed
                if ($sidebarState.PSObject.Properties['waitMs']) {
                    $sidebarSyncWaitMs = [int]$sidebarState.waitMs
                }
            } catch {
                $archiveVerificationDeferred = $true
                $archivedListVerificationStatus = 'sidebar-verification-deferred'
                $archivedListVerificationError = $_.Exception.Message
            }

            try {
                $listState = Get-ChatGPTArchivedListMembershipSnapshot $connection $conversationId
                if ($listState.ok) {
                    $archivedListVerified = [bool]$listState.present
                    if ($archivedListVerified) {
                        $archivedListVerificationStatus = 'verified'
                    } else {
                        $archiveVerificationDeferred = $true
                        $archivedListVerificationStatus = 'not-found-yet'
                    }
                } else {
                    $archiveVerificationDeferred = $true
                    if ([int]$listState.status -eq 429) {
                        $archivedListVerificationStatus = 'rate-limited'
                    } else {
                        $archivedListVerificationStatus = 'unavailable'
                    }
                    $archivedListVerificationError = [string]$listState.error
                }
            } catch {
                $archiveVerificationDeferred = $true
                $archivedListVerificationStatus = 'unavailable'
                $archivedListVerificationError = $_.Exception.Message
            }
        }

        return [pscustomobject]@{
            Path = $target
            BackupOfPrevious = $backup
            Title = $Title
            ItemKind = 'server'
            ConversationId = $conversationId
            MappingCount = @($verify.mapping.PSObject.Properties).Count
            SnapshotStatus = [string]$snapshot.Status
            LatestUserTurnCompleted = [bool]$snapshot.LatestUserTurnCompleted
            RecordCount = $null
            Bytes = (Get-Item -LiteralPath $target).Length
            Sha256 = $hash
            SourcePath = $null
            ArchivedSourcePath = $null
            ArchiveRequested = [bool]$ArchiveAfterBackup
            ArchivedAfterBackup = $archivedAfterBackup
            ArchiveChanged = $archiveChanged
            SidebarRemovedAfterBackup = $sidebarRemovedAfterBackup
            SidebarSyncWaitMs = $sidebarSyncWaitMs
            ArchivedListVerified = $archivedListVerified
            ArchiveVerificationDeferred = $archiveVerificationDeferred
            ArchivedListVerificationStatus = $archivedListVerificationStatus
            ArchivedListVerificationError = $archivedListVerificationError
        }
    } catch {
        if (-not $backupVerified -and $backup -and (Test-Path -LiteralPath $backup)) {
            try {
                if (Test-Path -LiteralPath $target) {
                    Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
                }
                Copy-Item -LiteralPath $backup -Destination $target -Force -ErrorAction Stop
                if ((Get-Sha256 $target) -ne (Get-Sha256 $backup)) {
                    throw 'Rollback verification failed.'
                }
            } catch {
                throw "Backup failed and rollback also failed: $($_.Exception.Message)"
            }
        }
        throw
    } finally {
        Close-CdpSocket $connection
    }
}

Export-ModuleMember -Function Backup-ChatGPTConversation