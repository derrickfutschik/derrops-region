/**
 * Unit tests for the power Lambda's decision logic
 * ([`lib/bastion-power.js`](../lib/bastion-power.js)).
 *
 * `BastionStack` reads that file verbatim into `lambda.Code.fromInline`, so
 * what runs in AWS is exactly what is exercised here — see the assertion in
 * `bastion-stack.test.ts` that pins the two together.
 *
 * `onAlarmState` takes its AWS calls as functions, so no SDK and no mocking
 * framework is needed: hand it stubs and inspect what it did. It is `require`d
 * rather than imported because the handler is plain CommonJS JavaScript, with
 * no type declarations to import from.
 */
const { onAlarmState } = require('../lib/bastion-power');

const INSTANCE_ID = 'i-0123456789abcdef0';
const PARAM = '/derrops/region/bastion/auto-stop/enabled';

/** Stubs plus a record of the calls made through them. */
function stubs(parameterValue: unknown, state = 'OK', previousState = 'ALARM') {
  const started: string[] = [];
  const stopped: string[] = [];
  const logs: string[] = [];
  return {
    started,
    stopped,
    logs,
    deps: {
      state,
      previousState,
      instanceId: INSTANCE_ID,
      parameterName: PARAM,
      log: (line: string) => logs.push(line),
      sleep: async () => {},
      getParameter: async (name: string) => {
        expect(name).toBe(PARAM);
        if (parameterValue instanceof Error) throw parameterValue;
        return parameterValue;
      },
      startInstances: async (id: string) => {
        started.push(id);
        return [{ instanceId: id, from: 'stopped', to: 'pending' }];
      },
      stopInstances: async (id: string) => {
        stopped.push(id);
        return [{ instanceId: id, from: 'running', to: 'stopping' }];
      },
    },
  };
}

/** The error EC2 raises for a start while the instance is still stopping. */
function incorrectState() {
  const err = new Error('The instance is not in a state from which it can be started');
  err.name = 'IncorrectInstanceState';
  return err;
}

/** The error shape the SSM SDK raises for a parameter that does not exist. */
function parameterNotFound() {
  const err = new Error('Parameter not found');
  err.name = 'ParameterNotFound';
  return err;
}

test('ALARM starts the instance', async () => {
  const { deps, started, stopped } = stubs('true', 'ALARM', 'OK');
  const result = await onAlarmState(deps);
  expect(started).toEqual([INSTANCE_ID]);
  expect(stopped).toEqual([]);
  expect(result).toEqual({ transitions: [{ instanceId: INSTANCE_ID, from: 'stopped', to: 'pending' }] });
});

test('a start is never gated by the switch', async () => {
  // The switch suspends the *stop*. A request for the box is always honoured,
  // so the parameter is not even read on the way up.
  const { deps, started } = stubs(new Error('must not be read'), 'ALARM', 'OK');
  await onAlarmState(deps);
  expect(started).toEqual([INSTANCE_ID]);
});

test('a start waits out an instance that is still stopping', async () => {
  // A request landing just after the hold expired finds the box mid-stop, and
  // EC2 rejects a start until it has fully stopped.
  const { deps } = stubs('true', 'ALARM', 'OK');
  let attempts = 0;
  let slept = 0;
  const result = await onAlarmState({
    ...deps,
    sleep: async () => {
      slept++;
    },
    startInstances: async (id: string) => {
      if (++attempts < 3) throw incorrectState();
      return [{ instanceId: id, from: 'stopped', to: 'pending' }];
    },
  });
  expect(attempts).toBe(3);
  expect(slept).toBe(2);
  expect(result.transitions).toHaveLength(1);
});

test('a start that never becomes possible is raised, as is any other EC2 failure', async () => {
  const { deps } = stubs('true', 'ALARM', 'OK');
  await expect(
    onAlarmState({ ...deps, startInstances: async () => { throw incorrectState(); } }),
  ).rejects.toThrow('not in a state');

  let attempts = 0;
  const denied = new Error('not authorized');
  denied.name = 'UnauthorizedOperation';
  await expect(
    onAlarmState({ ...deps, startInstances: async () => { attempts++; throw denied; } }),
  ).rejects.toThrow('not authorized');
  // Not retried: only "still stopping" is worth waiting for.
  expect(attempts).toBe(1);
});

test('only an OK that follows ALARM stops the instance', async () => {
  // A new alarm settles from INSUFFICIENT_DATA into OK on its first
  // evaluation. That is not the end of a request, and must not stop a box
  // somebody started by hand — on the first deploy, for one. Nor is an event
  // with no state at all.
  for (const [state, previousState] of [
    ['OK', 'INSUFFICIENT_DATA'],
    ['INSUFFICIENT_DATA', 'ALARM'],
    ['INSUFFICIENT_DATA', 'OK'],
    [null, null],
  ] as const) {
    const { deps, started, stopped } = stubs('true', state as any, previousState as any);
    expect(await onAlarmState(deps)).toEqual({ ignored: true });
    expect(started).toEqual([]);
    expect(stopped).toEqual([]);
  }
});

test("OK after ALARM stops the instance when the switch reads 'true'", async () => {
  const { deps, stopped } = stubs('true');
  const result = await onAlarmState(deps);
  expect(stopped).toEqual([INSTANCE_ID]);
  expect(result).toEqual({ transitions: [{ instanceId: INSTANCE_ID, from: 'running', to: 'stopping' }] });
});

test('the switch is read on every stop, before anything is stopped', async () => {
  // The whole point of the parameter is that it is consulted at *runtime*, not
  // baked in at deploy time — so a suspension takes effect on the next stop.
  const order: string[] = [];
  const { deps } = stubs('true');
  await onAlarmState({
    ...deps,
    getParameter: async () => {
      order.push('read-switch');
      return 'true';
    },
    stopInstances: async () => {
      order.push('stop');
      return [];
    },
  });
  expect(order).toEqual(['read-switch', 'stop']);
});

test("skips the stop when the switch reads 'false'", async () => {
  const { deps, stopped, logs } = stubs('false');
  expect(await onAlarmState(deps)).toEqual({ skipped: true });
  expect(stopped).toEqual([]);
  expect(logs.join()).toContain('auto-stop disabled');
});

test('tolerates the casing and whitespace a console edit leaves behind', async () => {
  for (const value of ['TRUE', ' true\n', 'True']) {
    const { deps, stopped } = stubs(value);
    await onAlarmState(deps);
    expect(stopped).toEqual([INSTANCE_ID]);
  }
});

test('any value that is not true suspends the stop', async () => {
  // Documented on the parameter itself: only 'true' runs it. A typo therefore
  // fails towards leaving the box alone rather than towards a surprise stop.
  for (const value of ['no', 'disabled', '', undefined]) {
    const { deps, stopped } = stubs(value);
    expect(await onAlarmState(deps)).toEqual({ skipped: true });
    expect(stopped).toEqual([]);
  }
});

test('a deleted switch still stops the instance', async () => {
  // The stack seeds the parameter 'true', so its absence means the switch was
  // deleted, not turned off — and the expensive failure mode is a box left
  // running, so this fails towards stopping.
  const { deps, stopped, logs } = stubs(parameterNotFound());
  await onAlarmState(deps);
  expect(stopped).toEqual([INSTANCE_ID]);
  expect(logs.join()).toContain('switch missing');
});

test('any other SSM failure is raised, not swallowed', async () => {
  // Access denied or a throttle is not evidence about the switch either way.
  // Surfacing it puts the invocation in the Lambda error metric instead of
  // silently stopping (or silently not stopping) the instance.
  const err = new Error('rate exceeded');
  err.name = 'ThrottlingException';
  const { deps, stopped } = stubs(err);
  await expect(onAlarmState(deps)).rejects.toThrow('rate exceeded');
  expect(stopped).toEqual([]);
});
