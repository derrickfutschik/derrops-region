'use strict';

/**
 * Powers the region bastion on and off from its CloudWatch alarm.
 *
 * `lib/bastion-stack.ts` reads this file **verbatim** into
 * `lambda.Code.fromInline`, so it must stay under 4 KB (a test asserts that)
 * and require nothing beyond the AWS SDK v3 that ships in the Node.js runtime.
 *
 * `onAlarmState` takes its AWS calls as plain functions rather than SDK
 * clients, so the decision logic can be exercised with stubs and no SDK
 * installed in this repo. The SDK is required lazily inside `handler`, which is
 * what keeps importing this module free of side effects.
 */

let calls;

function awsCalls() {
  if (!calls) {
    const { EC2Client, StartInstancesCommand, StopInstancesCommand } = require('@aws-sdk/client-ec2');
    const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
    const ec2 = new EC2Client({});
    const ssm = new SSMClient({});
    const transitions = (list) =>
      (list || []).map((i) => ({
        instanceId: i.InstanceId,
        from: i.PreviousState && i.PreviousState.Name,
        to: i.CurrentState && i.CurrentState.Name,
      }));
    calls = {
      getParameter: async (Name) => {
        const { Parameter } = await ssm.send(new GetParameterCommand({ Name }));
        return Parameter && Parameter.Value;
      },
      startInstances: async (id) =>
        transitions((await ec2.send(new StartInstancesCommand({ InstanceIds: [id] }))).StartingInstances),
      stopInstances: async (id) =>
        transitions((await ec2.send(new StopInstancesCommand({ InstanceIds: [id] }))).StoppingInstances),
    };
  }
  return calls;
}

const START_ATTEMPTS = 30;
const START_RETRY_MS = 5000;

/** Starts the box, waiting out a `stopping` one (EC2 rejects that start). */
async function start(opts) {
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await opts.startInstances(opts.instanceId);
    } catch (err) {
      if (err.name !== 'IncorrectInstanceState' || attempt >= START_ATTEMPTS) throw err;
      await sleep(START_RETRY_MS);
    }
  }
}

/** Stops `instanceId` unless the switch at `parameterName` says not to. */
async function stopIfEnabled(opts) {
  const { getParameter, stopInstances, instanceId, parameterName } = opts;
  const log = opts.log || console.log;

  let value;
  try {
    value = await getParameter(parameterName);
  } catch (err) {
    // Seeded 'true', so absence means the switch is gone, not turned off.
    if (err.name !== 'ParameterNotFound') throw err;
    log(JSON.stringify({ message: 'switch missing, proceeding', parameterName }));
    value = 'true';
  }

  if (String(value).trim().toLowerCase() !== 'true') {
    log(JSON.stringify({ message: 'auto-stop disabled', parameterName, value }));
    return { skipped: true };
  }

  const transitions = await stopInstances(instanceId);
  log(JSON.stringify({ message: 'auto-stop', transitions }));
  return { transitions };
}

/**
 * ALARM starts the box. OK stops it, but only coming *out of* ALARM — the OK a
 * new alarm first settles into is not the end of a request.
 */
async function onAlarmState(opts) {
  const { state, previousState } = opts;
  const log = opts.log || console.log;

  if (state === 'ALARM') {
    const transitions = await start(opts);
    log(JSON.stringify({ message: 'power-on', transitions }));
    return { transitions };
  }
  if (state === 'OK' && previousState === 'ALARM') return stopIfEnabled(opts);

  log(JSON.stringify({ message: 'ignored', state, previousState }));
  return { ignored: true };
}

exports.onAlarmState = onAlarmState;

exports.handler = async (event) => {
  const data = (event && event.alarmData) || {};
  return onAlarmState({
    ...awsCalls(),
    instanceId: process.env.INSTANCE_ID,
    parameterName: process.env.ENABLED_PARAM,
    state: data.state && data.state.value,
    previousState: data.previousState && data.previousState.value,
  });
};
