import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { DerropsConventions } from 'derrops-conventions';

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
 *     agent preinstalled).
 *   - Lives in a **public subnet** (`publicSubnets[0]`) so it reaches the SSM
 *     endpoints (and later the Tailscale coordination server) over the free IGW
 *     — no NAT Gateway. The subnet's `mapPublicIpOnLaunch` gives it a public
 *     IPv4 (~$3.6/mo), which also aids Tailscale NAT traversal later.
 *
 * ## Access
 *
 *   - **No inbound at all.** The instance profile carries
 *     `AmazonSSMManagedInstanceCore` and the security group allows all egress,
 *     so you connect with `aws ssm start-session --target <id>` — no SSH, no
 *     open ports. SSM works purely over the agent's outbound HTTPS.
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

    // t4g is Graviton — the AMI must be arm64. `latestAmazonLinux2023` resolves
    // to an AWS-owned public SSM parameter at deploy time (not our config).
    const imageId = ec2.MachineImage.latestAmazonLinux2023({
      cpuType: ec2.AmazonLinuxCpuType.ARM_64,
    }).getImage(this).imageId;

    // ── IAM role + instance profile (SSM Session Manager) ───────────────────
    // Deliberately *unnamed* — the one exception to the always-use-a-convention
    // -name rule. IAM is account-global, so a fixed convention name would
    // collide the moment this stack is deployed to a second region, and the
    // conventions library only emits its `region` segment for globally-unique
    // resource types (S3 buckets) — there is no convention name that stays
    // unique per region. CDK generates a unique physical name instead; find the
    // role via the derrops:* tags or the instance profile.
    const role = new iam.Role(this, 'BastionRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        // The only access path: connect via SSM Session Manager, no SSH.
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    const instanceProfile = new iam.CfnInstanceProfile(this, 'BastionInstanceProfile', {
      roles: [role.roleName],
    });

    // ── Security group: all egress, no inbound ──────────────────────────────
    // SSM needs only the agent's outbound HTTPS; nothing inbound is required.
    const sgName = naming.name({ type: 'ec2SecurityGroup', purpose: 'bastion' });
    const sg = new ec2.CfnSecurityGroup(this, 'BastionSecurityGroup', {
      groupName: sgName,
      groupDescription: 'Bastion: all egress, no inbound (access via SSM Session Manager).',
      vpcId: props.vpc.ref,
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
    });
    cdk.Tags.of(this.instance).add('Name', instanceName);

    // ── Discovery for out-of-app areas (SDK/CLI read at runtime) ────────────
    new ssm.StringParameter(this, 'BastionInstanceIdParam', {
      parameterName: naming.name({ type: 'ssmParam', key: 'instance-id' }),
      stringValue: this.instance.ref,
      description: 'Instance ID of the bastion (connect via SSM Session Manager).',
    });
  }
}
