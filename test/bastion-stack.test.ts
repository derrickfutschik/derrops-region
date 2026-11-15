import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { BastionStack, powerMetric } from '../lib/bastion-stack';

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

// The regression this pins: the AMI must come from *our* parameter, not from
// AWS's public 'latest AL2023' pointer. That pointer moves whenever AWS
// publishes an image, and a changed ImageId replaces the instance — which is
// how the hand-configured box was lost on 2026-08-09.
test('takes its AMI from the pinned SSM parameter, not a floating pointer', () => {
  const template = synth();
  const params = template.toJSON().Parameters ?? {};
  const amiParams = Object.entries<{ Type: string; Default: string }>(params).filter(
    ([, p]) => p.Type === 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>',
  );
  expect(amiParams).toHaveLength(1);
  expect(amiParams[0]![1].Default).toBe('/derrops/region/bastion/ami-id');
  // ...and the instance actually uses it.
  template.hasResourceProperties('AWS::EC2::Instance', {
    ImageId: { Ref: amiParams[0]![0] },
  });
});

// The parameter is written by hand, per region — the stack must never create
// or re-assert it, or a deploy would put the image back to whatever source
// says and replace the instance all over again.
test('does not manage the AMI parameter itself', () => {
  const template = synth();
  const managed = Object.values<{ Properties?: { Name?: string } }>(
    template.toJSON().Resources ?? {},
  ).filter((r) => r.Properties?.Name === '/derrops/region/bastion/ami-id');
  expect(managed).toHaveLength(0);
});

test('amiId overrides the parameter when given', () => {
  const template = synth({ amiId: 'ami-0a036c1f3ca5d1f73' });
  template.hasResourceProperties('AWS::EC2::Instance', {
    ImageId: 'ami-0a036c1f3ca5d1f73',
  });
});

// The box is hand-configured (Tailscale), so a replacement — from any property,
// not just the AMI — loses everything on it. Protection is the backstop.
test('has termination protection on by default', () => {
  const template = synth();
  template.hasResourceProperties('AWS::EC2::Instance', {
    DisableApiTermination: true,
  });
});

// Has to be switchable, or `cdk destroy` can never delete the instance.
test('termination protection is overridable', () => {
  const template = synth({ instanceTerminationProtection: false });
  template.hasResourceProperties('AWS::EC2::Instance', {
    DisableApiTermination: false,
  });
});

// It's the private tier's NAT instance (EgressStack); with the check on, EC2
// drops every forwarded packet.
test('has the source/destination check off, so it can forward as a NAT', () => {
  const template = synth();
  template.hasResourceProperties('AWS::EC2::Instance', {
    SourceDestCheck: false,
  });
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
    // `.../auto-stop/enabled` is editable and therefore seeded, not managed, so
    // it is not an AWS::SSM::Parameter at all — see the power tests.
    '/derrops/region/bastion/eip-allocation-id',
    '/derrops/region/bastion/instance-id',
    '/derrops/region/bastion/power-metric',
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

/** The seeded credential parameters, keyed by parameter name. */
function credentialParams(template: Template) {
  return new Map(
    seededCalls(template)
      .filter((c) => c.parameters.Name.includes('/users/'))
      .map((c) => [c.parameters.Name as string, c]),
  );
}

test('seeds one credential parameter per field, not a JSON blob', () => {
  const template = synth();
  const created = credentialParams(template);

  // `users` + username as `purpose` + the field as `kind`, so the library
  // builds the path — the key itself never contains a '/'. The blob parameter
  // these replaced (.../users/derrops-platform, with no field segment) must be
  // gone: two sources of truth for one password is exactly the drift the split
  // was meant to remove.
  expect([...created.keys()].sort()).toEqual([
    '/derrops/region/opensearch/users/derrops-platform/endpoint',
    '/derrops/region/opensearch/users/derrops-platform/engine',
    '/derrops/region/opensearch/users/derrops-platform/host',
    '/derrops/region/opensearch/users/derrops-platform/password',
    '/derrops/region/opensearch/users/derrops-platform/port',
    '/derrops/region/opensearch/users/derrops-platform/protocol',
    '/derrops/region/opensearch/users/derrops-platform/username',
    '/derrops/region/postgres/users/derrops-platform/dbname',
    '/derrops/region/postgres/users/derrops-platform/engine',
    '/derrops/region/postgres/users/derrops-platform/host',
    '/derrops/region/postgres/users/derrops-platform/password',
    '/derrops/region/postgres/users/derrops-platform/port',
    '/derrops/region/postgres/users/derrops-platform/username',
  ]);

  for (const c of created.values()) {
    // Create-if-absent: a value set out-of-band — a rotated password, a dbname
    // naming a database provisioned since — is never clobbered by a later
    // deploy, and never diffed against the seed.
    expect(c.parameters.Overwrite).toBe(false);
    expect(c.ignoreErrorCodesMatching).toBe('ParameterAlreadyExists');
  }
});

test('only the password is a SecureString', () => {
  const template = synth();
  for (const [name, c] of credentialParams(template)) {
    // CloudFormation's AWS::SSM::Parameter cannot create a SecureString at all,
    // which is why these are SDK calls rather than managed parameters. The rest
    // are connectivity metadata, and stay readable without kms:Decrypt.
    expect(c.parameters.Type).toBe(name.endsWith('/password') ? 'SecureString' : 'String');
  }
});

test('seeds the OpenSearch endpoint settings beside host/port/url', () => {
  const template = synth();
  const byName = new Map(seededCalls(template).map((c) => [c.parameters.Name as string, c.parameters]));

  // auth-mode and service describe the *endpoint*, not one user, so they sit in
  // the service namespace rather than under users/. Seeded rather than managed:
  // host/port/url are facts about the bastion the stack knows and must keep
  // current, while these are choices about the endpoint it cannot know — the
  // switches you flip when the cluster moves onto a managed domain.
  expect(byName.get('/derrops/region/opensearch/auth-mode')).toMatchObject({
    Value: 'basic',
    Type: 'String',
    Overwrite: false,
  });
  expect(byName.get('/derrops/region/opensearch/service')).toMatchObject({
    Value: 'es',
    Type: 'String',
    Overwrite: false,
  });

  // Postgres gets no equivalent: nothing about reaching it varies per
  // deployment shape the way OpenSearch's auth does.
  expect(byName.has('/derrops/region/postgres/auth-mode')).toBe(false);
  expect(byName.has('/derrops/region/postgres/service')).toBe(false);
});

test('no real credential is baked into the template', () => {
  const template = synth();
  // Every seeded value reaches the template in plaintext, so the password must
  // stay a recognisable placeholder. If someone ever pastes a real secret into
  // PLACEHOLDER_SECRET, this is the test that should stop them.
  const passwords = [...credentialParams(template)].filter(([n]) => n.endsWith('/password'));
  expect(passwords).toHaveLength(2);
  for (const [, c] of passwords) {
    expect(c.parameters.Value).toBe('REPLACE-ME');
  }
});

test('credential fields follow the datasource convention', () => {
  const template = synth();
  const values = new Map(
    [...credentialParams(template)].map(([name, c]) => [name, c.parameters.Value]),
  );

  // engine/host/port/dbname + user — the field names Secrets Manager writes for
  // an RDS secret, so a consumer that understands one understands this. Values
  // are strings: SSM stores nothing else, so the numeric `port` is '5432'.
  const pg = '/derrops/region/postgres/users/derrops-platform';
  expect(values.get(`${pg}/engine`)).toBe('postgres');
  expect(values.get(`${pg}/host`)).toBe('10.0.4.189'); // the bastion's private IP token
  expect(values.get(`${pg}/port`)).toBe('5432');
  expect(values.get(`${pg}/dbname`)).toBe('postgres');
  expect(values.get(`${pg}/username`)).toBe('derrops-platform');

  // Same, plus what an HTTP datasource needs: protocol, and a pre-assembled
  // endpoint so a client need not join scheme/host/port itself. Port 9200 (the
  // tunnel on the bastion), not the 443 of a managed OpenSearch domain.
  const os = '/derrops/region/opensearch/users/derrops-platform';
  expect(values.get(`${os}/engine`)).toBe('opensearch');
  expect(values.get(`${os}/host`)).toBe('10.0.4.189');
  expect(values.get(`${os}/port`)).toBe('9200');
  expect(values.get(`${os}/protocol`)).toBe('https');
  expect(values.get(`${os}/endpoint`)).toBe('https://10.0.4.189:9200');
  expect(values.get(`${os}/username`)).toBe('derrops-platform');
});

test('each credential parameter documents itself', () => {
  const template = synth();
  for (const [name, c] of credentialParams(template)) {
    // Whoever opens one of these in the console to set a real value is exactly
    // who needs to know what it holds and how to edit it, and they are not
    // reading the CDK source. Each stands alone: with a parameter per field, a
    // reader sees only this description, not the set's.
    const field = name.split('/').pop()!;
    expect(c.parameters.Description).toContain(field);
    expect(c.parameters.Description).toContain('put-parameter');
    // SSM caps descriptions at 1024 characters.
    expect(c.parameters.Description.length).toBeLessThanOrEqual(1024);
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

/** The power alarm — the only alarm in the stack. */
function powerAlarm(template: Template) {
  const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
  expect(alarms).toHaveLength(1);
  return alarms[0]!.Properties;
}

test('a power-on request alarms on the convention-named metric', () => {
  const template = synth();
  // The schedule is gone: nothing but the alarm turns the box on or off.
  template.resourceCountIs('AWS::Events::Rule', 0);
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmName: 'derrops--region--bastion--power',
    // Namespace is org/domain only; the service is a dimension. Publishers pin
    // against all three, so these are a contract, not an implementation detail.
    Namespace: 'derrops/region',
    MetricName: 'PowerOnRequests',
    // Lowercase `service` is what the library actually emits (its README says
    // `Service`) — asserted here because CloudWatch dimensions are case-sensitive.
    Dimensions: [{ Name: 'service', Value: 'bastion' }],
    // Maximum, so one publisher's 0 cannot average away another's 1.
    Statistic: 'Maximum',
    Period: 60,
    ComparisonOperator: 'GreaterThanThreshold',
    Threshold: 0,
  });
});

test('one request is enough to alarm, and OK takes four clear hours', () => {
  const alarm = powerAlarm(synth());
  // 1-of-240 one-minute periods: a single datapoint above 0 trips it on the
  // next evaluation, and it clears only when all 240 minutes are clear.
  expect(alarm.DatapointsToAlarm).toBe(1);
  expect(alarm.EvaluationPeriods).toBe(240);
  // A publisher that just stops posting must release the box like one that
  // posts 0 — otherwise silence would pin the alarm in INSUFFICIENT_DATA.
  expect(alarm.TreatMissingData).toBe('notBreaching');
});

test('the hold is overridable, within what CloudWatch can evaluate', () => {
  expect(powerAlarm(synth({ powerOnHold: cdk.Duration.minutes(90) })).EvaluationPeriods).toBe(90);
  // An alarm's evaluation window cannot exceed a day; fail at synth, not deploy.
  expect(() => synth({ powerOnHold: cdk.Duration.hours(25) })).toThrow(/powerOnHold/);
  expect(() => synth({ powerOnHold: cdk.Duration.seconds(0) })).toThrow(/powerOnHold/);
});

test('both alarm transitions invoke the power lambda, and only it may be invoked by this alarm', () => {
  const template = synth();
  const alarm = powerAlarm(template);
  const fnArn = {
    // An L2 Function's logical id carries CDK's hash suffix, unlike the L1
    // resources elsewhere in this stack.
    'Fn::GetAtt': [expect.stringMatching(/^BastionPowerFunction/), 'Arn'],
  };
  expect(alarm.AlarmActions).toEqual([fnArn]);
  expect(alarm.OKActions).toEqual([fnArn]);
  // Missing data is not breaching, so INSUFFICIENT_DATA is only the alarm's
  // first moment of life — not a reason to touch the box.
  expect(alarm.InsufficientDataActions).toBeUndefined();

  template.hasResourceProperties('AWS::Lambda::Permission', {
    Action: 'lambda:InvokeFunction',
    Principal: 'lambda.alarms.cloudwatch.amazonaws.com',
    // Scoped to this alarm, so no other alarm in the account can drive it.
    SourceArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^BastionPowerAlarm'), 'Arn'] },
  });
});

test('the inline code is the real handler file, and still fits', () => {
  const template = synth();
  const source = fs.readFileSync(
    path.join(__dirname, '../lib/bastion-power.js'),
    'utf8',
  );
  const [fn] = Object.values(template.findResources('AWS::Lambda::Function')).filter(
    (f) => f.Properties.FunctionName === 'derrops--region--bastion--power',
  );
  // Read verbatim, so the unit tests in bastion-power.test.ts exercise
  // exactly what Lambda will run.
  expect(fn.Properties.Code.ZipFile).toBe(source);
  // `Code.fromInline` caps the source at 4 KB. This is the assertion that turns
  // that into a build failure rather than a deploy failure.
  expect(Buffer.byteLength(source, 'utf8')).toBeLessThanOrEqual(4096);
});

test('the power lambda targets this stack’s instance', () => {
  const template = synth();
  template.hasResourceProperties('AWS::Lambda::Function', {
    // Lambda function names are region-scoped, so a convention name is safe to
    // repeat per region (unlike the IAM role, which stays unnamed).
    FunctionName: 'derrops--region--bastion--power',
    Runtime: 'nodejs22.x',
    Architectures: ['arm64'],
    Environment: {
      Variables: { INSTANCE_ID: { Ref: 'BastionInstance' } },
    },
  });
});

test('the power lambda may only start and stop, and only this instance', () => {
  const template = synth();
  const ec2Statements = policyStatements(template).filter((s) =>
    JSON.stringify(s.Action).includes('ec2:'),
  );

  expect(ec2Statements).toHaveLength(1);
  const [power] = ec2Statements;
  expect(power.Action).toEqual(['ec2:StartInstances', 'ec2:StopInstances']);
  // Scoped to one instance ARN in this account and region — never '*', and
  // never a terminate action. Something that runs unattended must not be able
  // to reach anything but the box it was written for.
  expect(power.Resource).not.toBe('*');
  expect(JSON.stringify(power.Resource)).toContain(
    ':ec2:us-east-1:123456789012:instance/',
  );
  expect(JSON.stringify(power.Resource)).toContain('"BastionInstance"');
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
  // Only the *name* is baked in — the value is read before each stop, which is
  // the whole point of the switch being editable between deploys.
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
  // hand an unattended function the ability to read them.
  expect(ssmReads[0].Resource).not.toBe('*');
  expect(JSON.stringify(ssmReads[0].Resource)).toContain(
    ':ssm:us-east-1:123456789012:parameter/derrops/region/bastion/auto-stop/enabled',
  );
});

test('publishes the metric coordinates, matching what the alarm watches', () => {
  const template = synth();
  const [param] = Object.values(template.findResources('AWS::SSM::Parameter')).filter(
    (p) => p.Properties.Name === '/derrops/region/bastion/power-metric',
  );
  const alarm = powerAlarm(template);
  // A publisher that reads this must land on the very metric the alarm
  // watches — a datapoint with different dimensions is a different metric.
  expect(JSON.parse(param!.Properties.Value)).toEqual({
    Namespace: alarm.Namespace,
    MetricName: alarm.MetricName,
    Dimensions: alarm.Dimensions,
  });
  expect(powerMetric).toEqual({
    namespace: 'derrops/region',
    metricName: 'PowerOnRequests',
    dimensions: [{ Name: 'service', Value: 'bastion' }],
  });
});

test('the power lambda logs to a named group with bounded retention', () => {
  const template = synth();
  template.hasResourceProperties('AWS::Logs::LogGroup', {
    LogGroupName: '/derrops/region/bastion/power',
    RetentionInDays: 30,
  });
});

test('the alarm is region-neutral and the grant follows the region', () => {
  // Second region, per the repo rule: the metric and alarm names carry no
  // region so they must NOT change, while the instance ARN in the grant must
  // land in the region deployed to. A grant that stayed pinned to us-east-1
  // would silently fail to start or stop anything.
  const template = synth({}, '10.0.0.0/16', {
    account: '123456789012',
    region: 'ap-southeast-2',
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmName: 'derrops--region--bastion--power',
    Namespace: 'derrops/region',
    MetricName: 'PowerOnRequests',
  });
  const [power] = policyStatements(template).filter((s) =>
    JSON.stringify(s.Action).includes('ec2:'),
  );
  expect(JSON.stringify(power.Resource)).toContain(
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
