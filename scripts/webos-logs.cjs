#!/usr/bin/env node

const { runInspector } = require('./webos-inspect.cjs');

try {
  console.log('PiggieTV web-app logs are available in the Web Inspector Console.');
  console.log('The inspector URL will be printed below; no browser is opened automatically.');
  runInspector();
  console.log('Open the URL, select Console, enable Preserve log, and redact sensitive data before sharing.');
} catch (error) {
  const message = error instanceof Error ? error.message : 'Could not start the Web Inspector log workflow.';
  console.error(message);
  process.exitCode = 1;
}
