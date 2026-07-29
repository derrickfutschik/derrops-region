# `derrops--region--network`

The region's shared **VPC** with all three subnet tiers — one VPC per region you
light up, not one per account and not one per application. Defined in
[`lib/vpc-stack.ts`](../lib/vpc-stack.ts) (`VpcStack`). Names and CIDRs come from
`derrops-conventions`' `topology()`.

## Topology

A single network domain (`region`) carves up the VPC. With the defaults
(`10.0.0.0/16`, the region's first three AZs, tiers `private`/`public`/`isolated`),
shown here for a region in AZ group `1` (e.g. `us-east-1`):

```
VPC        derrops                       10.0.0.0/16
 region    (domain /20)                  10.0.0.0/20
   private   10.0.0.0/22  → 10.0.0.0/24 (1a), 10.0.1.0/24 (1b), 10.0.2.0/24 (1c)
   public    10.0.4.0/22  → 10.0.4.0/24 (1a), 10.0.5.0/24 (1b), 10.0.6.0/24 (1c)
   isolated  10.0.8.0/22  → 10.0.8.0/24 (1a), 10.0.9.0/24 (1b), 10.0.10.0/24 (1c)
```

In `ap-southeast-2` the CIDRs are identical and the AZ suffixes become `2a`/`2b`/`2c`
(`derrops--region--public--2a`, …). **The CIDR plan is the same in every region** —
these VPCs do not peer, so overlapping address space is not a conflict. If you
ever peer two regions, give one of them a different `vpcCidr` first.

Subnet / route-table / NACL names are domain-scoped (`derrops--region--<tier>--<az>`),
never service-scoped — the `service: network` segment only names the stack.

### Network ACL

One custom NACL fronts every subnet in the domain. A *custom* NACL (unlike the
VPC default) starts as **deny-all**, so it carries an explicit **allow-all entry
in each direction** (rule 100, all protocols, `0.0.0.0/0`); the stateful
**security groups** are the real access control. NACLs are stateless, so
allow-all both ways avoids the ephemeral-return-port trap. Without these entries
every subnet is cut off from the internet (this is what blocks the SSM agent /
outbound egress if they're ever removed).

Tiers and AZs are **append-only** CIDR slots: appending a fourth AZ
(`availabilityZoneSuffixes: ['1a','1b','1c','1d']`) or a new tier never shifts an
existing subnet's CIDR, so CloudFormation provisions only the new subnets.

| Tier | Routing | Typical residents |
| --- | --- | --- |
| `private` | **No default route by default** (no NAT — see below) | app servers, ECS tasks, Lambda-in-VPC |
| `public` | `0.0.0.0/0` → Internet Gateway | load balancers, bastion, **the Tailscale relay** |
| `isolated` | No internet route at all | RDS/Aurora, OpenSearch, ElastiCache |

## Cost model: IGW yes, NAT no

The stack creates one **Internet Gateway** (free — you pay only for data
transfer, which you'd pay anyway) and **zero NAT Gateways**. A NAT Gateway is
~$0.045/hr (~$32/mo) + $0.045/GB; for an account whose main tenant is a single
small relay box that would dominate the bill. So the `private` tier is left with
no `0.0.0.0/0` route. To give it egress later, cheapest-first:

- **Egress-only IGW** — free, but IPv6-only (requires enabling IPv6 on the VPC).
- **Route through the Tailscale box** acting as a NAT / subnet router.
- **NAT instance** — a tiny EC2 running NAT (~$3–4/mo).
- **NAT Gateway** — simplest, but the ~$32/mo option.

Note this cost repeats per region: each region you light up gets its own IGW
(free) and its own public IPv4 charges for whatever runs in its public tier.

## Where to run the Tailscale relay EC2

> The instance is **not created** by this stack — this is the recommendation.
> [`derrops--region--bastion`](derrops--region--bastion.md) is the box that acts
> on it.

Run the small Tailscale EC2 in a **`public` subnet**. The SSM parameter
`/derrops/region/network/tailscale-relay-subnet-id` **in that region** points at
the recommended one (the first public subnet).

Why public:

- Tailscale is **outbound-initiated** (WireGuard to the coordination server +
  DERP relays), so a public subnet reaches the internet over the **free IGW** —
  no NAT Gateway needed. Cost-optimal.
- A public IP improves NAT traversal, so peers form **direct** encrypted tunnels
  instead of relaying through DERP (lower latency). The public IPv4 charge
  (~$3.6/mo) is far below any NAT option.
- The security group needs **no inbound** rules from the internet (optionally
  UDP 41641 to aid direct connections; it falls back to DERP without it). Allow
  all egress.
- As a **subnet router / exit node**, it advertises routes so tailnet peers —
  including your local dev server — can reach VPC-internal `private` / `isolated`
  resources, and it exposes the local dev server's services onto the tailnet,
  all while sitting in the cheap public tier and reaching the other tiers over
  the VPC's internal routing.

## Discovery

In-app consumers receive the VPC and subnet arrays by reference
(`vpc`, `publicSubnets`, `privateSubnets`, `isolatedSubnets`). Out-of-app areas
read SSM (runtime, SDK/CLI) — **always with an explicit `--region`**, since the
same parameter names exist independently in every region you have deployed:

| Parameter | Value |
| --- | --- |
| `/derrops/region/network/vpc-id` | VPC ID |
| `/derrops/region/network/subnet-ids/public` | comma-separated public subnet IDs |
| `/derrops/region/network/subnet-ids/private` | comma-separated private subnet IDs |
| `/derrops/region/network/subnet-ids/isolated` | comma-separated isolated subnet IDs |
| `/derrops/region/network/tailscale-relay-subnet-id` | recommended subnet for the Tailscale EC2 |

```bash
aws ssm get-parameter --region ap-southeast-2 \
  --name /derrops/region/network/vpc-id --query Parameter.Value --output text
```

## Deploy-time configuration

| Prop | Default | Notes |
| --- | --- | --- |
| `vpcCidr` | `10.0.0.0/16` | /16 → /20 per domain, /22 per tier, /24 per subnet |
| `availabilityZoneSuffixes` | the region's first three AZs (`['1a','1b','1c']` in `us-east-1`, `['2a','2b','2c']` in `ap-southeast-2`) | append-only; **don't** hardcode a group number — that pins the stack to one region |

The region itself is **required** and comes from `-c region=<aws-region>`; the
stack throws if it would synth without a concrete region. Independent of the
bastion stack — no `addStackDependency` wiring in this direction.

```bash
npx cdk deploy 'derrops--region--network' -c region=ap-southeast-2
```
