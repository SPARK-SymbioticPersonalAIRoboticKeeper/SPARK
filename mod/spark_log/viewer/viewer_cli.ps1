param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$InputFile,
    [switch]$Headless
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-FreeTcpPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    try { return ([Net.IPEndPoint]$listener.LocalEndpoint).Port }
    finally { $listener.Stop() }
}

function Get-DefaultBrowserPath {
    # Use the user's actual Windows default for HTTPS rather than hardcoding
    # Microsoft Edge. Reading UserChoice/ClassesRoot is non-mutating.
    $association = 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice'
    $choice = Get-ItemProperty -LiteralPath $association -ErrorAction Stop
    $progId = [string]$choice.ProgId
    if ([string]::IsNullOrWhiteSpace($progId)) { throw 'Windows has no configured default HTTPS browser.' }

    $key = [Microsoft.Win32.Registry]::ClassesRoot.OpenSubKey("$progId\shell\open\command")
    if (-not $key) { throw "Default browser registry command is missing for $progId." }
    try { $launch = [string]$key.GetValue('') }
    finally { $key.Dispose() }

    $match = [regex]::Match($launch, '^\s*"([^"]+\.exe)"')
    if (-not $match.Success) {
        $match = [regex]::Match($launch, '^\s*(\S+\.exe)\b')
    }
    if (-not $match.Success) { throw "Cannot resolve default browser executable for $progId." }
    $exe = [Environment]::ExpandEnvironmentVariables([string]$match.Groups[1].Value)
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
        throw "Configured default browser executable does not exist: $exe"
    }

    $binary = [IO.Path]::GetFileName($exe).ToLowerInvariant()
    if ($binary -notin @('brave.exe', 'chrome.exe', 'msedge.exe', 'chromium.exe', 'vivaldi.exe', 'opera.exe')) {
        throw "Default browser $progId does not support Chromium CDP file auto-selection. Use chatlog -v without -InputFile to open the default browser and choose the file manually."
    }
    return [pscustomobject]@{ Path = $exe; ProgId = $progId }
}

function ConvertTo-FileUrl([string]$Path) {
    return ([Uri]$Path).AbsoluteUri
}

function New-CdpConnection([string]$WebSocketUrl, [int]$TimeoutSeconds = 20) {
    $socket = [Net.WebSockets.ClientWebSocket]::new()
    $cts = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($TimeoutSeconds))
    $socket.ConnectAsync([Uri]$WebSocketUrl, $cts.Token).GetAwaiter().GetResult() | Out-Null
    return [pscustomobject]@{ Socket = $socket; Cts = $cts; Token = $cts.Token; NextId = 1 }
}

function Close-CdpConnection($Connection) {
    if ($null -eq $Connection) { return }
    try { $Connection.Socket.Dispose() } catch {}
    try { $Connection.Cts.Dispose() } catch {}
}

function Invoke-Cdp($Connection, [string]$Method, [hashtable]$Params = @{}) {
    $id = $Connection.NextId
    $Connection.NextId++
    $payload = @{ id = $id; method = $Method; params = $Params } | ConvertTo-Json -Compress -Depth 12
    $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
    $Connection.Socket.SendAsync(
        [ArraySegment[byte]]::new($bytes),
        [Net.WebSockets.WebSocketMessageType]::Text,
        $true,
        $Connection.Token
    ).GetAwaiter().GetResult() | Out-Null

    while ($true) {
        $buffer = New-Object byte[] 1048576
        $stream = [IO.MemoryStream]::new()
        do {
            $result = $Connection.Socket.ReceiveAsync(
                [ArraySegment[byte]]::new($buffer),
                $Connection.Token
            ).GetAwaiter().GetResult()
            if ($result.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) {
                throw 'Browser CDP connection closed unexpectedly.'
            }
            $stream.Write($buffer, 0, $result.Count)
        } while (-not $result.EndOfMessage)

        $message = [Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
        $idProp = $message.PSObject.Properties['id']
        if ($idProp -and [int]$idProp.Value -eq $id) {
            $errorProp = $message.PSObject.Properties['error']
            if ($errorProp -and $null -ne $errorProp.Value) {
                throw ('Browser CDP error: ' + ($errorProp.Value | ConvertTo-Json -Compress))
            }
            return $message.result
        }
    }
}

$resolved = (Resolve-Path -LiteralPath $InputFile).Path
if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
    throw "Input file does not exist: $InputFile"
}
if ([IO.Path]::GetExtension($resolved) -notin @('.json', '.jsonl')) {
    throw 'Viewer input must be .json or .jsonl.'
}

$viewerRoot = $PSScriptRoot
$indexPath = Join-Path $viewerRoot 'index.html'
if (-not (Test-Path -LiteralPath $indexPath -PathType Leaf)) {
    throw "Viewer index was not found: $indexPath"
}

# Use the existing OS temporary directory, not a new project root/test folder.
$tmpRoot = [IO.Path]::GetTempPath()
if (-not(Test-Path -LiteralPath $tmpRoot -PathType Container)) { throw 'Operating system temporary directory does not exist.' }
# Resolve before creating a temporary browser profile, so failure does not
# leave orphaned directories. Use the default browser's executable for this
# isolated local-file Viewer session, not the user's active browser profile.
$browser = Get-DefaultBrowserPath
$profile = Join-Path $tmpRoot ('chatlog-viewer-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $profile | Out-Null

$port = Get-FreeTcpPort
$url = ConvertTo-FileUrl $indexPath

$browserArgs = @(
    "--remote-debugging-port=$port",
    '--remote-debugging-address=127.0.0.1',
    "--user-data-dir=$profile",
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window'
)
if ($Headless) { $browserArgs += '--headless=new' }
$browserArgs += $url

Write-Output ("VIEWER_DEFAULT_BROWSER=" + $browser.ProgId + " executable=" + [IO.Path]::GetFileName($browser.Path))
$process = Start-Process -FilePath $browser.Path -ArgumentList $browserArgs -PassThru
$connection = $null

try {
    $target = $null
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline) {
        try {
            $targets = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/json" -TimeoutSec 2).Content | ConvertFrom-Json
            $target = $targets | Where-Object {
                $_.type -eq 'page' -and $_.url -like 'file:///*index.html*'
            } | Select-Object -First 1
            if ($target) { break }
        } catch {}
        Start-Sleep -Milliseconds 200
    }
    if (-not $target) { throw 'Viewer browser target did not become ready.' }

    $connection = New-CdpConnection ([string]$target.webSocketDebuggerUrl) 120

    # Electron/Edge can replace the DOM while scripts initialize. A nodeId
    # returned by DOM.getDocument becomes invalid on the next navigation.
    # Evaluate the actual input element and hand its remote objectId to CDP;
    # retry on a transient navigation instead of failing or picking another
    # conversation file. Never interact with the user's ChatGPT application.
    $fileSelected = $false
    $lastInputError = $null
    $inputDeadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $inputDeadline) {
        try {
            $element = Invoke-Cdp $connection 'Runtime.evaluate' @{
                expression = "document.querySelector('#fileInput')"
                returnByValue = $false
            }
            $objectId = [string]$element.result.objectId
            if (-not [string]::IsNullOrWhiteSpace($objectId)) {
                $null = Invoke-Cdp $connection 'DOM.setFileInputFiles' @{
                    objectId = $objectId
                    files = @($resolved)
                }
                $null = Invoke-Cdp $connection 'Runtime.evaluate' @{
                    expression = "document.querySelector('#fileInput').dispatchEvent(new Event('change',{bubbles:true})); true"
                    returnByValue = $true
                }
                $fileSelected = $true
                break
            }
        } catch { $lastInputError = $_.Exception.Message }
        Start-Sleep -Milliseconds 200
    }
    if (-not $fileSelected) {
        throw ('Viewer file input did not become ready. ' + $lastInputError)
    }

    $loaded = $false
    # Large 2,000+ message conversations need additional render time.
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        $state = Invoke-Cdp $connection 'Runtime.evaluate' @{
            expression = "(()=>{const meta=document.querySelector('#conversationMeta')?.textContent||'';const match=meta.match(/([0-9]+) +visible messages/);const expected=match?Number(match[1]):0;const messages=document.querySelectorAll('#messages .message').length;return JSON.stringify({appVisible:!document.querySelector('#app').classList.contains('hidden'),title:document.querySelector('#conversationTitle')?.textContent||'',messages,expected,complete:expected>0&&messages>=expected,latestTurnPending:meta.includes('INCOMPLETE SNAPSHOT')})})()"
            returnByValue = $true
        }
        $value = [string]$state.result.value
        if ($value) {
            $parsed = $value | ConvertFrom-Json
            if ($parsed.appVisible -and $parsed.complete) {
                $loaded = $true
                Write-Output ("VIEWER_OPENED title=" + $parsed.title + " messages=" + $parsed.messages + "/" + $parsed.expected)
                Write-Output ("VIEWER_CAPTURE_STATUS=" + $(if ($parsed.latestTurnPending) { 'LATEST_USER_TURN_IN_PROGRESS; NOT FULLY COMPLETED' } else { 'COMPLETE_THROUGH_LATEST_USER_TURN' }))
                break
            }
        }
        Start-Sleep -Milliseconds 200
    }
    if (-not $loaded) { throw 'Viewer opened, but the requested conversation did not load.' }

    if ($Headless) {
        $richState = Invoke-Cdp $connection 'Runtime.evaluate' @{
            expression = "(()=>{const m=document.querySelector('.mermaid svg');const box=m?.getBoundingClientRect();return JSON.stringify({mermaid:document.querySelectorAll('.mermaid').length,mermaidSvg:document.querySelectorAll('.mermaid svg').length,mermaidError:document.querySelectorAll('.mermaid-error').length,mermaidGraphics:m?m.querySelectorAll('path,line,polyline,polygon,rect,text,circle').length:0,mermaidWidth:box?.width||0,mermaidHeight:box?.height||0,chartWidgets:document.querySelectorAll('.chart-widget').length,chartSvg:document.querySelectorAll('.chart-widget svg.chart-svg').length,genericWidgets:document.querySelectorAll('.generic-widget').length,citations:document.querySelectorAll('.citation').length,sources:document.querySelectorAll('.sources-footnote').length,assets:document.querySelectorAll('.asset').length,tables:document.querySelectorAll('table').length,codeBlocks:document.querySelectorAll('pre code').length})})()"
            returnByValue = $true
        }
        $rich = ([string]$richState.result.value) | ConvertFrom-Json
        Write-Output ("RICH_CONTENT mermaid=" + $rich.mermaid + " mermaidSvg=" + $rich.mermaidSvg + " mermaidError=" + $rich.mermaidError + " mermaidGraphics=" + $rich.mermaidGraphics + " mermaidSize=" + $rich.mermaidWidth + "x" + $rich.mermaidHeight + " chartWidgets=" + $rich.chartWidgets + " chartSvg=" + $rich.chartSvg + " genericWidgets=" + $rich.genericWidgets + " citations=" + $rich.citations + " sources=" + $rich.sources + " assets=" + $rich.assets + " tables=" + $rich.tables + " codeBlocks=" + $rich.codeBlocks)

        if ([int]$rich.mermaid -gt 0 -and [int]$rich.mermaidSvg -ne [int]$rich.mermaid) {
            throw 'Mermaid smoke test failed: not every Mermaid block produced an SVG.'
        }
        if ([int]$rich.mermaidError -gt 0) {
            throw 'Mermaid smoke test failed: render error fallback was used.'
        }
        if ([int]$rich.mermaid -gt 0 -and ([int]$rich.mermaidGraphics -lt 1 -or [double]$rich.mermaidWidth -lt 10 -or [double]$rich.mermaidHeight -lt 10)) {
            throw 'Mermaid smoke test failed: SVG exists but has no visible graphic content.'
        }
        if ([int]$rich.chartWidgets -gt 0 -and [int]$rich.chartSvg -ne [int]$rich.chartWidgets) {
            throw 'Chart widget smoke test failed: not every chart widget produced an SVG.'
        }

        try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch {}
        Start-Sleep -Milliseconds 300
        Remove-Item -LiteralPath $profile -Recurse -Force -ErrorAction SilentlyContinue
    } else {
        $cleanupCommand = "Wait-Process -Id $($process.Id) -ErrorAction SilentlyContinue; Remove-Item -LiteralPath '$($profile.Replace("'","''"))' -Recurse -Force -ErrorAction SilentlyContinue"
        Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile', '-Command', $cleanupCommand) | Out-Null
    }
}
finally {
    Close-CdpConnection $connection
}
