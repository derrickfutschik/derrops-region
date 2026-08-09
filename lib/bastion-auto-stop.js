'use strict';

/**
 * Daily auto-stop for the region bastion.
 *
 * `lib/bastion-stack.ts` reads this file **verbatim** into
 * `lambda.Code.fromInline`, so it must stay under 4 KB (a test asserts that)
 * and require nothing beyond the AWS SDK v3 that ships in the Node.js runtime.
 *
 * `stopIfEnabled` takes its two AWS calls as plain functions rather than SDK
 * clients, so the decision logic can be exercised with stubs and no SDK
 * installed in this repo. The SDK is required lazily inside `handler`, which is
 * what keeps importing this module free of side effects.
 */

let calls;

/** The real AWS calls, built once and reused across warm invocations. */
function awsCalls() {
  if (!calls) {
    const { EC2Client, StopInstancesCommand } = require('@aws-sdk/client-ec2');
    const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
    const ec2 = new EC2Client({});
    const ssm = new SSMClient({});
    calls = {
      getParameter: async (Name) => {
        const { Parameter } = await ssm.send(new GetParameterCommand({ Name }));
        return Parameter && Parameter.Value;
      },
      stopInstances: async (id) => {
        const res = await ec2.send(new StopInstancesCommand({ InstanceIds: [id] }));
        return (res.StoppingInstances || []).map((i) => ({
          instanceId: i.InstanceId,
          from: i.PreviousState && i.PreviousState.Name,
          to: i.CurrentState && i.CurrentState.Name,
        }));
      },
    };
  }
  return calls;
}

/** Stops `instanceId` unless the switch at `parameterName` says not to. */
async function stopIfEnabled(opts) {
  const { getParameter, stopInstances, instanceId, parameterName } = opts;
  const log = opts.log || console.log;

  let value;
  try {
    value = await getParameter(parameterName);
  } catch (err) {
    // A deleted parameter is not a reason to leave the box running: the stack
    // seeds it 'true', so absence means the switch is gone, not turned off.
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

exports.stopIfEnabled = stopIfEnabled;

exports.handler = async () =>
  stopIfEnabled({
    ...awsCalls(),
    instanceId: process.env.INSTANCE_ID,
    parameterName: process.env.ENABLED_PARAM,
  });
