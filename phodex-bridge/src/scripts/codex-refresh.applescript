-- FILE: codex-refresh.applescript
-- Purpose: Refreshes Codex either by route-bouncing or by fully relaunching into the target thread.
-- Layer: UI automation helper
-- Args: bundle id, app path fallback, optional target deep link, optional refresh mode

on run argv
  set bundleId to item 1 of argv
  set appPath to item 2 of argv
  set targetUrl to ""
  set refreshMode to "bounce"

  if (count of argv) is greater than or equal to 3 then
    set targetUrl to item 3 of argv
  end if

  if (count of argv) is greater than or equal to 4 then
    set refreshMode to item 4 of argv
  end if

  if refreshMode is "relaunch" then
    my relaunchCodex(bundleId, appPath, targetUrl)
  else
    my bounceCodex(bundleId, appPath, targetUrl)
  end if
end run

on bounceCodex(bundleId, appPath, targetUrl)
  set bounceUrl to "codex://settings"

  try
    tell application "Finder" to activate
  end try

  delay 0.25

  my openCodexUrl(bundleId, appPath, bounceUrl)
  delay 0.45

  if targetUrl is not "" then
    my openCodexUrl(bundleId, appPath, targetUrl)
  else
    my openCodexUrl(bundleId, appPath, "")
  end if

  delay 0.45
  try
    tell application id bundleId to activate
  end try
end bounceCodex

on relaunchCodex(bundleId, appPath, targetUrl)
  my forceTerminateCodex()

  repeat 8 times
    if my isCodexRunning(bundleId) is false then
      exit repeat
    end if
    delay 0.25
  end repeat

  delay 0.2

  my openCodexUrlFresh(bundleId, appPath, "")

  repeat 20 times
    if my isCodexRunning(bundleId) then
      exit repeat
    end if
    delay 0.2
  end repeat

  delay 1.2

  if targetUrl is not "" then
    my openCodexUrl(bundleId, appPath, targetUrl)
    delay 0.9
    my openCodexUrl(bundleId, appPath, "codex://settings")
    delay 0.45
    my openCodexUrl(bundleId, appPath, targetUrl)
    delay 0.9
    my openCodexUrl(bundleId, appPath, targetUrl)
  end if

  delay 0.45
  try
    tell application id bundleId to activate
  end try
end relaunchCodex

on openCodexUrl(bundleId, appPath, targetUrl)
  my openCodexUrlWithOptions(bundleId, appPath, targetUrl, false)
end openCodexUrl

on openCodexUrlFresh(bundleId, appPath, targetUrl)
  my openCodexUrlWithOptions(bundleId, appPath, targetUrl, true)
end openCodexUrlFresh

on openCodexUrlWithOptions(bundleId, appPath, targetUrl, forceNewInstance)
  set openPrefix to "open "
  if forceNewInstance then
    set openPrefix to "open -n "
  end if

  try
    if targetUrl is not "" then
      do shell script openPrefix & "-b " & quoted form of bundleId & " " & quoted form of targetUrl
    else
      do shell script openPrefix & "-b " & quoted form of bundleId
    end if
  on error
    if targetUrl is not "" then
      do shell script openPrefix & "-a " & quoted form of appPath & " " & quoted form of targetUrl
    else
      do shell script openPrefix & "-a " & quoted form of appPath
    end if
  end try
end openCodexUrlWithOptions

on isCodexRunning(bundleId)
  try
    tell application id bundleId to return running
  on error
    return false
  end try
end isCodexRunning

on forceTerminateCodex()
  try
    do shell script "/usr/bin/pkill -TERM -x Codex >/dev/null 2>&1 || true"
  end try

  try
    do shell script "/usr/bin/pkill -TERM -f '/Applications/Codex.app/Contents/Resources/codex app-server' >/dev/null 2>&1 || true"
  end try

  delay 0.35

  try
    do shell script "/usr/bin/pkill -KILL -x Codex >/dev/null 2>&1 || true"
  end try

  try
    do shell script "/usr/bin/pkill -KILL -f '/Applications/Codex.app/Contents/Resources/codex app-server' >/dev/null 2>&1 || true"
  end try
end forceTerminateCodex
