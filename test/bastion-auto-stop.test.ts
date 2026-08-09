/**
 * Unit tests for the auto-stop Lambda's decision logic
 * ([`lib/bastion-auto-stop.js`](../lib/bastion-auto-stop.js)).
 *
 * `BastionStack` reads that file verbatim into `lambda.Code.fromInline`, so
 * what runs in AWS is exactly what is exercised here — see the assertion in
 * `bastion-stack.test.ts` that pins the two together.
 *
 * `stopIfEnabled` takes its AWS calls as functions, so no SDK and no mocking
 * framework is needed: hand it two stubs and inspect what it did. It is
 * `require`d rather than imported because the handler is plain CommonJS
 * JavaScript, with no type declarations to import from.
 */
const { stopIfEnabled } = require('../lib/bastion-auto-stop');

const INSTANCE_ID = 'i-0123456789abcdef0';
const PARAM = '/derrops/region/bastion/auto-stop/enabled';

/** A stub pair plus a record of the calls made through them. */
function stubs(parameterValue: unknown) {
  const stopped: string[] = [];
  const logs: string[] = [];
  return {
    stopped,
    logs,
    deps: {
      instanceId: INSTANCE_ID,
      parameterName: PARAM,
      log: (line: string) => logs.push(line),
      getParameter: async (name: string) => {
        expect(name).toBe(PARAM);
        if (parameterValue instanceof Error) throw parameterValue;
        return parameterValue;
      },
      stopInstances: async (id: string) => {
        stopped.push(id);
        return [{ instanceId: id, from: 'running', to: 'stopping' }];
      },
    },
  };
}

/** The error shape the SSM SDK raises for a parameter that does not exist. */
function parameterNotFound() {
  const err = new Error('Parameter not found');
  err.name = 'ParameterNotFound';
  return err;
}

test("stops the instance when the switch reads 'true'", async () => {
  const { deps, stopped } = stubs('true');
  const result = await stopIfEnabled(deps);
  expect(stopped).toEqual([INSTANCE_ID]);
  expect(result).toEqual({ transitions: [{ instanceId: INSTANCE_ID, from: 'running', to: 'stopping' }] });
});

test('the switch is read on every run, before anything is stopped', async () => {
  // The whole point of the parameter is that it is consulted at *runtime*, not
  // baked in at deploy time — so a suspension takes effect on the next firing.
  const order: string[] = [];
  await stopIfEnabled({
    instanceId: INSTANCE_ID,
    parameterName: PARAM,
    log: () => {},
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
  expect(await stopIfEnabled(deps)).toEqual({ skipped: true });
  expect(stopped).toEqual([]);
  expect(logs.join()).toContain('auto-stop disabled');
});

test('tolerates the casing and whitespace a console edit leaves behind', async () => {
  for (const value of ['TRUE', ' true\n', 'True']) {
    const { deps, stopped } = stubs(value);
    await stopIfEnabled(deps);
    expect(stopped).toEqual([INSTANCE_ID]);
  }
});

test('any value that is not true suspends the stop', async () => {
  // Documented on the parameter itself: only 'true' runs it. A typo therefore
  // fails towards leaving the box alone rather than towards a surprise stop.
  for (const value of ['no', 'disabled', '', undefined]) {
    const { deps, stopped } = stubs(value);
    expect(await stopIfEnabled(deps)).toEqual({ skipped: true });
    expect(stopped).toEqual([]);
  }
});

test('a deleted switch still stops the instance', async () => {
  // The stack seeds the parameter 'true', so its absence means the switch was
  // deleted, not turned off — and the expensive failure mode is a box left
  // running, so this fails towards stopping.
  const { deps, stopped, logs } = stubs(parameterNotFound());
  await stopIfEnabled(deps);
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
  await expect(stopIfEnabled(deps)).rejects.toThrow('rate exceeded');
  expect(stopped).toEqual([]);
});
