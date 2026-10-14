#!/usr/bin/env node

const {
  readAppInfo,
  readCliOption,
  readDeviceAlias,
  requireDeviceAlias,
  runWebOsCli
} = require('./webos-common.cjs');
const { assertWorkspaceAuthority } = require('./ptv-workspace-preflight.cjs');

function readCliDeviceAlias(args = process.argv.slice(2)) {
  return readCliOption(args, ['--device', '-d'], '--device');
}

function formatSafeDeviceList(rawOutput) {
  const devices = [];
  const plainOutput = String(rawOutput).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  for (const line of plainOutput.split(/\r?\n/)) {
    const match = line.match(/^\s*(.*?)\s{2,}[^\s@]+@([^\s:]+):(\d+)\s{2,}/);
    if (!match) continue;
    const alias = match[1].trim().replace(/\s+\(default\)$/i, '');
    devices.push({ alias, endpoint: `${match[2]}:${match[3]}` });
  }

  if (devices.length === 0) {
    throw new Error('Could not parse the webOS device list without exposing credential fields.');
  }

  return [
    'Configured webOS devices (credential fields omitted):',
    ...devices.map((device) => `- ${device.alias}: ${device.endpoint}`)
  ].join('\n');
}

function listDevices(execute = runWebOsCli, cliDirectory = null) {
  const output = execute('ares-setup-device', ['--list'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cliDirectory
  });
  console.log(formatSafeDeviceList(output));
}

function buildInspectorArgs(args = process.argv.slice(2), env = process.env, root = process.cwd()) {
  const device = requireDeviceAlias(args, env);
  const appId = readAppInfo(root).id;
  return [appId, '-d', device];
}

function runInspector(options = {}) {
  const execute = options.execute ?? runWebOsCli;
  const inputArgs = options.args ?? process.argv.slice(2);
  const device = requireDeviceAlias(inputArgs, options.env ?? process.env);
  const authority = assertWorkspaceAuthority('inspect-device', {
    cwd: options.root ?? process.cwd(), targetId: device
  });
  const args = buildInspectorArgs(inputArgs, options.env, options.root);
  execute('ares-inspect', args, { stdio: 'inherit', cliDirectory: authority.sdkCliDirectory });
}

function main() {
  const listRequested = process.argv.slice(2).includes('--list');
  try {
    if (listRequested) {
      const authority = assertWorkspaceAuthority('inspect-sdk', { cwd: process.cwd() });
      listDevices(runWebOsCli, authority.sdkCliDirectory);
      return;
    }
    runInspector();
  } catch (error) {
    const message = listRequested
      ? 'Could not safely list configured webOS devices.'
      : error instanceof Error
        ? error.message
        : 'webOS inspection failed.';
    console.error(message);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  buildInspectorArgs,
  formatSafeDeviceList,
  readCliDeviceAlias,
  readDeviceAlias,
  runInspector
};
