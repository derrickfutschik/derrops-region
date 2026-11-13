# `derrops--region--egress`

Outbound internet for the region VPC's **private** tier. Defined in
[`lib/egress-stack.ts`](../lib/egress-stack.ts) (`EgressStack`).

[`derrops--region--network`](derrops--region--network.md) creates the private
tier with no default route, because a NAT Gateway would dominate the bill. This
stack adds that route, so in-VPC workloads such as the derrops-cloud API Lambda
can reach AWS service endpoints (SQS, Secrets Manager, AppSync) and the internet.

## What it creates

| Resource | Details |
| --- | --- |
| Private tier default route | `0.0.0.0/0` on the private route table → the bastion instance, used as a NAT instance |
| S3 gateway endpoint | `derrops--region--egress`, on the private route table. Free, and keeps S3 traffic off the NAT |

The isolated tier is untouched: no internet route in either direction.

## Why its own stack

A route table holds only one route per destination, so the private tier's
`0.0.0.0/0` route must have exactly one owner. If the bastion stack owned it,
moving to a NAT Gateway in another stack would take two deploys with no egress in
between. Owning it here, the switch is a change to `target` and one deploy:
changing a route's target is an in-place update.

## The bastion as NAT instance

The route alone isn't enough. Two more pieces make the bastion forward traffic:

1. **Source/destination check off.** Set by `BastionStack`
   (`SourceDestCheck: false`), an in-place update that never replaces the
   instance.
2. **NAT on the box itself, set up by hand** over SSM, like Tailscale. User data
   only runs on an instance's first boot, so it can't configure the running box.
   On Amazon Linux 2023:

   ```bash
   aws ssm start-session --region ap-southeast-2 --target "$(aws ssm get-parameter \
     --region ap-southeast-2 --name /derrops/region/bastion/instance-id \
     --query Parameter.Value --output text)"

   # On the box (as root): IP forwarding, now and at boot
   echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/90-derrops-nat.conf
   sysctl -p /etc/sysctl.d/90-derrops-nat.conf

   # An idempotent script that adds the MASQUERADE rule (ens5 is the egress NIC)
   cat > /usr/local/sbin/derrops-nat <<'EOF'
   #!/bin/bash
   set -euo pipefail
   RULE=(-s 10.0.0.0/16 ! -d 10.0.0.0/16 -o ens5 -j MASQUERADE -m comment --comment derrops-nat)
   iptables -t nat -C POSTROUTING "${RULE[@]}" 2>/dev/null || iptables -t nat -A POSTROUTING "${RULE[@]}"
   EOF
   chmod 0755 /usr/local/sbin/derrops-nat

   # A oneshot unit runs it at every boot
   cat > /etc/systemd/system/derrops-nat.service <<'EOF'
   [Unit]
   Description=NAT (MASQUERADE) for the region VPC private tier
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=oneshot
   ExecStart=/usr/local/sbin/derrops-nat
   RemainAfterExit=yes

   [Install]
   WantedBy=multi-user.target
   EOF
   systemctl daemon-reload && systemctl enable --now derrops-nat.service

   # Check
   sysctl net.ipv4.ip_forward
   iptables -t nat -S POSTROUTING   # the derrops-nat rule
   iptables -S FORWARD              # policy ACCEPT
   ```

   The unit adds only its own rule. It deliberately doesn't use
   `iptables-services`, which saves and restores the whole ruleset at boot,
   Tailscale's chains included, and ships default `REJECT` rules that would
   block forwarding.

   Both settings survive reboot and stop/start, so the daily auto-stop is fine:
   NAT comes back with the box. They live only on the instance, so a
   replacement loses them, the same as Tailscale.

The bastion's security group already allows all traffic from the VPC CIDR in and
everything out, so it needs no change.

Check it from a private-tier Lambda or instance, e.g. `curl -sI https://sqs.ap-southeast-2.amazonaws.com`.

### Keep the bastion running

The bastion stops itself every day at 04:00 AEST. While it's stopped, the
private tier has no egress (and, today, no Postgres or OpenSearch either, which
the bastion also proxies). Auto-stop is left on for now, so start the box
before using the API outside its hours. To keep it up instead, turn the
auto-stop off; the parameter is seeded, so later deploys don't reset it:

```bash
aws ssm put-parameter --region ap-southeast-2 --overwrite \
  --name /derrops/region/bastion/auto-stop/enabled --type String --value false
```

## Trade-offs

- **One box carries everything.** If the bastion stops or fails, the private
  tier loses egress along with the services the bastion proxies.
- **One AZ.** The bastion sits in public subnet `2a`. Traffic from the `2b` and
  `2c` private subnets crosses AZs to reach it ($0.01/GB).
- **Cost: nothing extra.** No new resources besides the free S3 endpoint.

## Moving to a NAT Gateway later

1. Add a `{ kind: 'natGateway' }` variant to `EgressTarget` that creates an
   Elastic IP and an `AWS::EC2::NatGateway` in a public subnet. (Needs a NAT
   Gateway resource type in `derrops-conventions` to name it.)
2. Point `target` at it in `bin/region-bootstrap.ts` and deploy this stack. The
   route's target changes in place; connections open at that moment drop and
   reconnect.
3. Optionally turn the bastion's source/destination check back on, remove the
   `MASQUERADE` rule, and turn auto-stop back on (once nothing else depends on
   the box).

Nothing outside this repo changes: consumers just use whatever the private
subnets route to.
