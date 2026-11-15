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
| Stop/start is **unaffected** | Including the power Lambda, which only ever calls `StartInstances` / `StopInstances` |
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

## NAT instance for the private tier

The bastion is also the private tier's NAT instance:
[`derrops--region--egress`](derrops--region--egress.md) routes the private
tier's `0.0.0.0/0` to it. This stack turns the **source/destination check off**
(`SourceDestCheck: false`, an in-place update), since EC2 otherwise drops
forwarded packets. IP forwarding and the `MASQUERADE` rule are set up on the box
by hand; the steps are in the egress stack's doc. While the box is stopped, the
private tier has no egress.

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
| [`scripts/bastion-start.sh`](../scripts/bastion-start.sh) | Start the instance and post a power-on request, so it is stopped again after the hold; `--wait` blocks until it is running *and* online in SSM |
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

## Power on demand

The bastion is **off unless something asks for it**. Asking is posting a number
above 0 to a CloudWatch custom metric; a CloudWatch alarm on that metric turns
the box on, and turns it off again 4 hours after the last request:

| Resource | Name | What it is |
| --- | --- | --- |
| Custom metric | namespace `derrops/region`, name `PowerOnRequests`, dimension `service=bastion` | What publishers post to. Not a deployed resource — it exists once something posts |
| CloudWatch alarm | `derrops--region--bastion--power` | `Maximum > 0` in **1 of the last 240** one-minute periods; missing data is not breaching |
| Lambda function | `derrops--region--bastion--power` | Node.js 22, arm64, inline; invoked by the alarm on ALARM and on OK |
| Log group | `/derrops/region/bastion/power` | 30-day retention (Lambda's own default never expires) |

How the alarm's shape gives the behaviour:

1. **One datapoint above 0 → ALARM → start.** Only 1 of the 240 periods has to
   breach, so the first request trips the alarm on its next evaluation and the
   Lambda calls `ec2:StartInstances`. CloudWatch evaluates once a minute, so
   expect the start within about a minute of the datapoint, then the usual boot
   time on top.
2. **240 clear minutes → OK → stop.** The alarm leaves ALARM only when *every*
   period in the window is clear — 4 hours after the last request. Each new
   request pushes that out again. On ALARM → OK the Lambda calls
   `ec2:StopInstances`.
3. **Posting 0 and going silent are the same thing.** Missing data is treated as
   not breaching, so a publisher can post `0` when it is done or just stop
   posting. Either way the hold runs from its last datapoint above 0.
4. **`Maximum`, not `Average`** — one publisher's `0` cannot cancel another's
   `1` in the same minute.

Change the hold with the `powerOnHold` prop (see the props table below).

### Requesting the bastion from another service

The names come from `derrops-conventions`, so a service using the library
derives them rather than hardcoding them — `org: 'derrops'`, `domain:
'region'`, `service: 'bastion'`:

```typescript
const bastion = new DerropsConventions({ org: 'derrops', domain: 'region', service: 'bastion' })

await cloudwatch.send(new PutMetricDataCommand({
  Namespace: bastion.name({ type: 'cloudwatchMetricNamespace' }), // 'derrops/region'
  MetricData: [{
    MetricName: 'PowerOnRequests',
    Dimensions: bastion.dimensions(),                             // [{ Name: 'service', Value: 'bastion' }]
    Value: 1,
  }],
}))
```

The same three values are published as JSON at
`/derrops/region/bastion/power-metric` for anything that would rather read them
at runtime, and exported as `powerMetric` from
[`lib/bastion-stack.ts`](../lib/bastion-stack.ts). From a shell:

```bash
aws cloudwatch put-metric-data --region ap-southeast-2 \
  --namespace derrops/region --metric-name PowerOnRequests \
  --dimensions service=bastion --value 1
```

Things a publisher has to get right:

- **The dimension is part of the metric's identity.** A datapoint without
  `service=bastion` — or with `Service`, capitalised — is a *different* metric
  and wakes nothing. (The library emits lowercase `service`; its README shows
  `Service`. A test pins the real output.)
- **Post to the bastion's region.** The metric exists independently in each
  region, so the client needs an explicit region.
- **Keep posting while you need the box.** One datapoint buys 4 hours. A
  long-running consumer should post on each use, or on a timer comfortably
  inside the hold.
- **It needs `cloudwatch:PutMetricData`.** That action has no resource ARN —
  scope it with a `cloudwatch:namespace` condition of `derrops/region`.
- **Wait for the box.** Posting returns at once; the instance is reachable a
  minute or two later. Retry the connection rather than assuming it is up.

### What the alarm does not do

The Lambda acts on alarm **transitions**, not on the alarm's standing state:

- A request that arrives while the alarm is *already* in ALARM extends the hold
  but invokes nothing. If someone stopped the box by hand in the meantime
  (`bastion-stop.sh`), it stays stopped until the alarm has returned to OK and
  tripped again — or until you start it by hand.
- It stops the box only on **ALARM → OK**. The OK a brand-new alarm settles into
  on its first evaluation (so, the deploy that creates it) is ignored, as is
  INSUFFICIENT_DATA. A box that was started without a request is therefore never
  stopped by this — which is why
  [`scripts/bastion-start.sh`](../scripts/bastion-start.sh) posts a request
  itself: a manual start gets the same 4-hour hold and the same automatic stop.
- A request that lands just as the box is stopping is honoured: EC2 rejects a
  start mid-stop, so the Lambda retries every 5 seconds for up to 2½ minutes.

Its IAM grant is scoped to one ARN each in this account and region:
`ec2:StartInstances` and `ec2:StopInstances` on this instance, and
`ssm:GetParameter` on the switch below — never `*`, never a path wildcard (the
`SecureString` credentials sit under sibling paths), and never a terminate
action. Its resource policy lets only this alarm invoke it. Tests assert all of
that, since this is the one thing here that runs with nobody watching.

### The kill switch

`/derrops/region/bastion/auto-stop/enabled` (seeded `true`) gates the **stop**
half only. Before each stop the Lambda re-reads it and leaves the box running
unless the value is `true` (case- and whitespace-insensitive; any other value
suspends the stop). Starting is never gated.

Suspend the stop — for an overnight job, a migration, a debugging session —
with:

```bash
aws ssm put-parameter --region ap-southeast-2 \
  --name /derrops/region/bastion/auto-stop/enabled \
  --type String --overwrite --value false
```

It goes through [`SeedParameter`](../lib/seed-parameter.ts) rather than being
CloudFormation-managed, for the same reason the credentials do: `Overwrite:
false` means it is written once and never re-asserted, so a `false` you set at
2am survives every later `cdk deploy`. **Remember to set it back** — nothing
re-enables it for you, and a stop that was skipped is not retried: the alarm is
already back in OK, so the box runs until the next request has come and gone, or
until you stop it by hand. If the parameter is deleted entirely the stop still
runs: the stack seeds it `true`, so absence means the switch is gone, not off.

### Where the handler lives

The Lambda's source is a real file —
[`lib/bastion-power.js`](../lib/bastion-power.js) — not a string literal
inside the stack. `BastionStack` reads it **verbatim** into
`lambda.Code.fromInline`, so an editor highlights and checks it, and what runs
in AWS is byte-for-byte what the repo holds (a test asserts the template's
`ZipFile` equals the file, and that it stays under `fromInline`'s 4 KB cap).

It stays inline rather than becoming a `fromAsset` bundle because the whole
function is three API calls and the AWS SDK v3 ships in the Node.js runtime —
there is nothing to build, and the code stays readable in the console and in
`cdk diff`.

Its decision logic takes the AWS calls as injected functions, so
[`test/bastion-power.test.ts`](../test/bastion-power.test.ts) exercises
it with plain stubs — no SDK dependency, no mocking framework. That is where the
semantics are pinned: ALARM starts (ungated, retrying through a `stopping`
box); only OK-after-ALARM stops; for the switch, `'true'` stops, anything else
skips, a *deleted* parameter still stops, and any other SSM error is raised
rather than swallowed.

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
| `/derrops/region/bastion/auto-stop/enabled` | Kill switch for the automatic stop — **editable** (see above) |
| `/derrops/region/bastion/power-metric` | JSON `Namespace` / `MetricName` / `Dimensions` of the power-on metric — read-only (see above) |
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

#### Endpoint settings

OpenSearch gets two more parameters in the same namespace, describing **how** to
talk to the endpoint — the part a consumer cannot derive from `host`/`port`/`url`:

| Parameter | Seeded value | Meaning |
| --- | --- | --- |
| `/derrops/region/opensearch/auth-mode` | `basic` | `basic` (username/password from the `users/` parameters), `iam` (SigV4 with the caller's own credentials), or `anonymous` |
| `/derrops/region/opensearch/service` | `es` | SigV4 signing service, used only in `iam` mode: `es` for a managed domain, `aoss` for Serverless |

Unlike `host`/`port`/`url`, these are **seeded, not managed**. That split is the
point: `host`/`port`/`url` are facts about the bastion the stack knows and must
keep current, while these are choices about the endpoint the stack cannot know.
They are exactly what you change when the cluster moves off the bastion tunnel
onto a managed domain, and that edit has to survive the next deploy:

```bash
aws ssm put-parameter --region ap-southeast-2 \
  --name /derrops/region/opensearch/auth-mode --type String --overwrite --value iam
```

Postgres gets no equivalent — nothing about reaching it varies per deployment
shape the way OpenSearch's auth does.

### Credentials

Each service also gets a set of parameters per user — **one parameter per
field**, under `.../users/<username>/`:

| Parameter | Type | Seeded value |
| --- | --- | --- |
| `/derrops/region/postgres/users/derrops-platform/engine` | `String` | `postgres` |
| `/derrops/region/postgres/users/derrops-platform/host` | `String` | the bastion's private IPv4 |
| `/derrops/region/postgres/users/derrops-platform/port` | `String` | `5432` |
| `/derrops/region/postgres/users/derrops-platform/dbname` | `String` | `postgres` |
| `/derrops/region/postgres/users/derrops-platform/username` | `String` | `derrops-platform` |
| `/derrops/region/postgres/users/derrops-platform/password` | `SecureString` | `REPLACE-ME` |
| `/derrops/region/opensearch/users/derrops-platform/engine` | `String` | `opensearch` |
| `/derrops/region/opensearch/users/derrops-platform/host` | `String` | the bastion's private IPv4 |
| `/derrops/region/opensearch/users/derrops-platform/port` | `String` | `9200` |
| `/derrops/region/opensearch/users/derrops-platform/protocol` | `String` | `https` |
| `/derrops/region/opensearch/users/derrops-platform/endpoint` | `String` | `https://<host>:9200` |
| `/derrops/region/opensearch/users/derrops-platform/username` | `String` | `derrops-platform` |
| `/derrops/region/opensearch/users/derrops-platform/password` | `SecureString` | `REPLACE-ME` |

`users` is the key, the username is the `purpose` segment and the field is the
`kind` segment, so the library builds the path — the key itself never contains a
`/`. That gives two nested grant boundaries: an IAM policy can scope to
`/derrops/region/postgres/users/*`, to a single user, or to a subset of one
user's fields — handing a consumer the connectivity fields while withholding
`.../password`, which is the only `SecureString` of the set and the only one
that needs `kms:Decrypt`.

Read one field, or the whole set at once:

```bash
# One field
aws ssm get-parameter --region ap-southeast-2 \
  --name /derrops/region/postgres/users/derrops-platform/password \
  --with-decryption --query Parameter.Value --output text

# The whole set, as a name→value map
aws ssm get-parameters-by-path --region ap-southeast-2 \
  --path /derrops/region/postgres/users/derrops-platform \
  --with-decryption \
  --query 'Parameters[].{name:Name,value:Value}' --output table
```

#### The datasource-credentials convention

The field names are a **complete datasource descriptor**, not just a password —
reading the set hands a client everything it needs to connect. These are the
field names Secrets Manager writes for an RDS secret, so a consumer that already
understands one understands these.

- Postgres: `engine`, `host`, `port`, `dbname`, `username`, `password`.
- OpenSearch: the same minus `dbname`, plus what an HTTP datasource needs —
  `protocol`, and `endpoint` pre-assembled so a client need not join
  scheme/host/port itself.

Every value is a string, because SSM stores nothing else: `port` reads back as
`"5432"`, not `5432`. Each parameter's own `description` says what that one
field holds and how to edit it, since whoever opens it in the console is exactly
who needs that and is not reading the CDK source.

Two values are worth calling out because they differ from what a *managed* AWS
datasource would carry:

- **`host` is the bastion's private IPv4**, not an RDS/OpenSearch endpoint —
  everything here is reached through the tunnel on the box.
- **OpenSearch `port` is 9200**, not the 443 of a managed OpenSearch domain,
  matching `/derrops/region/opensearch/port`.

The `host`, `port` and `endpoint` fields are **seed-time** values: they are
written once and never re-asserted (see below), so if the bastion instance is
ever replaced they go stale here while
`/derrops/region/<service>/{host,port,url}` update with the stack. Those
sibling parameters are the authoritative ones for connectivity; treat this set
as authoritative for **credentials**.

**These are seeded, not managed.** They go through
[`SeedParameter`](../lib/seed-parameter.ts) — an `AwsCustomResource` calling
`ssm:PutParameter` with `Overwrite: false`, which writes only if the parameter
is absent. (For the password it is also the only option available:
CloudFormation's `AWS::SSM::Parameter` cannot create a `SecureString` at all.
Encryption uses the account's default `alias/aws/ssm` key.)

Every seeded value **reaches the CloudFormation template in plaintext** — that
is why the password is a placeholder while every other field is real. Set the
real password out-of-band, once:

```bash
aws ssm put-parameter --region ap-southeast-2 \
  --name /derrops/region/postgres/users/derrops-platform/password \
  --type SecureString --overwrite --value '…'
```

`Overwrite: false` is what makes that safe: after the first seed, no `cdk deploy`
re-asserts, re-seeds, or diffs the live value. The same protection covers every
other field, so an edit that outgrows the seed — a `dbname` naming a database
provisioned later, a `username` other than `derrops-platform` — survives every
future deployment too. A test asserts the template carries only the placeholder
password.

#### Migrating off the old blob parameter

These replace a single `SecureString` JSON blob per user, at
`/derrops/region/<service>/users/derrops-platform` with no field segment:

```json
{"engine":"postgres","host":"…","port":5432,"dbname":"…","username":"…","password":"…"}
```

A blob is only convenient for a consumer that reads all of it at once; split, a
caller reads the one value its client wants, and rotating the password touches
the password rather than a re-serialized copy of every other field.

`SeedParameter` defines no `onDelete` call, so **removing it from the stack does
not delete the live parameter** — the old blob, real password and all, stays in
SSM as an orphan that no stack manages. That is deliberate (nothing here can
destroy a credential), but it does leave a stale second copy of the password.
Once every consumer reads the per-field parameters, delete it by hand:

```bash
aws ssm delete-parameter --region ap-southeast-2 \
  --name /derrops/region/postgres/users/derrops-platform
aws ssm delete-parameter --region ap-southeast-2 \
  --name /derrops/region/opensearch/users/derrops-platform
```

Note the per-field parameters are seeded with the **placeholder** password, not
the blob's real one — nothing copies it across. Read the password out of the
blob before deleting it and `put-parameter` it into `.../password`.

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
| `powerOnHold` | 4 hours | A `cdk.Duration`: how long the box stays on after the last power-on request. Whole minutes, at most 1 day (CloudWatch's limit on an alarm's evaluation window) |
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
