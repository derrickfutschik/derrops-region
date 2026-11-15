import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { DerropsConventions } from 'derrops-conventions';
import { SeedParameter } from './seed-parameter';

/**
 * The platform's own user on each service the bastion fronts. One constant, so
 * the spelling is fixed in a single place — it becomes an SSM parameter path
 * that outside consumers pin against.
 */
const PLATFORM_USER = { id: 'DerropsPlatform', name: 'derrops-platform' };

/**
 * Seeded into every credentials parameter, and never a real secret: the value
 * reaches the CloudFormation template in plaintext. `SeedParameter` writes it
 * only when the parameter is absent, so replacing it out-of-band is permanent.
 */
const PLACEHOLDER_SECRET = 'REPLACE-ME';

/**
 * An editable fact about a proxied endpoint that a consumer needs but cannot
 * derive from `host`/`port`/`url` — how to authenticate to it, and how to sign
 * if that authentication is SigV4.
 */
type EndpointSetting = { key: string; value: string; description: string };

/**
 * A kebab-case parameter key as a CDK construct id fragment: `auth-mode` →
 * `AuthMode`. Construct ids are part of a resource's logical id, so this has to
 * stay stable — changing it replaces the custom resource.
 */
const pascal = (key: string) =>
  key.replace(/(^|-)(.)/g, (_, __, c: string) => c.toUpperCase());

/**
 * Credential fields that hold a secret, and so must be seeded as a
 * `SecureString`. Everything else in a credentials set is connectivity metadata
 * — engine, host, port — and stays a plain `String`, readable by a consumer
 * that has no `kms:Decrypt`.
 */
const SECRET_FIELDS = new Set(['password']);

/**
 * What each credential field holds, said on the parameter itself. With one
 * parameter per field, whoever opens a single one in the console sees only its
 * own description — so each has to stand alone rather than describe the set.
 */
const FIELD_DESCRIPTIONS: Record<string, string> = {
  engine: 'The datasource engine identifier.',
  host: "Host to connect to: the region bastion's private IPv4, which proxies this service.",
  port: 'Port the service answers on, on the region bastion.',
  dbname: 'Database to connect to.',
  protocol: 'URL scheme for the endpoint.',
  endpoint: 'protocol://host:port, pre-assembled so a client need not join the parts itself.',
  username: 'Username to authenticate as.',
  password: 'Password for this user.',
};

/**
 * The power Lambda's source, next to this file so an editor treats it as the
 * JavaScript it is. Read verbatim into `lambda.Code.fromInline` below.
 */
const POWER_HANDLER_FILE = 'bastion-power.js';

/**
 * Design-time naming segments for the bastion stack. Every resource name, the
 * stack name, and the CDK construct id in `bin/` derive from this one instance
 * via `derrops-conventions` — never hand-assembled.
 *
 * One bastion per region, so the names here must be safe to repeat across
 * regions. Everything named below (stack, security group, SSM parameter, the
 * instance's `Name` tag) is region-scoped by AWS, so identical names in two
 * regions are two independent resources. The one exception is the IAM role —
 * see the note at its construction.
 */
export const naming = new DerropsConventions({
  org: 'derrops',
  domain: 'region',
  service: 'bastion',
}).tagPrefix('derrops:');

/**
 * The AMI the bastion is built from, held in SSM per region and read at deploy
 * time. Exported because `bin/` seeds it before synth — see
 * [`ensureAmiParameter`](ensure-ami-parameter.ts) for why that cannot happen
 * inside this stack.
 */
export const amiParameterName = naming.name({ type: 'ssmParam', key: 'ami-id' });

/**
 * The custom metric that asks for the bastion to be on. Any service that needs
 * the box posts a value above 0 to it (`cloudwatch:PutMetricData`); the alarm
 * in this stack starts the instance, and stops it again once the metric has
 * stayed at 0 — or silent — for the whole hold.
 *
 * Namespace and dimensions come from the convention: the namespace is
 * org/domain only, and the service is a dimension, not part of the name. The
 * library has no resource type for a metric *name* (it is not an AWS resource
 * name), so that follows its documented PascalCase style instead.
 *
 * A datapoint only counts if it carries exactly these dimensions — CloudWatch
 * treats every distinct dimension set as a separate metric. Region-portable:
 * the same metric exists independently in each region, so a publisher has to
 * post to the region whose bastion it wants.
 */
export const powerMetric = {
  namespace: naming.name({ type: 'cloudwatchMetricNamespace' }),
  metricName: 'PowerOnRequests',
  dimensions: naming.dimensions(),
};

export interface BastionStackProps extends cdk.StackProps {
  /** The region's VPC (from `VpcStack`) the bastion launches into. */
  readonly vpc: ec2.CfnVPC;
  /**
   * Public-tier subnets (from `VpcStack.publicSubnets`). The bastion lands in
   * the first one — a public subnet is the cost-optimal home for an
   * outbound-initiated Tailscale box (free IGW egress, direct WireGuard via a
   * public IP, no NAT Gateway). See `VpcStack` class docs.
   */
  readonly publicSubnets: ec2.CfnSubnet[];

  /**
   * Instance type. `t4g.nano` (2 vCPU / 0.5 GiB, Graviton/arm64) is the
   * smallest current-gen box — plenty for a WireGuard relay/subnet-router.
   *
   * @default 't4g.nano'
   */
  readonly instanceType?: string;

  /**
   * How long the bastion stays on after the last power-on request — the time
   * the metric must stay at 0 (or silent) before the alarm returns to OK and
   * the box is stopped. Whole minutes, at most a day (CloudWatch's limit on an
   * alarm's evaluation window).
   *
   * @default 4 hours
   */
  readonly powerOnHold?: cdk.Duration;

  /**
   * AMI for the bastion, pinned in source rather than read from SSM.
   *
   * Leave it unset. The default reads `.../bastion/ami-id` **in the region
   * being deployed**, which is the only pin that stays region-portable — an id
   * written here would be a different image, or nothing at all, in the next
   * region. This exists for tests and for a one-off recovery when the parameter
   * is unreachable.
   *
   * @default the AMI id held at `/derrops/region/bastion/ami-id`
   */
  readonly amiId?: string;

  /**
   * EC2 termination protection (`DisableApiTermination`) on the bastion. On by
   * default: this box is configured **by hand** (Tailscale), so nothing it
   * holds can be rebuilt from this repo, and a deploy that quietly terminates
   * it is unrecoverable.
   *
   * Named `instanceTerminationProtection`, not `terminationProtection` —
   * `cdk.StackProps` already defines the latter and it means something else
   * (protect the *stack* from deletion).
   *
   * Set `false` before `cdk destroy`; the stack cannot delete a protected
   * instance. It can also be cleared live, without a deploy:
   * `aws ec2 modify-instance-attribute --instance-id <id> --no-disable-api-termination`
   * (the next deploy re-asserts it).
   *
   * @default true
   */
  readonly instanceTerminationProtection?: boolean;
}

/**
 * A single tiny bastion EC2 instance, reached over **SSM Session Manager**.
 *
 * The intent is to `tailscale up` on it manually (over an SSM session) so it
 * joins this region's VPC to your tailnet — exposing your local server's services
 * to the tailnet and giving tailnet peers a route into the VPC. This stack does
 * **not** install or configure Tailscale; it just stands up the box and makes
 * SSM sessions possible.
 *
 * ## Shape / cost
 *
 *   - **t4g.nano** on **Amazon Linux 2023 arm64** — the cheapest current-gen
 *     instance (t4g is Graviton, so the AMI must be arm64; AL2023 ships the SSM
 *     agent preinstalled). The exact image is pinned per region in SSM, not
 *     tracked live — see below.
 *   - Lives in a **public subnet** (`publicSubnets[0]`) so it reaches the SSM
 *     endpoints (and later the Tailscale coordination server) over the free IGW
 *     — no NAT Gateway. An **Elastic IP** is associated so that public IPv4
 *     (~$3.6/mo) is stable across stop/start, which also aids Tailscale NAT
 *     traversal later. Its address is published to SSM as `.../endpoint`.
 *
 * ## Not losing the box: a pinned AMI, and termination protection
 *
 * This instance is the only thing in the repo whose contents cannot be rebuilt
 * from the repo — Tailscale is brought up by hand on it — so both guards below
 * exist to keep a routine `cdk deploy` from taking it away. They were added
 * after a deploy on **2026-08-09** silently replaced it (terminating the box
 * created on Jul 28) while changing nothing about the instance at all.
 *
 *   1. **The AMI is pinned** to `/derrops/region/bastion/ami-id`, a parameter
 *      written by hand. The previous `latestAmazonLinux2023()` re-resolved
 *      AWS's public "newest AL2023" pointer on every deploy, and a changed
 *      `ImageId` replaces an instance — so every AL2023 release armed the next
 *      deploy to rebuild the box. That is the cause, and this is the fix:
 *      upgrading the image is now something you do, by overwriting the
 *      parameter and redeploying, rather than something a deploy does to you.
 *   2. **Termination protection** (`DisableApiTermination`, see
 *      `instanceTerminationProtection`) catches whatever else forces a
 *      replacement — a subnet change, an instance-type change, an unpinned
 *      property added later. It does not prevent the replacement; it makes the
 *      old box survive it, as a running orphan, instead of being deleted.
 *
 * ## Access
 *
 *   - **Nothing inbound from the internet.** You connect with
 *     `aws ssm start-session --target <id>` — no SSH from outside, no publicly
 *     reachable port. The instance profile carries
 *     `AmazonSSMManagedInstanceCore` and SSM works purely over the agent's
 *     outbound HTTPS, so no ingress rule is needed for it at all.
 *   - The security group's only ingress rule allows **all traffic from the
 *     VPC's own CIDR**, so in-VPC hosts (and tailnet peers arriving via the
 *     Tailscale subnet router) can reach the box on its private IP. Egress is
 *     unrestricted.
 *
 * ## Power on demand
 *
 * The box is off unless something asks for it. Asking is posting a value above
 * 0 to the `powerMetric` custom metric: a CloudWatch alarm on that metric goes
 * to ALARM on the first such datapoint and invokes a small Lambda, which calls
 * `ec2:StartInstances`. The alarm returns to OK only once the metric has been
 * 0 or silent for the whole hold (4 hours by default), and that transition
 * invokes the same Lambda to call `ec2:StopInstances`. Stopping is the cost
 * lever: stopped, the box bills only its EBS root volume and its idle Elastic
 * IP, and its instance id, address, security group and SSM parameters all
 * survive — but anything brought up by hand on it (Tailscale) needs bringing
 * up again.
 *
 * `.../auto-stop/enabled` is a **runtime kill switch** for the stop half only:
 * the Lambda reads it before stopping and leaves the box running unless it is
 * `'true'`. It is seeded, not managed, so setting it to `false` survives every
 * later deploy — and nothing sets it back for you. `.../power-metric` publishes
 * the metric's coordinates for publishers outside this app.
 */
export class BastionStack extends cdk.Stack {
  /** The bastion EC2 instance — consumers receive it by reference. */
  public readonly instance: ec2.CfnInstance;

  constructor(scope: Construct, id: string, props: BastionStackProps) {
    super(scope, id, {
      ...props,
      stackName: props.stackName ?? naming.name({ type: 'cloudFormationStack' }),
    });

    naming.applyTags((k, v) => this.addStackTag(k, v));
    // Standard org tags (derrops:domain / derrops:service) on every resource.
    naming.applyTags((k, v) => cdk.Tags.of(this).add(k, v));

    const instanceType = props.instanceType ?? 't4g.nano';
    const subnet = props.publicSubnets[0];
    if (!subnet) {
      throw new Error('BastionStack requires at least one public subnet.');
    }

    // ── The AMI, pinned in SSM ──────────────────────────────────────────────
    // Read from *our* parameter, not from AWS's `latestAmazonLinux2023` public
    // pointer. Both resolve at deploy time and both are region-portable, but
    // AWS moves theirs: it names whatever AL2023 image is newest, so the
    // ImageId changed under a deploy that touched nothing about the instance,
    // and ImageId replaces an instance. This parameter changes only when
    // somebody changes it, so a deploy is no longer a coin flip on whether the
    // hand-configured box survives.
    //
    // The parameter is deliberately not created here. Two reasons, and the
    // second is the hard one:
    //   - Its whole purpose is to be a value a deploy never touches. A
    //     stack-managed parameter would be re-asserted from source on every
    //     deploy, which is the behaviour being escaped.
    //   - CloudFormation resolves an `AWS::SSM::Parameter::Value<...>`
    //     parameter before it touches any resource, so a parameter this stack
    //     creates could not be one it also reads — the first deploy would fail
    //     on the read regardless.
    // `bin/region-bootstrap.ts` therefore seeds it (with the latest AL2023
    // arm64 image, create-if-absent) *before* synth — see `ensureAmiParameter`.
    // Upgrading afterwards is an overwrite plus a deploy, and nothing else.
    //
    // Typed as AWS::EC2::Image::Id so CloudFormation rejects a value that is
    // not an AMI id before it reaches the instance. t4g is Graviton, so
    // whatever is pinned must be an **arm64** image — nothing here can check
    // that, and a mismatch fails at launch.
    let imageId = props.amiId;
    if (imageId) {
      // A literal id, which template validation flags (W9010) as unportable —
      // correctly, in general. Here it is an explicit override of the pin,
      // reached only when a caller passes `amiId`; the default path below is
      // exactly the parameter W9010 asks for.
      cdk.Validations.of(this).acknowledge({
        id: 'CloudFormation-Validate::W9010',
        reason: `AMI pinned explicitly via the amiId prop; the default reads ${amiParameterName}.`,
      });
    } else {
      imageId = ssm.StringParameter.valueForTypedStringParameterV2(
        this,
        amiParameterName,
        ssm.ParameterValueType.AWS_EC2_IMAGE_ID,
      );
    }

    // ── IAM role + instance profile (SSM Session Manager) ───────────────────
    // Deliberately *unnamed* — the one exception to the always-use-a-convention
    // -name rule. IAM is account-global, so a fixed convention name would
    // collide the moment this stack is deployed to a second region, and the
    // conventions library only emits its `region` segment for globally-unique
    // resource types (S3 buckets) — there is no convention name that stays
    // unique per region. CDK generates a unique physical name instead; find the
    // role via the derrops:* tags or the instance profile.
    const role = new iam.Role(this, naming.name({ type: 'iamRole', purpose: 'bastion' }), {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        // The only access path: connect via SSM Session Manager, no SSH.
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    const instanceProfile = new iam.CfnInstanceProfile(this, 'BastionInstanceProfile', {
      roles: [role.roleName],
    });

    // ── Security group: all egress, inbound from the VPC only ───────────────
    // SSM itself needs nothing inbound (the agent dials out over HTTPS). The one
    // ingress rule below opens the box to the VPC's own address range so
    // in-VPC hosts can reach it directly — e.g. over the Tailscale subnet
    // router, or for ad-hoc checks from another instance. The internet stays
    // fully blocked: the instance has a public IPv4, but nothing outside the
    // VPC CIDR matches the rule.
    //
    // The CIDR comes off the VPC rather than being restated here, so it tracks
    // whatever `VpcStack` was given for `vpcCidr`. Prefer the VPC's own
    // `cidrBlock` (a synth-time literal) over `attrCidrBlock`: the two stacks
    // are separate, so the attribute would become a cross-stack export and pin
    // the VPC's CIDR against later change. `attrCidrBlock` is the fallback for a
    // VPC that has no literal CIDR (e.g. one allocated from an IPAM pool).
    // Note in-VPC callers must use the bastion's *private* IP — traffic sent to
    // its public IP leaves via the IGW and arrives with an out-of-VPC source
    // address, which this rule does not match.
    const vpcCidr = props.vpc.cidrBlock ?? props.vpc.attrCidrBlock;
    // No `purpose` segment: this stack's service *is* the bastion, so a
    // `purpose: 'bastion'` would only stutter (derrops--region--bastion--bastion)
    // for the one security group here. Add one if a second group ever appears.
    const sgName = naming.name({ type: 'ec2SecurityGroup' });
    const sg = new ec2.CfnSecurityGroup(this, 'BastionSecurityGroup', {
      groupName: sgName,
      // EC2 security-group descriptions are immutable, so CloudFormation
      // implements any edit as a *replacement* of the group. That is normally
      // the thing to avoid here — replacement creates the new group before
      // deleting the old one, which would collide on the fixed `groupName`
      // above (InvalidGroup.Duplicate) — but the rename to the stutter-free
      // name replaces the group anyway, and under a name the old group does not
      // hold, so this description could finally be corrected to match the rules
      // in the same deployment. Treat it as frozen again from here.
      // The instance is fine either way: swapping a VPC instance's
      // SecurityGroupIds is an in-place, no-interruption update, whatever
      // `cdk diff`'s "may be replaced" hedge suggests.
      groupDescription: 'Bastion: all egress, inbound from the VPC CIDR only (no internet ingress; SSM Session Manager needs none).',
      vpcId: props.vpc.ref,
      securityGroupIngress: [
        {
          ipProtocol: '-1',
          cidrIp: vpcCidr,
          description: 'Allow all traffic from within the VPC; nothing from the internet.',
        },
      ],
      securityGroupEgress: [
        {
          ipProtocol: '-1',
          cidrIp: '0.0.0.0/0',
          description: 'Allow all outbound (SSM agent + later Tailscale, both outbound-initiated).',
        },
      ],
    });
    cdk.Tags.of(sg).add('Name', sgName);

    // ── The instance ────────────────────────────────────────────────────────
    const instanceName = naming.name({ type: 'ec2Instance', kind: 'public-blocked' });
    this.instance = new ec2.CfnInstance(this, 'BastionInstance', {
      instanceType,
      imageId,
      subnetId: subnet.ref,
      securityGroupIds: [sg.attrGroupId],
      iamInstanceProfile: instanceProfile.ref,
      // Termination protection, on by default. Everything on this box is set up
      // by hand (Tailscale), so a terminate is the one unrecoverable event here
      // — and the deploy of 2026-08-09 did exactly that, via the unpinned AMI
      // the parameter above now fixes. This is the backstop for the *next*
      // cause: any replacement property (subnet, instance type, a property
      // added later) does the same thing, and there is no reason to find out
      // which one the hard way twice.
      //
      // Read what this does and does not buy precisely:
      //   - EC2 refuses the terminate, so the existing box SURVIVES. That is
      //     the point: the state on it is recoverable.
      //   - It does NOT stop the replacement. CloudFormation still creates a
      //     new instance and repoints the EIP and every SSM parameter at it,
      //     then fails to delete the old one — which is left running,
      //     detached from the stack and still billing. That failure is the
      //     alarm; clean the orphan up by hand once you have what you need
      //     off it.
      //   - It does not affect stop/start, so the power Lambda is
      //     unaffected — it only ever calls Start/StopInstances.
      //   - `cdk destroy` cannot delete the instance until this is cleared.
      //
      disableApiTermination: props.instanceTerminationProtection ?? true,
      // The bastion is the private tier's NAT instance (EgressStack routes the
      // private tier's 0.0.0.0/0 here). EC2 drops packets that aren't addressed
      // to the instance itself unless this check is off. Changing it is an
      // in-place, no-interruption update, never a replacement. The NAT itself
      // (ip_forward + MASQUERADE) is set up by hand on the box, like Tailscale.
      sourceDestCheck: false,
    });
    cdk.Tags.of(this.instance).add('Name', instanceName);

    // ── Elastic IP ──────────────────────────────────────────────────────────
    // The subnet's `mapPublicIpOnLaunch` already gives the box a public IPv4,
    // but that address is re-drawn on every stop/start, so nothing can be
    // pinned to it. An EIP makes the address stable for the life of the stack —
    // worth it for a Tailscale box, whose peers benefit from a fixed endpoint,
    // and for anything (DNS, an allow-list elsewhere) that wants to name the
    // bastion by address. Associating it *replaces* the auto-assigned address,
    // so this is one public IPv4 either way while the instance runs; it does
    // add the idle-address charge (~$3.6/mo) for the time the box is stopped.
    //
    // An EIP has no name property — only tags — so the convention name goes on
    // the `Name` tag. `ec2ElasticIp` is an org/domain/service type (no `key`).
    const eipName = naming.name({ type: 'ec2ElasticIp' });
    const eip = new ec2.CfnEIP(this, 'BastionEip', {
      // 'vpc' allocates from the VPC address pool — required for an EIP that
      // attaches to a VPC instance by allocation id.
      domain: 'vpc',
    });
    cdk.Tags.of(eip).add('Name', eipName);

    new ec2.CfnEIPAssociation(this, 'BastionEipAssociation', {
      allocationId: eip.attrAllocationId,
      instanceId: this.instance.ref,
    });

    // ── Power on demand (custom metric → alarm → Lambda) ────────────────────
    // The instance is only ever wanted while something is using it, and the one
    // failure mode that costs real money is leaving it running. So "off" is the
    // resting state, and being on has to be *asked for*: a service posts a value
    // above 0 to `powerMetric`, the alarm below goes to ALARM and the Lambda
    // starts the box; once the requests stop, the alarm falls back to OK after
    // the hold and the same Lambda stops it. Stopping preserves the instance id,
    // the EIP association, the security group and every SSM parameter above.
    const powerOnHold = props.powerOnHold ?? cdk.Duration.hours(4);
    // One evaluation period per minute of hold. `toMinutes()` throws on a
    // fractional minute; the range check is CloudWatch's own — an alarm's
    // evaluation window cannot exceed a day.
    const holdMinutes = powerOnHold.toMinutes();
    if (holdMinutes < 1 || holdMinutes > 24 * 60) {
      throw new Error(
        `BastionStack: powerOnHold must be between 1 minute and 1 day; got ${holdMinutes} minutes.`,
      );
    }

    // The kill switch for the *stop* half. Seeded (create-if-absent) rather
    // than CloudFormation-managed, so flipping it to 'false' in the console
    // survives every later deploy — that is the whole point of a switch you
    // reach for at 2am. The alarm always fires; the lambda reads this before
    // each stop and leaves the box running when it is not 'true'. Starting is
    // never gated: a request for the box is always honoured.
    const autoStopEnabledParamName = naming.name({
      type: 'ssmParam',
      key: 'auto-stop',
      purpose: 'enabled',
    });
    new SeedParameter(this, 'BastionAutoStopEnabledParam', {
      parameterName: autoStopEnabledParamName,
      value: 'true',
      description:
        "Whether the bastion is stopped when its power-on requests lapse. Set to 'false' to keep it running without a deploy (any other value also suspends the stop); 'true' to resume. Seeded once — never re-asserted by a deploy. If the parameter is deleted the stop still runs.",
    });

    const powerLogGroup = new logs.LogGroup(this, 'BastionPowerLogGroup', {
      // Lambda would otherwise create /aws/lambda/<fn-name> itself, with
      // retention set to never expire. Naming it here puts it under the same
      // convention as everything else and bounds what it keeps.
      logGroupName: naming.name({ type: 'cloudwatchLogsGroup', key: 'power' }),
      retention: logs.RetentionDays.ONE_MONTH,
      // Nothing here is worth keeping after the stack goes: one line per
      // state transition that EC2 itself already knows about.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const powerFn = new lambda.Function(this, 'BastionPowerFunction', {
      // Lambda function names are region-scoped, so the convention name is safe
      // to repeat per region — unlike the role above, which stays unnamed.
      functionName: naming.name({ type: 'lambdaFunction', key: 'power' }),
      runtime: lambda.Runtime.NODEJS_22_X,
      // arm64 for the same reason the instance is Graviton: cheaper per ms.
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      // Long enough to wait out a box that is still `stopping` when a new
      // request arrives — EC2 rejects a start until it has fully stopped, and
      // the handler retries for up to 2½ minutes.
      timeout: cdk.Duration.minutes(3),
      logGroup: powerLogGroup,
      environment: {
        // The instance id is passed rather than looked up: it is right here in
        // this stack, so a runtime read would only add a failure mode. The
        // enabled flag is the opposite — its whole value is being editable
        // between deploys, so only its *name* can be baked in.
        INSTANCE_ID: this.instance.ref,
        ENABLED_PARAM: autoStopEnabledParamName,
      },
      // Inline, not a bundled asset: the whole function is three API calls, and
      // the AWS SDK v3 ships in the Node.js runtime, so there is nothing to
      // build. It stays readable in the synthesized template and in the console.
      //
      // The source is a real `.js` file rather than a string literal here, so
      // an editor highlights and checks it and its decision logic has its own
      // unit test (`test/bastion-power.test.ts`) — it is read verbatim, so
      // what runs in Lambda is exactly what that test exercises. `fromInline`
      // caps the code at 4 KB; a test asserts the file still fits.
      code: lambda.Code.fromInline(
        fs.readFileSync(path.join(__dirname, POWER_HANDLER_FILE), 'utf8'),
      ),
    });

    // Exactly two actions on exactly one instance — the ARN is built from this
    // stack's own region/account, so the grant cannot reach a box elsewhere.
    powerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ec2:StartInstances', 'ec2:StopInstances'],
        resources: [
          this.formatArn({
            service: 'ec2',
            resource: 'instance',
            resourceName: this.instance.ref,
            arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
      }),
    );
    // Read-only, and only the switch — not the whole parameter tree. The
    // credentials parameters live under sibling paths in the same account.
    powerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          this.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: autoStopEnabledParamName.replace(/^\//, ''),
            arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
      }),
    );

    // "Any request in the last <hold>": the alarm looks back over one
    // one-minute period per minute of hold and needs just ONE of them above 0.
    //   - A single datapoint > 0 is enough to go to ALARM, on the alarm's next
    //     evaluation (CloudWatch evaluates once a minute, so "straight away"
    //     is within about a minute of the datapoint landing).
    //   - It returns to OK only when *every* period in the window is clear,
    //     i.e. a full hold after the last request. Each new request pushes
    //     that out again.
    //   - Maximum, so one publisher's 0 cannot average away another's 1 in the
    //     same minute.
    //   - Missing data counts as not breaching: a publisher that simply stops
    //     posting releases the box exactly like one that posts 0.
    const powerAlarm = new cloudwatch.Alarm(this, 'BastionPowerAlarm', {
      // Alarm names are region-scoped, so the convention name repeats safely.
      alarmName: naming.name({ type: 'cloudwatchAlarm', key: 'power' }),
      alarmDescription: `Bastion power: ALARM (start) on any ${powerMetric.namespace} ${powerMetric.metricName} above 0, OK (stop) once it has been 0 or silent for ${holdMinutes} minutes.`,
      metric: new cloudwatch.Metric({
        namespace: powerMetric.namespace,
        metricName: powerMetric.metricName,
        dimensionsMap: Object.fromEntries(
          powerMetric.dimensions.map((d) => [d.Name, d.Value]),
        ),
        statistic: cloudwatch.Stats.MAXIMUM,
        period: cdk.Duration.minutes(1),
      }),
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      threshold: 0,
      evaluationPeriods: holdMinutes,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    // The alarm invokes the Lambda directly on both transitions; the handler
    // reads the new state off the event. No INSUFFICIENT_DATA action: with
    // missing data treated as not breaching, that state is only ever the
    // alarm's first moment of life, which is not a reason to touch the box.
    powerAlarm.addAlarmAction(new cwActions.LambdaAction(powerFn));
    powerAlarm.addOkAction(new cwActions.LambdaAction(powerFn));

    // The metric's coordinates, for publishers outside this app. One parameter
    // holding all three, because they are only meaningful together — a
    // datapoint with the right name but the wrong dimensions is a different
    // metric and wakes nothing. CloudFormation-managed: it is derived from the
    // same `powerMetric` the alarm is built from, so it cannot drift.
    new ssm.StringParameter(this, 'BastionPowerMetricParam', {
      parameterName: naming.name({ type: 'ssmParam', key: 'power-metric' }),
      stringValue: JSON.stringify({
        Namespace: powerMetric.namespace,
        MetricName: powerMetric.metricName,
        Dimensions: powerMetric.dimensions,
      }),
      description:
        `Where to post to turn the bastion on: PutMetricData with this Namespace, MetricName and Dimensions and a Value above 0, in this region. It stays on until ${holdMinutes} minutes after the last such datapoint. Read-only: published by the stack.`,
    });

    // ── Discovery for out-of-app areas (SDK/CLI read at runtime) ────────────
    // Each parameter is named for exactly what it holds — there is no generic
    // `host`/`endpoint` alias, because *which* address is the right host is not
    // a detail a consumer can be allowed to skip. Once this box proxies
    // something (postgres, opensearch, …) and callers build a
    // `protocol://host:port` URL, the host is `private-ip`: the security group
    // admits only the VPC's own CIDR, so a connection to the public address
    // from anywhere — including from inside the VPC, where it leaves via the
    // IGW and returns with an out-of-VPC source — matches no ingress rule and
    // is dropped. `public-ip` is published to *identify* the box (DNS records,
    // an allow-list on someone else's side), not to connect to.
    //
    // The port belongs to whatever proxy you later run on the box; this stack
    // installs nothing, so it publishes no port. Add one here alongside the
    // thing that listens on it.
    //
    // There is deliberately no `public-dns-name`: the instance's PublicDnsName
    // attribute encodes the address the box had when CloudFormation created it
    // — the auto-assigned one — and the EIP is associated afterwards, so the
    // value would be captured stale and never corrected. `public-ip` is read
    // off the EIP itself, which is authoritative.
    const discovery = [
      {
        id: 'BastionInstanceIdParam',
        key: 'instance-id',
        value: this.instance.ref,
        description: 'Instance ID of the bastion (SSM Session Manager target).',
      },
      {
        id: 'BastionPrivateIpParam',
        key: 'private-ip',
        value: this.instance.attrPrivateIp,
        description:
          'Private IPv4 of the bastion. The host for protocol://host:port — the only address the security group admits, reachable from inside the VPC and from tailnet peers via the subnet router. Survives stop/start.',
      },
      {
        id: 'BastionPrivateDnsNameParam',
        key: 'private-dns-name',
        value: this.instance.attrPrivateDnsName,
        description:
          'Internal DNS name of the bastion, resolving to its private IPv4 inside the VPC. Same reachability as private-ip; prefer it if you would rather not pin an address.',
      },
      {
        id: 'BastionPublicIpParam',
        key: 'public-ip',
        value: eip.attrPublicIp,
        description:
          'Elastic IP of the bastion: its stable public IPv4, fixed across stop/start. An identifier, not a way in — no ingress rule admits traffic to it.',
      },
      {
        id: 'BastionEipAllocationIdParam',
        key: 'eip-allocation-id',
        value: eip.attrAllocationId,
        description: 'Allocation ID of the bastion Elastic IP (for re-association).',
      },
      {
        id: 'BastionSecurityGroupIdParam',
        key: 'security-group-id',
        value: sg.attrGroupId,
        description:
          "ID of the bastion's security group — reference it as a source in another group's rules.",
      },
    ];

    for (const p of discovery) {
      new ssm.StringParameter(this, p.id, {
        parameterName: naming.name({ type: 'ssmParam', key: p.key }),
        stringValue: p.value,
        description: p.description,
      });
    }

    // ── URLs for the services this box fronts ───────────────────────────────
    // These land under *sibling* service namespaces (/derrops/region/postgres,
    // /derrops/region/opensearch) rather than under bastion, deliberately: a
    // consumer that wants postgres looks up postgres. That the connection
    // currently happens to arrive via a tunnel on the bastion is this stack's
    // business, not the caller's — and if a managed database ever replaces the
    // tunnel, the parameter name does not move, only its value. The service
    // segment is the only thing that varies, so they derive from the same
    // `naming` instance via `.with({ service })`; org and domain stay defined
    // once, at the top of this file.
    //
    // Each service gets `host`, `port` and `url` — the two components and the
    // assembled form — so a caller can take whichever its client wants without
    // parsing. `url` is built from the very same host and port, never restated,
    // so the three cannot drift apart.
    //
    // Host is the private IPv4, for the reason given above: no ingress rule
    // admits traffic to the public address. Note these describe the *intended*
    // endpoint — this stack installs no proxy, so they only answer once you
    // have brought the corresponding tunnel up on the box.
    const host = this.instance.attrPrivateIp;
    const proxied = [
      {
        id: 'Postgres',
        label: 'Postgres',
        service: 'postgres',
        user: PLATFORM_USER,
        // libpq's URI scheme; callers append their own /database and credentials.
        scheme: 'postgresql',
        port: '5432',
        // Nothing about reaching Postgres varies per deployment shape the way
        // OpenSearch's auth does — a client connects with the credentials or it
        // does not.
        settings: [] as EndpointSetting[],
        // The datasource-credentials convention: engine/host/port/dbname plus
        // the user. Same shape Secrets Manager writes for an RDS secret, so a
        // consumer that already understands one understands this.
        credentials: {
          engine: 'postgres',
          host,
          port: 5432,
          // The always-present default database — a real value rather than a
          // placeholder, since it is right until someone provisions another.
          dbname: 'derrops',
          username: PLATFORM_USER.name,
          password: PLACEHOLDER_SECRET,
        },
      },
      {
        id: 'Opensearch',
        label: 'OpenSearch',
        service: 'opensearch',
        user: PLATFORM_USER,
        // https, not http: OpenSearch ships with its security plugin enabled,
        // so the node answers TLS on 9200. Switch to http if the thing behind
        // the tunnel is a plaintext cluster.
        scheme: 'https',
        port: '9200',
        // How a client is expected to talk to this endpoint — the two things a
        // consumer needs but cannot derive from host/port/url. They describe the
        // *endpoint*, not one user, so they sit beside host/port/url rather than
        // under `users/`.
        //
        // Seeded rather than managed, because these are precisely the switches
        // you flip when the cluster moves off the bastion onto a managed domain,
        // and that edit has to stick. Nothing in this stack knows when that
        // happens, so nothing here may re-assert them.
        settings: [
          {
            key: 'auth-mode',
            value: 'basic',
            description:
              "How to authenticate to OpenSearch: 'basic' (username/password from the users/ parameters beside this one), 'iam' (SigV4 with the caller's own credentials, no username needed), or 'anonymous'. 'basic' while the cluster is the security-plugin-enabled node behind the bastion tunnel; change it here when that changes.",
          },
          {
            key: 'service',
            value: 'es',
            description:
              "SigV4 signing service name, used only when auth-mode is 'iam': 'es' for a managed OpenSearch domain, 'aoss' for Serverless. Ignored in basic/anonymous mode, but published unconditionally so a consumer never has to guess it while switching.",
          },
        ],
        // Same convention, with the fields an HTTP datasource needs on top:
        // protocol, and `endpoint` pre-assembled so a client need not join
        // scheme/host/port itself.
        credentials: {
          engine: 'opensearch',
          host,
          // 9200, not the 443 of a managed OpenSearch domain: this is the port
          // the tunnel on the bastion listens on, and it matches the sibling
          // /derrops/region/opensearch/port parameter.
          port: 9200,
          protocol: 'https',
          endpoint: `https://${host}:9200`,
          username: PLATFORM_USER.name,
          password: PLACEHOLDER_SECRET,
        },
      },
    ];

    for (const p of proxied) {
      const ns = naming.with({ service: p.service });
      const reach = `Reachable from inside the VPC and from tailnet peers; requires the ${p.label} tunnel to be up on the bastion.`;

      for (const part of [
        {
          id: 'Host',
          key: 'host',
          value: host,
          description: `Host for ${p.label}: the region bastion's private IPv4, which proxies it. ${reach}`,
        },
        {
          id: 'Port',
          key: 'port',
          value: p.port,
          description: `Port for ${p.label} on the region bastion. ${reach}`,
        },
        {
          id: 'Url',
          key: 'url',
          value: `${p.scheme}://${host}:${p.port}`,
          description: `${p.label} URL, proxied by the region bastion (host and port as published alongside). ${reach}`,
        },
      ]) {
        const param = new ssm.StringParameter(this, `${p.id}${part.id}Param`, {
          parameterName: ns.name({ type: 'ssmParam', key: part.key }),
          stringValue: part.value,
          description: part.description,
        });
        // Re-tag from the sibling instance, overriding the stack-wide
        // derrops:service=bastion these would otherwise inherit. The tags have
        // to agree with the name: a parameter called /derrops/region/postgres/url
        // tagged as the bastion service is exactly the kind of thing that makes
        // a tag-based search quietly wrong.
        ns.applyTags((k, v) => cdk.Tags.of(param).add(k, v));
      }

      // ── Endpoint settings, seeded once ───────────────────────────────────
      // Siblings of host/port/url — same namespace, because they describe the
      // endpoint rather than any one user — but seeded rather than managed:
      // host/port/url are facts about the bastion that the stack knows and must
      // keep current, while these are choices about the endpoint that the stack
      // cannot know and must not overwrite.
      for (const s of p.settings) {
        new SeedParameter(this, `${p.id}${pascal(s.key)}Param`, {
          parameterName: ns.name({ type: 'ssmParam', key: s.key }),
          value: s.value,
          description: [
            `${p.label} ${s.key}, as reached via the region bastion.`,
            s.description,
            `Seeded once and never re-asserted — edit it with: aws ssm put-parameter --name <this> --type String --overwrite --value '<value>'.`,
          ].join(' '),
        });
      }

      // ── Credentials, seeded once, one parameter per field ────────────────
      // `users` + the username as `purpose` + the field as `kind`, so the
      // library builds the path — never a '/' inside a key. The user segment
      // keeps the grant boundary where it was (an IAM policy can still scope to
      // /derrops/region/postgres/users/* or to one user), and the field segment
      // adds a finer one below it: a consumer can be handed the connectivity
      // fields and not the password.
      //
      // A field per parameter rather than one JSON blob, because a blob is only
      // convenient for whoever reads all of it at once. Split, a caller reads
      // the one value its client wants — or the whole set in a single
      // `aws ssm get-parameters-by-path --path .../users/derrops-platform
      // --with-decryption` — and rotating the password touches the password,
      // not a re-serialized copy of every other field.
      //
      // Seeded, not managed: every value below reaches the template in
      // plaintext, and `SeedParameter` writes each only if that parameter does
      // not already exist. So live values that have since diverged from these
      // seeds — a rotated password, a `dbname` naming a database someone
      // provisioned later — survive every subsequent deploy untouched.
      for (const [field, value] of Object.entries(p.credentials)) {
        const secret = SECRET_FIELDS.has(field);
        const type = secret ? 'SecureString' : 'String';
        new SeedParameter(this, `${p.id}${p.user.id}${pascal(field)}Param`, {
          parameterName: ns.name({
            type: 'ssmParam',
            key: 'users',
            purpose: p.user.name,
            kind: field,
          }),
          type,
          // Numbers in the credentials set (port) are parameter values like any
          // other — SSM stores strings.
          value: String(value),
          // Documented on the parameter itself: whoever opens this in the
          // console to set the real value is exactly who needs to know what it
          // is and that editing it sticks, and they are not reading this file.
          description: [
            `${p.label} ${field} for the ${p.user.name} user, reached via the region bastion.`,
            FIELD_DESCRIPTIONS[field],
            secret
              ? `Seeded with a placeholder (${PLACEHOLDER_SECRET}) — set the real value with: aws ssm put-parameter --name <this> --type ${type} --overwrite --value '<value>'.`
              : `Seeded once and never re-asserted — edit it with: aws ssm put-parameter --name <this> --type ${type} --overwrite --value '<value>'.`,
            `Siblings under .../users/${p.user.name}/ complete the set; /derrops/region/${p.service}/{host,port,url} are the authoritative connectivity parameters.`,
          ].join(' '),
        });
      }
    }
  }
}
