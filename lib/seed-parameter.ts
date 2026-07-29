import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from 'aws-cdk-lib/custom-resources';

export type SeedParameterType = 'String' | 'StringList' | 'SecureString';

export interface SeedParameterProps {
  /** Full SSM parameter name (generate it via `naming.name({ type: 'ssmParam', ... })`). */
  readonly parameterName: string;
  /**
   * Default value to seed. For a StringList, a comma-joined string.
   *
   * **This lands in the CloudFormation template in plaintext**, and in the log
   * group of the custom-resource lambda. For a `SecureString` it must therefore
   * be a placeholder, never a real credential — see the class docs.
   */
  readonly value: string;
  /** @default 'String' */
  readonly type?: SeedParameterType;
  readonly description?: string;
}

/**
 * Seeds an SSM parameter with a default value **once**, then never touches it
 * again.
 *
 * A CloudFormation-managed `AWS::SSM::Parameter` re-asserts its `Value` whenever
 * the template value changes, so a value edited out-of-band gets clobbered on
 * the next deploy. This construct instead creates the parameter only if it does
 * not already exist, so out-of-band edits survive later `cdk deploy`s.
 *
 * Mechanism: an `AwsCustomResource` that calls `ssm:PutParameter` with
 * `Overwrite: false` on create. If the parameter already exists the call returns
 * `ParameterAlreadyExists`, which is ignored (a no-op). Updates carry no SDK
 * call (only `onCreate` is defined), and the parameter is retained on stack
 * delete — so nothing ever overwrites the live value after the initial seed.
 *
 * ## `SecureString` and secrets
 *
 * This is also the only way to *create* a `SecureString` from CDK:
 * CloudFormation's `AWS::SSM::Parameter` does not support the type at all, so a
 * direct SDK call is the only route. Encryption uses the account's default
 * `alias/aws/ssm` key.
 *
 * The seeded `value` is **not** a secure place for a secret — it is written
 * into the synthesized template, which lands in the CDK assets bucket and in
 * every `cdk diff`. Seed a recognisable placeholder and set the real value
 * out-of-band, once, after the first deploy:
 *
 * ```bash
 * aws ssm put-parameter --region <region> --name <name> \
 *   --type SecureString --overwrite --value "$(cat secret.json)"
 * ```
 *
 * `Overwrite: false` is what makes that safe: the real value is never
 * re-asserted, re-seeded, or diffed against the placeholder afterwards.
 *
 * Use this for editable config defaults and seeded credentials; keep
 * CloudFormation-managed parameters for derived values that should track the
 * stack (e.g. a resource ARN).
 */
export class SeedParameter extends Construct {
  constructor(scope: Construct, id: string, props: SeedParameterProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const parameterArn = stack.formatArn({
      service: 'ssm',
      resource: 'parameter',
      resourceName: props.parameterName.replace(/^\//, ''),
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    });

    const statements = [
      new iam.PolicyStatement({
        actions: ['ssm:PutParameter'],
        resources: [parameterArn],
      }),
    ];

    // Encrypting under the default `alias/aws/ssm` key needs kms:Encrypt on the
    // caller as well as in the key policy. The key is AWS-managed, so its ARN is
    // not known here; scope the grant with `kms:ViaService` instead, which
    // limits it to keys used *through SSM in this region* — the lambda cannot
    // use it against any other service.
    if (props.type === 'SecureString') {
      statements.push(
        new iam.PolicyStatement({
          actions: ['kms:Encrypt', 'kms:GenerateDataKey'],
          resources: ['*'],
          conditions: {
            StringEquals: { 'kms:ViaService': `ssm.${stack.region}.amazonaws.com` },
          },
        }),
      );
    }

    new AwsCustomResource(this, 'Resource', {
      resourceType: 'Custom::SeedSsmParameter',
      onCreate: {
        service: 'SSM',
        action: 'putParameter',
        parameters: {
          Name: props.parameterName,
          Value: props.value,
          Type: props.type ?? 'String',
          Overwrite: false,
          ...(props.description ? { Description: props.description } : {}),
        },
        physicalResourceId: PhysicalResourceId.of(props.parameterName),
        // Leave an already-existing (possibly hand-edited) value untouched.
        ignoreErrorCodesMatching: 'ParameterAlreadyExists',
      },
      policy: AwsCustomResourcePolicy.fromStatements(statements),
      installLatestAwsSdk: false,
    });
  }
}
