import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

const simulator = require('../scripts/webos-simulator-validate.cjs') as {
  activateOwnedSimulatorWindow: (
    child: { pid?: number },
    execute?: (...args: any[]) => unknown,
    platform?: string
  ) => boolean;
  activateSimulatorWindow: (
    shellSession: Record<string, any>,
    appSession: Record<string, any>
  ) => Promise<void>;
  attachBoundaryCrossingProgress: (
    error: unknown,
    progress: Record<string, unknown>
  ) => Error & { boundaryProgress: Record<string, unknown> };
  attachEnduranceProgress: (
    error: unknown,
    progress: Record<string, unknown>
  ) => Error & { enduranceProgress: Record<string, unknown> };
  attachAppSessionTelemetry: (
    appSession: { onEvent: (listener: (event: Record<string, any>) => void) => void },
    metadataTracker: { handle: (event: Record<string, any>) => void },
    runtimeEvents: Record<string, any>[],
    validationPhase: string
  ) => void;
  captureEvidenceScreenshot: (
    session: Record<string, unknown>,
    outputPath: string,
    evidence: Record<string, any> | null,
    capture: (session: Record<string, unknown>, outputPath: string) => Promise<void>,
    read?: (session: Record<string, unknown>) => Promise<Record<string, any>>
  ) => Promise<{ captured: boolean; path: string | null; reason: string | null }>;
  classifySimulatorMetrics: (snapshot: Record<string, unknown>) => {
    ok: boolean;
    violations: string[];
  };
  classifyRuntimeConsole: (events: Record<string, any>[] | null | undefined) => {
    issueCount: number;
    status: 'PASS' | 'FAIL' | 'UNKNOWN';
  };
  compareAtomicFocusWithDiagnostics: (
    atomicFocus: Record<string, any>,
    diagnostics: Record<string, any> | null
  ) => {
    differences: Array<{ atomic: unknown; diagnostic: unknown; field: string }>;
    status: 'AGREE' | 'DISAGREE' | 'UNKNOWN';
  };
  compareExactDirectionalStep: (
    before: { column: number; columns: number; index: number; row: number } | null,
    after: { column: number; columns: number; index: number; row: number } | null,
    key: string
  ) => {
    actual?: { column: number; index: number; row: number };
    expected?: { column: number; index: number; row: number };
    ok: boolean;
    reason: string | null;
  };
  deriveShowsRenderWindowStartFromGeometry: (
    columnCount: number,
    hasTopSpacer: boolean,
    spacerHeight: number | null,
    cardHeight: number | null,
    rowGap: number | null
  ) => {
    renderWindowStart: number | null;
    renderWindowStartSource: string;
  };
  dispatchPointerMove: (
    appSession: { call: (method: string, params?: Record<string, any>) => Promise<unknown> },
    point: { x: number; y: number },
    settleMs?: number,
    previousPointer?: { lastPointerX: number | null; lastPointerY: number | null } | null
  ) => Promise<Array<{ x: number; y: number }>>;
  enableAppSessionTelemetry: (
    appSession: { call: (method: string) => Promise<unknown> }
  ) => Promise<void>;
  evaluateAcceptanceCoverage: (
    report: Record<string, any>,
    options: { boundaryCrossings?: number; enduranceMinutes: number; lifecycleCycle?: boolean }
  ) => { complete: boolean; missing: string[] };
  filterNavigationKey: (evidence: Record<string, any>) => string;
  normalizeAtomicShowsFocusSample: (sample: Record<string, any>) => Record<string, any>;
  parseMetadataRequest: (url: string) => {
    filter: string;
    limit: number;
    startIndex: number;
  } | null;
  pointerMoveCoordinates: (
    point: { x: number; y: number },
    previousPointer?: { lastPointerX: number | null; lastPointerY: number | null } | null
  ) => Array<{ x: number; y: number }>;
  pointerOwnershipTransitionMatches: (
    evidence: Record<string, any>,
    expected: {
      coordinate?: { x: number; y: number };
      mode: 'pointer' | 'remote';
      pointerBaselinePending: boolean;
    }
  ) => boolean;
  processCleanupSucceeded: (cleanup: Record<string, unknown> | null) => boolean;
  parseSimulatorArgs: (
    args?: string[],
    env?: Record<string, string | undefined>,
    root?: string
  ) => {
    appDir: string | null;
    boundaryCrossings: number;
    prepare: boolean;
    simulatorPath: string;
    simulatorVersion: string;
    [key: string]: unknown;
  };
  readAtomicShowsFocusSample: (
    session: { evaluate: (expression: string) => Promise<Record<string, any>> }
  ) => Promise<Record<string, any>>;
  runEndurance: (
    appSession: Record<string, any>,
    rcuSession: Record<string, any>,
    minutes: number,
    observations: Record<string, any>[],
    inputOptions?: Record<string, any>
  ) => Promise<Record<string, any>>;
  runShowsBoundaryCrossingGate: (
    appSession: Record<string, any>,
    rcuSession: Record<string, any>,
    requestedCrossings: number,
    observations: Record<string, any>[],
    inputOptions?: Record<string, any>
  ) => Promise<Record<string, any>>;
  runPreparation: (
    root: string,
    execute: (
      command: string,
      args: string[],
      options: Record<string, any>
    ) => unknown,
    platform: string,
    inheritedEnv: Record<string, string>
  ) => void;
  sanitizeSimulatorArtifact: (value: unknown) => unknown;
  showsFilterSettled: (
    evidence: { surface?: Record<string, unknown> | null },
    targetFocus: string
  ) => boolean;
  showsBoundaryTraversalSteps: () => Array<{
    column: number;
    index: number;
    key: 'ArrowDown' | 'ArrowUp';
    renderBoundary: '512-to-520' | '520-to-512' | null;
    row: number;
  }>;
  showsFocusPosition: (evidence: Record<string, any>) => {
    column: number;
    columns: number;
    index: number;
    row: number;
  } | null;
  showsLibraryEndReached: (evidence: Record<string, any>) => boolean;
  showsRowDelta: (
    before: Record<string, any>,
    after: Record<string, any>
  ) => number | null;
  summarizeRuntimeEvent: (event: Record<string, unknown>) => Record<string, unknown>;
  summarizeAtomicFocusSampling: (observations: Record<string, any>[]) => {
    diagnosticComparisonStatus: 'AGREE' | 'DISAGREE' | 'UNKNOWN';
    status: 'PASS' | 'UNKNOWN';
    unknownDirectionalSampleCount: number;
  };
  validateBoundaryAtomicStep: (
    evidence: Record<string, any>,
    expected: { column: number; index: number; row: number },
    pageInstanceId: string,
    beforePosition?: { column: number; columns: number; index: number; row: number } | null,
    key?: string | null
  ) => {
    checks: Record<string, boolean>;
    missing: string[];
    status: 'PASS' | 'FAIL' | 'UNKNOWN';
  };
  validateAppDirectory: (candidate: string) => string;
  validateSimulatorExecutable: (candidate: string) => string;
};

const cdp = require('../scripts/webos-cdp.cjs') as {
  isSafeLocalCdpUrl: (value: string) => boolean;
  selectAppTarget: (
    targets: Array<Record<string, unknown>>,
    appDirectory?: string
  ) => Record<string, unknown> | null;
  selectRcuTarget: (targets: Array<Record<string, unknown>>) => Record<string, unknown> | null;
  selectShellTarget: (targets: Array<Record<string, unknown>>) => Record<string, unknown> | null;
};

function withSimulatorFixture(run: (fixture: {
  appDir: string;
  root: string;
  simulatorDir: string;
  simulatorExe: string;
}) => void) {
  const root = mkdtempSync(join(tmpdir(), 'ptv-webos-simulator-'));
  const simulatorDir = join(root, 'webOS_TV_26_Simulator_1.5.0');
  const simulatorExe = join(simulatorDir, 'webOS_TV_26_Simulator_1.5.0.exe');
  const appDir = join(root, 'app');
  mkdirSync(simulatorDir);
  mkdirSync(appDir);
  writeFileSync(simulatorExe, 'fixture');
  writeFileSync(join(appDir, 'appinfo.json'), JSON.stringify({
    id: 'com.piggietv.webosnative',
    main: 'index.html',
    type: 'web',
    version: '0.1.8'
  }));
  writeFileSync(join(appDir, 'index.html'), '<!doctype html><title>PiggieTV</title>');

  try {
    run({ appDir, root, simulatorDir, simulatorExe });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function completeCoverageReport() {
  const exactRestorations = Array.from({ length: 5 }, () => ({ exactFocusRestored: true }));
  const filters = Array.from({ length: 5 }, () => ({ selected: true }));
  return {
    atomicFocusSampling: {
      diagnosticComparisonStatus: 'AGREE',
      status: 'PASS'
    },
    automatedDpad: 'PASS',
    cleanup: { portClosed: true, processTreeClosed: true },
    console: [],
    endurance: {
      completedMinutes: 30,
      cycles: 10,
      directionalSteps: 60,
      focusDriftFailures: 0,
      pointerOwnershipTransitionPasses: 2,
      pointerSwitches: 2,
      renderWindowTransitions: 10
    },
    lifecycle: {
      closeAndRelaunch: 'PASS',
      firstClose: { portClosed: true, processTreeClosed: true }
    },
    metadataNetwork: {
      duplicateActiveCount: 0,
      requests: [{ limit: 24, startIndex: 0 }]
    },
    metrics: {
      coverage: { artwork: true },
      maximumMetadata: 1_048,
      status: 'PASS'
    },
    observations: [{
      atomicFocus: {
        focusOwnerCount: 1,
        pageInstanceId: 'page-one',
        status: 'PASS'
      },
      kind: 'down',
      snapshot: { showsLibrary: { current: { hasMore: false } } },
      surface: { focusedElements: 99 }
    }],
    stress: {
      backwardRows: 60,
      detailsRestorations: exactRestorations,
      exactVerticalTraversal: true,
      filterResults: filters,
      forwardRows: 131,
      metadataRequestsAfterEnd: 0,
      renderWindowStarts: [0, 8],
      stoppedReason: 'library end reached'
    },
    surface: {
      bodyOverflow: 0,
      cardWidth: 180,
      documentVisibility: 'visible',
      gridColumns: 8,
      gridOverflow: 0,
      longTitleOverflow: 0,
      viewport: { height: 1080, width: 1920 }
    }
  };
}

function boundaryEvidenceAt(
  index: number,
  options: {
    focusOwnerCount?: number;
    logicalFocusId?: string | null;
    mode?: 'pointer' | 'remote' | null;
    pageInstanceId?: string | null;
    renderWindowStart?: number;
  } = {}
) {
  const renderWindowStart = options.renderWindowStart ?? 520;
  const focusId = `browse-shows-card-${index}`;
  const logicalFocusId = options.logicalFocusId === undefined ? focusId : options.logicalFocusId;
  const pageInstanceId = options.pageInstanceId === undefined ? 'page-one' : options.pageInstanceId;
  const mode = options.mode === undefined ? 'remote' : options.mode;
  return {
    atomicFocus: {
      column: index % 8,
      columnCount: 8,
      derivedGlobalFocusedIndex: index,
      focusInteractionAtSample: mode ? { mode, pointerBaselinePending: true } : null,
      focusOwnerCount: options.focusOwnerCount ?? 1,
      focusedCardOffset: index - renderWindowStart,
      focusedElement: { focusId, isConnected: true, tagName: 'BUTTON' },
      focusedId: focusId,
      logicalFocusIdAtSample: logicalFocusId,
      logicalNativeFocusAgreement: logicalFocusId === focusId,
      pageInstanceId,
      renderWindowStart,
      renderedCardCount: 96,
      row: Math.floor(index / 8),
      scrollTop: 24_640,
      status: 'PASS',
      timestamp: 123_456
    }
  };
}

describe('webOS TV Simulator workflow safety', () => {
  it('activates only the explicitly runner-owned Windows process ID', () => {
    const calls: any[][] = [];
    const activated = simulator.activateOwnedSimulatorWindow(
      { pid: 12_345 },
      (...args: any[]) => calls.push(args),
      'win32'
    );

    expect(activated).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('powershell.exe');
    expect(calls[0][1]).toEqual(expect.arrayContaining(['-NonInteractive', '-Command']));
    expect(calls[0][1].at(-1)).toContain('Get-Process -Id 12345');
    expect(calls[0][1].at(-1)).toContain('SetWindowPos');
    expect(calls[0][1].at(-1)).not.toContain('Stop-Process');
  });

  it('normalizes a minimized Simulator window before bringing PiggieTV forward', async () => {
    const calls: string[] = [];
    const shellSession = {
      call: async (method: string) => {
        calls.push(`shell:${method}`);
        if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
        if (method === 'Browser.getWindowBounds') return { bounds: { windowState: 'minimized' } };
        return {};
      },
      evaluate: async () => {
        calls.push('shell:window.focus');
      }
    };
    const appSession = {
      call: async (method: string) => {
        calls.push(`app:${method}`);
        return {};
      },
      evaluate: async () => {
        calls.push('app:window.focus');
      }
    };

    await simulator.activateSimulatorWindow(shellSession, appSession);

    expect(calls).toEqual([
      'shell:Browser.getWindowForTarget',
      'shell:Browser.getWindowBounds',
      'shell:Browser.setWindowBounds',
      'shell:Page.bringToFront',
      'shell:window.focus',
      'app:Page.bringToFront',
      'app:window.focus'
    ]);
  });

  it('accepts only an explicit TV Simulator executable or its containing directory', () => {
    withSimulatorFixture(({ root, simulatorDir, simulatorExe }) => {
      expect(simulator.validateSimulatorExecutable(simulatorExe)).toBe(resolve(simulatorExe));
      expect(simulator.validateSimulatorExecutable(simulatorDir)).toBe(resolve(simulatorExe));

      const unrelatedExe = join(root, 'not-the-simulator.exe');
      writeFileSync(unrelatedExe, 'fixture');
      expect(() => simulator.validateSimulatorExecutable(unrelatedExe)).toThrow(/Simulator/i);
      expect(() => simulator.validateSimulatorExecutable(join(root, 'missing.exe'))).toThrow();
    });
  });

  it('requires a launchable unpacked web-app directory', () => {
    withSimulatorFixture(({ appDir, root }) => {
      expect(simulator.validateAppDirectory(appDir)).toBe(resolve(appDir));

      const missingMain = join(root, 'missing-main');
      mkdirSync(missingMain);
      writeFileSync(join(missingMain, 'appinfo.json'), JSON.stringify({
        id: 'com.piggietv.webosnative',
        main: 'index.html',
        type: 'web',
        version: '0.1.8'
      }));
      expect(() => simulator.validateAppDirectory(missingMain)).toThrow(/index\.html|main/i);
      expect(() => simulator.validateAppDirectory(join(root, 'missing-app'))).toThrow();
    });
  });

  it('allows preparation to supply the app directory but requires it with --no-prepare', () => {
    withSimulatorFixture(({ appDir, root, simulatorDir }) => {
      expect(simulator.parseSimulatorArgs([
        '--simulator-version', '26',
        '--simulator-path', simulatorDir
      ], {}, root)).toMatchObject({
        appDir: join(root, 'dist', '.ptv-webos-package'),
        boundaryCrossings: 0,
        prepare: true,
        simulatorPath: simulatorDir,
        simulatorVersion: '26'
      });

      expect(simulator.parseSimulatorArgs([
        '--simulator-version', '26',
        '--simulator-path', simulatorDir,
        '--no-prepare',
        '--app-dir', appDir,
        '--auth-wait-minutes', '10',
        '--boundary-crossings', '100'
      ], {}, root)).toMatchObject({
        appDir,
        authWaitMinutes: 10,
        boundaryCrossings: 100,
        prepare: false,
        simulatorPath: simulatorDir,
        simulatorVersion: '26'
      });

      expect(() => simulator.parseSimulatorArgs([
        '--simulator-version', '26',
        '--simulator-path', simulatorDir,
        '--no-prepare'
      ], {}, root)).toThrow(/app(?:lication)? directory|app-dir/i);

      expect(() => simulator.parseSimulatorArgs([
        '--simulator-version', '26',
        '--simulator-path', simulatorDir,
        '--no-prepare',
        '--app-dir', appDir,
        '--auth-wait-minutes', '31'
      ], {}, root)).toThrow(/auth-wait-minutes/i);

      expect(() => simulator.parseSimulatorArgs([
        '--simulator-version', '26',
        '--simulator-path', simulatorDir,
        '--boundary-crossings', '2001'
      ], {}, root)).toThrow(/boundary-crossings/i);
    });
  });

  it('prepares Simulator candidates with diagnostics while preserving the package guard', () => {
    const calls: Array<{
      args: string[];
      command: string;
      options: Record<string, any>;
    }> = [];

    simulator.runPreparation(
      'C:\\repo',
      (command, args, options) => calls.push({ args, command, options }),
      'win32',
      { EXISTING_FLAG: 'kept' }
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      args: ['run', 'package'],
      command: 'npm.cmd',
      options: {
        cwd: 'C:\\repo',
        env: {
          EXISTING_FLAG: 'kept',
          PTV_DIAGNOSTICS: '1'
        },
        windowsHide: true
      }
    });
  });

  it('never accepts or inherits a physical-device alias', () => {
    withSimulatorFixture(({ simulatorDir }) => {
      const baseArgs = [
        '--simulator-version', '26',
        '--simulator-path', simulatorDir
      ];
      expect(() => simulator.parseSimulatorArgs([
        ...baseArgs,
        '--device', 'PiggieTV-LG'
      ], {})).toThrow(/device|physical/i);
      expect(() => simulator.parseSimulatorArgs(baseArgs, {
        PTV_WEBOS_TEST_DEVICE: 'PiggieTV-LG'
      })).toThrow(/device|physical/i);
      expect(() => simulator.parseSimulatorArgs(baseArgs, {
        PTV_WEBOS_SIMULATOR_PATH: simulatorDir,
        PTV_WEBOS_TEST_DEVICE: 'PiggieTV-LG'
      })).toThrow(/device|physical/i);

      const parsed = simulator.parseSimulatorArgs(baseArgs, {});
      expect(parsed).not.toHaveProperty('device');
      expect(parsed).not.toHaveProperty('deviceAlias');
    });
  });

  it('permits CDP only over an explicit loopback WebSocket endpoint', () => {
    expect(cdp.isSafeLocalCdpUrl('ws://127.0.0.1:9230/devtools/page/app')).toBe(true);
    expect(cdp.isSafeLocalCdpUrl('ws://localhost:9230/devtools/page/app')).toBe(true);
    expect(cdp.isSafeLocalCdpUrl('ws://0.0.0.0:9230/devtools/page/app')).toBe(false);
    expect(cdp.isSafeLocalCdpUrl('ws://192.168.1.20:9230/devtools/page/app')).toBe(false);
    expect(cdp.isSafeLocalCdpUrl('wss://127.0.0.1:9230/devtools/page/app')).toBe(false);
    expect(cdp.isSafeLocalCdpUrl('ws://user:secret@127.0.0.1:9230/devtools/page/app')).toBe(false);
  });

  it('selects the PiggieTV and virtual-RCU targets without falling back to another page', () => {
    const targets = [
      {
        id: 'simulator-shell',
        title: 'webOS TV 26 Simulator',
        type: 'page',
        url: 'file:///simulator/screen/main/index.html'
      },
      {
        id: 'virtual-rcu',
        title: 'Remote Control Unit',
        type: 'page',
        url: 'file:///simulator/screen/rcu/index.html'
      },
      {
        id: 'piggie-app',
        title: 'PiggieTV',
        type: 'page',
        url: 'file:///candidate/index.html'
      }
    ];

    expect(cdp.selectAppTarget(targets)).toMatchObject({ id: 'piggie-app' });
    expect(cdp.selectRcuTarget(targets)).toMatchObject({ id: 'virtual-rcu' });
    expect(cdp.selectShellTarget(targets)).toMatchObject({ id: 'simulator-shell' });
    expect(cdp.selectAppTarget(targets.filter(target => target.id !== 'piggie-app'))).toBeNull();
    expect(cdp.selectRcuTarget(targets.filter(target => target.id !== 'virtual-rcu'))).toBeNull();
    expect(cdp.selectShellTarget(targets.filter(target => target.id !== 'simulator-shell'))).toBeNull();
    expect(cdp.selectAppTarget(targets, 'C:/different-candidate')).toBeNull();
  });

  it('classifies only observed Shows-library invariant breaches', () => {
    const passingSnapshot = {
      focusOwnerCount: 1,
      showsLibrary: {
        current: {
          artworkActive: 6,
          duplicateMetadataRequest: false,
          focusedIndex: 80,
          focusOwnerCount: 1,
          metadataCount: 120,
          renderedCardCount: 96,
          renderWindowEnd: 120,
          renderWindowStart: 24
        },
        recentEvents: [
          { type: 'render-window-change', initialBatch: true, metadataCount: 24 },
          { type: 'render-window-change', metadataCount: 48 },
          { type: 'render-window-change', metadataCount: 72 },
          { type: 'render-window-change', metadataCount: 96 }
        ]
      }
    };

    expect(simulator.classifySimulatorMetrics(passingSnapshot)).toMatchObject({
      ok: true,
      violations: []
    });
    expect(simulator.classifySimulatorMetrics({})).toMatchObject({
      ok: true,
      status: 'UNKNOWN',
      violations: []
    });

    expect(simulator.classifySimulatorMetrics({
      focusOwnerCount: 2,
      showsLibrary: {
        current: {
          artworkActive: 7,
          duplicateMetadataRequest: true,
          focusedIndex: 120,
          focusOwnerCount: 2,
          metadataCount: 49,
          renderedCardCount: 97,
          renderWindowEnd: 120,
          renderWindowStart: 24
        },
        recentEvents: [
          { type: 'render-window-change', initialBatch: true, metadataCount: 25 },
          { type: 'render-window-change', metadataCount: 49 }
        ]
      }
    }).violations).toEqual(expect.arrayContaining([
      'INITIAL_BATCH_LIMIT',
      'RENDER_WINDOW_LIMIT',
      'ARTWORK_CONCURRENCY_LIMIT',
      'FOCUS_OUTSIDE_WINDOW',
      'FOCUS_OWNER_COUNT',
      'DUPLICATE_METADATA_REQUEST'
    ]));
  });

  it('recursively removes secrets and private media identifiers from artifacts', () => {
    const sanitized = simulator.sanitizeSimulatorArtifact({
      count: 1_048,
      itemId: 'private-jellyfin-item-id',
      nested: [{ password: 'hunter2' }, { accessToken: 'token-secret' }],
      streamUrl: 'https://piggietv.com/Videos/private-jellyfin-item-id/stream?api_key=query-secret'
    });
    const serialized = JSON.stringify(sanitized);

    expect(serialized).toContain('1048');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('token-secret');
    expect(serialized).not.toContain('query-secret');
    expect(serialized).not.toContain('private-jellyfin-item-id');
  });

  it('cannot report complete Simulator coverage from a partial stress run', () => {
    const partial = simulator.evaluateAcceptanceCoverage({
      automatedDpad: 'PASS',
      console: [],
      endurance: { completedMinutes: 0 },
      metrics: {
        coverage: { artwork: true },
        maximumMetadata: 120,
        status: 'PASS'
      },
      stress: {
        backwardRows: 10,
        detailsRestorations: [{ exactFocusRestored: true }],
        filterResults: [{ selected: true }],
        forwardRows: 50,
        renderWindowStarts: [0, 24],
        stoppedReason: null
      },
      surface: {
        bodyOverflow: 0,
        gridColumns: 8,
        gridOverflow: 0,
        longTitleOverflow: 0,
        viewport: { height: 1080, width: 1920 }
      }
    }, { enduranceMinutes: 0, lifecycleCycle: true });

    expect(partial.complete).toBe(false);
    expect(partial.missing).toEqual(expect.arrayContaining([
      'detailsBackFiveDepths',
      'enduranceThirtyMinutes',
      'fullLibraryReached',
      'lifecycleFirstCloseCleanup',
      'upwardReconstruction'
    ]));
  });

  it('requires every acceptance check to be the boolean true and never trusts surface focus ownership', () => {
    const complete = completeCoverageReport();
    expect(simulator.evaluateAcceptanceCoverage(
      complete,
      { enduranceMinutes: 30, lifecycleCycle: true }
    )).toMatchObject({ complete: true, missing: [] });

    const badAtomicOwner = completeCoverageReport();
    badAtomicOwner.observations[0].atomicFocus.focusOwnerCount = 2;
    badAtomicOwner.observations[0].surface.focusedElements = 1;
    expect(simulator.evaluateAcceptanceCoverage(
      badAtomicOwner,
      { enduranceMinutes: 30, lifecycleCycle: true }
    ).missing).toContain('focusOwnerOne');

    const truthyTraversal = completeCoverageReport();
    truthyTraversal.stress.exactVerticalTraversal = 'PASS' as unknown as boolean;
    expect(simulator.evaluateAcceptanceCoverage(
      truthyTraversal,
      { enduranceMinutes: 30, lifecycleCycle: true }
    ).missing).toContain('traversalExactVerticalRows');
  });

  it('treats warning and missing console telemetry as unclean acceptance evidence', () => {
    expect(simulator.classifyRuntimeConsole([])).toMatchObject({ issueCount: 0, status: 'PASS' });
    expect(simulator.classifyRuntimeConsole(undefined)).toMatchObject({ status: 'UNKNOWN' });
    expect(simulator.classifyRuntimeConsole([{
      level: 'warning',
      method: 'Log.entryAdded'
    }])).toMatchObject({ issueCount: 1, status: 'FAIL' });
    expect(simulator.classifyRuntimeConsole([{
      method: 'Runtime.consoleAPICalled',
      type: 'warn'
    }])).toMatchObject({ issueCount: 1, status: 'FAIL' });
    expect(simulator.classifyRuntimeConsole([{
      method: 'Runtime.consoleAPICalled'
    }])).toMatchObject({ status: 'UNKNOWN' });

    for (const consoleEvidence of [
      undefined,
      [{ level: 'warning', method: 'Log.entryAdded' }]
    ]) {
      const report = completeCoverageReport() as Record<string, any>;
      report.console = consoleEvidence;
      expect(simulator.evaluateAcceptanceCoverage(
        report,
        { enduranceMinutes: 30, lifecycleCycle: true }
      ).missing).toContain('consoleClean');
    }
  });

  it('retains a complete endurance progress object for early and unexpected failures', async () => {
    const activationFailure = await simulator.runEndurance(
      {},
      {},
      1,
      [],
      { reactivate: async () => false }
    ).then(() => null, error => error as Error & { enduranceProgress: Record<string, any> });
    expect(activationFailure?.enduranceProgress).toMatchObject({
      completedMinutes: 0,
      cycles: 0,
      directionalSteps: 0,
      failedCycle: 0,
      failedInputSequence: [],
      failedPhase: 'activation',
      focusDriftFailures: 0,
      pointerOwnershipTransitionPasses: 0,
      pointerSwitches: 0,
      renderWindowTransitions: 0
    });

    const readFailure = await simulator.runEndurance(
      { evaluate: async () => { throw new Error('CDP read failed'); } },
      {},
      1,
      [],
      { reactivate: async () => true }
    ).then(() => null, error => error as Error & { enduranceProgress: Record<string, any> });
    expect(readFailure?.enduranceProgress).toMatchObject({
      cycles: 0,
      directionalSteps: 0,
      failedCycle: 0,
      failedPhase: 'initial'
    });

    const partial = simulator.attachEnduranceProgress(
      Object.assign(new Error('late failure'), {
        enduranceProgress: { failedPhase: 'down-2' }
      }),
      {
        completedMinutes: 1.7,
        cycles: 87,
        directionalSteps: 524,
        focusDriftFailures: 1,
        pointerOwnershipTransitionPasses: 2,
        pointerSwitches: 2,
        renderWindowTransitions: 176
      }
    );
    expect(partial.enduranceProgress).toMatchObject({
      completedMinutes: 1.7,
      cycles: 87,
      directionalSteps: 524,
      failedPhase: 'down-2',
      focusDriftFailures: 1,
      pointerOwnershipTransitionPasses: 2,
      pointerSwitches: 2,
      renderWindowTransitions: 176
    });
  });

  it('requires both the first lifecycle process tree and its CDP port to close', () => {
    expect(simulator.processCleanupSucceeded({
      portClosed: true,
      processTreeClosed: true
    })).toBe(true);
    expect(simulator.processCleanupSucceeded({
      portClosed: true,
      processTreeClosed: false
    })).toBe(false);
    expect(simulator.processCleanupSucceeded({
      portClosed: false,
      processTreeClosed: true
    })).toBe(false);
    expect(simulator.processCleanupSucceeded(null)).toBe(false);
  });

  it('attaches runtime, log, and network telemetry to a relaunched app session', async () => {
    const enabledDomains: string[] = [];
    const handledEvents: Record<string, any>[] = [];
    const runtimeEvents: Record<string, any>[] = [];
    let listener: ((event: Record<string, any>) => void) | null = null;
    const session = {
      call: async (method: string) => enabledDomains.push(method),
      onEvent: (nextListener: (event: Record<string, any>) => void) => {
        listener = nextListener;
      }
    };

    simulator.attachAppSessionTelemetry(session, {
      handle: event => handledEvents.push(event)
    }, runtimeEvents, 'relaunch');
    await simulator.enableAppSessionTelemetry(session);
    listener?.({ method: 'Network.requestWillBeSent', params: {} });
    listener?.({
      method: 'Runtime.exceptionThrown',
      params: { exceptionDetails: { text: 'relaunch failure' } }
    });

    expect(enabledDomains).toEqual(expect.arrayContaining([
      'Runtime.enable',
      'Log.enable',
      'Network.enable',
      'Page.enable'
    ]));
    expect(handledEvents).toHaveLength(2);
    expect(runtimeEvents).toHaveLength(1);
    expect(simulator.summarizeRuntimeEvent(runtimeEvents[0])).toMatchObject({
      method: 'Runtime.exceptionThrown',
      phase: 'relaunch'
    });
  });

  it('dispatches two distinct in-card coordinates for deterministic pointer reactivation', async () => {
    const calls: Array<{ method: string; params?: Record<string, any> }> = [];
    const coordinates = await simulator.dispatchPointerMove({
      call: async (method, params) => calls.push({ method, params })
    }, { x: 420, y: 240 }, 0);

    expect(coordinates).toEqual([
      { x: 417, y: 240 },
      { x: 420, y: 240 }
    ]);
    expect(calls).toEqual([
      {
        method: 'Input.dispatchMouseEvent',
        params: expect.objectContaining({ type: 'mouseMoved', x: 417, y: 240 })
      },
      {
        method: 'Input.dispatchMouseEvent',
        params: expect.objectContaining({ type: 'mouseMoved', x: 420, y: 240 })
      }
    ]);
    expect(simulator.pointerMoveCoordinates(
      { x: 420, y: 240 },
      { lastPointerX: 417, lastPointerY: 240 }
    )).toEqual([
      { x: 414, y: 240 },
      { x: 420, y: 240 }
    ]);
  });

  it('requires the complete captured pointer ownership-state transition sequence', () => {
    const evidence = (
      mode: 'pointer' | 'remote',
      pointerBaselinePending: boolean,
      coordinate?: { x: number; y: number }
    ) => ({
      atomicFocus: {
        focusInteractionAtSample: {
          lastPointerMotionTimestamp: coordinate ? 123_456 : null,
          lastPointerX: coordinate?.x ?? null,
          lastPointerY: coordinate?.y ?? null,
          mode,
          pointerBaselinePending
        },
        status: 'PASS'
      }
    });

    expect(simulator.pointerOwnershipTransitionMatches(
      evidence('remote', true),
      { mode: 'remote', pointerBaselinePending: true }
    )).toBe(true);
    expect(simulator.pointerOwnershipTransitionMatches(
      evidence('remote', false, { x: 417, y: 240 }),
      {
        coordinate: { x: 417, y: 240 },
        mode: 'remote',
        pointerBaselinePending: false
      }
    )).toBe(true);
    expect(simulator.pointerOwnershipTransitionMatches(
      evidence('pointer', false, { x: 420, y: 240 }),
      {
        coordinate: { x: 420, y: 240 },
        mode: 'pointer',
        pointerBaselinePending: false
      }
    )).toBe(true);
    expect(simulator.pointerOwnershipTransitionMatches(
      evidence('remote', true, { x: 420, y: 240 }),
      { mode: 'remote', pointerBaselinePending: true }
    )).toBe(true);

    expect(simulator.pointerOwnershipTransitionMatches(
      evidence('remote', true, { x: 417, y: 240 }),
      {
        coordinate: { x: 417, y: 240 },
        mode: 'remote',
        pointerBaselinePending: false
      }
    )).toBe(false);
    expect(simulator.pointerOwnershipTransitionMatches(
      { atomicFocus: { status: 'PASS' } },
      { mode: 'remote', pointerBaselinePending: true }
    )).toBe(false);
    expect(simulator.pointerOwnershipTransitionMatches(
      evidence('pointer', false, { x: 419, y: 240 }),
      {
        coordinate: { x: 420, y: 240 },
        mode: 'pointer',
        pointerBaselinePending: false
      }
    )).toBe(false);

    const missingTransitionCount = completeCoverageReport();
    delete (missingTransitionCount.endurance as Record<string, unknown>)
      .pointerOwnershipTransitionPasses;
    expect(simulator.evaluateAcceptanceCoverage(
      missingTransitionCount,
      { enduranceMinutes: 30, lifecycleCycle: true }
    ).missing).toContain('pointerOwnershipStress');
  });

  it('drops raw console argument values before artifact serialization', () => {
    const summarized = simulator.summarizeRuntimeEvent({
      method: 'Runtime.consoleAPICalled',
      validationPhase: 'relaunch',
      params: {
        args: [{ type: 'string', value: 'SUPERSECRET123' }],
        timestamp: 123,
        type: 'log'
      }
    });

    expect(JSON.stringify(summarized)).not.toContain('SUPERSECRET123');
    expect(summarized).toMatchObject({
      argumentTypes: ['string'],
      phase: 'relaunch',
      type: 'log'
    });
  });

  it('records only bounded Series metadata request coordinates', () => {
    expect(simulator.parseMetadataRequest(
      'https://piggietv.com/Users/private-user/Items?IncludeItemTypes=Series&StartIndex=24&Limit=24&SortBy=SortName&EnableTotalRecordCount=true&api_key=secret'
    )).toEqual({ filter: 'az', limit: 24, startIndex: 24 });
    expect(simulator.parseMetadataRequest(
      'https://piggietv.com/Users/private-user/Items?IncludeItemTypes=Movie&StartIndex=0&Limit=24'
    )).toBeNull();
    expect(simulator.parseMetadataRequest(
      'https://piggietv.com/Users/private-user/Items?IncludeItemTypes=Series&StartIndex=0&Limit=16&SortBy=DateCreated&EnableTotalRecordCount=false'
    )).toBeNull();
    expect(simulator.parseMetadataRequest(
      'https://piggietv.com/Users/private-user/Items?IncludeItemTypes=Series&StartIndex=0&Limit=24&SortBy=SortName&Filters=IsFavorite&EnableTotalRecordCount=true'
    )).toEqual({ filter: 'favorites', limit: 24, startIndex: 0 });
  });

  it('waits for each Shows filter reset to settle before traversal', () => {
    const surface = {
      cardCount: 24,
      selectedFilterId: 'browse-filter-recent',
      showsBusy: false,
      showsError: false
    };

    expect(simulator.showsFilterSettled({ surface }, 'browse-filter-recent')).toBe(true);
    expect(simulator.showsFilterSettled({ surface: { ...surface, cardCount: 0 } }, 'browse-filter-recent')).toBe(false);
    expect(simulator.showsFilterSettled({ surface: { ...surface, showsBusy: true } }, 'browse-filter-recent')).toBe(false);
    expect(simulator.showsFilterSettled({ surface: { ...surface, selectedFilterId: 'browse-filter-az' } }, 'browse-filter-recent')).toBe(false);
    expect(simulator.showsFilterSettled({
      surface: {
        ...surface,
        cardCount: 0,
        selectedFilterId: 'browse-filter-favorites'
      }
    }, 'browse-filter-favorites')).toBe(true);
  });

  it('recognizes the final focused row only after the library is complete', () => {
    const evidence = {
      state: {
        currentFocusId: 'browse-shows-private-id',
        shows: {
          currentColumns: 8,
          focusedIndex: 1_027,
          hasMore: false,
          metadataCount: 1_048,
          renderWindowStart: 952
        }
      },
      surface: { focusedCardOffset: 88, gridColumns: 8 }
    };

    expect(simulator.showsLibraryEndReached(evidence)).toBe(true);
    expect(simulator.showsLibraryEndReached({
      ...evidence,
      state: { ...evidence.state },
      surface: { focusedCardOffset: 80, gridColumns: 8 }
    })).toBe(false);
    expect(simulator.showsLibraryEndReached({
      ...evidence,
      state: {
        ...evidence.state,
        shows: { ...evidence.state.shows, hasMore: true }
      }
    })).toBe(false);
  });

  it('derives stable absolute Shows positions from the render window and DOM offset', () => {
    const evidence = {
      state: {
        currentFocusId: 'browse-shows-private-id',
        shows: { currentColumns: 8, renderWindowStart: 952 }
      },
      surface: { focusedCardOffset: 88, gridColumns: 8 }
    };

    expect(simulator.showsFocusPosition(evidence)).toEqual({
      column: 0,
      columns: 8,
      index: 1_040,
      row: 130
    });
    expect(simulator.showsFocusPosition({
      ...evidence,
      state: { ...evidence.state, currentFocusId: 'browse-filter-recent' }
    })).toBeNull();
    expect(simulator.showsFocusPosition({
      ...evidence,
      surface: { focusedCardOffset: null, gridColumns: 8 }
    })).toBeNull();
  });

  it('counts only real absolute row movement in either direction', () => {
    const evidenceAt = (offset: number, start = 0) => ({
      state: {
        currentFocusId: `browse-shows-${start + offset}`,
        shows: { currentColumns: 8, renderWindowStart: start }
      },
      surface: { focusedCardOffset: offset, gridColumns: 8 }
    });

    expect(simulator.showsRowDelta(evidenceAt(0), evidenceAt(8))).toBe(1);
    expect(simulator.showsRowDelta(evidenceAt(8), evidenceAt(9))).toBeNull();
    expect(simulator.showsRowDelta(evidenceAt(16), evidenceAt(8))).toBe(-1);
    expect(simulator.showsRowDelta(evidenceAt(88, 0), evidenceAt(64, 24))).toBe(0);
    expect(simulator.showsRowDelta(
      evidenceAt(0),
      { ...evidenceAt(8), state: { ...evidenceAt(8).state, currentFocusId: 'browse-filter-recent' } }
    )).toBeNull();
  });

  it.each([
    ['ArrowDown', { column: 0, columns: 8, index: 568, row: 71 }],
    ['ArrowUp', { column: 0, columns: 8, index: 552, row: 69 }],
    ['ArrowRight', { column: 1, columns: 8, index: 561, row: 70 }]
  ])('checks the exact atomic position after each %s input', (key, after) => {
    const before = { column: 0, columns: 8, index: 560, row: 70 };
    expect(simulator.compareExactDirectionalStep(before, after, key)).toMatchObject({
      actual: {
        column: after.column,
        index: after.index,
        row: after.row
      },
      ok: true
    });
  });

  it('rejects transient lateral drift and missing atomic directional positions', () => {
    const before = { column: 0, columns: 8, index: 560, row: 70 };
    expect(simulator.compareExactDirectionalStep(
      { column: 1, columns: 8, index: 561, row: 70 },
      before,
      'ArrowLeft'
    ).ok).toBe(true);
    expect(simulator.compareExactDirectionalStep(before, {
      column: 2,
      columns: 8,
      index: 570,
      row: 71
    }, 'ArrowDown').ok).toBe(false);
    expect(simulator.compareExactDirectionalStep(before, {
      column: 0,
      columns: 8,
      index: 576,
      row: 72
    }, 'ArrowDown').ok).toBe(false);
    expect(simulator.compareExactDirectionalStep(before, {
      column: 0,
      columns: 8,
      index: 544,
      row: 68
    }, 'ArrowUp').ok).toBe(false);
    expect(simulator.compareExactDirectionalStep(before, {
      column: 0,
      columns: 8,
      index: 568,
      row: 71
    }, 'ArrowDown').ok).toBe(true);
    expect(simulator.compareExactDirectionalStep(before, {
      column: 0,
      columns: 8,
      index: 552,
      row: 69
    }, 'ArrowUp').ok).toBe(true);
    expect(simulator.compareExactDirectionalStep(before, null, 'ArrowDown')).toEqual({
      ok: false,
      reason: 'missing-or-incompatible-position'
    });
  });

  it('defines the exact 552 through 600 boundary path and counts both render-boundary directions', () => {
    const steps = simulator.showsBoundaryTraversalSteps();
    expect(steps.map(step => step.index)).toEqual([
      560, 568, 576, 584, 592, 600,
      592, 584, 576, 568, 560, 552
    ]);
    expect(steps.every(step => step.column === 0)).toBe(true);
    expect(steps.filter(step => step.renderBoundary)).toEqual([
      expect.objectContaining({
        index: 576,
        key: 'ArrowDown',
        renderBoundary: '512-to-520'
      }),
      expect.objectContaining({
        index: 568,
        key: 'ArrowUp',
        renderBoundary: '520-to-512'
      })
    ]);
  });

  it('requires complete authoritative atomic boundary evidence after every key', () => {
    const before = { column: 0, columns: 8, index: 568, row: 71 };
    const passing = boundaryEvidenceAt(576, { renderWindowStart: 520 });
    expect(simulator.validateBoundaryAtomicStep(
      passing,
      { column: 0, index: 576, row: 72 },
      'page-one',
      before,
      'ArrowDown'
    )).toMatchObject({ status: 'PASS' });

    for (const [label, evidence] of [
      ['logical disagreement', boundaryEvidenceAt(576, {
        logicalFocusId: 'browse-filter-recent',
        renderWindowStart: 520
      })],
      ['pointer mode', boundaryEvidenceAt(576, { mode: 'pointer', renderWindowStart: 520 })],
      ['two owners', boundaryEvidenceAt(576, { focusOwnerCount: 2, renderWindowStart: 520 })],
      ['new page', boundaryEvidenceAt(576, { pageInstanceId: 'page-two', renderWindowStart: 520 })]
    ] as const) {
      expect(simulator.validateBoundaryAtomicStep(
        evidence,
        { column: 0, index: 576, row: 72 },
        'page-one',
        before,
        'ArrowDown'
      ), label).toMatchObject({ status: 'FAIL' });
    }

    const missingLogical = boundaryEvidenceAt(576, { renderWindowStart: 520 });
    delete missingLogical.atomicFocus.logicalFocusIdAtSample;
    delete missingLogical.atomicFocus.logicalNativeFocusAgreement;
    expect(simulator.validateBoundaryAtomicStep(
      missingLogical,
      { column: 0, index: 576, row: 72 },
      'page-one',
      before,
      'ArrowDown'
    )).toMatchObject({
      missing: expect.arrayContaining(['logicalFocusId']),
      status: 'UNKNOWN'
    });

    expect(simulator.validateBoundaryAtomicStep(
      boundaryEvidenceAt(584, { renderWindowStart: 520 }),
      { column: 0, index: 576, row: 72 },
      'page-one',
      before,
      'ArrowDown'
    )).toMatchObject({ status: 'FAIL' });
  });

  it('preserves partial concentrated-boundary progress on the first mismatch', () => {
    const error = simulator.attachBoundaryCrossingProgress(
      Object.assign(new Error('boundary mismatch'), {
        boundaryProgress: { failedPhase: 'path' }
      }),
      {
        completedCrossings: 8,
        completedExactKeySteps: 47,
        cyclesCompleted: 3,
        failureCount: 1,
        focusDriftFailures: 1,
        logicalNativeDisagreementCount: 1,
        renderBoundaryCrossings: 8,
        requestedCrossings: 100,
        status: 'FAIL'
      }
    );
    expect(error.boundaryProgress).toMatchObject({
      completedCrossings: 8,
      completedExactKeySteps: 47,
      cyclesCompleted: 3,
      failedPhase: 'path',
      failureCount: 1,
      focusDriftFailures: 1,
      logicalNativeDisagreementCount: 1,
      renderBoundaryCrossings: 8,
      requestedCrossings: 100,
      status: 'FAIL'
    });
  });

  it('runs one exact boundary round trip and stops at the first strict atomic mismatch', async () => {
    const renderStart = (index: number) => ({
      552: 504,
      560: 512,
      568: 512,
      576: 520,
      584: 528,
      592: 536,
      600: 544
    })[index] ?? 0;
    const path = [
      552,
      ...simulator.showsBoundaryTraversalSteps().map(step => step.index)
    ];
    const evidence = path.map(index => boundaryEvidenceAt(index, {
      renderWindowStart: renderStart(index)
    }));
    const sentKeys: string[] = [];
    const passing = await simulator.runShowsBoundaryCrossingGate(
      {},
      {},
      2,
      [],
      {
        reactivate: async () => true,
        readStableEvidence: async () => evidence.shift(),
        sendKey: async (_app: unknown, _rcu: unknown, key: string) => sentKeys.push(key)
      }
    );
    expect(passing).toMatchObject({
      completedCrossings: 2,
      completedExactKeySteps: 12,
      cyclesCompleted: 1,
      failureCount: 0,
      finalIndex: 552,
      logicalNativeDisagreementCount: 0,
      renderBoundaryBackwardCrossings: 1,
      renderBoundaryCrossings: 2,
      renderBoundaryForwardCrossings: 1,
      requestedCrossings: 2,
      status: 'PASS'
    });
    expect(sentKeys).toEqual(simulator.showsBoundaryTraversalSteps().map(step => step.key));

    const mismatchingEvidence = [
      boundaryEvidenceAt(552, { renderWindowStart: 504 }),
      boundaryEvidenceAt(560, { renderWindowStart: 512 }),
      boundaryEvidenceAt(568, { renderWindowStart: 512 }),
      boundaryEvidenceAt(576, {
        logicalFocusId: 'browse-filter-recent',
        renderWindowStart: 520
      }),
      boundaryEvidenceAt(584, { renderWindowStart: 528 })
    ];
    const mismatchingKeys: string[] = [];
    const failure = await simulator.runShowsBoundaryCrossingGate(
      {},
      {},
      2,
      [],
      {
        reactivate: async () => true,
        readStableEvidence: async () => mismatchingEvidence.shift(),
        sendKey: async (_app: unknown, _rcu: unknown, key: string) => mismatchingKeys.push(key)
      }
    ).then(() => null, error => error as Error & { boundaryProgress: Record<string, any> });
    expect(failure?.boundaryProgress).toMatchObject({
      completedCrossings: 0,
      completedExactKeySteps: 2,
      failureCount: 1,
      focusDriftFailures: 1,
      logicalNativeDisagreementCount: 1,
      renderBoundaryCrossings: 0,
      requestedCrossings: 2,
      status: 'FAIL'
    });
    expect(failure?.boundaryProgress.failedPhase).toBe('path');
    expect(mismatchingKeys).toEqual(['ArrowDown', 'ArrowDown', 'ArrowDown']);
    expect(mismatchingEvidence).toHaveLength(1);
  });

  it('interprets 100 requested crossings as 50 round trips and 600 exact key validations', async () => {
    const steps = simulator.showsBoundaryTraversalSteps();
    const renderStart = (index: number) => ({
      552: 504,
      560: 512,
      568: 512,
      576: 520,
      584: 528,
      592: 536,
      600: 544
    })[index] ?? 0;
    const indices = [
      552,
      ...Array.from({ length: 50 }, () => steps.map(step => step.index)).flat()
    ];
    const evidence = indices.map(index => boundaryEvidenceAt(index, {
      renderWindowStart: renderStart(index)
    }));
    let sentKeyCount = 0;
    const result = await simulator.runShowsBoundaryCrossingGate(
      {},
      {},
      100,
      [],
      {
        reactivate: async () => true,
        readStableEvidence: async () => evidence.shift(),
        sendKey: async () => { sentKeyCount += 1; }
      }
    );

    expect(result).toMatchObject({
      completedCrossings: 100,
      completedExactKeySteps: 600,
      cyclesCompleted: 50,
      renderBoundaryBackwardCrossings: 50,
      renderBoundaryCrossings: 100,
      renderBoundaryForwardCrossings: 50,
      requestedCrossings: 100,
      status: 'PASS'
    });
    expect(sentKeyCount).toBe(600);
    expect(evidence).toHaveLength(0);
  });

  it('requires complete concentrated-boundary counts only when the mode is requested', () => {
    const report = completeCoverageReport() as Record<string, any>;
    expect(simulator.evaluateAcceptanceCoverage(
      report,
      { boundaryCrossings: 0, enduranceMinutes: 30, lifecycleCycle: true }
    ).missing).not.toContain('boundaryCrossingGate');

    report.boundaryCrossingGate = {
      completedCrossings: 100,
      completedExactKeySteps: 600,
      cyclesCompleted: 50,
      failureCount: 0,
      focusDriftFailures: 0,
      logicalNativeDisagreementCount: 0,
      renderBoundaryBackwardCrossings: 50,
      renderBoundaryCrossings: 100,
      renderBoundaryForwardCrossings: 50,
      requestedCrossings: 100,
      status: 'PASS'
    };
    expect(simulator.evaluateAcceptanceCoverage(
      report,
      { boundaryCrossings: 100, enduranceMinutes: 30, lifecycleCycle: true }
    ).missing).not.toContain('boundaryCrossingGate');

    for (const mutation of [
      (gate: Record<string, any>) => { gate.status = 'UNKNOWN'; },
      (gate: Record<string, any>) => { gate.failureCount = 1; },
      (gate: Record<string, any>) => { gate.logicalNativeDisagreementCount = 1; },
      (gate: Record<string, any>) => { delete gate.renderBoundaryBackwardCrossings; }
    ]) {
      const incomplete = structuredClone(report);
      mutation(incomplete.boundaryCrossingGate);
      expect(simulator.evaluateAcceptanceCoverage(
        incomplete,
        { boundaryCrossings: 100, enduranceMinutes: 30, lifecycleCycle: true }
      ).missing).toContain('boundaryCrossingGate');
    }
  });

  it('derives one global Shows index from a single atomic Runtime.evaluate sample', async () => {
    const expressions: string[] = [];
    const columnTemplate = Array.from({ length: 8 }, () => '180px').join(' ');
    document.body.innerHTML = `
      <div class="ptv-browse--shows">
        <div class="ptv-browse__viewport">
          <div class="ptv-shows-window-spacer"></div>
          <ul
            class="ptv-poster-grid"
            style="display:grid;grid-template-columns:${columnTemplate};row-gap:30px"
          >
            ${Array.from({ length: 96 }, (_, index) => `
              <li><button
                class="ptv-card-btn${index === 50 ? ' is-focused' : ''}"
                data-focus-id="browse-shows-card-${index}"
              ></button></li>
            `).join('')}
          </ul>
        </div>
      </div>
    `;
    const viewport = document.querySelector<HTMLElement>('.ptv-browse__viewport');
    const spacer = document.querySelector<HTMLElement>('.ptv-shows-window-spacer');
    const cards = document.querySelectorAll<HTMLElement>('.ptv-card-btn');
    if (!viewport || !spacer || cards.length !== 96 || !cards[50]) {
      throw new Error('Atomic focus fixture did not render.');
    }
    viewport.scrollTop = 24_640;
    spacer.getBoundingClientRect = () => ({ height: 65 * 352 } as DOMRect);
    cards[0].getBoundingClientRect = () => ({ height: 322 } as DOMRect);
    cards[50].focus();
    window.sessionStorage.setItem('ptv.runtimeDiagnostics.pageInstanceId.v1', 'page-one');
    Object.defineProperty(window, '__ptvDiagnosticHealth', {
      configurable: true,
      value: Object.freeze({
        snapshot: () => ({
          lastHeartbeat: {
            focusInteraction: {
              lastPointerMotionTimestamp: 120_000,
              lastPointerX: 417,
              lastPointerY: 240,
              mode: 'remote',
              pointerBaselinePending: true
            },
            lastFocusTransition: {
              direction: 'up',
              inputKey: 'ArrowUp',
              nextFocusId: 'browse-shows-private-id',
              reason: 'directional'
            },
            pageInstanceId: 'page-one'
          },
          page: { pageInstanceId: 'page-one' },
          showsLibrary: {
            current: {
              currentColumns: 8,
              focusedIndex: 578,
              pageInstanceId: 'page-one',
              renderedCardCount: 96,
              renderWindowStart: 520,
              scrollTop: 24_640
            }
          }
        })
      })
    });

    let sample: Record<string, any>;
    try {
      sample = await simulator.readAtomicShowsFocusSample({
        evaluate: async expression => {
          expressions.push(expression);
          return window.eval(expression) as Record<string, any>;
        }
      });
    } finally {
      delete (window as unknown as Record<string, unknown>).__ptvDiagnosticHealth;
      window.sessionStorage.removeItem('ptv.runtimeDiagnostics.pageInstanceId.v1');
      document.body.innerHTML = '';
    }

    expect(expressions).toHaveLength(1);
    expect(expressions[0]).toContain("querySelector('.ptv-poster-grid')");
    expect(expressions[0]).toContain('ptv.runtimeDiagnostics.pageInstanceId.v1');
    expect(simulator.deriveShowsRenderWindowStartFromGeometry(
      8,
      true,
      65 * 352,
      322,
      30
    )).toEqual({
      renderWindowStart: 520,
      renderWindowStartSource: 'dom-top-spacer'
    });
    expect(sample).toMatchObject({
      column: 2,
      columnCount: 8,
      derivedGlobalFocusedIndex: 570,
      focusInteractionAtSample: {
        mode: 'remote',
        pointerBaselinePending: true
      },
      focusedCardOffset: 50,
      lastFocusTransitionAtSample: {
        inputKey: 'ArrowUp',
        reason: 'directional'
      },
      renderWindowStart: 520,
      row: 71,
      status: 'PASS'
    });
  });

  it('derives a zero window start without a top spacer and rejects malformed atomic positions', () => {
    expect(simulator.deriveShowsRenderWindowStartFromGeometry(
      8,
      false,
      0,
      322,
      30
    )).toEqual({
      renderWindowStart: 0,
      renderWindowStartSource: 'dom-no-top-spacer'
    });

    const valid = {
      columnCount: 8,
      focusOwnerCount: 1,
      focusedCardOffset: 0,
      focusedElement: {
        focusId: 'browse-shows-private-id',
        isConnected: true,
        tagName: 'BUTTON'
      },
      pageInstanceId: 'page-one',
      renderWindowStart: 0,
      renderWindowStartSource: 'dom-no-top-spacer',
      renderedCardCount: 24,
      scrollTop: 0,
      timestamp: 123_456
    };
    expect(simulator.normalizeAtomicShowsFocusSample(valid).status).toBe('PASS');
    for (const malformed of [
      { focusedCardOffset: 24 },
      { focusedCardOffset: 0.5 },
      { renderWindowStart: -8 },
      { renderWindowStart: 4 },
      { renderedCardCount: 0 },
      { columnCount: 0 },
      { focusOwnerCount: 2 },
      { scrollTop: -1 }
    ]) {
      expect(simulator.normalizeAtomicShowsFocusSample({
        ...valid,
        ...malformed
      }).status).toBe('UNKNOWN');
    }
  });

  it('keeps asynchronous app diagnostics from corrupting the atomic focus assertion', () => {
    const atomicFocus = simulator.normalizeAtomicShowsFocusSample({
      columnCount: 8,
      focusOwnerCount: 1,
      focusedCardOffset: 56,
      focusedElement: {
        focusId: 'browse-shows-private-id',
        isConnected: true,
        tagName: 'BUTTON'
      },
      pageInstanceId: 'page-one',
      renderWindowStart: 520,
      renderWindowStartSource: 'dom-top-spacer',
      renderedCardCount: 96,
      scrollTop: 24_640,
      timestamp: 123_456
    });
    const evidence = {
      atomicFocus,
      // These values model an asynchronously published diagnostic/surface pair.
      state: {
        currentFocusId: 'browse-shows-private-id',
        shows: { currentColumns: 8, focusedIndex: 578, renderWindowStart: 520 }
      },
      surface: { focusedCardOffset: 58, gridColumns: 8 }
    };

    expect(simulator.showsFocusPosition(evidence)).toEqual({
      column: 0,
      columns: 8,
      index: 576,
      row: 72
    });
    expect(simulator.compareAtomicFocusWithDiagnostics(atomicFocus, {
      columnCount: 8,
      focusedIndex: 576,
      pageInstanceId: 'page-one',
      renderWindowStart: 520,
      renderedCardCount: 96,
      scrollTop: 24_640
    })).toMatchObject({
      differences: [],
      status: 'AGREE'
    });
    expect(simulator.compareAtomicFocusWithDiagnostics(atomicFocus, {
      columnCount: 8,
      focusedIndex: 578,
      pageInstanceId: 'page-one',
      renderWindowStart: 520,
      renderedCardCount: 96,
      scrollTop: 24_640
    })).toMatchObject({
      differences: [{ atomic: 576, diagnostic: 578, field: 'focusedIndex' }],
      status: 'DISAGREE'
    });
    expect(simulator.compareAtomicFocusWithDiagnostics(atomicFocus, {
      columnCount: 8,
      focusedIndex: 576,
      pageInstanceId: 'page-one',
      renderWindowStart: 520,
      renderedCardCount: 96
    })).toMatchObject({
      differences: [],
      status: 'UNKNOWN'
    });
  });

  it('keeps a missing atomic directional sample UNKNOWN instead of using mixed fallback data', () => {
    const mixedFallbackEvidence = {
      atomicFocus: simulator.normalizeAtomicShowsFocusSample({
        reason: 'atomic-runtime-evaluation-failed'
      }),
      state: {
        currentFocusId: 'browse-shows-private-id',
        shows: { currentColumns: 8, renderWindowStart: 520 }
      },
      surface: { focusedCardOffset: 56, gridColumns: 8 }
    };

    expect(simulator.showsFocusPosition(mixedFallbackEvidence)).toBeNull();
    expect(simulator.summarizeAtomicFocusSampling([{
      atomicFocus: mixedFallbackEvidence.atomicFocus,
      kind: 'endurance-failure'
    }])).toMatchObject({
      diagnosticComparisonStatus: 'UNKNOWN',
      status: 'UNKNOWN',
      unknownDirectionalSampleCount: 1
    });
  });

  it('propagates UNKNOWN from every nested directional before and after sample', () => {
    const passingAtomic = simulator.normalizeAtomicShowsFocusSample({
      columnCount: 8,
      focusOwnerCount: 1,
      focusedCardOffset: 48,
      focusedElement: {
        focusId: 'browse-shows-private-id',
        isConnected: true,
        tagName: 'BUTTON'
      },
      pageInstanceId: 'page-one',
      renderWindowStart: 520,
      renderedCardCount: 96,
      scrollTop: 24_640,
      timestamp: 123_456
    });
    const unknownAtomic = simulator.normalizeAtomicShowsFocusSample({
      reason: 'atomic-runtime-evaluation-failed'
    });

    for (const observation of [
      {
        after: { atomicFocus: unknownAtomic },
        atomicFocus: passingAtomic,
        before: { atomicFocus: passingAtomic },
        kind: 'endurance-failure'
      },
      {
        after: { atomicFocus: passingAtomic },
        before: { atomicFocus: unknownAtomic },
        kind: 'directional-failure'
      },
      {
        after: {},
        before: { atomicFocus: passingAtomic },
        kind: 'directional-failure'
      }
    ]) {
      expect(simulator.summarizeAtomicFocusSampling([observation])).toMatchObject({
        status: 'UNKNOWN',
        unknownDirectionalSampleCount: 1
      });
    }

    expect(simulator.summarizeAtomicFocusSampling([{
      after: { atomicFocus: passingAtomic },
      before: { atomicFocus: passingAtomic },
      kind: 'directional-failure'
    }])).toMatchObject({
      status: 'PASS',
      unknownDirectionalSampleCount: 0
    });

    const missingDiagnostic = completeCoverageReport();
    missingDiagnostic.atomicFocusSampling.diagnosticComparisonStatus = 'UNKNOWN';
    expect(simulator.evaluateAcceptanceCoverage(
      missingDiagnostic,
      { enduranceMinutes: 30, lifecycleCycle: true }
    ).missing).toContain('atomicDiagnosticComparisonObserved');
  });

  it('recovers the filter row through the left edge of the poster grid', () => {
    const cardEvidence = (offset: number) => ({
      state: {
        currentFocusId: `browse-shows-${offset}`,
        shows: { currentColumns: 8, renderWindowStart: 0 }
      },
      surface: { focusedCardOffset: offset, gridColumns: 8 }
    });

    expect(simulator.filterNavigationKey({
      state: { currentFocusId: 'shell-music' }
    })).toBe('ArrowDown');
    expect(simulator.filterNavigationKey(cardEvidence(12))).toBe('ArrowLeft');
    expect(simulator.filterNavigationKey(cardEvidence(8))).toBe('ArrowUp');
    expect(simulator.filterNavigationKey(cardEvidence(0))).toBe('ArrowUp');
  });

  it('keeps authenticated screenshot failures from aborting functional validation', async () => {
    const result = await simulator.captureEvidenceScreenshot(
      {},
      'shows-initial.png',
      { state: { currentRoute: 'shows' } },
      async () => {
        throw new Error('CDP Page.captureScreenshot timed out.');
      }
    );

    expect(result).toEqual({ captured: false, path: null, reason: 'capture-failed' });
  });

  it('keeps screenshot-only evidence reads non-fatal', async () => {
    let captureAttempted = false;
    const result = await simulator.captureEvidenceScreenshot(
      {},
      'shows-initial.png',
      null,
      async () => {
        captureAttempted = true;
      },
      async () => {
        throw new Error('CDP Runtime.evaluate timed out.');
      }
    );

    expect(captureAttempted).toBe(false);
    expect(result).toEqual({ captured: false, path: null, reason: 'evidence-failed' });
  });

  it('never captures screenshots on unauthenticated routes', async () => {
    let captureAttempted = false;
    const result = await simulator.captureEvidenceScreenshot(
      {},
      'auth.png',
      { state: { currentRoute: 'auth' } },
      async () => {
        captureAttempted = true;
      }
    );

    expect(captureAttempted).toBe(false);
    expect(result).toEqual({
      captured: false,
      path: null,
      reason: 'unauthenticated-or-unknown-route'
    });
  });
});
