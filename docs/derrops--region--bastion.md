# `derrops--region--bastion`

A single tiny **bastion EC2 instance** per region, reached over **SSM Session
Manager**. Defined in [`lib/bastion-stack.ts`](../lib/bastion-stack.ts)
(`BastionStack`).

The intent is to `tailscale up` on it **manually** (over an SSM session) so it
joins that region's VPC to your tailnet — exposing your local server's services
to the tailnet and giving tailnet peers a route into the VPC. This stack does
**not** install or configure Tailscale; it just stands up the box and makes SSM
sessions possible.

## Shape / cost

| Aspect | Choice | Why |
| --- | --- | --- |
| Instance type | `t4g.nano` (override via `instanceType`) | Cheapest current-gen; ample for a WireGuard relay |
| AMI | Amazon Linux 2023 **arm64** (latest, via AWS-owned SSM param) | `t4g` is Graviton (arm64); AL2023 ships the SSM agent. Resolved at deploy time, so it is correct in every region automatically |
| Subnet | `publicSubnets[0]` from `VpcStack` | Free IGW egress reaches the SSM (and later Tailscale) endpoints — no NAT Gateway; public IPv4 (~$3.6/mo) also aids Tailscale NAT traversal |
| Public address | **Elastic IP**, associated with the instance | Stable across stop/start, so the address can be pinned (DNS, an allow-list elsewhere, a Tailscale peer endpoint). Published to SSM as `.../endpoint` |

Roughly $7–8/mo per region (instance + public IPv4), so only deploy this into
regions you actually want a tailnet presence in.

The EIP replaces the subnet's auto-assigned public IPv4 rather than adding to
it, so a *running* bastion costs the same one address either way. It does keep
billing (~$3.6/mo) while the instance is **stopped**, since an unassociated
Elastic IP is charged as idle — that is the price of the address staying put.

## The IAM role is deliberately unnamed

Every other resource here carries a `derrops-conventions` name. The bastion's
IAM role does not — it is the one deliberate exception in this repo.

IAM is **account-global**, while this stack is deployed once per region. A fixed
convention name (`derrops--region--bastion`) would succeed in the first
region and fail with `EntityAlreadyExists` in the second. The conventions library
only emits its `region` segment for globally-unique resource types (S3 buckets),
so there is no convention name that stays unique per region. CDK generates a
unique physical name instead; find the role via its `derrops:*` tags or via the
instance profile. A test asserts `RoleName` stays absent from the template.

Everything else — the CloudFormation stack, the security group, the SSM
parameter, the instance's `Name` tag — is region-scoped by AWS, so the identical
name in two regions is two independent resources.

## Access

- **Nothing inbound from the internet.** The security group
  (`derrops--region--bastion`) allows **all egress** and exactly one
  ingress rule: all protocols from the **VPC's own CIDR**. The box has a public
  IPv4, but no source outside the VPC matches that rule, so there is no SSH from
  outside and no publicly reachable port.
- The in-VPC rule is what lets other instances — and tailnet peers arriving via
  the Tailscale subnet router — reach the bastion directly. Use its **private**
  IP: traffic sent to its public IP leaves via the IGW and comes back with an
  out-of-VPC source address, which the rule does not match.
- The CIDR is taken off the VPC passed in props (`CfnVPC.cidrBlock`), never
  restated here, so it follows `VpcStack`'s `vpcCidr`. It stays a synth-time
  literal deliberately — using the VPC's `CidrBlock` *attribute* would create a
  cross-stack CloudFormation export and pin the CIDR against later change.
- SSM itself needs **no** ingress rule at all — the instance profile carries
  `AmazonSSMManagedInstanceCore` and Session Manager works purely over the
  agent's outbound HTTPS.
- Connect with (note the explicit `--region` on both calls — the parameter name
  is the same in every region):

  ```bash
  aws ssm start-session --region ap-southeast-2 --target "$(
    aws ssm get-parameter --region ap-southeast-2 \
      --name /derrops/region/bastion/instance-id \
      --query Parameter.Value --output text)"
  ```

- Then, inside the session, install and bring up Tailscale yourself — e.g. as a
  subnet router / exit node so tailnet peers can reach VPC-internal resources:

  ```bash
  sudo tailscale up --ssh --advertise-exit-node --advertise-routes=10.0.0.0/16
  ```

  Every region's VPC uses the same `10.0.0.0/16` by default, so if you run a
  bastion in more than one region, give each VPC a distinct `vpcCidr` before
  advertising routes — otherwise the two subnet routers advertise overlapping
  prefixes to the same tailnet.

## Scripts

Wrappers around the three things you do to a bastion. Each takes the region as
an optional first argument, **defaulting to `ap-southeast-2`** (announced on
stderr whenever it falls back), and each resolves the instance from
`/derrops/region/bastion/instance-id` in that region — override the instance
with `-i/--instance-id`.

Note this is looser than the `cdk` commands, which never default: the SSM
parameter name is identical in every region, so an omitted region here operates
on ap-southeast-2's box rather than erroring. Pass the region explicitly once
you run a bastion anywhere else.

| Script | What it does |
| --- | --- |
| [`scripts/bastion-session.sh`](../scripts/bastion-session.sh) | Open an interactive shell over SSM Session Manager |
| [`scripts/bastion-start.sh`](../scripts/bastion-start.sh) | Start the instance; `--wait` blocks until it is running *and* online in SSM |
| [`scripts/bastion-stop.sh`](../scripts/bastion-stop.sh) | Stop the instance; `--wait` blocks until it reaches `stopped` |

```bash
./scripts/bastion-start.sh ap-southeast-2 --wait
./scripts/bastion-session.sh ap-southeast-2
./scripts/bastion-stop.sh ap-southeast-2
```

Start/stop are the cost lever: stopped, the bastion bills only its EBS root
volume and its idle Elastic IP (no instance-hours), and the instance id, Elastic
IP, security group and SSM parameters all survive — nothing is redeployed. Both
are idempotent, and both refuse a terminated instance rather than pretend.

One thing does not survive a stop/start cycle:

- **Tailscale**, if you brought it up by hand, needs `sudo tailscale up ...`
  again after the box comes back — and while it is stopped, any routes it
  advertises are gone from the tailnet.

## Discovery

In-app consumers receive the `instance` by reference. Out-of-app areas read SSM
(runtime, SDK/CLI, always with an explicit `--region`):

| Parameter | Value |
| --- | --- |
| `/derrops/region/bastion/instance-id` | Instance ID (SSM `start-session` target) |
| `/derrops/region/bastion/private-ip` | Private IPv4 — **the host to connect to** |
| `/derrops/region/bastion/private-dns-name` | Internal DNS name, resolving to that private IPv4 |
| `/derrops/region/bastion/public-ip` | The Elastic IP — stable public address, but nothing inbound is open to it |
| `/derrops/region/bastion/eip-allocation-id` | Allocation ID of the Elastic IP (for re-association) |
| `/derrops/region/bastion/security-group-id` | The security group, to reference as a source in another group's rules |

Each is named for exactly what it holds. There is deliberately **no generic
`host` or `endpoint` parameter** — which address is the right one is not a
detail a caller can be allowed to skip.

### Which address is the host?

When this box proxies something (postgres, opensearch, …) and callers build a
`protocol://host:port` URL, the host is **`private-ip`** (or
`private-dns-name`). The security group admits only the VPC's own CIDR, so a
connection to the public address matches no ingress rule and is dropped — that
includes attempts from *inside* the VPC, where traffic sent to the public IP
leaves via the IGW and comes back with an out-of-VPC source address. Reachable
from: other instances in the VPC, and tailnet peers arriving via the Tailscale
subnet router.

`public-ip` is for **identifying** the box, not connecting to it — a DNS record,
a Tailscale peer endpoint, an allow-list on someone else's side. That it is
Elastic is what makes it safe to pin.

No **port** is published: this stack installs no proxy. Publish one next to
whatever you later put on the box to listen.

There is no `public-dns-name` either. The instance's `PublicDnsName` attribute
encodes the address the box had when CloudFormation created it — the
auto-assigned one — and the EIP is associated afterwards, so the value would be
captured stale and never corrected. `public-ip` is read off the EIP itself,
which is authoritative.

```bash
# The host for a proxy URL, e.g. postgresql://<host>:5432/…
aws ssm get-parameter --region ap-southeast-2 \
  --name /derrops/region/bastion/private-ip \
  --query Parameter.Value --output text
```

## Deploy-time configuration

| Prop | Default | Notes |
| --- | --- | --- |
| `vpc` | — (required) | The region's VPC (`VpcStack.vpc`) |
| `publicSubnets` | — (required) | Public subnets (`VpcStack.publicSubnets`); the bastion lands in the first |
| `instanceType` | `t4g.nano` | Must stay an **arm64/Graviton** type to match the AMI |

Depends on [`derrops--region--network`](derrops--region--network.md) (consumes
its VPC + public subnets, so it deploys after it). The region comes from
`-c region=<aws-region>`.

```bash
npx cdk deploy --all -c region=ap-southeast-2
```
