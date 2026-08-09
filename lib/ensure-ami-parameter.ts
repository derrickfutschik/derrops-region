import { SSMClient, GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm';

/**
 * AWS's own pointer at the newest Amazon Linux 2023 image, **arm64** — t4g is
 * Graviton. Public, and present in every region, so reading it needs no
 * region-specific knowledge beyond the region itself.
 *
 * This is read exactly once per region, to seed the pin below. It is
 * deliberately *not* what the stack builds the instance from: AWS re-points it
 * at each AL2023 release, and `ImageId` replaces an instance.
 */
const AWS_LATEST_AL2023_ARM64 =
  '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-arm64';

const DESCRIPTION = [
  'AMI the region bastion is built from — read at deploy time by',
  'derrops--region--bastion. Seeded once with the then-latest Amazon Linux 2023',
  'arm64 image and never re-asserted: overwrite it (and redeploy) to upgrade the',
  'bastion, which REPLACES the instance.',
].join(' ');

/**
 * The SSM operations this needs, injected so the decision logic can be tested
 * without the SDK or a mocking framework (same approach as the auto-stop
 * lambda). `ensureAmiParameter` supplies real ones by default.
 */
export interface AmiParameterOps {
  /** Resolves the parameter's value, or `undefined` if it does not exist. */
  readonly getParameter: (name: string) => Promise<string | undefined>;
  /** Creates the parameter. Must not overwrite an existing value. */
  readonly putParameter: (name: string, value: string) => Promise<void>;
}

/**
 * Result of a single `ensureAmiParameter` call — returned rather than only
 * logged, so callers (and tests) can tell the three outcomes apart.
 */
export interface AmiParameterResult {
  readonly action: 'kept' | 'seeded';
  readonly amiId: string;
}

/**
 * Make sure the region's bastion AMI parameter exists, defaulting it to the
 * latest Amazon Linux 2023 arm64 image.
 *
 * ## Why this runs before synth rather than inside a stack
 *
 * `BastionStack` reads the AMI as an `AWS::SSM::Parameter::Value<>` stack
 * parameter. CloudFormation resolves those **before it touches any resource**,
 * so a stack cannot create the parameter it also reads — the read runs first
 * and the whole deploy fails on a region that has never been deployed. Seeding
 * it from a stack is therefore impossible in principle, not merely awkward, and
 * the only place left is ahead of the CDK app.
 *
 * ## What it does and does not touch
 *
 * Create-if-absent, exactly like `SeedParameter`: if the parameter already
 * exists this reads it and returns, so a value set by hand is never disturbed.
 * That is the whole point of the pin — a deploy must not get to decide what the
 * bastion runs.
 *
 * Nothing region-specific reaches the template as a result: the value lives in
 * SSM, in the region it belongs to, and the template still resolves it at
 * deploy time.
 */
export async function ensureAmiParameter(
  region: string,
  parameterName: string,
  ops?: AmiParameterOps,
): Promise<AmiParameterResult> {
  const io = ops ?? sdkOps(region);

  const existing = await io.getParameter(parameterName);
  if (existing) {
    return { action: 'kept', amiId: existing };
  }

  const latest = await io.getParameter(AWS_LATEST_AL2023_ARM64);
  if (!latest) {
    throw new Error(
      `Cannot seed ${parameterName} in ${region}: ${AWS_LATEST_AL2023_ARM64} returned no value.`,
    );
  }

  await io.putParameter(parameterName, latest);
  return { action: 'seeded', amiId: latest };
}

/** Real SSM calls, against one explicit region. */
function sdkOps(region: string): AmiParameterOps {
  const client = new SSMClient({ region });

  return {
    getParameter: async (name) => {
      try {
        const res = await client.send(new GetParameterCommand({ Name: name }));
        return res.Parameter?.Value;
      } catch (err) {
        // Absent is an answer, not a failure — everything else is real.
        if ((err as { name?: string }).name === 'ParameterNotFound') return undefined;
        throw err;
      }
    },
    putParameter: async (name, value) => {
      await client.send(
        new PutParameterCommand({
          Name: name,
          Value: value,
          Type: 'String',
          Description: DESCRIPTION,
          // Never clobber: a parameter that appeared between the read above and
          // this write is somebody else's decision, and it wins.
          Overwrite: false,
        }),
      );
    },
  };
}
