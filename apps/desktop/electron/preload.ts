import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('eternalDesktop', {
  // Licence gate: read the current verdict, and hand over a key the customer
  // typed. Verification happens in the main process against the embedded
  // public key — the renderer is never trusted to decide this.
  getLicenseState: () => ipcRenderer.invoke('eternal:license-state'),
  activateLicense: key => ipcRenderer.invoke('eternal:license-activate', key),
  getConnection: profile => ipcRenderer.invoke('eternal:connection', profile),
  // Registry-scoped backend resolution: { connectionId, profile } → descriptor.
  getConnectionFor: payload => ipcRenderer.invoke('eternal:connection:for', payload),
  revalidateConnection: () => ipcRenderer.invoke('eternal:connection:revalidate'),
  touchBackend: profile => ipcRenderer.invoke('eternal:backend:touch', profile),
  getGatewayWsUrl: profile => ipcRenderer.invoke('eternal:gateway:ws-url', profile),
  // Registry-scoped fresh WS URL: { connectionId, profile } → result shape of
  // getGatewayWsUrl, minted against that connection's backend.
  getGatewayWsUrlFor: payload => ipcRenderer.invoke('eternal:gateway:ws-url-for', payload),
  // Union agent roster across every registered connection.
  getAgentRoster: () => ipcRenderer.invoke('eternal:agents:roster'),
  openSessionWindow: (sessionId, opts) => ipcRenderer.invoke('eternal:window:openSession', sessionId, opts),
  openSessionInTerminal: (sessionId, opts) => ipcRenderer.invoke('eternal:window:openInTerminal', sessionId, opts),
  openWindow: () => ipcRenderer.invoke('eternal:window:openInstance'),
  claimAmbientCue: key => ipcRenderer.invoke('eternal:ambient:claim', key),
  wakeIndicator: {
    getState: () => ipcRenderer.invoke('eternal:wake-indicator:get'),
    setState: state => ipcRenderer.send('eternal:wake-indicator:set', state),
    onState: callback => {
      const listener = (_event, state) => callback(state)
      ipcRenderer.on('eternal:wake-indicator:state', listener)

      return () => ipcRenderer.removeListener('eternal:wake-indicator:state', listener)
    }
  },
  petOverlay: {
    // Main renderer → main process: window lifecycle + drag. `request` is
    // `{ bounds, screen }`; resolves with the screen bounds it actually used.
    open: request => ipcRenderer.invoke('eternal:pet-overlay:open', request),
    close: () => ipcRenderer.invoke('eternal:pet-overlay:close'),
    setBounds: bounds => ipcRenderer.send('eternal:pet-overlay:set-bounds', bounds),
    setIgnoreMouse: ignore => ipcRenderer.send('eternal:pet-overlay:ignore-mouse', ignore),
    // Flip the overlay focusable (and focus it) while the composer needs keys.
    setFocusable: focusable => ipcRenderer.send('eternal:pet-overlay:set-focusable', focusable),
    // Main renderer → overlay (forwarded by main): push the latest pet state.
    pushState: payload => ipcRenderer.send('eternal:pet-overlay:state', payload),
    // Overlay → main renderer (forwarded by main): pop back in / composer submit.
    control: payload => ipcRenderer.send('eternal:pet-overlay:control', payload),
    // Overlay subscribes to state pushes.
    onState: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('eternal:pet-overlay:state', listener)

      return () => ipcRenderer.removeListener('eternal:pet-overlay:state', listener)
    },
    // Main renderer subscribes to overlay control messages.
    onControl: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('eternal:pet-overlay:control', listener)

      return () => ipcRenderer.removeListener('eternal:pet-overlay:control', listener)
    }
  },
  // HUD mode: the chrome-free floating chat. A full app renderer (own gateway)
  // sized as a floating bar, so it mounts the real composer. Main owns the
  // window; `onChanged` keeps every window's toggle truthful.
  hud: {
    open: request => ipcRenderer.invoke('eternal:hud:open', request),
    close: () => ipcRenderer.invoke('eternal:hud:close'),
    setIgnoreMouse: ignore => ipcRenderer.send('eternal:hud:ignore-mouse', ignore),
    moveBy: delta => ipcRenderer.send('eternal:hud:move-by', delta),
    setBounds: bounds => ipcRenderer.send('eternal:hud:set-bounds', bounds),
    setVibrancy: on => ipcRenderer.invoke('eternal:hud:vibrancy', on),
    // The HUD tells main which session it is on; main hands that back to the
    // app window when the HUD closes, so the app can re-home onto it.
    setSession: sessionId => ipcRenderer.send('eternal:hud:session', sessionId),
    onGoto: callback => {
      const listener = (_event, sessionId) => callback(sessionId)
      ipcRenderer.on('eternal:hud:goto', listener)

      return () => ipcRenderer.removeListener('eternal:hud:goto', listener)
    },
    onChanged: callback => {
      const listener = (_event, state) => callback(state)
      ipcRenderer.on('eternal:hud:changed', listener)

      return () => ipcRenderer.removeListener('eternal:hud:changed', listener)
    },
    // Linux only, and silent elsewhere: where the cursor is, in page
    // coordinates, or null when it has left the window. Stands in for the
    // mousemove that `setIgnoreMouseEvents(true, { forward: true })` delivers on
    // macOS and Windows but not here.
    onCursor: callback => {
      const listener = (_event, point) => callback(point)
      ipcRenderer.on('eternal:hud:cursor', listener)

      return () => ipcRenderer.removeListener('eternal:hud:cursor', listener)
    }
  },
  // Quick Entry: the global-hotkey mini composer window. Main owns the OS
  // shortcut + the persisted preference; the quick window only captures text
  // and hands it back, and the primary renderer submits it through the normal
  // prompt path.
  quickEntry: {
    getSettings: () => ipcRenderer.invoke('eternal:quick-entry:settings:get'),
    setSettings: patch => ipcRenderer.invoke('eternal:quick-entry:settings:set', patch),
    submit: payload => ipcRenderer.send('eternal:quick-entry:submit', payload),
    dismiss: () => ipcRenderer.send('eternal:quick-entry:dismiss'),
    // Primary renderer → main → quick window: gateway connection state + the
    // recent-session options the target picker offers. Main caches the latest
    // payload so a freshly spawned quick window starts from truth.
    pushState: payload => ipcRenderer.send('eternal:quick-entry:state', payload),
    // Quick window subscribes to those pushes.
    onState: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('eternal:quick-entry:state', listener)

      return () => ipcRenderer.removeListener('eternal:quick-entry:state', listener)
    },
    // Main → primary renderer: a submit captured by the quick window.
    onSubmit: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('eternal:quick-entry:submit', listener)

      return () => ipcRenderer.removeListener('eternal:quick-entry:submit', listener)
    },
    // Main → quick window: you were just summoned (reset draft + refocus).
    onShown: callback => {
      const listener = () => callback()
      ipcRenderer.on('eternal:quick-entry:shown', listener)

      return () => ipcRenderer.removeListener('eternal:quick-entry:shown', listener)
    }
  },
  getBootProgress: () => ipcRenderer.invoke('eternal:boot-progress:get'),
  getConnectionConfig: profile => ipcRenderer.invoke('eternal:connection-config:get', profile),
  saveConnectionConfig: payload => ipcRenderer.invoke('eternal:connection-config:save', payload),
  applyConnectionConfig: payload => ipcRenderer.invoke('eternal:connection-config:apply', payload),
  testConnectionConfig: payload => ipcRenderer.invoke('eternal:connection-config:test', payload),
  // v2 multi-connection registry: named agent sources (local / remote / cloud / ssh).
  connections: {
    list: () => ipcRenderer.invoke('eternal:connections:list'),
    save: payload => ipcRenderer.invoke('eternal:connections:save', payload),
    remove: id => ipcRenderer.invoke('eternal:connections:remove', id),
    setPrimary: id => ipcRenderer.invoke('eternal:connections:set-primary', id),
    test: id => ipcRenderer.invoke('eternal:connections:test', id),
    // Fan out `eternal update` to every eligible registered connection.
    updateAll: () => ipcRenderer.invoke('eternal:connections:update-all'),
    // Registry lifecycle push (main → renderer): a connection was removed or
    // materially edited, so secondaries scoped to it must be disposed (and,
    // for edits, re-dialed at the new target).
    onChanged: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('eternal:connections:changed', listener)

      return () => ipcRenderer.removeListener('eternal:connections:changed', listener)
    }
  },
  sshConfigHosts: () => ipcRenderer.invoke('eternal:ssh-config:hosts'),
  sshResolveHost: host => ipcRenderer.invoke('eternal:ssh-config:resolve', host),
  probeConnectionConfig: remoteUrl => ipcRenderer.invoke('eternal:connection-config:probe', remoteUrl),
  oauthLoginConnectionConfig: remoteUrl => ipcRenderer.invoke('eternal:connection-config:oauth-login', remoteUrl),
  oauthLogoutConnectionConfig: remoteUrl => ipcRenderer.invoke('eternal:connection-config:oauth-logout', remoteUrl),
  // Eternal Cloud: one portal login powers discovery + silent per-agent sign-in
  // (cloud-auto-discovery Phase 3).
  cloud: {
    status: () => ipcRenderer.invoke('eternal:cloud:status'),
    login: () => ipcRenderer.invoke('eternal:cloud:login'),
    logout: () => ipcRenderer.invoke('eternal:cloud:logout'),
    discover: org => ipcRenderer.invoke('eternal:cloud:discover', org),
    agentSignIn: dashboardUrl => ipcRenderer.invoke('eternal:cloud:agent-sign-in', dashboardUrl)
  },
  profile: {
    get: () => ipcRenderer.invoke('eternal:profile:get'),
    set: name => ipcRenderer.invoke('eternal:profile:set', name)
  },
  api: request => ipcRenderer.invoke('eternal:api', request),
  notify: payload => ipcRenderer.invoke('eternal:notify', payload),
  requestMicrophoneAccess: () => ipcRenderer.invoke('eternal:requestMicrophoneAccess'),
  readWindowBelow: () => ipcRenderer.invoke('eternal:window:readBelow'),
  readFileDataUrl: filePath => ipcRenderer.invoke('eternal:readFileDataUrl', filePath),
  readFileDataUrlForAttach: filePath => ipcRenderer.invoke('eternal:readFileDataUrlForAttach', filePath),
  dataUrlReadMax: {
    get: () => ipcRenderer.invoke('eternal:data-url-read-max:get'),
    set: maxMb => ipcRenderer.invoke('eternal:data-url-read-max:set', maxMb)
  },
  readFileText: filePath => ipcRenderer.invoke('eternal:readFileText', filePath),
  selectPaths: options => ipcRenderer.invoke('eternal:selectPaths', options),
  selectSavePath: options => ipcRenderer.invoke('eternal:selectSavePath', options),
  writeClipboard: text => ipcRenderer.invoke('eternal:writeClipboard', text),
  readClipboard: () => ipcRenderer.invoke('eternal:readClipboard'),
  saveGatewayFile: payload => ipcRenderer.invoke('eternal:saveGatewayFile', payload),
  saveImageFromUrl: url => ipcRenderer.invoke('eternal:saveImageFromUrl', url),
  saveImageBuffer: (data, ext) => ipcRenderer.invoke('eternal:saveImageBuffer', { data, ext }),
  saveClipboardImage: () => ipcRenderer.invoke('eternal:saveClipboardImage'),
  getPathForFile: file => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },
  normalizePreviewTarget: (target, baseDir) => ipcRenderer.invoke('eternal:normalizePreviewTarget', target, baseDir),
  watchPreviewFile: url => ipcRenderer.invoke('eternal:watchPreviewFile', url),
  watchDirectory: dir => ipcRenderer.invoke('eternal:watchDirectory', dir),
  stopPreviewFileWatch: id => ipcRenderer.invoke('eternal:stopPreviewFileWatch', id),
  setActiveWork: payload => ipcRenderer.send('eternal:active-work', payload),
  setTitleBarTheme: payload => ipcRenderer.send('eternal:titlebar-theme', payload),
  setNativeTheme: mode => ipcRenderer.send('eternal:native-theme', mode),
  setTranslucency: payload => ipcRenderer.send('eternal:translucency', payload),
  setKeepAwake: on => ipcRenderer.send('eternal:keep-awake', on),
  setDisableF12: blocked => ipcRenderer.send('eternal:devtools:disable-f12', blocked),
  setPreviewShortcutActive: active => ipcRenderer.send('eternal:previewShortcutActive', Boolean(active)),
  openExternal: url => ipcRenderer.invoke('eternal:openExternal', url),
  openPreviewInBrowser: url => ipcRenderer.invoke('eternal:openPreviewInBrowser', url),
  fetchLinkTitle: url => ipcRenderer.invoke('eternal:fetchLinkTitle', url),
  sanitizeWorkspaceCwd: cwd => ipcRenderer.invoke('eternal:workspace:sanitize', cwd),
  settings: {
    getDefaultProjectDir: () => ipcRenderer.invoke('eternal:setting:defaultProjectDir:get'),
    setDefaultProjectDir: dir => ipcRenderer.invoke('eternal:setting:defaultProjectDir:set', dir),
    pickDefaultProjectDir: () => ipcRenderer.invoke('eternal:setting:defaultProjectDir:pick')
  },
  zoom: {
    // Current zoom of this window, as { level, percent }.
    get: () => ipcRenderer.invoke('eternal:zoom:get'),
    setPercent: percent => ipcRenderer.send('eternal:zoom:set-percent', percent),
    // Fires on every zoom change, including the Ctrl/Cmd +/-/0 shortcuts,
    // so the settings UI can stay in sync with the keyboard.
    onChanged: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('eternal:zoom:changed', listener)

      return () => ipcRenderer.removeListener('eternal:zoom:changed', listener)
    }
  },
  revealLogs: () => ipcRenderer.invoke('eternal:logs:reveal'),
  getRecentLogs: () => ipcRenderer.invoke('eternal:logs:recent'),
  // Fire-and-forget: persists a renderer error-boundary catch (with component
  // stack) to desktop.log so crashes survive the window (#79428).
  reportRendererError: report => ipcRenderer.send('eternal:logs:renderer-error', report),
  readDir: dirPath => ipcRenderer.invoke('eternal:fs:readDir', dirPath),
  gitRoot: startPath => ipcRenderer.invoke('eternal:fs:gitRoot', startPath),
  revealPath: targetPath => ipcRenderer.invoke('eternal:fs:reveal', targetPath),
  openDir: dirPath => ipcRenderer.invoke('eternal:fs:openDir', dirPath),
  desktopPluginsRoot: () => ipcRenderer.invoke('eternal:fs:desktopPluginsRoot'),
  agentPluginsRoot: () => ipcRenderer.invoke('eternal:fs:agentPluginsRoot'),
  renamePath: (targetPath, newName) => ipcRenderer.invoke('eternal:fs:rename', targetPath, newName),
  writeTextFile: (filePath, content) => ipcRenderer.invoke('eternal:fs:writeText', filePath, content),
  trashPath: targetPath => ipcRenderer.invoke('eternal:fs:trash', targetPath),
  git: {
    worktreeList: repoPath => ipcRenderer.invoke('eternal:git:worktreeList', repoPath),
    worktreeAdd: (repoPath, options) => ipcRenderer.invoke('eternal:git:worktreeAdd', repoPath, options),
    worktreeRemove: (repoPath, worktreePath, options) =>
      ipcRenderer.invoke('eternal:git:worktreeRemove', repoPath, worktreePath, options),
    branchSwitch: (repoPath, branch) => ipcRenderer.invoke('eternal:git:branchSwitch', repoPath, branch),
    branchList: repoPath => ipcRenderer.invoke('eternal:git:branchList', repoPath),
    baseBranchList: repoPath => ipcRenderer.invoke('eternal:git:baseBranchList', repoPath),
    repoStatus: repoPath => ipcRenderer.invoke('eternal:git:repoStatus', repoPath),
    fileDiff: (repoPath, filePath) => ipcRenderer.invoke('eternal:git:fileDiff', repoPath, filePath),
    scanRepos: (roots, options) => ipcRenderer.invoke('eternal:git:scanRepos', roots, options),
    review: {
      list: (repoPath, scope, baseRef) => ipcRenderer.invoke('eternal:git:review:list', repoPath, scope, baseRef),
      diff: (repoPath, filePath, scope, baseRef, staged) =>
        ipcRenderer.invoke('eternal:git:review:diff', repoPath, filePath, scope, baseRef, staged),
      stage: (repoPath, filePath) => ipcRenderer.invoke('eternal:git:review:stage', repoPath, filePath),
      unstage: (repoPath, filePath) => ipcRenderer.invoke('eternal:git:review:unstage', repoPath, filePath),
      revert: (repoPath, filePath) => ipcRenderer.invoke('eternal:git:review:revert', repoPath, filePath),
      revParse: (repoPath, ref) => ipcRenderer.invoke('eternal:git:review:revParse', repoPath, ref),
      commit: (repoPath, message, push) => ipcRenderer.invoke('eternal:git:review:commit', repoPath, message, push),
      commitContext: repoPath => ipcRenderer.invoke('eternal:git:review:commitContext', repoPath),
      push: repoPath => ipcRenderer.invoke('eternal:git:review:push', repoPath),
      shipInfo: repoPath => ipcRenderer.invoke('eternal:git:review:shipInfo', repoPath),
      prList: (repoPath, branches, numbers) =>
        ipcRenderer.invoke('eternal:git:review:prList', repoPath, branches, numbers),
      fetchPrComment: (repoPath, url) => ipcRenderer.invoke('eternal:git:review:fetchPrComment', repoPath, url),
      createPr: repoPath => ipcRenderer.invoke('eternal:git:review:createPr', repoPath)
    }
  },
  terminal: {
    cwd: id => ipcRenderer.invoke('eternal:terminal:cwd', id),
    dispose: id => ipcRenderer.invoke('eternal:terminal:dispose', id),
    resize: (id, size) => ipcRenderer.invoke('eternal:terminal:resize', id, size),
    start: options => ipcRenderer.invoke('eternal:terminal:start', options),
    write: (id, data) => ipcRenderer.invoke('eternal:terminal:write', id, data),
    onData: (id, callback) => {
      const channel = `eternal:terminal:${id}:data`
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(channel, listener)

      return () => ipcRenderer.removeListener(channel, listener)
    },
    onExit: (id, callback) => {
      const channel = `eternal:terminal:${id}:exit`
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(channel, listener)

      return () => ipcRenderer.removeListener(channel, listener)
    }
  },
  onClosePreviewRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('eternal:close-preview-requested', listener)

    return () => ipcRenderer.removeListener('eternal:close-preview-requested', listener)
  },
  onOpenFolderRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('eternal:open-folder-requested', listener)

    return () => ipcRenderer.removeListener('eternal:open-folder-requested', listener)
  },
  onOpenUpdatesRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('eternal:open-updates', listener)

    return () => ipcRenderer.removeListener('eternal:open-updates', listener)
  },
  onDeepLink: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('eternal:deep-link', listener)

    return () => ipcRenderer.removeListener('eternal:deep-link', listener)
  },
  signalDeepLinkReady: () => ipcRenderer.invoke('eternal:deep-link-ready'),
  onWindowStateChanged: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('eternal:window-state-changed', listener)

    return () => ipcRenderer.removeListener('eternal:window-state-changed', listener)
  },
  onFocusSession: callback => {
    const listener = (_event, sessionId) => callback(sessionId)
    ipcRenderer.on('eternal:focus-session', listener)

    return () => ipcRenderer.removeListener('eternal:focus-session', listener)
  },
  onNotificationAction: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('eternal:notification-action', listener)

    return () => ipcRenderer.removeListener('eternal:notification-action', listener)
  },
  onPreviewFileChanged: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('eternal:preview-file-changed', listener)

    return () => ipcRenderer.removeListener('eternal:preview-file-changed', listener)
  },
  onBackendExit: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('eternal:backend-exit', listener)

    return () => ipcRenderer.removeListener('eternal:backend-exit', listener)
  },
  // Soft gateway-mode apply finished tearing down the primary backend. Renderer
  // should wipe session lists + re-dial without a window reload.
  onConnectionApplied: callback => {
    const listener = () => callback()
    ipcRenderer.on('eternal:connection:applied', listener)

    return () => ipcRenderer.removeListener('eternal:connection:applied', listener)
  },
  onPowerResume: callback => {
    const listener = () => callback()
    ipcRenderer.on('eternal:power-resume', listener)

    return () => ipcRenderer.removeListener('eternal:power-resume', listener)
  },
  // AC ↔ battery transitions; renderers slow their backstop polls on battery.
  getOnBattery: () => ipcRenderer.invoke('eternal:power-battery:get'),
  onBatteryChanged: callback => {
    const listener = (_event, onBattery) => callback(Boolean(onBattery))
    ipcRenderer.on('eternal:power-battery', listener)

    return () => ipcRenderer.removeListener('eternal:power-battery', listener)
  },
  onBootProgress: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('eternal:boot-progress', listener)

    return () => ipcRenderer.removeListener('eternal:boot-progress', listener)
  },
  // First-launch bootstrap progress -- emitted by the install.ps1 stage
  // runner in main.ts (apps/desktop/electron/bootstrap-runner.ts).
  // Renderer's install overlay subscribes to live events and queries the
  // current snapshot via getBootstrapState() to recover after a devtools
  // reload mid-bootstrap.
  getBootstrapState: () => ipcRenderer.invoke('eternal:bootstrap:get'),
  continueBootstrapLocal: () => ipcRenderer.invoke('eternal:bootstrap:continue-local'),
  resetBootstrap: () => ipcRenderer.invoke('eternal:bootstrap:reset'),
  repairBootstrap: () => ipcRenderer.invoke('eternal:bootstrap:repair'),
  cancelBootstrap: () => ipcRenderer.invoke('eternal:bootstrap:cancel'),
  onBootstrapEvent: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('eternal:bootstrap:event', listener)

    return () => ipcRenderer.removeListener('eternal:bootstrap:event', listener)
  },
  getVersion: () => ipcRenderer.invoke('eternal:version'),
  getRemoteDisplayReason: () => ipcRenderer.invoke('eternal:get-remote-display-reason'),
  uninstall: {
    summary: () => ipcRenderer.invoke('eternal:uninstall:summary'),
    run: mode => ipcRenderer.invoke('eternal:uninstall:run', { mode })
  },
  updates: {
    check: () => ipcRenderer.invoke('eternal:updates:check'),
    apply: opts => ipcRenderer.invoke('eternal:updates:apply', opts),
    getBranch: () => ipcRenderer.invoke('eternal:updates:branch:get'),
    setBranch: name => ipcRenderer.invoke('eternal:updates:branch:set', name),
    onProgress: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('eternal:updates:progress', listener)

      return () => ipcRenderer.removeListener('eternal:updates:progress', listener)
    }
  },
  themes: {
    fetchMarketplace: id => ipcRenderer.invoke('eternal:vscode-theme:fetch', id),
    searchMarketplace: query => ipcRenderer.invoke('eternal:vscode-theme:search', query)
  },
  // Find-in-page (Ctrl/Cmd+F): delegates to Electron's
  // webContents.findInPage on the IPC sender's window so a Cmd+F pressed
  // in a secondary session window searches THAT window, not the primary.
  // `onFoundInPage` returns the unsubscribe fn; the renderer wires it via
  // `initFindInPageListener` in store/find-in-page.ts and tears it down
  // when the FindBar unmounts.
  findInPage: (query, options) => ipcRenderer.invoke('eternal:find-in-page', query, options),
  stopFindInPage: () => ipcRenderer.invoke('eternal:stop-find-in-page'),
  onFoundInPage: callback => {
    const listener = (_event, result) => callback(result)
    ipcRenderer.on('eternal:found-in-page', listener)

    return () => ipcRenderer.removeListener('eternal:found-in-page', listener)
  },
  // Main-process `before-input-event` forwards Ctrl/Cmd+F here so renderer
  // can open the FindBar even when the GTK compositor has already grabbed
  // the chord at the windowing layer (#81727).
  onOpenFindBarRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('eternal:open-find-bar', listener)

    return () => ipcRenderer.removeListener('eternal:open-find-bar', listener)
  }
})
