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
| AMI | Amazon Linux 2023 **arm64**, **pinned** at `/derrops/region/bastion/ami-id` | `t4g` is Graviton (arm64); AL2023 ships the SSM agent. Read at deploy time from a parameter you own, per region — never AWS's floating "latest" pointer, which replaces the instance whenever it moves (see below) |
| Subnet | `publicSubnets[0]` from `VpcStack` | Free IGW egress reaches the SSM (and later Tailscale) endpoints — no NAT Gateway; public IPv4 (~$3.6/mo) also aids Tailscale NAT traversal |
| Public address | **Elastic IP**, associated with the instance | Stable across stop/start, so the address can be pinned (DNS, an allow-list elsewhere, a Tailscale peer endpoint). Published to SSM as `.../endpoint` |

Roughly $7–8/mo per region (instance + public IPv4), so only deploy this into
regions you actually want a tailnet presence in.

The EIP replaces the subnet's auto-assigned public IPv4 rather than adding to
it, so a *running* bastion costs the same one address either way. It does keep
billing (~$3.6/mo) while the instance is **stopped**, since an unassociated
Elastic IP is charged as idle — that is the price of the address staying put.

## Not losing the box

The bastion is the only thing in this repo whose contents cannot be rebuilt
from the repo — Tailscale is brought up on it **by hand** — so it is the only
resource that must not be allowed to vanish in a routine deploy. Two guards
exist, added after a deploy did exactly that.

### What went wrong on 2026-08-09

A deploy that touched nothing about the instance terminated
`i-0f2022ddf0410d02b` (created Jul 28) and created `i-0a946bfd58e572b0a`.
The stack event was `Requested update requires the creation of a new physical
resource`.

The cause was the AMI. The stack used
`MachineImage.latestAmazonLinux2023()`, which emits a CloudFormation parameter
pointing at AWS's public *newest AL2023* pointer
(`/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-arm64`), re-resolved
on **every** deploy. AWS republished it in the twelve days since the box was
created, `ImageId` is a replacement property on `AWS::EC2::Instance`, and so the
deploy rebuilt the box. Every AL2023 release armed the next deploy to do it
again.

(The security group was the other suspect and is innocent: it was replaced on
Jul 29 and the instance recorded a plain in-place `UPDATE_COMPLETE`. Swapping
`SecurityGroupIds` on a VPC instance really is a no-interruption update.)

### 1. The AMI is pinned in SSM

| | |
| --- | --- |
| Parameter | `/derrops/region/bastion/ami-id` |
| Current value | `ami-0a036c1f3ca5d1f73` (`al2023-ami-2023.12.20260803.3-kernel-6.1-arm64`) |
| Seeded with | The latest AL2023 arm64 image, **once**, on the first `cdk` run in a region |
| Changed by | **You**, and nothing else. No deploy ever re-asserts it |

`BastionStack` reads it as an `AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>`
stack parameter, so the value resolves at deploy time and stays region-portable
— the same parameter name in another region names that region's own image.
Nothing moves it but you, so a deploy no longer decides for itself what the box
should be running.

Upgrading is now a deliberate act: overwrite the parameter, then deploy.

```bash
aws ssm put-parameter --region ap-southeast-2 \
  --name /derrops/region/bastion/ami-id \
  --type String --overwrite --value ami-0123456789abcdef0
npx cdk deploy --all -c region=ap-southeast-2
```

That deploy **replaces the instance** — which is the point of doing it on
purpose. Anything set up by hand on the box (Tailscale) has to be set up again.
To find the current AL2023 arm64 image for a region:

```bash
aws ssm get-parameter --region ap-southeast-2 \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-arm64 \
  --query Parameter.Value --output text
```

Whatever you pin must be **arm64** — `t4g` is Graviton. Nothing in the stack can
check that; a mismatch fails at launch.

#### Where the first value comes from

A new region needs no preparation: the parameter defaults to the latest AL2023
arm64 image, seeded on the first `cdk` command run against that region.

The seeding lives in [`bin/region-bootstrap.ts`](../bin/region-bootstrap.ts)
(logic in [`lib/ensure-ami-parameter.ts`](../lib/ensure-ami-parameter.ts)), which
is the **only** thing in this repo that touches AWS outside a stack. That is
forced, not chosen: CloudFormation resolves `AWS::SSM::Parameter::Value<>` stack
parameters **before it touches any resource**, so a stack cannot create the
parameter it also reads — the read happens first and the deploy fails. Ahead of
synth is the only place left.

What it does, on every `cdk` command:

1. Read `/derrops/region/bastion/ami-id` in the target region. **Present → stop.**
   An existing pin, however it got there, is never disturbed.
2. Absent → read AWS's public `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-arm64`
   for that region and write it, with `Overwrite: false`.

Its decision logic is unit-tested with stub SSM operations
([`test/ensure-ami-parameter.test.ts`](../test/ensure-ami-parameter.test.ts)) —
the case that matters being *existing pin plus newer image available* → nothing
written.

Failures here are printed and swallowed: `cdk list` and `cdk synth` have to keep
working without credentials. If the parameter genuinely does not exist, the
deploy fails on its own with `Parameters [/derrops/region/bastion/ami-id] do not
exist in the Parameter Store`, before changing anything.

### 2. Termination protection

The instance carries `DisableApiTermination` (`instanceTerminationProtection`,
default `true`). The pinned AMI removes the *known* cause of a replacement; this
catches the next one — a subnet change, an instance-type change, a replacement
property added later.

| | |
| --- | --- |
| The existing box **survives** | EC2 refuses the terminate. Whatever you set up on it is still there |
| The replacement still **happens** | CloudFormation creates a new instance and repoints the EIP and every SSM parameter at it, then fails to delete the old one |
| The old box becomes an **orphan** | Still running, still billing, no longer in the stack. That failed delete is the alarm — get what you need off it and terminate it by hand |
| Stop/start is **unaffected** | Including the daily auto-stop, which only ever calls `StopInstances` |
| `cdk destroy` **blocks** | Pass `instanceTerminationProtection: false` and deploy first, or clear the attribute live: `aws ec2 modify-instance-attribute --region ap-southeast-2 --instance-id <id> --no-disable-api-termination` (the next deploy re-asserts it) |

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

## Automatic shutdown (04:00 AEST daily)

You do not have to remember to run `bastion-stop.sh`. The stack schedules the
stop itself, so **off is the resting state** and the expensive failure mode —
leaving the box running for a week — cannot happen:

| Resource | Name | What it is |
| --- | --- | --- |
| EventBridge rule | `derrops--region--bastion--auto-stop` | `cron(0 18 * * ? *)` — fires once a day, **always enabled** |
| Lambda function | `derrops--region--bastion--auto-stop` | Node.js 22, arm64, inline; checks the switch, then `ec2:StopInstances` |
| Log group | `/derrops/region/bastion/auto-stop` | 30-day retention (Lambda's own default never expires) |

It is deliberately **one-directional** — the Lambda never *starts* the instance.
That is what makes it safe to run unattended: the worst it can do is stop a box
that is already stopped, which EC2 treats as a no-op. Start the bastion yourself
with `./scripts/bastion-start.sh` whenever you need it; expect it to be off
again by the next morning, along with anything you brought up by hand on it.

Its IAM grant is two actions, each scoped to one ARN in this account and region:
`ec2:StopInstances` on this instance, and `ssm:GetParameter` on the switch below
— never `*`, never a path wildcard (the `SecureString` credentials sit under
sibling paths), and never a start or terminate action. Tests assert all of that,
since this is the one thing here that runs with nobody watching.

### The two SSM parameters

| Parameter | Value | Editable? |
| --- | --- | --- |
| `/derrops/region/bastion/auto-stop/enabled` | `true` | **Yes** — the kill switch, read on every run |
| `/derrops/region/bastion/auto-stop/schedule` | `cron(0 18 * * ? *)` | No — published by the stack |

**`enabled`** is a real runtime switch:

1. The rule is **always enabled** — nothing in the stack turns it off — so it
   fires every day at 18:00 UTC no matter what.
2. Each firing invokes the Lambda, which **re-reads this parameter first** and
   returns without touching EC2 unless the value is `true` (case- and
   whitespace-insensitive; any other value suspends the stop).

Gating in the Lambda rather than on the rule's `State` is what makes suspending
it a live edit instead of a deploy — and means there is no second place that can
disagree about whether auto-stop is on. Suspend it — for an overnight job, a
migration, a debugging session — with:

```bash
aws ssm put-parameter --region ap-southeast-2 \
  --name /derrops/region/bastion/auto-stop/enabled \
  --type String --overwrite --value false
```

It goes through [`SeedParameter`](../lib/seed-parameter.ts) rather than being
CloudFormation-managed, for the same reason the credentials do: `Overwrite:
false` means it is written once and never re-asserted, so a `false` you set at
2am survives every later `cdk deploy`. **Remember to set it back** — nothing
re-enables it for you. If the parameter is deleted entirely the stop still runs:
the stack seeds it `true`, so absence means the switch is gone, not off.

**`schedule`** is the opposite — a read-only descriptor, so the cron can be read
without a `cdk synth` or an `events:DescribeRule` call. Its value is taken off
the very same `events.Schedule` object the rule is built from, so the two cannot
drift; a test asserts it follows an overridden `autoStopSchedule`. Editing it
changes nothing — EventBridge owns the schedule, so change the
`autoStopSchedule` prop and deploy.

### Why 18:00 UTC, and what daylight saving does

An **EventBridge rule** cron is evaluated in UTC and has no timezone field at
all, so the schedule is stated as UTC and derived in
[`lib/bastion-stack.ts`](../lib/bastion-stack.ts) from two constants:
`STOP_HOUR_AEST = 4` and `AEST_UTC_OFFSET_HOURS = 10` → 18:00 UTC. Being UTC, the
same expression is correct in **every** region this stack is deployed to.

AEST is fixed UTC+10, so during Sydney's daylight saving (AEDT, UTC+11) this
fires at **05:00 local** rather than 04:00. For "power the box off overnight"
that hour is immaterial. If it ever matters, the fix is to move the schedule off
an EventBridge *rule* onto EventBridge **Scheduler** (`scheduler.CfnSchedule`),
which does take `ScheduleExpressionTimezone: 'Australia/Sydney'` and follows
the zone's DST transitions.

To change the timing, pass a different `autoStopSchedule` (see the props table
below); to suspend the stop without a deploy, use the `enabled` switch above.

### Where the handler lives

The Lambda's source is a real file —
[`lib/bastion-auto-stop.js`](../lib/bastion-auto-stop.js) — not a string literal
inside the stack. `BastionStack` reads it **verbatim** into
`lambda.Code.fromInline`, so an editor highlights and checks it, and what runs
in AWS is byte-for-byte what the repo holds (a test asserts the template's
`ZipFile` equals the file, and that it stays under `fromInline`'s 4 KB cap).

It stays inline rather than becoming a `fromAsset` bundle because the whole
function is two API calls and the AWS SDK v3 ships in the Node.js runtime —
there is nothing to build, and the code stays readable in the console and in
`cdk diff`.

Its decision logic takes the two AWS calls as injected functions, so
[`test/bastion-auto-stop.test.ts`](../test/bastion-auto-stop.test.ts) exercises
it with plain stubs — no SDK dependency, no mocking framework. That is where the
switch semantics are pinned: `'true'` stops, anything else skips, a *deleted*
parameter still stops, and any other SSM error is raised rather than swallowed.

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
| `/derrops/region/bastion/auto-stop/enabled` | Kill switch for the daily auto-stop — **editable** (see above) |
| `/derrops/region/bastion/auto-stop/schedule` | The auto-stop cron, in UTC — read-only |
| `/derrops/region/bastion/ami-id` | The pinned AMI — **an input**, not an output: seeded once with the latest AL2023 arm64, then yours to change; the stack only reads it (see above) |

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

### Proxied services

For each service the bastion fronts, it publishes `host`, `port` and `url` —
the two components and the assembled form — under that service's **own**
namespace rather than under `bastion`:

| Parameter | Value |
| --- | --- |
| `/derrops/region/postgres/host` | the bastion's private IPv4 |
| `/derrops/region/postgres/port` | `5432` |
| `/derrops/region/postgres/url` | `postgresql://<host>:5432` |
| `/derrops/region/opensearch/host` | the bastion's private IPv4 |
| `/derrops/region/opensearch/port` | `9200` |
| `/derrops/region/opensearch/url` | `https://<host>:9200` |

`url` is assembled from the very same host and port, never restated, so the
three cannot drift apart — take whichever your client wants (a `psql` URI, or
separate `PGHOST`/`PGPORT`) without parsing.

The placement is deliberate: a consumer that wants postgres looks up
**postgres**. Arriving via a tunnel on the bastion is this stack's business, not
the caller's — and if a managed database ever replaces the tunnel, the parameter
names do not move, only their values. Each is tagged `derrops:service` for its
own service, so a tag-based search finds it under the right owner.

The host is the private IPv4, per the rule above. All of these describe the
**intended** endpoint: this stack installs no proxy, so they only answer once
the corresponding tunnel is up on the box.

OpenSearch is `https` on the assumption its security plugin is enabled (the
default). If the cluster behind the tunnel is plaintext, change the scheme in
`lib/bastion-stack.ts`.

```bash
psql "$(aws ssm get-parameter --region ap-southeast-2 \
  --name /derrops/region/postgres/url --query Parameter.Value --output text)/mydb"
```

### Credentials

Each service also gets a **`SecureString`** parameter per user:

| Parameter |
| --- |
| `/derrops/region/postgres/users/derrops-platform` |
| `/derrops/region/opensearch/users/derrops-platform` |

`users` is the key and the username is the `purpose` segment, so the library
builds the path — the key itself never contains a `/`. One parameter per user
puts the grant boundary at the parameter: an IAM policy can scope to
`/derrops/region/postgres/users/*` or to a single user.

#### The datasource-credentials convention

The value is a **complete datasource descriptor**, not a bare password — one
read hands a client everything it needs to connect. This is the shape Secrets
Manager writes for an RDS secret, so a consumer that already understands one
understands these. It is documented in each parameter's own `description`, since
whoever opens it in the console to set the real password is exactly who needs to
know the shape and is not reading the CDK source.

Postgres — `engine`, `host`, `port`, `dbname`, `username`, `password`:

```json
{
  "engine": "postgres",
  "host": "10.0.4.189",
  "port": 5432,
  "dbname": "postgres",
  "username": "derrops-platform",
  "password": "super-secret-password"
}
```

OpenSearch — the same, plus what an HTTP datasource needs: `protocol`, and
`endpoint` pre-assembled so a client need not join scheme/host/port itself:

```json
{
  "engine": "opensearch",
  "host": "10.0.4.189",
  "port": 9200,
  "protocol": "https",
  "endpoint": "https://10.0.4.189:9200",
  "username": "derrops-platform",
  "password": "super-secret-password"
}
```

Two values are worth calling out because they differ from what a *managed* AWS
datasource would carry:

- **`host` is the bastion's private IPv4**, not an RDS/OpenSearch endpoint —
  everything here is reached through the tunnel on the box.
- **OpenSearch `port` is 9200**, not the 443 of a managed OpenSearch domain,
  matching `/derrops/region/opensearch/port`.

The `host`, `port` and `endpoint` fields are **seed-time** values: they are
written once and never re-asserted (see below), so if the bastion instance is
ever replaced they go stale in this blob while
`/derrops/region/<service>/{host,port,url}` update with the stack. Those
sibling parameters are the authoritative ones for connectivity; treat this blob
as authoritative for **credentials**.

**These are seeded, not managed.** CloudFormation's `AWS::SSM::Parameter` cannot
create a `SecureString` at all, so they go through
[`SeedParameter`](../lib/seed-parameter.ts) — an `AwsCustomResource` calling
`ssm:PutParameter` with `Overwrite: false`, which writes only if the parameter
is absent. Encryption uses the account's default `alias/aws/ssm` key.

The seeded blob carries `"password": "REPLACE-ME"`, and it **reaches the
CloudFormation template in plaintext** — that is why the password is a
placeholder while every other field is real. Set the real value out-of-band,
once:

```bash
aws ssm put-parameter --region ap-southeast-2 \
  --name /derrops/region/postgres/users/derrops-platform \
  --type SecureString --overwrite \
  --value '{"engine":"postgres","host":"10.0.4.189","port":5432,"dbname":"postgres","username":"derrops-platform","password":"…"}'
```

`Overwrite: false` is what makes that safe: after the first seed, no `cdk deploy`
re-asserts, re-seeds, or diffs the live value, so the real credentials survive
every future deployment. A test asserts the template carries only the
placeholder.

If these ever need rotation, cross-account access, or generated passwords,
that is the point to move them to Secrets Manager — SSM `SecureString` is the
cheap option (free at standard tier, versus ~$0.40/secret/month) and does none
of those three.

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
| `autoStopSchedule` | 04:00 AEST — `cron(0 18 * * ? *)` | An `events.Schedule`; **evaluated in UTC** (a rule cron has no timezone) |
| `instanceTerminationProtection` | `true` | EC2 `DisableApiTermination` (see above). Set `false` before `cdk destroy`. Not `terminationProtection` — `cdk.StackProps` owns that name for protecting the *stack* |
| `amiId` | read from `/derrops/region/bastion/ami-id` | Pins the AMI in source instead. Leave unset — an id here is a different image, or none, in the next region. For tests and one-off recovery |

Depends on [`derrops--region--network`](derrops--region--network.md) (consumes
its VPC + public subnets, so it deploys after it). The region comes from
`-c region=<aws-region>`. `/derrops/region/bastion/ami-id` is seeded
automatically in a region that has never had one (see above).

```bash
npx cdk deploy --all -c region=ap-southeast-2
```

Check what a deploy would do to the instance before running it — `ImageId` and
`SubnetId` changes are the ones that replace the box:

```bash
npx cdk diff -c region=ap-southeast-2
```
