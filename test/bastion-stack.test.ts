import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import { BastionStack } from '../lib/bastion-stack';

const env = { account: '123456789012', region: 'us-east-1' };

function synth(
  props: Partial<ConstructorParameters<typeof BastionStack>[2]> = {},
  vpcCidr = '10.0.0.0/16',
  // Both stacks share it: a host stack in another region would make the subnet
  // reference a cross-region one, which CDK refuses.
  stackEnv = env,
) {
  const app = new cdk.App();
  // A throwaway host stack to mint real CfnVPC / CfnSubnet tokens to hand in.
  const host = new cdk.Stack(app, 'Host', { env: stackEnv });
  // The fixture stands in for VpcStack, which pins concrete AZ names per CIDR
  // slot on purpose (see the acknowledgement in lib/vpc-stack.ts).
  cdk.Validations.of(host).acknowledge({
    id: 'CloudFormation-Validate::W3010',
    reason: 'Fixture subnet mirrors VpcStack, which pins AZ names per CIDR slot by design.',
  });
  const vpc = new ec2.CfnVPC(host, 'Vpc', { cidrBlock: vpcCidr });
  const publicSubnets = [
    new ec2.CfnSubnet(host, 'PublicA', {
      vpcId: vpc.ref,
      // Keep the subnet inside whatever VPC CIDR the test passes — a fixed
      // '10.0.4.0/24' falls outside a 172.31.0.0/16 VPC (validation E3059).
      cidrBlock: `${vpcCidr.split('.').slice(0, 2).join('.')}.4.0/24`,
      availabilityZone: `${stackEnv.region}a`,
    }),
  ];
  const stack = new BastionStack(app, 'TestBastionStack', {
    env: stackEnv,
    vpc,
    publicSubnets,
    ...props,
  });
  return Template.fromStack(stack);
}

test('creates a single t4g.nano instance', () => {
  const template = synth();
  template.resourceCountIs('AWS::EC2::Instance', 1);
  template.hasResourceProperties('AWS::EC2::Instance', {
    InstanceType: 't4g.nano',
    // `kind: 'public-blocked'` — in a public subnet, but with all inbound blocked.
    Tags: Match.arrayWith([
      { Key: 'Name', Value: 'derrops--region--bastion--public-blocked' },
    ]),
  });
});

test('instanceType is overridable', () => {
  const template = synth({ instanceType: 't4g.micro' });
  template.hasResourceProperties('AWS::EC2::Instance', { InstanceType: 't4g.micro' });
});

test('lands in the provided public subnet', () => {
  const template = synth();
  template.hasResourceProperties('AWS::EC2::Instance', {
    SubnetId: Match.anyValue(),
  });
});

test('is reachable via SSM Session Manager (instance profile with SSM core)', () => {
  const template = synth();
  template.resourceCountIs('AWS::IAM::InstanceProfile', 1);
  // EC2 assume-role trust.
  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Principal: { Service: 'ec2.amazonaws.com' },
        }),
      ]),
    },
    ManagedPolicyArns: Match.arrayWith([
      Match.objectLike({
        'Fn::Join': Match.arrayWith([
          Match.arrayWith([':iam::aws:policy/AmazonSSMManagedInstanceCore']),
        ]),
      }),
    ]),
  });
});

test('the bastion role has no pinned name, so it survives a second region', () => {
  const template = synth();
  // IAM is account-global: a fixed convention name would collide the moment
  // this stack is deployed to a second region in the same account. CDK must be
  // left to generate a unique physical name.
  template.hasResourceProperties('AWS::IAM::Role', {
    RoleName: Match.absent(),
  });
});

test('security group allows all egress and inbound from the VPC only', () => {
  const template = synth();
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    // No `purpose` segment — the service is already 'bastion', so adding one
    // would stutter (derrops--region--bastion--bastion).
    GroupName: 'derrops--region--bastion',
    SecurityGroupEgress: [
      Match.objectLike({ IpProtocol: '-1', CidrIp: '0.0.0.0/0' }),
    ],
    // Exactly one ingress rule, and its CIDR is the VPC's own (taken off the
    // VPC, not restated in BastionStack — the host VPC above is 10.0.0.0/16).
    // Anything from outside that range, i.e. the internet, matches nothing.
    SecurityGroupIngress: [
      {
        IpProtocol: '-1',
        CidrIp: '10.0.0.0/16',
        Description: Match.anyValue(),
      },
    ],
  });
});

test('the inbound CIDR follows the VPC it is given, not a literal', () => {
  const template = synth({}, '172.31.0.0/16');
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    SecurityGroupIngress: [Match.objectLike({ CidrIp: '172.31.0.0/16' })],
  });
});

test('the security group opens nothing to 0.0.0.0/0 inbound', () => {
  const template = synth();
  // The guard that matters: a public-subnet box with a public IPv4 must never
  // grow an internet-facing ingress rule.
  const sgs = template.findResources('AWS::EC2::SecurityGroup');
  for (const sg of Object.values(sgs)) {
    for (const rule of sg.Properties?.SecurityGroupIngress ?? []) {
      expect(rule.CidrIp).not.toBe('0.0.0.0/0');
      expect(rule.CidrIpv6).not.toBe('::/0');
    }
  }
});

test('publishes an instance-id discovery parameter', () => {
  const template = synth();
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/derrops/region/bastion/instance-id',
  });
});

test('allocates a VPC Elastic IP and associates it with the instance', () => {
  const template = synth();
  template.resourceCountIs('AWS::EC2::EIP', 1);
  template.hasResourceProperties('AWS::EC2::EIP', {
    Domain: 'vpc',
    // An EIP has no name property — the convention name lands on the Name tag.
    // `ec2ElasticIp` is an org/domain/service type, so there is no key segment.
    Tags: Match.arrayWith([{ Key: 'Name', Value: 'derrops--region--bastion' }]),
  });
  template.resourceCountIs('AWS::EC2::EIPAssociation', 1);
  template.hasResourceProperties('AWS::EC2::EIPAssociation', {
    AllocationId: { 'Fn::GetAtt': [Match.anyValue(), 'AllocationId'] },
    InstanceId: { Ref: Match.anyValue() },
  });
});

test('publishes each access detail under a parameter named for its exact value', () => {
  const template = synth();
  const params = Object.values(template.findResources('AWS::SSM::Parameter'));
  const byName = new Map(params.map((p) => [p.Properties.Name, p.Properties.Value]));

  expect([...byName.keys()].sort()).toEqual([
    // The auto-stop schedule is derived and read-only; its sibling
    // `.../auto-stop/enabled` is editable and therefore seeded, not managed, so
    // it is not an AWS::SSM::Parameter at all — see the auto-stop tests.
    '/derrops/region/bastion/auto-stop/schedule',
    '/derrops/region/bastion/eip-allocation-id',
    '/derrops/region/bastion/instance-id',
    '/derrops/region/bastion/private-dns-name',
    '/derrops/region/bastion/private-ip',
    '/derrops/region/bastion/public-ip',
    '/derrops/region/bastion/security-group-id',
    // Sibling service namespaces — see the proxied-service tests below.
    '/derrops/region/opensearch/host',
    '/derrops/region/opensearch/port',
    '/derrops/region/opensearch/url',
    '/derrops/region/postgres/host',
    '/derrops/region/postgres/port',
    '/derrops/region/postgres/url',
  ]);

  // Each value comes off the right attribute of the right resource — the point
  // of naming them precisely is defeated if one carries the wrong address.
  expect(byName.get('/derrops/region/bastion/private-ip')).toEqual({
    'Fn::GetAtt': ['BastionInstance', 'PrivateIp'],
  });
  expect(byName.get('/derrops/region/bastion/private-dns-name')).toEqual({
    'Fn::GetAtt': ['BastionInstance', 'PrivateDnsName'],
  });
  expect(byName.get('/derrops/region/bastion/security-group-id')).toEqual({
    'Fn::GetAtt': ['BastionSecurityGroup', 'GroupId'],
  });
  expect(byName.get('/derrops/region/bastion/eip-allocation-id')).toEqual({
    'Fn::GetAtt': ['BastionEip', 'AllocationId'],
  });
});

test('public-ip comes off the Elastic IP, never the instance', () => {
  const template = synth();
  const params = Object.values(template.findResources('AWS::SSM::Parameter'));
  const publicIp = params.find(
    (p) => p.Properties.Name === '/derrops/region/bastion/public-ip',
  );
  // The instance's own PublicIp/PublicDnsName attributes are captured at create
  // time, before the EIP is associated, so they would be stale forever. The EIP
  // is the authoritative source for the address.
  expect(publicIp?.Properties.Value).toEqual({
    'Fn::GetAtt': ['BastionEip', 'PublicIp'],
  });
  for (const p of params) {
    expect(JSON.stringify(p.Properties.Value)).not.toContain('PublicDnsName');
    expect(p.Properties.Value).not.toEqual({
      'Fn::GetAtt': ['BastionInstance', 'PublicIp'],
    });
  }
});

test('publishes host, port and url per proxied service, in its own namespace', () => {
  const template = synth();
  // The service segment is the sibling service, not 'bastion' — a consumer that
  // wants postgres looks up postgres, and the name survives the tunnel being
  // replaced by a real database later.
  const privateIp = { 'Fn::GetAtt': ['BastionInstance', 'PrivateIp'] };

  for (const [service, scheme, port] of [
    ['postgres', 'postgresql://', '5432'],
    ['opensearch', 'https://', '9200'],
  ]) {
    // The host is the bastion's *private* IP — the public address is not
    // reachable, so anything built on it would never connect.
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: `/derrops/region/${service}/host`,
      Value: privateIp,
    });
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: `/derrops/region/${service}/port`,
      Value: port,
    });
    // url is assembled from those same two values, so the three cannot drift.
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: `/derrops/region/${service}/url`,
      Value: { 'Fn::Join': ['', [scheme, privateIp, `:${port}`]] },
    });
  }
});

test('proxied params are tagged for their own service, not the bastion', () => {
  const template = synth();
  const params = Object.values(template.findResources('AWS::SSM::Parameter'));
  const byName = new Map(params.map((p) => [p.Properties.Name, p.Properties.Tags]));
  // Tags must agree with the name, or a tag-based search for the postgres
  // service silently misses its own parameters.
  for (const key of ['host', 'port', 'url']) {
    expect(byName.get(`/derrops/region/postgres/${key}`)).toMatchObject({
      'derrops:service': 'postgres',
      'derrops:domain': 'region',
    });
    expect(byName.get(`/derrops/region/opensearch/${key}`)).toMatchObject({
      'derrops:service': 'opensearch',
    });
  }
  expect(byName.get('/derrops/region/bastion/private-ip')).toMatchObject({
    'derrops:service': 'bastion',
  });
});

/**
 * The SDK call is a JSON string with the bastion's private IP spliced in as a
 * GetAtt, so it synthesizes to an Fn::Join. Substitute a stand-in address for
 * the token and parse it back into the call it will actually make.
 */
function seededCalls(template: Template) {
  return Object.values(template.findResources('Custom::SeedSsmParameter')).map((s) => {
    const create = s.Properties.Create;
    const joined =
      typeof create === 'string'
        ? create
        : create['Fn::Join'][1]
            .map((part: unknown) => (typeof part === 'string' ? part : '10.0.4.189'))
            .join('');
    return JSON.parse(joined);
  });
}

test('seeds a SecureString credentials parameter per proxied service', () => {
  const template = synth();
  const created = seededCalls(template).filter((c) => c.parameters.Type === 'SecureString');
  expect(created).toHaveLength(2);
  // `users` + username as `purpose`, so the library builds the path — the key
  // itself never contains a '/'.
  expect(created.map((c) => c.parameters.Name).sort()).toEqual([
    '/derrops/region/opensearch/users/derrops-platform',
    '/derrops/region/postgres/users/derrops-platform',
  ]);

  for (const c of created) {
    // CloudFormation's AWS::SSM::Parameter cannot create a SecureString at all,
    // which is why these are SDK calls rather than managed parameters.
    expect(c.parameters.Type).toBe('SecureString');
    // Create-if-absent: the real value, set out-of-band, is never clobbered by
    // a later deploy, and never diffed against the placeholder.
    expect(c.parameters.Overwrite).toBe(false);
    expect(c.ignoreErrorCodesMatching).toBe('ParameterAlreadyExists');
  }
});

test('no real credential is baked into the template', () => {
  const template = synth();
  // The seeded value reaches the template in plaintext, so the password must
  // stay a recognisable placeholder. If someone ever pastes a real secret into
  // PLACEHOLDER_SECRET, this is the test that should stop them.
  for (const call of seededCalls(template)) {
    if (call.parameters.Type !== 'SecureString') continue;
    expect(JSON.parse(call.parameters.Value).password).toBe('REPLACE-ME');
  }
});

test('credentials follow the datasource convention, documented on the parameter', () => {
  const template = synth();
  const byName = new Map(
    seededCalls(template)
      .filter((c) => c.parameters.Type === 'SecureString')
      .map((c) => [c.parameters.Name, c.parameters]),
  );

  // engine/host/port/dbname + user — the shape Secrets Manager writes for an
  // RDS secret, so a consumer that understands one understands this.
  expect(
    JSON.parse(byName.get('/derrops/region/postgres/users/derrops-platform')!.Value),
  ).toEqual({
    engine: 'postgres',
    host: '10.0.4.189', // the bastion's private IP token
    port: 5432,
    dbname: 'postgres',
    username: 'derrops-platform',
    password: 'REPLACE-ME',
  });

  // Same, plus what an HTTP datasource needs: protocol, and a pre-assembled
  // endpoint so a client need not join scheme/host/port itself. Port 9200 (the
  // tunnel on the bastion), not the 443 of a managed OpenSearch domain.
  expect(
    JSON.parse(byName.get('/derrops/region/opensearch/users/derrops-platform')!.Value),
  ).toEqual({
    engine: 'opensearch',
    host: '10.0.4.189',
    port: 9200,
    protocol: 'https',
    endpoint: 'https://10.0.4.189:9200',
    username: 'derrops-platform',
    password: 'REPLACE-ME',
  });

  for (const [name, params] of byName) {
    // Whoever opens this in the console to set the real password is exactly who
    // needs to know the shape, and they are not reading the CDK source.
    expect(params.Description).toContain('"engine"');
    expect(params.Description).toContain('put-parameter');
    // SSM caps descriptions at 1024 characters.
    expect(params.Description.length).toBeLessThanOrEqual(1024);
    expect(name).toMatch(/\/users\/derrops-platform$/);
  }
});

test('the seeding role can encrypt only via SSM in this region', () => {
  const template = synth();
  // The default alias/aws/ssm key has no knowable ARN, so the kms grant is
  // resource '*' — scoped by ViaService so the lambda cannot turn it on another
  // service's keys.
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: ['kms:Encrypt', 'kms:GenerateDataKey'],
          Resource: '*',
          Condition: {
            StringEquals: { 'kms:ViaService': 'ssm.us-east-1.amazonaws.com' },
          },
        }),
      ]),
    },
  });
});

/** Every statement across every inline IAM policy in the template. */
function policyStatements(template: Template) {
  return Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
    (p) => p.Properties.PolicyDocument.Statement as any[],
  );
}

test('stops the bastion daily at 04:00 AEST', () => {
  const template = synth();
  template.resourceCountIs('AWS::Events::Rule', 1);
  template.hasResourceProperties('AWS::Events::Rule', {
    Name: 'derrops--region--bastion--auto-stop',
    // AEST is UTC+10 and an EventBridge rule cron is evaluated in UTC with no
    // timezone field, so 04:00 AEST is 18:00 UTC. This assertion is the guard
    // on that arithmetic — the same expression is correct in every region.
    ScheduleExpression: 'cron(0 18 * * ? *)',
    State: 'ENABLED',
    Targets: [
      Match.objectLike({
        // An L2 Function's logical id carries CDK's hash suffix, unlike the L1
        // resources elsewhere in this stack.
        Arn: {
          'Fn::GetAtt': [Match.stringLikeRegexp('^BastionAutoStopFunction'), 'Arn'],
        },
      }),
    ],
  });
});

test('the schedule is overridable', () => {
  const template = synth({
    autoStopSchedule: events.Schedule.cron({ minute: '30', hour: '9' }),
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'cron(30 9 * * ? *)',
  });
});

test('the rule is always enabled — the switch is checked in the lambda', () => {
  const template = synth();
  const [rule] = Object.values(template.findResources('AWS::Events::Rule'));
  // Deliberately unconditional: the rule fires every day and the lambda decides
  // once it is running. Gating on the rule's State instead would make
  // suspending the stop a deploy, and would let the State and the parameter
  // disagree about whether auto-stop is on.
  expect(rule.Properties.State).toBe('ENABLED');
  expect(JSON.stringify(rule.Properties.Targets)).not.toContain('auto-stop/enabled');
});

test('the inline code is the real handler file, and still fits', () => {
  const template = synth();
  const source = fs.readFileSync(
    path.join(__dirname, '../lib/bastion-auto-stop.js'),
    'utf8',
  );
  const [fn] = Object.values(template.findResources('AWS::Lambda::Function')).filter(
    (f) => f.Properties.FunctionName === 'derrops--region--bastion--auto-stop',
  );
  // Read verbatim, so the unit tests in bastion-auto-stop.test.ts exercise
  // exactly what Lambda will run.
  expect(fn.Properties.Code.ZipFile).toBe(source);
  // `Code.fromInline` caps the source at 4 KB. This is the assertion that turns
  // that into a build failure rather than a deploy failure.
  expect(Buffer.byteLength(source, 'utf8')).toBeLessThanOrEqual(4096);
});

test('the auto-stop lambda targets this stack’s instance', () => {
  const template = synth();
  template.hasResourceProperties('AWS::Lambda::Function', {
    // Lambda function names are region-scoped, so a convention name is safe to
    // repeat per region (unlike the IAM role, which stays unnamed).
    FunctionName: 'derrops--region--bastion--auto-stop',
    Runtime: 'nodejs22.x',
    Architectures: ['arm64'],
    Environment: {
      Variables: { INSTANCE_ID: { Ref: 'BastionInstance' } },
    },
  });
});

test('the auto-stop lambda may only stop, and only this instance', () => {
  const template = synth();
  const ec2Statements = policyStatements(template).filter((s) =>
    JSON.stringify(s.Action).includes('ec2:'),
  );

  expect(ec2Statements).toHaveLength(1);
  const [stop] = ec2Statements;
  expect(stop.Action).toBe('ec2:StopInstances');
  // Scoped to one instance ARN in this account and region — never '*', and
  // never a start/terminate action. A rule that runs unattended every night
  // must not be able to reach anything but the box it was written for.
  expect(stop.Resource).not.toBe('*');
  expect(JSON.stringify(stop.Resource)).toContain(
    ':ec2:us-east-1:123456789012:instance/',
  );
  expect(JSON.stringify(stop.Resource)).toContain('"BastionInstance"');
  expect(JSON.stringify(policyStatements(template))).not.toContain('StartInstances');
  expect(JSON.stringify(policyStatements(template))).not.toContain('TerminateInstances');
});

test('the enabled switch is seeded, so a deploy never re-asserts it', () => {
  const template = synth();
  const [enabled] = seededCalls(template).filter(
    (c) => c.parameters.Name === '/derrops/region/bastion/auto-stop/enabled',
  );
  // Seeded rather than CloudFormation-managed: flipping it to 'false' in the
  // console has to survive every later deploy, or it is not a kill switch.
  expect(enabled.parameters.Type).toBe('String');
  expect(enabled.parameters.Value).toBe('true');
  expect(enabled.parameters.Overwrite).toBe(false);
  expect(enabled.ignoreErrorCodesMatching).toBe('ParameterAlreadyExists');
});

test('the lambda reads the switch at runtime, and only that parameter', () => {
  const template = synth();
  // Only the *name* is baked in — the value is read on each run, which is the
  // whole point of the switch being editable between deploys.
  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: {
      Variables: Match.objectLike({
        ENABLED_PARAM: '/derrops/region/bastion/auto-stop/enabled',
      }),
    },
  });

  const ssmReads = policyStatements(template).filter(
    (s) => JSON.stringify(s.Action) === '"ssm:GetParameter"',
  );
  expect(ssmReads).toHaveLength(1);
  // Scoped to the switch alone. The bastion's SecureString credentials sit
  // under sibling paths in this same account, so a path wildcard here would
  // hand a nightly cron job the ability to read them.
  expect(ssmReads[0].Resource).not.toBe('*');
  expect(JSON.stringify(ssmReads[0].Resource)).toContain(
    ':ssm:us-east-1:123456789012:parameter/derrops/region/bastion/auto-stop/enabled',
  );
});

test('publishes the schedule as a read-only parameter that tracks the rule', () => {
  const template = synth();
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/derrops/region/bastion/auto-stop/schedule',
    Value: 'cron(0 18 * * ? *)',
    // Whoever opens this in the console is exactly who might assume it is a
    // dial; the description has to say it is not.
    Description: Match.stringLikeRegexp('Read-only'),
  });
});

test('the published schedule follows an overridden one, so the two cannot drift', () => {
  const template = synth({
    autoStopSchedule: events.Schedule.cron({ minute: '30', hour: '9' }),
  });
  template.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/derrops/region/bastion/auto-stop/schedule',
    Value: 'cron(30 9 * * ? *)',
  });
});

test('the auto-stop lambda logs to a named group with bounded retention', () => {
  const template = synth();
  template.hasResourceProperties('AWS::Logs::LogGroup', {
    LogGroupName: '/derrops/region/bastion/auto-stop',
    RetentionInDays: 30,
  });
});

test('the auto-stop schedule and grant follow the region', () => {
  // Second region, per the repo rule: the cron is UTC so it must NOT change,
  // while the instance ARN in the grant must land in the region deployed to. A
  // grant that stayed pinned to us-east-1 would silently fail to stop anything.
  const template = synth({}, '10.0.0.0/16', {
    account: '123456789012',
    region: 'ap-southeast-2',
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    Name: 'derrops--region--bastion--auto-stop',
    ScheduleExpression: 'cron(0 18 * * ? *)',
  });
  const [stop] = policyStatements(template).filter((s) =>
    JSON.stringify(s.Action).includes('ec2:'),
  );
  expect(JSON.stringify(stop.Resource)).toContain(
    ':ec2:ap-southeast-2:123456789012:instance/',
  );
});

test('resources carry the derrops org tags', () => {
  const template = synth();
  for (const tag of [
    { Key: 'derrops:domain', Value: 'region' },
    { Key: 'derrops:service', Value: 'bastion' },
  ]) {
    template.hasResourceProperties('AWS::EC2::Instance', {
      Tags: Match.arrayWith([tag]),
    });
  }
});
