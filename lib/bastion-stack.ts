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
 *     — no NAT Gateway. An **Elastic IP** is associated so that public IPv4
 *     (~$3.6/mo) is stable across stop/start, which also aids Tailscale NAT
 *     traversal later. Its address is published to SSM as `.../endpoint`.
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
  }
}
