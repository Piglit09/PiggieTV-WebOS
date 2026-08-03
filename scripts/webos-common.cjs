#!/usr/bin/env node

const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');

const SAFE_CLI_VALUE = /^[A-Za-z0-9._-]+$/;
const WEBOS_COMMANDS = new Set([
  'ares-device',
  'ares-inspect',
  'ares-install',
  'ares-launch',
  'ares-package',
  'ares-setup-device'
]);
const SAFE_BUILD_ASSET = /^[A-Za-z0-9._-]+\.js$/;

function readCliOption(args, names, label) {
  const optionIndex = args.findIndex(value => names.includes(value));
  if (optionIndex < 0) return null;
  const value = args[optionIndex + 1];
  if (!value || value.startsWith('-')) {
    throw new Error(`The ${label} option requires a value.`);
  }
  return value;
}

function readDeviceAlias(args = process.argv.slice(2), env = process.env) {
  return readCliOption(args, ['--device', '-d'], '--device')
    ?? env.PTV_WEBOS_TEST_DEVICE
    ?? null;
}

function requireSafeCliValue(value, label) {
  if (typeof value !== 'string' || !SAFE_CLI_VALUE.test(value)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
  return value;
}

function requireDeviceAlias(args = process.argv.slice(2), env = process.env) {
  const alias = readDeviceAlias(args, env);
  if (!alias) {
    throw new Error('Missing webOS device alias. Set PTV_WEBOS_TEST_DEVICE or pass --device <alias>.');
  }
  return requireSafeCliValue(alias, 'Device alias');
}

function readAppInfo(root = process.cwd()) {
  const appInfo = JSON.parse(fs.readFileSync(path.join(root, 'appinfo.json'), 'utf8'));
  if (typeof appInfo.id !== 'string' || typeof appInfo.version !== 'string') {
    throw new Error('appinfo.json is missing a valid id or version.');
  }
  if (appInfo.disableBackHistoryAPI !== true) {
    throw new Error('appinfo.json must set disableBackHistoryAPI to true so webOS delivers Back events to the application.');
  }
  return {
    ...appInfo,
    id: requireSafeCliValue(appInfo.id, 'Application ID'),
    version: requireSafeCliValue(appInfo.version, 'Application version')
  };
}

function requireHostIp(args = process.argv.slice(2), env = process.env) {
  const host = readCliOption(args, ['--host-ip', '--host', '-I'], '--host-ip')
    ?? env.PTV_WEBOS_HOST_IP
    ?? null;
  if (!host) {
    throw new Error('Missing workstation host IP. Set PTV_WEBOS_HOST_IP or pass --host-ip <ip>.');
  }
  if (!net.isIPv4(host)) {
    throw new Error('Hosted launch requires a literal workstation IPv4 address.');
  }
  return host;
}

function findPowerShellCliScript(command, env = process.env) {
  const pathEntries = String(env.PATH || '')
    .split(path.delimiter)
    .map(entry => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  for (const directory of pathEntries) {
    const candidate = path.join(directory, `${command}.ps1`);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`Could not resolve ${command}.ps1 from PATH.`);
}

function runWebOsCli(command, args, options = {}) {
  if (!WEBOS_COMMANDS.has(command)) {
    throw new Error(`Unsupported webOS CLI command: ${command}`);
  }
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) {
    throw new Error('webOS CLI arguments must be an array of strings.');
  }

  if (process.platform === 'win32') {
    const script = findPowerShellCliScript(command, options.env ?? process.env);
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const powershell = path.join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    );
    const { env, ...childOptions } = options;
    return execFileSync(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { windowsHide: true, env: env ?? process.env, ...childOptions }
    );
  }

  return execFileSync(command, args, { ...options, windowsHide: true });
}

function copyValidatedBuildAssets(sourceDir, targetDir) {
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  if (!entries.length) {
    throw new Error('The web build contains no JavaScript assets.');
  }
  const unexpected = entries.filter(entry => !entry.isFile() || !SAFE_BUILD_ASSET.test(entry.name));
  if (unexpected.length) {
    throw new Error(`The web build contains unexpected assets: ${unexpected.map(entry => entry.name).join(', ')}`);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of entries) {
    fs.copyFileSync(path.join(sourceDir, entry.name), path.join(targetDir, entry.name));
  }
  return entries.map(entry => entry.name);
}

module.exports = {
  copyValidatedBuildAssets,
  findPowerShellCliScript,
  readAppInfo,
  readCliOption,
  readDeviceAlias,
  requireDeviceAlias,
  requireHostIp,
  requireSafeCliValue,
  runWebOsCli
};
