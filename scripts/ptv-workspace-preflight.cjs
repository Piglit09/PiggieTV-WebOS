#!/usr/bin/env node

// Supported entrypoints call this before any write, build, package, or device action.
// Operator authority is deliberately outside this checkout and outside the user profile.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const PROJECT_ID = 'PTV_WEBOS';
const OFFICIAL_VERSION_SOURCE = 'appinfo.json';
const REGISTRY_KEY = 'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\PiggieTV\\WorkspaceAuthority';
const REGISTRY_PROTECTION_KEYS = Object.freeze([
  'Registry::HKEY_LOCAL_MACHINE',
  'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE',
  'Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\PiggieTV',
  REGISTRY_KEY
]);
const MODES = new Set(['audit', 'edit', 'build', 'package', 'deploy', 'inspect-device', 'inspect-sdk']);
const DEPLOY_OPERATIONS = new Set(['install', 'remove', 'launch', 'close', 'hosted']);
const GIT = process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : 'git';
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

function canonicalPath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  try {
    return fs.realpathSync.native(path.resolve(value));
  } catch {
    throw new Error(`${label} does not exist or cannot be resolved.`);
  }
}

function samePath(left, right) {
  const normalized = value => process.platform === 'win32' ? value.toLowerCase() : value;
  return normalized(path.normalize(left)) === normalized(path.normalize(right));
}

function requireNoAlias(value, label) {
  const resolved = canonicalPath(value, label);
  if (!samePath(path.resolve(value), resolved)) {
    throw new Error(`${label} uses a symlink, junction, or path alias.`);
  }
  return resolved;
}

function insidePath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function canonicalFuturePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  let cursor = path.resolve(value);
  const missing = [];
  for (;;) {
    try {
      fs.lstatSync(cursor);
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`${label} cannot be inspected.`);
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error(`${label} has no existing parent.`);
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
  return path.join(requireNoAlias(cursor, label), ...missing);
}

function verifyPackageOutputPlans(options, identity, policy) {
  const expectedStaging = path.join(identity.root, 'dist', '.ptv-webos-package');
  const expectedOutput = path.join(identity.root, 'dist', 'pkgs');
  const staging = canonicalFuturePath(options.plannedStagingDir, 'Planned package staging directory');
  const output = canonicalFuturePath(options.plannedOutputDir, 'Planned package output directory');
  if (!samePath(staging, expectedStaging) || !samePath(output, expectedOutput)) {
    throw new Error('Planned package output paths differ from the approved source layout.');
  }
  if (!Array.isArray(policy.artifactRoots) || policy.artifactRoots.length === 0) {
    throw new Error('Approved artifact roots are missing.');
  }
  const roots = policy.artifactRoots.map(value => canonicalFuturePath(value, 'Approved artifact root'));
  if (!roots.some(root => insidePath(staging, root)) || !roots.some(root => insidePath(output, root))) {
    throw new Error('Planned package output paths are outside approved artifact roots.');
  }
}

function verifyPackageSdk(policy, observedScript) {
  if (typeof policy.sdkCliDirectory !== 'string') {
    throw new Error('Operator-approved webOS SDK CLI directory is missing.');
  }
  const sdkCliDirectory = requireNoAlias(policy.sdkCliDirectory, 'Approved webOS SDK CLI directory');
  const approvedScript = canonicalPath(path.join(sdkCliDirectory, 'ares-package.ps1'), 'Approved ares-package CLI script');
  const activeScript = canonicalPath(observedScript, 'Active ares-package CLI script');
  if (!samePath(approvedScript, activeScript)) {
    throw new Error('Active ares-package SDK CLI differs from operator policy.');
  }
  return sdkCliDirectory;
}

function verifyInventorySdk(policy, observedScript) {
  if (typeof policy.sdkCliDirectory !== 'string') {
    throw new Error('Operator-approved webOS SDK CLI directory is missing.');
  }
  const sdkCliDirectory = requireNoAlias(policy.sdkCliDirectory, 'Approved webOS SDK CLI directory');
  const approvedScript = canonicalPath(path.join(sdkCliDirectory, 'ares-setup-device.ps1'), 'Approved device inventory CLI script');
  const activeScript = canonicalPath(observedScript, 'Active device inventory CLI script');
  if (!samePath(approvedScript, activeScript)) {
    throw new Error('Active device inventory SDK CLI differs from operator policy.');
  }
  return sdkCliDirectory;
}

function git(cwd, ...args) {
  // Git's ambient variables can replace the repository, worktree, index, object
  // store, or config. Identity checks must describe cwd rather than the caller's
  // process environment. Add back only the two read-only controls we own.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  try {
    return execFileSync(GIT, ['-c', 'core.fsmonitor=false', '-c', 'maintenance.auto=false', ...args], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env
    }).trim();
  } catch {
    throw new Error(`Git identity check failed for ${args[0]}.`);
  }
}

function inspectGit(cwd) {
  const root = canonicalPath(git(cwd, 'rev-parse', '--show-toplevel'), 'Git root');
  const commonText = git(cwd, 'rev-parse', '--git-common-dir');
  const common = canonicalPath(path.isAbsolute(commonText) ? commonText : path.resolve(cwd, commonText), 'Git common directory');
  const commit = git(cwd, 'rev-parse', 'HEAD');
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Git commit identity is invalid.');
  const branchText = git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
  const branch = branchText === 'HEAD' ? null : branchText;
  const remoteNames = git(cwd, 'remote').split(/\r?\n/).filter(Boolean);
  const remote = remoteNames.includes('origin') ? git(cwd, 'remote', 'get-url', 'origin') : null;
  const dirty = git(cwd, 'status', '--porcelain=v1', '--untracked-files=all') !== '';
  return { root, common, commit, branch, remote, dirty };
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${label} is missing or invalid.`);
  }
}

function inspectVersion(root, policy) {
  if (policy.versionSource !== OFFICIAL_VERSION_SOURCE) {
    throw new Error(`Official version source must be ${OFFICIAL_VERSION_SOURCE}.`);
  }
  const appInfo = readJson(path.join(root, OFFICIAL_VERSION_SOURCE), 'Official version source');
  const packageJson = readJson(path.join(root, 'package.json'), 'package.json');
  const packageLock = readJson(path.join(root, 'package-lock.json'), 'package-lock.json');
  if (appInfo.id !== policy.appId || appInfo.id !== 'com.piggietv.webosnative') {
    throw new Error('Application identity differs from the approved policy.');
  }
  const version = appInfo.version;
  if (typeof version !== 'string' || !/^\d{1,2}\.\d{1,2}\.\d{1,2}$/.test(version)) {
    throw new Error('Official app version is invalid.');
  }
  if (packageJson.version !== version || packageLock.version !== version || packageLock.packages?.['']?.version !== version) {
    throw new Error('Version metadata differs from appinfo.json.');
  }
  return version;
}

function requireApprovedPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('Operator workspace authority policy is missing.');
  }
  if (policy.projectId !== PROJECT_ID) throw new Error('Operator policy names the wrong project.');
  for (const key of ['sourceRoot', 'gitCommonDir', 'remote', 'appId', 'versionSource']) {
    if (typeof policy[key] !== 'string' || !policy[key]) {
      throw new Error(`Operator policy lacks ${key}.`);
    }
  }
  return policy;
}

function verifyArtifact(options, identity, policy) {
  if (typeof options.artifactPath !== 'string' || typeof options.manifestPath !== 'string') {
    throw new Error('Exact artifact path and manifest path are required.');
  }
  const artifactPath = requireNoAlias(options.artifactPath, 'Artifact path');
  const manifestPath = requireNoAlias(options.manifestPath, 'Artifact manifest path');
  if (!Array.isArray(policy.artifactRoots) || policy.artifactRoots.length === 0) {
    throw new Error('Approved artifact roots are missing.');
  }
  const approvedRoots = policy.artifactRoots.map(item => requireNoAlias(item, 'Approved artifact root'));
  if (!approvedRoots.some(item => insidePath(artifactPath, item)) ||
      !approvedRoots.some(item => insidePath(manifestPath, item))) {
    throw new Error('Artifact path or manifest path is outside approved artifact roots.');
  }
  const { verifyArtifactManifest } = require('./ptv-artifact-manifest.cjs');
  const manifest = verifyArtifactManifest(manifestPath, {
    artifactPath,
    sourceRoot: identity.root,
    sourceCommit: identity.commit,
    sourceVersion: identity.version
  });
  if (manifest.projectId !== PROJECT_ID || manifest.artifact?.path !== artifactPath ||
      !/^[a-f0-9]{64}$/i.test(manifest.artifact.sha256)) {
    throw new Error('Artifact manifest identity or SHA-256 is invalid.');
  }
  return { artifactPath, manifestPath, artifactSha256: manifest.artifact.sha256 };
}

function verifyDeviceBinding(target, targetId, deviceConfig) {
  if (!target || typeof target.deviceConfigPath !== 'string' ||
      !target.endpoint || typeof target.endpoint !== 'object') {
    throw new Error('Operator target lacks a pinned device endpoint and configuration path.');
  }
  if (!deviceConfig || typeof deviceConfig !== 'object' ||
      !Array.isArray(deviceConfig.devices) || typeof deviceConfig.path !== 'string') {
    throw new Error('Current webOS device configuration is unavailable.');
  }
  const approvedPath = requireNoAlias(target.deviceConfigPath, 'Approved device configuration path');
  const observedPath = requireNoAlias(deviceConfig.path, 'Current device configuration path');
  if (!samePath(approvedPath, observedPath)) {
    throw new Error('Current device configuration path differs from operator policy.');
  }
  const matching = deviceConfig.devices.filter(item => item && item.name === targetId);
  if (matching.length !== 1) throw new Error('Device alias is missing or ambiguous in the SDK configuration.');
  const selected = matching[0];
  const expected = target.endpoint;
  const port = Number(selected.port);
  if (!net.isIPv4(expected.host) ||
      !Number.isInteger(expected.port) || expected.port < 1 || expected.port > 65535 ||
      typeof expected.user !== 'string' || !expected.user || expected.profile !== 'tv' ||
      !net.isIPv4(selected.host) ||
      !Number.isInteger(port) || port < 1 || port > 65535 ||
      selected.host !== expected.host || port !== expected.port ||
      selected.username !== expected.user || selected.profile !== expected.profile ||
      (expected.deviceUid != null && selected.id !== expected.deviceUid)) {
    throw new Error('Device alias endpoint differs from operator policy.');
  }
  return { host: expected.host, port: expected.port, user: expected.user, profile: expected.profile };
}

function verifyRollbackEvidence(policy, reference) {
  const evidence = policy.rollbackEvidence?.[reference];
  if (!evidence || typeof evidence.artifactPath !== 'string' ||
      typeof evidence.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(evidence.sha256)) {
    throw new Error('Operator-pinned rollback artifact evidence is missing or invalid.');
  }
  const artifactPath = requireNoAlias(evidence.artifactPath, 'Rollback artifact path');
  const hash = createHash('sha256');
  const bytes = Buffer.allocUnsafe(1024 * 1024);
  let handle;
  try {
    handle = fs.openSync(artifactPath, 'r');
    let count;
    while ((count = fs.readSync(handle, bytes, 0, bytes.length, null)) > 0) {
      hash.update(bytes.subarray(0, count));
    }
  } catch {
    throw new Error('Operator-pinned rollback artifact cannot be read.');
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
  if (hash.digest('hex').toLowerCase() !== evidence.sha256.toLowerCase()) {
    throw new Error('Operator-pinned rollback artifact SHA-256 differs from approval evidence.');
  }
  return artifactPath;
}

function requireApprovedTarget(policy, targetId, operation) {
  if (typeof targetId !== 'string' || !targetId ||
      !policy.targets || typeof policy.targets !== 'object' ||
      !Object.hasOwn(policy.targets, targetId) ||
      policy.targets[targetId]?.approved !== true) {
    throw new Error('Device target is unknown or not approved.');
  }
  const target = policy.targets[targetId];
  if (!Array.isArray(target.operations) || !target.operations.includes(operation)) {
    throw new Error('Device operation is not approved for this target.');
  }
  return target;
}

function readCurrentDeviceConfig(policy, operation, targetId) {
  const target = policy.targets?.[targetId];
  if (!target || typeof policy.sdkCliDirectory !== 'string') {
    throw new Error('Operator SDK or deployment target registration is missing.');
  }
  const sdkCliDirectory = requireNoAlias(policy.sdkCliDirectory, 'Approved webOS SDK CLI directory');
  const commands = operation === 'inspect'
    ? ['ares-setup-device', 'ares-device', 'ares-inspect', 'ares-launch', 'ares-novacom']
    : ['ares-setup-device', operation === 'install' || operation === 'remove' ? 'ares-install' : 'ares-launch'];
  const { findPowerShellCliScript } = require('./webos-common.cjs');
  for (const command of commands) {
    const found = canonicalPath(findPowerShellCliScript(command), `${command} CLI script`);
    const approved = canonicalPath(path.join(sdkCliDirectory, `${command}.ps1`), `Approved ${command} CLI script`);
    if (!samePath(found, approved)) throw new Error('Active webOS SDK CLI differs from operator policy.');
  }
  const sdkConfig = readJson(
    path.join(sdkCliDirectory, 'node_modules', '@webos-tools', 'cli', 'files', 'conf', 'config.json'),
    'Installed webOS SDK configuration'
  );
  if (sdkConfig.profile !== 'tv' || sdkConfig.dataDir !== '.webos/tv') {
    throw new Error('Installed webOS SDK device configuration layout is not approved.');
  }
  const appData = process.env.APPDATA || process.env.HOME || process.env.USERPROFILE;
  if (!appData) throw new Error('webOS SDK application data directory is unavailable.');
  const configPath = requireNoAlias(path.join(appData, sdkConfig.dataDir, 'novacom-devices.json'), 'Current device configuration path');
  const devices = readJson(configPath, 'Current webOS device configuration');
  return { path: configPath, devices, sdkCliDirectory };
}

function validateWorkspaceAuthority(mode, options = {}, policy = null, deviceConfig = null, packageSdkScript = null, inventorySdkScript = null) {
  if (!MODES.has(mode)) throw new Error('Unknown workspace preflight mode.');
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Workspace preflight options are invalid.');
  }
  const cwd = requireNoAlias(options.cwd ?? process.cwd(), 'Working directory');
  const identity = inspectGit(cwd);
  if (!insidePath(cwd, identity.root)) throw new Error('Working directory escaped its Git root.');
  if (mode === 'audit') return { ...identity, projectId: PROJECT_ID };

  requireApprovedPolicy(policy);
  const sourceRoot = requireNoAlias(policy.sourceRoot, 'Approved source root');
  if (!samePath(identity.root, sourceRoot)) throw new Error('Unauthorized source root or linked worktree.');
  const common = requireNoAlias(policy.gitCommonDir, 'Approved Git common directory');
  if (!samePath(identity.common, common)) throw new Error('Unexpected Git common directory.');
  if (identity.remote !== policy.remote) throw new Error('Unexpected Git remote.');
  const version = inspectVersion(identity.root, policy);
  const result = { ...identity, projectId: PROJECT_ID, version };
  if (mode === 'edit' || mode === 'build') return result;

  if (mode === 'inspect-device') {
    const target = requireApprovedTarget(policy, options.targetId, 'inspect');
    const endpoint = verifyDeviceBinding(target, options.targetId, deviceConfig);
    return { ...result, targetId: options.targetId, endpoint, sdkCliDirectory: deviceConfig.sdkCliDirectory ?? null };
  }

  if (mode === 'inspect-sdk') {
    return { ...result, sdkCliDirectory: verifyInventorySdk(policy, inventorySdkScript) };
  }

  if (identity.dirty) throw new Error('Release packaging or deployment requires clean committed source.');
  const packageSdk = mode === 'package' ? verifyPackageSdk(policy, packageSdkScript) : null;
  if (mode === 'package' && options.artifactPath == null && options.manifestPath == null) {
    verifyPackageOutputPlans(options, result, policy);
    return { ...result, sdkCliDirectory: packageSdk };
  }
  const artifact = verifyArtifact(options, result, policy);
  if (mode === 'package') return { ...result, ...artifact, sdkCliDirectory: packageSdk };

  if (!DEPLOY_OPERATIONS.has(options.operation)) {
    throw new Error('Deployment operation is not approved for this target.');
  }
  const target = requireApprovedTarget(policy, options.targetId, options.operation);
  if (typeof options.rollbackReference !== 'string' || !options.rollbackReference.trim()) {
    throw new Error('Verified rollback reference is required.');
  }
  if (typeof options.approvalId !== 'string' || !options.approvalId ||
      !target.approvals || !Object.hasOwn(target.approvals, options.approvalId)) {
    throw new Error('Exact task-specific deployment approval is missing.');
  }
  const approval = target.approvals[options.approvalId];
  if (approval.targetId !== options.targetId || approval.operation !== options.operation ||
      approval.sourceCommit !== identity.commit || approval.artifactSha256 !== artifact.artifactSha256 ||
      approval.rollbackReference !== options.rollbackReference) {
    throw new Error('Deployment approval does not match target, operation, commit, artifact SHA-256, or rollback reference.');
  }
  verifyRollbackEvidence(policy, options.rollbackReference);
  const endpoint = verifyDeviceBinding(target, options.targetId, deviceConfig);
  return {
    ...result, ...artifact, targetId: options.targetId, operation: options.operation,
    approvalId: options.approvalId, endpoint,
    sdkCliDirectory: deviceConfig.sdkCliDirectory ?? null
  };
}

function registryAclScript(keys) {
  if (!Array.isArray(keys) || keys.length === 0 ||
      keys.some(key => typeof key !== 'string' || !key.startsWith('Registry::HKEY_'))) {
    throw new Error('Registry ACL check requires explicit registry keys.');
  }
  const protectedKeys = keys.map(key => `'${key.replace(/'/g, "''")}'`).join(', ');
  return `
$ErrorActionPreference = 'Stop'
$protectedKeys = @(${protectedKeys})
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
$callerSid = $identity.User.Value
# WriteKey also contains ReadPermissions, so check only rights that can
# actually change this key or create a writable descendant.
$rights = [System.Security.AccessControl.RegistryRights]
$writeMask = [int]($rights::SetValue -bor $rights::CreateSubKey -bor $rights::CreateLink -bor $rights::Delete -bor $rights::ChangePermissions -bor $rights::TakeOwnership -bor 0x10000000 -bor 0x40000000)
foreach ($protectedKey in $protectedKeys) {
  $machineName = 'Registry::HKEY_LOCAL_MACHINE'
  $userName = 'Registry::HKEY_CURRENT_USER'
  $separator = [char]92
  if ($protectedKey -eq $machineName -or $protectedKey.StartsWith($machineName + $separator, [System.StringComparison]::OrdinalIgnoreCase)) {
    $hive = [Microsoft.Win32.Registry]::LocalMachine
    $subPath = $protectedKey.Substring($machineName.Length).TrimStart($separator)
  } elseif ($protectedKey -eq $userName -or $protectedKey.StartsWith($userName + $separator, [System.StringComparison]::OrdinalIgnoreCase)) {
    $hive = [Microsoft.Win32.Registry]::CurrentUser
    $subPath = $protectedKey.Substring($userName.Length).TrimStart($separator)
  } else {
    throw 'Unsupported registry ACL path.'
  }
  $registryKey = if ($subPath) { $hive.OpenSubKey($subPath, $false) } else { $hive }
  if ($null -eq $registryKey) { throw 'Policy key or ancestor is missing.' }
  try {
    # RegistryKey avoids relying on PowerShell Security-module autoloading.
    $acl = $registryKey.GetAccessControl()
    $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($ownerSid -eq $callerSid) { throw 'Policy key or ancestor is owned by this task identity.' }
    # Raw ACLs expose SIDs directly. Translating names such as ALL APPLICATION
    # PACKAGES can fail on this host even when the ACL itself is readable.
    $sddl = $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)
    $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new($sddl)
    foreach ($ace in $descriptor.DiscretionaryAcl) {
      if ($ace -isnot [System.Security.AccessControl.QualifiedAce]) { throw 'Unsupported registry ACL entry.' }
      if ($ace.AceQualifier -ne [System.Security.AccessControl.AceQualifier]::AccessAllowed) { continue }
      $sid = $ace.SecurityIdentifier
      $active = ($sid.Value -eq $callerSid) -or $principal.IsInRole($sid)
      if ($active -and (($ace.AccessMask -band $writeMask) -ne 0)) { throw 'Policy key or ancestor is writable by this task identity.' }
    }
  } finally {
    if ($subPath) { $registryKey.Close() }
  }
}
`;
}

function assertRegistryAclProtection(keys) {
  if (process.platform !== 'win32') throw new Error('Registry ACL check requires Windows.');
  try {
    execFileSync(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', registryAclScript(keys)], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch {
    throw new Error('Registry ACL is writable by this task identity or cannot be verified.');
  }
}

function readOperatorPolicy() {
  if (process.platform !== 'win32') throw new Error('Operator authority requires Windows machine policy.');
  const script = `${registryAclScript(REGISTRY_PROTECTION_KEYS)}
$key = '${REGISTRY_KEY}'
$item = Get-Item -LiteralPath $key
if ($item.GetValueKind('PolicyJson') -ne [Microsoft.Win32.RegistryValueKind]::String) { throw 'PolicyJson must be REG_SZ.' }
[Console]::Out.Write($item.GetValue('PolicyJson', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames))
`;
  let raw;
  try {
    raw = execFileSync(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch {
    throw new Error('Operator workspace authority is absent, unreadable, or writable by this task identity.');
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Operator workspace authority contains invalid JSON.');
  }
}

function assertWorkspaceAuthority(mode, options = {}) {
  if (options && (Object.hasOwn(options, 'policy') || Object.hasOwn(options, 'registryPath') ||
      Object.hasOwn(options, 'policyPath'))) {
    throw new Error('Operator policy override is prohibited.');
  }
  const policy = mode === 'audit' ? null : readOperatorPolicy();
  const deviceConfig = mode === 'deploy' || mode === 'inspect-device'
    ? readCurrentDeviceConfig(policy, mode === 'inspect-device' ? 'inspect' : options.operation, options.targetId)
    : null;
  const packageSdkScript = mode === 'package'
    ? require('./webos-common.cjs').findPowerShellCliScript('ares-package')
    : null;
  const inventorySdkScript = mode === 'inspect-sdk'
    ? require('./webos-common.cjs').findPowerShellCliScript('ares-setup-device')
    : null;
  return validateWorkspaceAuthority(mode, options, policy, deviceConfig, packageSdkScript, inventorySdkScript);
}

function cliOptions(args) {
  if (args.length === 0) throw new Error('Usage: ptv-workspace-preflight.cjs <audit|edit|build|package|deploy|inspect-device|inspect-sdk> [options]');
  const [mode, ...flags] = args;
  const mapping = {
    '--target': 'targetId', '--operation': 'operation', '--artifact': 'artifactPath',
    '--manifest': 'manifestPath', '--approval': 'approvalId', '--rollback': 'rollbackReference'
  };
  const options = {};
  for (let index = 0; index < flags.length; index += 2) {
    const key = mapping[flags[index]];
    const value = flags[index + 1];
    if (!key || !value || value.startsWith('--') || Object.hasOwn(options, key)) {
      throw new Error(`Unsupported or incomplete preflight option: ${flags[index]}.`);
    }
    options[key] = value;
  }
  if (mode === 'package' && options.artifactPath == null && options.manifestPath == null) {
    options.plannedStagingDir = path.join(process.cwd(), 'dist', '.ptv-webos-package');
    options.plannedOutputDir = path.join(process.cwd(), 'dist', 'pkgs');
  }
  return { mode, options };
}

function protectedPolicyRegistryKeys() {
  return [...REGISTRY_PROTECTION_KEYS];
}

if (require.main === module) {
  try {
    const { mode, options } = cliOptions(process.argv.slice(2));
    const result = assertWorkspaceAuthority(mode, options);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Workspace preflight denied.');
    process.exitCode = 1;
  }
}

module.exports = { assertWorkspaceAuthority, validateWorkspaceAuthority, cliOptions, protectedPolicyRegistryKeys, assertRegistryAclProtection };
